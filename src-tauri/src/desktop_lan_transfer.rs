use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use uuid::Uuid;

use super::{collect_response, Connection, TransferOutcome, TransferSession, VerifiedUpload};
use crate::{
    local, local_transfer, message,
    protocol::{LanChange, LanChangeRequest, LanStat, LanUpload, LanUploadReply, LAN_UPLOAD_CHUNK},
    remote_transfer, Result,
};

pub(super) struct LanTransfer<'a> {
    pub connection: &'a Connection,
    pub transfer: &'a TransferSession,
}

pub(super) struct MoveCleanup {
    actions: Vec<(Vec<String>, LanChange)>,
}

impl MoveCleanup {
    pub(super) fn capture(
        client: &mut LanTransfer<'_>,
        staged: &Path,
        segments: &[String],
    ) -> Result<Self> {
        let mut cleanup = Self {
            actions: Vec::new(),
        };
        cleanup.record(client, staged, segments)?;
        Ok(cleanup)
    }

    fn record(
        &mut self,
        client: &mut LanTransfer<'_>,
        staged: &Path,
        segments: &[String],
    ) -> Result<()> {
        client.transfer.ensure_running().map_err(message)?;
        let change = if staged.is_dir() {
            for entry in fs::read_dir(staged).map_err(message)? {
                let entry = entry.map_err(message)?;
                let mut child = segments.to_vec();
                child.push(
                    entry
                        .file_name()
                        .into_string()
                        .map_err(|_| "A filename cannot be represented as Unicode.")?,
                );
                self.record(client, &entry.path(), &child)?;
            }
            LanChange::RemoveEmptyFolder
        } else {
            let expected = client.file_snapshot(segments)?;
            let digest =
                crate::protocol::lan_file_digest(File::open(staged).map_err(message)?, || {
                    client.transfer.ensure_running()
                })
                .map_err(message)?;
            LanChange::DeleteCompared { expected, digest }
        };
        self.actions.push((segments.to_vec(), change));
        Ok(())
    }

    pub(super) fn finish(
        self,
        client: &LanTransfer<'_>,
        source: &[String],
        destination: String,
    ) -> TransferOutcome {
        for (segments, change) in self.actions {
            if let Err(error) = client
                .transfer
                .ensure_running()
                .map_err(message)
                .and_then(|()| client.change(&segments, change))
            {
                return TransferOutcome::SourceRetained {
                    source: format!("/{}", source.join("/")),
                    destination,
                    error,
                };
            }
        }
        TransferOutcome::Completed
    }
}

enum LocalOriginal {
    Folder(same_file::Handle),
    File(local_transfer::FileRevision),
}

struct LocalMoveItem {
    path: PathBuf,
    target: Vec<String>,
    original: LocalOriginal,
}

fn collect_local_move(
    source: &Path,
    target: &[String],
    transfer: &TransferSession,
    items: &mut Vec<LocalMoveItem>,
) -> Result<()> {
    transfer.ensure_running().map_err(message)?;
    let metadata = fs::symlink_metadata(source).map_err(message)?;
    if local::is_link(&metadata) || (!metadata.is_file() && !metadata.is_dir()) {
        return Err("Choose local files and folders without symbolic links.".to_owned());
    }
    let original = if metadata.is_dir() {
        let folder = same_file::Handle::from_path(source).map_err(message)?;
        for entry in fs::read_dir(source).map_err(message)? {
            local_transfer::verify_folder(source, &folder).map_err(message)?;
            let entry = entry.map_err(message)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "A filename cannot be represented as Unicode.")?;
            let child = [target, &[name]].concat();
            collect_local_move(&entry.path(), &child, transfer, items)?;
        }
        LocalOriginal::Folder(folder)
    } else {
        LocalOriginal::File(
            local_transfer::FileRevision::capture(source, &metadata).map_err(message)?,
        )
    };
    items.push(LocalMoveItem {
        path: source.to_owned(),
        target: target.to_vec(),
        original,
    });
    Ok(())
}

