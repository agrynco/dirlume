use std::{
    collections::BTreeMap,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, UNIX_EPOCH},
};

use axum::{
    extract::{Request, State},
    http::StatusCode,
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use cap_std::fs::{Dir, File, Metadata, OpenOptions};
use uuid::Uuid;

use super::{
    preserve_lan_access, rename_lan_exclusive, require_lan_write, writable_lan_item, Share,
};
use crate::{
    message,
    protocol::{LanStat, LanUpload, LanUploadReply, RemotePath, LAN_UPLOAD_CHUNK},
    Result,
};

const MAX_STAGES: usize = 32;
const EXPIRE_AFTER: Duration = Duration::from_secs(120);

pub(super) type Uploads = Arc<Mutex<BTreeMap<Uuid, UploadStage>>>;

pub(super) struct UploadStage {
    directory: Dir,
    temporary: PathBuf,
    target: PathBuf,
    file: Option<File>,
    expected: Option<Destination>,
    offset: u64,
    touched: Instant,
}

impl Drop for UploadStage {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = self.directory.remove_file(&self.temporary);
    }
}

#[derive(PartialEq)]
struct Destination {
    identity: same_file::Handle,
    metadata: LanStat,
}

pub(super) fn reap_stale_uploads(uploads: &Uploads) {
    let uploads = Arc::downgrade(uploads);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let Some(table) = uploads.upgrade() else {
                break;
            };
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(mut live) = table.lock() {
                    live.retain(|_, stage| stage.touched.elapsed() < EXPIRE_AFTER);
                }
            })
            .await;
        }
    });
}

pub(super) async fn handle(
    State(share): State<Arc<Share>>,
    request: Request,
) -> std::result::Result<Json<Result<LanUploadReply>>, StatusCode> {
    share.authorize(request.headers())?;
    let bytes = axum::body::to_bytes(request.into_body(), LAN_UPLOAD_CHUNK * 2 + 64 * 1024)
        .await
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
    let operation = serde_json::from_slice(&bytes).map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok(Json(
        tokio::task::spawn_blocking(move || apply(&share, operation))
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    ))
}

fn apply(share: &Share, operation: LanUpload) -> Result<LanUploadReply> {
    match operation {
        LanUpload::Stat { segments } => {
            stat(share, segments).map(|entry| LanUploadReply::Stat { entry })
        }
        LanUpload::Cancel { stage } => {
            share.lan_uploads.lock().map_err(message)?.remove(&stage);
            Ok(LanUploadReply::Ok)
        }
        operation => {
            require_lan_write(share)?;
            let mut stages = share.lan_uploads.lock().map_err(message)?;
            match operation {
                LanUpload::Begin { segments } => {
                    if stages.len() >= MAX_STAGES {
                        return Err("Too many Dirlume LAN uploads are active.".to_owned());
                    }
                    let (directory, target) = writable_lan_item(share, segments)?;
                    let id = Uuid::new_v4();
                    stages.insert(
                        id,
                        UploadStage::begin(directory, target, id).map_err(message)?,
                    );
                    Ok(LanUploadReply::Begun { stage: id })
                }
                LanUpload::Chunk {
                    stage,
                    offset,
                    encoded,
                } => {
                    let pending = stages
                        .get_mut(&stage)
                        .ok_or("The Dirlume LAN upload expired.")?;
                    let buffer = URL_SAFE_NO_PAD.decode(encoded).map_err(message)?;
                    if buffer.is_empty()
                        || buffer.len() > LAN_UPLOAD_CHUNK
                        || pending.offset != offset
                    {
                        return Err(
                            "The Dirlume LAN upload received an unexpected chunk.".to_owned()
                        );
                    }
                    pending
                        .file
                        .as_mut()
                        .ok_or("The Dirlume LAN upload expired.")?
                        .write_all(&buffer)
                        .map_err(message)?;
                    pending.offset += buffer.len() as u64;
                    pending.touched = Instant::now();
                    Ok(LanUploadReply::Ok)
                }
                LanUpload::Commit { stage, overwrite } => {
                    let pending = stages
                        .remove(&stage)
                        .ok_or("The Dirlume LAN upload expired.")?;
                    drop(stages);
                    let _write = share.lan_writes.lock().map_err(message)?;
                    require_lan_write(share)?;
                    pending.commit(overwrite).map_err(message)?;
                    Ok(LanUploadReply::Ok)
                }
                _ => unreachable!(),
            }
        }
    }
}

