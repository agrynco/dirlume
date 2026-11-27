use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{mpsc, Arc, Mutex},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use tauri::ipc::Channel;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::{
    copy_downloaded_item, TransferEvent, TransferOutcome, TransferSession, VerifiedUpload,
};
use crate::remote_transfer::{DownloadSession, Entry as _, Session as _, UploadSession as _};
use crate::{local, local_transfer, message, remote_transfer, ssh, Result};

struct Pending {
    ticket: Uuid,
    connection: Arc<ssh::Connection>,
    read_only: bool,
    reply: mpsc::SyncSender<bool>,
}

#[derive(Default)]
pub(super) struct SudoRequest(Mutex<Option<Pending>>);

impl SudoRequest {
    fn ask(
        &self,
        connection: &Arc<ssh::Connection>,
        read_only: bool,
        path: String,
        transfer: &TransferSession,
        output: &Channel<TransferEvent>,
    ) -> Result<()> {
        let ticket = Uuid::new_v4();
        let (reply, answer) = mpsc::sync_channel(1);
        {
            let mut pending = self.0.lock().map_err(message)?;
            transfer.ensure_running().map_err(message)?;
            if pending.is_some() {
                return Err("An SSH authorization request is already pending.".to_owned());
            }
            *pending = Some(Pending {
                ticket,
                connection: connection.clone(),
                read_only,
                reply,
            });
        }
        if let Err(error) = output.send(TransferEvent::SudoRequired {
            ticket,
            address: connection.address(),
            path,
        }) {
            self.cancel()?;
            return Err(message(error));
        }
        match answer.recv() {
            Ok(true) => Ok(()),
            Ok(false) => Err(ssh::PERMISSION_DENIED.to_owned()),
            Err(_) => Err("Transfer canceled.".to_owned()),
        }
    }

    pub(super) fn authorize(
        &self,
        ticket: Uuid,
        password: Zeroizing<String>,
        transfer: &TransferSession,
    ) -> Result<()> {
        let (connection, read_only) = {
            let pending = self.0.lock().map_err(message)?;
            let request = pending
                .as_ref()
                .filter(|request| request.ticket == ticket)
                .ok_or("The SSH authorization request has closed.")?;
            (request.connection.clone(), request.read_only)
        };
        connection
            .authorized_operation(
                Some(password),
                read_only,
                Some(transfer.cancelled.clone()),
                |_| Ok(()),
            )?
            .ok_or("The SSH authorization request has closed.")?;
        self.answer(ticket, true)
    }

    pub(super) fn answer(&self, ticket: Uuid, approved: bool) -> Result<()> {
        let mut pending = self.0.lock().map_err(message)?;
        if pending
            .as_ref()
            .is_some_and(|request| request.ticket == ticket)
        {
            pending
                .take()
                .expect("matched SSH authorization")
                .reply
                .send(approved)
                .map_err(message)?;
        }
        Ok(())
    }

    pub(super) fn cancel(&self) -> Result<()> {
        self.0.lock().map_err(message)?.take();
        Ok(())
    }
}

pub(super) struct SshTransfer<'a> {
    ordinary: ssh::Session,
    connection: &'a Arc<ssh::Connection>,
    read_only: bool,
    transfer: &'a TransferSession,
    output: &'a Channel<TransferEvent>,
}

enum RemoteOriginal {
    Directory,
    File { entry: ssh::Entry, digest: String },
}

pub(super) struct SshMoveCleanup(Vec<(Vec<String>, RemoteOriginal)>);

impl SshMoveCleanup {
    pub(super) fn capture(
        remote: &mut SshTransfer<'_>,
        source: &[String],
        staged: &Path,
    ) -> Result<Self> {
        let mut cleanup = Self(Vec::new());
        cleanup.record(remote, source, staged)?;
        Ok(cleanup)
    }