pub(super) fn move_local_folder(
    client: &mut LanTransfer<'_>,
    source: &Path,
    target: &[String],
    policy: local_transfer::Policy,
    progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    ask: &mut impl FnMut(local_transfer::Conflict) -> io::Result<local_transfer::Decision>,
) -> Result<TransferOutcome> {
    let transfer = client.transfer;
    let mut items = Vec::new();
    collect_local_move(source, target, transfer, &mut items)?;
    if !remote_transfer::upload(
        client,
        source,
        target,
        policy,
        progress,
        ask,
        &mut |_, _| {},
    )? {
        return Ok(TransferOutcome::Skipped);
    }
    for item in items {
        let result = (|| {
            transfer.ensure_running().map_err(message)?;
            match item.original {
                LocalOriginal::Folder(original) => {
                    local_transfer::verify_folder(&item.path, &original).map_err(message)?;
                    fs::remove_dir(&item.path).map_err(message)
                }
                LocalOriginal::File(original) => {
                    original.verify(&item.path).map_err(message)?;
                    let mut input = File::open(&item.path).map_err(message)?;
                    client.verify_uploaded(&item.target, &mut input, transfer)?;
                    drop(input);
                    transfer.ensure_running().map_err(message)?;
                    local_transfer::remove_original(&item.path, &original).map_err(message)
                }
            }
        })();
        if let Err(error) = result {
            return Ok(TransferOutcome::SourceRetained {
                source: crate::file_history::display(source),
                destination: format!("/{}", target.join("/")),
                error,
            });
        }
    }
    Ok(TransferOutcome::Completed)
}

impl LanTransfer<'_> {
    pub(super) fn change(&self, segments: &[String], change: LanChange) -> Result<()> {
        tauri::async_runtime::block_on(self.transfer.interrupt(async {
            let timeout = if matches!(change, LanChange::DeleteCompared { .. }) {
                Duration::from_secs(180)
            } else {
                Duration::from_secs(20)
            };
            let action = LanChangeRequest {
                segments: segments.to_vec(),
                change,
            };
            let response = self
                .connection
                .request("v1/lan/change", action, timeout)
                .await?;
            serde_json::from_slice::<Result<()>>(&collect_response(response, 8192).await?)
                .map_err(message)?
        }))
    }

    pub(super) fn file_snapshot(&mut self, segments: &[String]) -> Result<LanStat> {
        use remote_transfer::Session;
        self.stat(segments)?
            .filter(|entry| entry.file)
            .ok_or_else(|| "Choose a regular Dirlume LAN file to move.".to_owned())
    }

    fn upload_action(&self, request: LanUpload) -> Result<LanUploadReply> {
        tauri::async_runtime::block_on(
            self.transfer
                .interrupt(self.request(request, Duration::from_secs(20))),
        )
    }

    async fn request(&self, request: LanUpload, timeout: Duration) -> Result<LanUploadReply> {
        let response = self
            .connection
            .request("v1/lan/upload", request, timeout)
            .await?;
        serde_json::from_slice::<Result<LanUploadReply>>(&collect_response(response, 8192).await?)
            .map_err(message)?
    }

    fn cancel(&self, stage: Uuid) {
        // The remote side can clean up a staging file after local cancellation.
        let _ = tauri::async_runtime::block_on(
            self.request(LanUpload::Cancel { stage }, Duration::from_secs(2)),
        );
    }
}

impl remote_transfer::Entry for LanStat {
    fn name(&self) -> &str {
        &self.name
    }
    fn is_directory(&self) -> bool {
        self.directory
    }
    fn is_file(&self) -> bool {
        self.file
    }
    fn size(&self) -> Option<u64> {
        self.file.then_some(self.size)
    }
    fn modified(&self) -> Option<SystemTime> {
        let (seconds, nanos) = self.modified?;
        UNIX_EPOCH.checked_add(Duration::new(seconds, nanos))
    }
}