fn stat(share: &Share, segments: Vec<String>) -> Result<Option<LanStat>> {
    let Some(name) = segments.last().cloned() else {
        return Err("Choose a location inside a remote drive.".to_owned());
    };
    let (directory, path) = share.resolve(RemotePath { segments }).map_err(message)?;
    match directory.symlink_metadata(path) {
        Ok(metadata) => Ok(Some(file_stat(name, &metadata))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(message(error)),
    }
}

pub(super) fn file_stat(name: String, metadata: &Metadata) -> LanStat {
    LanStat {
        name,
        directory: metadata.is_dir(),
        file: metadata.is_file(),
        size: metadata.len(),
        modified: metadata
            .modified()
            .ok()
            .and_then(|time| time.into_std().duration_since(UNIX_EPOCH).ok())
            .map(|time| (time.as_secs(), time.subsec_nanos())),
    }
}

fn current_file(directory: &Dir, path: &Path) -> io::Result<Option<(Destination, File)>> {
    let metadata = match directory.symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() {
        return Err(io::Error::other(
            "The Dirlume LAN destination is not a regular file.",
        ));
    }
    let mut options = OpenOptions::new();
    let file = directory.open_with(path, options.read(true).write(true))?;
    let destination = Destination {
        identity: same_file::Handle::from_file(file.try_clone()?.into_std())?,
        metadata: file_stat(String::new(), &file.metadata()?),
    };
    Ok(Some((destination, file)))
}

impl UploadStage {
    fn begin(directory: Dir, target: PathBuf, id: Uuid) -> io::Result<Self> {
        let original = current_file(&directory, &target)?;
        let temporary = PathBuf::from(format!(".dirlume-upload-{id}"));
        let mut options = OpenOptions::new();
        #[cfg(windows)]
        if original.is_some() {
            use cap_std::fs::OpenOptionsExt;
            use windows_sys::Win32::{Foundation::GENERIC_WRITE, Storage::FileSystem::WRITE_DAC};
            options.access_mode(GENERIC_WRITE | WRITE_DAC);
        }
        #[cfg(unix)]
        if original.is_some() {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = directory.open_with(&temporary, options.write(true).create_new(true))?;
        let mut stage = Self {
            directory,
            temporary,
            target,
            file: Some(file),
            expected: None,
            offset: 0,
            touched: Instant::now(),
        };
        if let Some((destination, original)) = original {
            preserve_lan_access(&original, stage.file.as_ref().unwrap())?;
            stage.expected = Some(destination);
        }
        Ok(stage)
    }

    fn commit(mut self, overwrite: bool) -> io::Result<()> {
        if let Some(file) = self.file.take() {
            file.sync_all()?;
        }
        if overwrite != self.expected.is_some() {
            return Err(io::Error::other(
                "The Dirlume LAN destination changed during the upload.",
            ));
        }
        let current = current_file(&self.directory, &self.target)?.map(|(stamp, _)| stamp);
        if current != self.expected {
            return Err(io::Error::other(
                "The Dirlume LAN destination changed during the upload.",
            ));
        }
        if overwrite {
            self.directory
                .rename(&self.temporary, &self.directory, &self.target)
        } else {
            rename_lan_exclusive(
                &self.directory,
                &self.temporary,
                &self.directory,
                &self.target,
            )
        }
    }
}