    fn record(
        &mut self,
        remote: &mut SshTransfer<'_>,
        source: &[String],
        staged: &Path,
    ) -> Result<()> {
        remote.transfer.ensure_running().map_err(message)?;
        let original = if staged.is_dir() {
            for item in fs::read_dir(staged).map_err(message)? {
                let item = item.map_err(message)?;
                let name = item
                    .file_name()
                    .into_string()
                    .map_err(|_| "A filename could not be represented as Unicode.")?;
                self.record(remote, &remote_transfer::child(source, &name), &item.path())?;
            }
            RemoteOriginal::Directory
        } else {
            let entry = remote
                .stat(source)?
                .filter(|entry| entry.is_file())
                .ok_or("The SSH source file changed during the move.")?;
            let digest =
                crate::protocol::lan_file_digest(File::open(staged).map_err(message)?, || {
                    remote.transfer.ensure_running()
                })
                .map_err(message)?;
            RemoteOriginal::File { entry, digest }
        };
        self.0.push((source.to_vec(), original));
        Ok(())
    }

    pub(super) fn finish(
        self,
        remote: &mut SshTransfer<'_>,
        source: &[String],
        destination: String,
    ) -> TransferOutcome {
        remote.read_only = false;
        let check = || "The SSH source item changed during the move.".to_owned();
        for (segments, original) in self.0 {
            let result = remote.operation(&segments, |session| {
                let current = session.stat(&segments)?.ok_or_else(check)?;
                match &original {
                    RemoteOriginal::Directory if current.is_directory() => {
                        session.remove_leaf(&segments, true)
                    }
                    RemoteOriginal::File { entry, digest } if *entry == current => {
                        let mut proof = FileHash(ring::digest::Context::new(&ring::digest::SHA256));
                        session.download_file(&segments, &mut proof, |_| Ok(()))?;
                        if &URL_SAFE_NO_PAD.encode(proof.0.finish().as_ref()) != digest
                            || session.stat(&segments)?.as_ref() != Some(entry)
                        {
                            return Err(check());
                        }
                        session.remove_leaf(&segments, false)
                    }
                    _ => Err(check()),
                }
            });
            if let Err(error) = result {
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

struct FileHash(ring::digest::Context);

impl Write for FileHash {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.0.update(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> SshTransfer<'a> {
    pub(super) fn open(
        connection: &'a Arc<ssh::Connection>,
        read_only: bool,
        transfer: &'a TransferSession,
        output: &'a Channel<TransferEvent>,
    ) -> Result<Self> {
        let ordinary = connection.open_with_cancel(Some(transfer.cancelled.clone()))?;
        Ok(Self {
            ordinary,
            connection,
            read_only,
            transfer,
            output,
        })
    }

    pub(super) fn move_to_local<P>(
        &mut self,
        source: &[String],
        target: &Path,
        options: &local_transfer::Options,
        progress: P,
        ask: impl FnMut(local_transfer::Conflict) -> io::Result<local_transfer::Decision>,
    ) -> Result<TransferOutcome>
    where
        P: FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    {
        let mut cleanup = None;
        let outcome = copy_downloaded_item(
            target,
            self.transfer,
            options,
            progress,
            ask,
            |staged, progress| {
                let temporary_copy = local_transfer::Options {
                    moving: false,
                    policy: local_transfer::Policy::Ask,
                    ask_read_only: true,
                    copy: local::CopyOptions::default(),
                };
                if !remote_transfer::download(
                    self,
                    source,
                    staged,
                    &temporary_copy,
                    progress,
                    |_| Ok(local_transfer::Decision::Skip),
                    |_, _| {},
                )? {
                    return Err("Could not stage the complete SSH move source.".to_owned());
                }
                cleanup = Some(SshMoveCleanup::capture(self, source, staged)?);
                Ok(())
            },
        )?;
        if matches!(outcome, TransferOutcome::Completed) {
            if let Some(cleanup) = cleanup {
                return Ok(cleanup.finish(self, source, crate::file_history::display(target)));
            }
        }
        Ok(outcome)
    }

    pub(super) fn remove(
        &mut self,
        segments: &[String],
        recursive: bool,
        recycle: bool,
    ) -> Result<()> {
        if recycle {
            return self.operation(segments, |session| session.recycle(segments));
        }
        let entry = self
            .stat(segments)?
            .ok_or("The SSH item no longer exists.")?;
        if recursive && entry.is_directory() {
            for child in self.children(segments)? {
                self.remove(&remote_transfer::child(segments, child.name()), true, false)?;
            }
        }
        self.operation(segments, |session| {
            let current = session.stat(segments)?;
            let still_selected = if entry.is_directory() {
                current.as_ref().is_some_and(|item| item.is_directory())
            } else {
                current.as_ref() == Some(&entry)
            };
            if !still_selected {
                return Err("The SSH item changed during deletion.".to_owned());
            }
            session.remove_leaf(segments, entry.is_directory())
        })
    }

    fn operation<T>(
        &mut self,
        segments: &[String],
        mut action: impl FnMut(&mut ssh::Session) -> Result<T>,
    ) -> Result<T> {
        match action(&mut self.ordinary) {
            Err(error) if error == ssh::PERMISSION_DENIED => {}
            result => return result,
        }
        let stop = Some(self.transfer.cancelled.clone());
        if let Some(value) =
            self.connection
                .authorized_operation(None, self.read_only, stop.clone(), &mut action)?
        {
            return Ok(value);
        }
        self.transfer.sudo.ask(
            self.connection,
            self.read_only,
            Self::absolute(segments)?,
            self.transfer,
            self.output,
        )?;
        self.connection
            .authorized_operation(None, self.read_only, stop, action)?
            .ok_or_else(|| "SSH sudo authorization expired.".to_owned())
    }
}

impl remote_transfer::Session for SshTransfer<'_> {
    const SOURCE: &'static str = "SSH";
    type Entry = ssh::Entry;

    fn stat(&mut self, segments: &[String]) -> Result<Option<Self::Entry>> {
        self.operation(segments, |session| session.stat(segments))
    }
}

impl DownloadSession for SshTransfer<'_> {
    fn preserve_download_timestamps(&self) -> bool {
        self.ordinary.preserve_download_timestamps()
    }

    fn children(&mut self, segments: &[String]) -> Result<Vec<Self::Entry>> {
        self.operation(segments, |session| session.children(segments))
    }

    fn download(
        &mut self,
        segments: &[String],
        output: &mut File,
        mut progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<()> {
        let start = output.stream_position().map_err(message)?;
        self.operation(segments, |session| {
            output.set_len(start).map_err(message)?;
            output.seek(SeekFrom::Start(start)).map_err(message)?;
            session.download(segments, output, &mut progress)
        })
    }
}

impl remote_transfer::UploadSession for SshTransfer<'_> {
    fn absolute(segments: &[String]) -> Result<String> {
        ssh::Session::absolute(segments)
    }

    fn parse_path(path: &str) -> Result<Vec<String>> {
        ssh::Session::parse_path(path)
    }

    fn check_publication(&self, overwrite: bool) -> Result<()> {
        self.ordinary.check_publication(overwrite)
    }

    fn mkdir(&mut self, segments: &[String]) -> Result<()> {
        self.operation(segments, |session| session.mkdir(segments))
    }

    fn upload_to_stage(
        &mut self,
        target: &[String],
        input: &mut (impl Read + Seek),
        mut progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<String> {
        let start = input.stream_position().map_err(message)?;
        self.operation(target, |session| {
            input.seek(SeekFrom::Start(start)).map_err(message)?;
            session.upload_to_stage(target, input, &mut progress)
        })
    }

    fn remove_stage(&mut self, stage: &str) {
        self.ordinary.remove_stage(stage);
        let _ = self
            .connection
            .authorized_operation(None, self.read_only, None, |session| {
                session.remove_stage(stage);
                Ok(())
            });
    }

    fn rename_stage(&mut self, stage: &str, target: &[String], overwrite: bool) -> Result<()> {
        self.operation(target, |session| {
            session.rename_stage(stage, target, overwrite)
        })
    }
}

impl VerifiedUpload for SshTransfer<'_> {
    fn verify_uploaded(
        &mut self,
        target: &[String],
        input: &mut File,
        transfer: &TransferSession,
    ) -> Result<()> {
        let start = input.stream_position().map_err(message)?;
        self.operation(target, |session| {
            input.seek(SeekFrom::Start(start)).map_err(message)?;
            session.verify_uploaded_contents(target, input, || {
                transfer.ensure_running().map_err(message)
            })
        })
    }
}