impl remote_transfer::Session for LanTransfer<'_> {
    const SOURCE: &'static str = "Dirlume LAN";
    type Entry = LanStat;

    fn stat(&mut self, segments: &[String]) -> Result<Option<Self::Entry>> {
        match self.upload_action(LanUpload::Stat {
            segments: segments.to_vec(),
        })? {
            LanUploadReply::Stat { entry } => Ok(entry),
            _ => Err("Unexpected Dirlume LAN file information.".to_owned()),
        }
    }
}

impl remote_transfer::UploadSession for LanTransfer<'_> {
    fn absolute(segments: &[String]) -> Result<String> {
        Ok("/".to_owned() + &segments.join("/"))
    }

    fn parse_path(path: &str) -> Result<Vec<String>> {
        let parts = path
            .strip_prefix('/')
            .ok_or("Choose an absolute Dirlume LAN destination.")?;
        let segments: Vec<_> = parts
            .trim_end_matches('/')
            .split('/')
            .map(str::to_owned)
            .collect();
        if segments
            .iter()
            .any(|part| part.is_empty() || part == "." || part == ".." || part.contains('\0'))
        {
            return Err("Choose a location inside a remote drive.".to_owned());
        }
        Ok(segments)
    }

    fn check_publication(&self, _: bool) -> Result<()> {
        Ok(())
    }

    fn mkdir(&mut self, segments: &[String]) -> Result<()> {
        self.change(segments, LanChange::Folder)
    }

    fn upload_to_stage(
        &mut self,
        target: &[String],
        input: &mut (impl Read + io::Seek),
        mut progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<String> {
        let LanUploadReply::Begun { stage } = self.upload_action(LanUpload::Begin {
            segments: target.to_vec(),
        })?
        else {
            return Err("The Dirlume LAN computer did not start the upload.".to_owned());
        };
        let result = (|| {
            let mut buffer = vec![0; LAN_UPLOAD_CHUNK];
            let mut offset = 0;
            loop {
                self.transfer.ensure_running().map_err(message)?;
                let count = input.read(&mut buffer).map_err(message)?;
                if count == 0 {
                    break;
                }
                self.upload_action(LanUpload::Chunk {
                    stage,
                    offset,
                    encoded: URL_SAFE_NO_PAD.encode(&buffer[..count]),
                })?;
                offset += count as u64;
                progress(offset)?;
            }
            Ok(stage.to_string())
        })();
        if result.is_err() {
            self.cancel(stage);
        }
        result
    }

    fn remove_stage(&mut self, stage: &str) {
        if let Ok(stage) = Uuid::parse_str(stage) {
            self.cancel(stage);
        }
    }

    fn rename_stage(&mut self, stage: &str, _: &[String], overwrite: bool) -> Result<()> {
        let stage = Uuid::parse_str(stage).map_err(message)?;
        match self.upload_action(LanUpload::Commit { stage, overwrite })? {
            LanUploadReply::Ok => Ok(()),
            _ => Err("The Dirlume LAN computer did not commit the upload.".to_owned()),
        }
    }
}

impl VerifiedUpload for LanTransfer<'_> {
    fn verify_uploaded(
        &mut self,
        target: &[String],
        input: &mut File,
        session: &TransferSession,
    ) -> Result<()> {
        let mut comparison = CompareFile {
            input,
            buffer: Vec::new(),
        };
        self.connection
            .download_file(target.to_vec(), &mut comparison, session, |_, _, _| Ok(()))?;
        if input.read(&mut [0]).map_err(message)? != 0 {
            return Err("The Dirlume LAN destination changed after the upload.".to_owned());
        }
        Ok(())
    }
}

struct CompareFile<'a> {
    input: &'a mut File,
    buffer: Vec<u8>,
}

impl Write for CompareFile<'_> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buffer.resize(data.len(), 0);
        if self.input.read_exact(&mut self.buffer).is_err() || self.buffer != data {
            return Err(io::Error::other(
                "The Dirlume LAN destination changed after the upload.",
            ));
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
