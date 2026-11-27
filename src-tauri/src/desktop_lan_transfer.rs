use std::{
    fs::File,
    io::{self, Read, Write},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use uuid::Uuid;

use super::{collect_response, Connection, TransferOutcome, TransferSession, VerifiedUpload};
use crate::{
    message,
    protocol::{LanChange, LanChangeRequest, LanStat, LanUpload, LanUploadReply, LAN_UPLOAD_CHUNK},
    remote_transfer, Result,
};

pub(super) struct LanTransfer<'a> {
    pub connection: &'a Connection,
    pub transfer: &'a TransferSession,
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

    pub(super) fn finish_move(
        &self,
        segments: &[String],
        expected: LanStat,
        digest: String,
        destination: String,
    ) -> TransferOutcome {
        match self
            .transfer
            .ensure_running()
            .map_err(message)
            .and_then(|()| self.change(segments, LanChange::DeleteCompared { expected, digest }))
        {
            Ok(()) => TransferOutcome::Completed,
            Err(error) => TransferOutcome::SourceRetained {
                source: format!("/{}", segments.join("/")),
                destination,
                error,
            },
        }
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
        input: &mut impl Read,
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
