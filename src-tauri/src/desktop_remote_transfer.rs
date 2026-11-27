use std::{
    fs, io,
    net::IpAddr,
    path::Path,
    sync::{Arc, Mutex},
};

use super::{
    collect_local_move, download_kswitcher_tree, finish_downloaded_file, ftp, lan_transfer, local,
    local_transfer, message, remote_transfer, ssh, ssh_transfer, transfer_kswitcher, Channel,
    Connection, LocalOriginal, Result, TransferEvent, TransferOutcome, TransferRequest,
    TransferSession, TransferSource, VerifiedUpload,
};

pub(super) enum Endpoint<'a> {
    Ftp(&'a ftp::Connection),
    Ssh(&'a Arc<ssh::Connection>),
    Server(&'a Connection),
    Archive(&'a Mutex<crate::archives::Archive>),
    Kswitcher(&'a str),
}

impl Endpoint<'_> {
    fn host(&self) -> Option<&str> {
        match self {
            Self::Ftp(connection) => Some(connection.host()),
            Self::Ssh(connection) => Some(connection.host()),
            Self::Server(connection) => connection.invitation.address.host_str(),
            Self::Archive(_) | Self::Kswitcher(_) => None,
        }
    }
}

pub(super) struct Relay<'a> {
    pub request: &'a TransferRequest,
    pub transfer: &'a Arc<TransferSession>,
    pub output: &'a Channel<TransferEvent>,
}

impl Relay<'_> {
    pub(super) fn run(
        &self,
        source: Endpoint<'_>,
        segments: &[String],
        destination: Endpoint<'_>,
        progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
        ask: &mut impl FnMut(local_transfer::Conflict) -> io::Result<local_transfer::Decision>,
    ) -> Result<TransferOutcome> {
        let localhost = |host: &str| {
            host.eq_ignore_ascii_case("localhost")
                || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
        };
        let same_host = source
            .host()
            .zip(destination.host())
            .is_some_and(|(host, other)| {
                let host = host.trim_end_matches('.');
                let other = other.trim_end_matches('.');
                host.eq_ignore_ascii_case(other) || localhost(host) && localhost(other)
            });
        let different_protocol =
            std::mem::discriminant(&source) != std::mem::discriminant(&destination);
        let name = segments.last().ok_or("Choose a remote file or folder.")?;
        let workspace = tempfile::tempdir().map_err(message)?;
        let staged = workspace
            .path()
            .join(local::name_component(name).map_err(message)?);
        let publish = |progress: &mut _, ask: &mut _| match destination {
            Endpoint::Ftp(connection) => self.publish(
                &mut connection.open_with_cancel(Some(self.transfer.cancelled.clone()))?,
                segments,
                &staged,
                (same_host, different_protocol),
                progress,
                ask,
            ),
            Endpoint::Ssh(connection) => self.publish(
                &mut ssh_transfer::SshTransfer::open(
                    connection,
                    false,
                    self.transfer,
                    self.output,
                )?,
                segments,
                &staged,
                (same_host, different_protocol),
                progress,
                ask,
            ),
            Endpoint::Server(connection) => self.publish(
                &mut lan_transfer::LanTransfer {
                    connection,
                    transfer: self.transfer,
                },
                segments,
                &staged,
                (same_host, different_protocol),
                progress,
                ask,
            ),
            Endpoint::Archive(archive) => {
                self.publish_archive(archive, name, &staged, progress, ask)
            }
            Endpoint::Kswitcher(peer) => self.publish_kswitcher(peer, name, &staged),
        };
        match source {
            Endpoint::Ftp(connection) => {
                let mut source =
                    connection.open_with_cancel(Some(self.transfer.cancelled.clone()))?;
                stage(&mut source, segments, &staged, progress)?;
                let cleanup = self
                    .request
                    .moving
                    .then(|| {
                        crate::ftp_transfer::MoveCleanup::capture(
                            &mut source,
                            segments,
                            &staged,
                            || self.transfer.ensure_running(),
                        )
                    })
                    .transpose()?;
                let Some(destination) = publish(progress, ask)? else {
                    return Ok(TransferOutcome::Skipped);
                };
                if let Some(cleanup) = cleanup {
                    if let Err(error) =
                        cleanup.finish(&mut source, || self.transfer.ensure_running())
                    {
                        return Ok(TransferOutcome::SourceRetained {
                            source: format!("/{}", segments.join("/")),
                            destination,
                            error,
                        });
                    }
                }
                Ok(TransferOutcome::Completed)
            }
            Endpoint::Ssh(connection) => {
                let mut source =
                    ssh_transfer::SshTransfer::open(connection, true, self.transfer, self.output)?;
                stage(&mut source, segments, &staged, progress)?;
                let cleanup = self
                    .request
                    .moving
                    .then(|| ssh_transfer::SshMoveCleanup::capture(&mut source, segments, &staged))
                    .transpose()?;
                let Some(destination) = publish(progress, ask)? else {
                    return Ok(TransferOutcome::Skipped);
                };
                Ok(cleanup.map_or(TransferOutcome::Completed, |cleanup| {
                    cleanup.finish(&mut source, segments, destination)
                }))
            }
            Endpoint::Server(connection) => {
                let TransferSource::Server {
                    folder,
                    modified,
                    writable_server,
                    ..
                } = &self.request.source
                else {
                    return Err("Choose a Dirlume share.".to_owned());
                };
                if self.request.moving && !writable_server {
                    return Err("This source is read-only.".to_owned());
                }
                if *folder {
                    connection.download_tree(
                        segments.to_vec(),
                        &staged,
                        self.transfer,
                        progress,
                    )?;
                } else {
                    let mut file = fs::File::create_new(&staged).map_err(message)?;
                    connection.download_file(
                        segments.to_vec(),
                        &mut file,
                        self.transfer,
                        &mut *progress,
                    )?;
                    finish_downloaded_file(&file, *modified).map_err(message)?;
                }
                let mut source = lan_transfer::LanTransfer {
                    connection,
                    transfer: self.transfer,
                };
                let cleanup = self
                    .request
                    .moving
                    .then(|| lan_transfer::MoveCleanup::capture(&mut source, &staged, segments))
                    .transpose()?;
                let Some(destination) = publish(progress, ask)? else {
                    return Ok(TransferOutcome::Skipped);
                };
                Ok(cleanup.map_or(TransferOutcome::Completed, |cleanup| {
                    cleanup.finish(&source, segments, destination)
                }))
            }
            Endpoint::Archive(archive) => {
                let generation = {
                    let archive = archive.lock().map_err(message)?;
                    if self.request.moving && !archive.is_writable() {
                        return Err("The archive is read-only.".to_owned());
                    }
                    if !archive.copy_to(
                        segments,
                        &staged,
                        &stage_options(),
                        &mut *progress,
                        |_| Ok(local_transfer::Decision::Skip),
                        |_, _| {},
                    )? {
                        return Ok(TransferOutcome::Skipped);
                    }
                    archive.generation().to_owned()
                };
                let Some(destination) = publish(progress, ask)? else {
                    return Ok(TransferOutcome::Skipped);
                };
                if self.request.moving {
                    let result = archive.lock().map_err(message).and_then(|mut archive| {
                        archive.remove_moved_member(segments, &generation, || {
                            self.transfer.ensure_running()
                        })
                    });
                    if let Err(error) = result {
                        return Ok(TransferOutcome::SourceRetained {
                            source: format!("/{}", segments.join("/")),
                            destination,
                            error,
                        });
                    }
                }
                Ok(TransferOutcome::Completed)
            }
            Endpoint::Kswitcher(peer) => {
                let TransferSource::Kswitcher {
                    path,
                    folder,
                    modified,
                    ..
                } = &self.request.source
                else {
                    return Err("Choose a KSwitcher LAN source.".to_owned());
                };
                if self.request.moving {
                    let capabilities = tauri::async_runtime::block_on(
                        self.transfer
                            .interrupt(crate::kswitcher_lan::capabilities(peer)),
                    )?;
                    if !capabilities.delete {
                        return Err(
                            "Grant the required file permission in Trusted clients.".to_owned()
                        );
                    }
                }
                if *folder {
                    download_kswitcher_tree(peer, path, &staged, self.transfer, progress)?;
                } else {
                    let mut file = fs::File::create_new(&staged).map_err(message)?;
                    tauri::async_runtime::block_on(self.transfer.interrupt(
                        crate::kswitcher_lan::download(peer, path, &mut file, |bytes, total| {
                            progress(Path::new(name), bytes, total)
                        }),
                    ))?;
                    finish_downloaded_file(&file, *modified).map_err(message)?;
                }
                let mut originals = Vec::new();
                if self.request.moving {
                    let mut staged_items = Vec::new();
                    collect_local_move(&staged, &[], self.transfer, &mut staged_items)?;
                    for item in staged_items {
                        let remote_path = join_kswitcher_path(path, &item.target);
                        let stamp = kswitcher_entry(peer, &remote_path, self.transfer)?;
                        if stamp.link
                            || stamp.directory != matches!(item.original, LocalOriginal::Folder(_))
                        {
                            return Err(
                                "The KSwitcher LAN item changed during the move.".to_owned()
                            );
                        }
                        originals.push((item.path, remote_path, stamp));
                    }
                }
                let Some(destination) = publish(progress, ask)? else {
                    return Ok(TransferOutcome::Skipped);
                };
                for (local, remote, stamp) in originals {
                    let cleanup = (|| {
                        check_kswitcher_stamp(peer, &remote, &stamp, self.transfer)?;
                        if !stamp.directory {
                            verify_kswitcher_copy(peer, &remote, &local, self.transfer)?;
                            check_kswitcher_stamp(peer, &remote, &stamp, self.transfer)?;
                        }
                        tauri::async_runtime::block_on(self.transfer.interrupt(
                            crate::kswitcher_lan::change(
                                peer,
                                &remote,
                                crate::kswitcher_lan::Change::Delete { recursive: false },
                            ),
                        ))
                    })();
                    if let Err(error) = cleanup {
                        return Ok(TransferOutcome::SourceRetained {
                            source: path.clone(),
                            destination,
                            error,
                        });
                    }
                }
                Ok(TransferOutcome::Completed)
            }
        }
    }

    fn publish<S: VerifiedUpload>(
        &self,
        session: &mut S,
        source: &[String],
        staged: &Path,
        (same_host, different_protocol): (bool, bool),
        progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
        ask: &mut impl FnMut(local_transfer::Conflict) -> io::Result<local_transfer::Decision>,
    ) -> Result<Option<String>> {
        let name = source.last().ok_or("Choose a remote file or folder.")?;
        let target = remote_transfer::upload_destination(
            session,
            &self.request.destination,
            name,
            self.request.multiple,
        )?;
        let within = |base: &[String], path: &[String]| {
            base.len() <= path.len()
                && base
                    .iter()
                    .zip(path)
                    .all(|(left, right)| left.eq_ignore_ascii_case(right))
        };
        if same_host && (within(source, &target) || within(&target, source)) {
            return Err("Choose a remote destination that does not overlap the source.".to_owned());
        }
        // Two protocols can expose the same host folder under different roots.
        // Keep cross-protocol moves from overwriting an entry whose identity cannot be compared across the connections.
        if same_host
            && different_protocol
            && self.request.moving
            && session.stat(&target)?.is_some()
        {
            return if self.request.policy == local_transfer::Policy::Skip {
                Ok(None)
            } else {
                Err(
                    "Choose an unused destination for a move between protocols on the same host."
                        .to_owned(),
                )
            };
        }
        if !remote_transfer::upload(
            session,
            staged,
            &target,
            self.request.policy,
            progress,
            ask,
            &mut |_, _| {},
        )? {
            return Ok(None);
        }
        if self.request.moving {
            let mut staged_items = Vec::new();
            collect_local_move(staged, &target, self.transfer, &mut staged_items)?;
            for item in staged_items {
                if matches!(item.original, LocalOriginal::File(_)) {
                    let mut input = fs::File::open(item.path).map_err(message)?;
                    session.verify_uploaded(&item.target, &mut input, self.transfer)?;
                }
            }
        }
        Ok(Some(format!("/{}", target.join("/"))))
    }

    fn publish_archive(
        &self,
        archive: &Mutex<crate::archives::Archive>,
        name: &str,
        staged: &Path,
        progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
        ask: impl FnMut(local_transfer::Conflict) -> io::Result<local_transfer::Decision>,
    ) -> Result<Option<String>> {
        let target = self
            .request
            .archive_destination
            .as_ref()
            .ok_or("Choose a destination archive.")?;
        let copied = archive.lock().map_err(message)?.copy_into(
            &target.segments,
            &[(staged.to_owned(), name.to_owned())],
            self.request.policy,
            progress,
            ask,
        )?;
        Ok((copied.first() == Some(&true))
            .then(|| format!("{}/{name}", self.request.destination.trim_end_matches('/'))))
    }

    fn publish_kswitcher(&self, peer: &str, name: &str, staged: &Path) -> Result<Option<String>> {
        let directory = staged
            .parent()
            .and_then(|path| path.to_str())
            .ok_or("Choose a local source folder.")?;
        let request = TransferRequest {
            source: TransferSource::Local {
                directory: directory.to_owned(),
                name: name.to_owned(),
            },
            destination: self.request.destination.clone(),
            ftp_destination: None,
            ssh_destination: None,
            server_destination: None,
            archive_destination: None,
            kswitcher_destination: Some(peer.to_owned()),
            kswitcher_broker: true,
            multiple: self.request.multiple,
            moving: false,
            policy: self.request.policy,
            ask_read_only: self.request.ask_read_only,
            retry: false,
            copy_options: Default::default(),
        };
        let (result, target) = tauri::async_runtime::block_on(
            self.transfer
                .interrupt(transfer_kswitcher(&request, self.transfer, self.output)),
        )?;
        match result {
            TransferOutcome::Skipped => return Ok(None),
            TransferOutcome::SourceRetained { error, .. } => return Err(error),
            TransferOutcome::Completed => {}
        }
        let target = target.to_str().ok_or("Choose an absolute destination.")?;
        if self.request.moving {
            let mut staged_items = Vec::new();
            collect_local_move(staged, &[], self.transfer, &mut staged_items)?;
            for item in staged_items {
                if matches!(item.original, LocalOriginal::File(_)) {
                    verify_kswitcher_copy(
                        peer,
                        &join_kswitcher_path(target, &item.target),
                        &item.path,
                        self.transfer,
                    )?;
                }
            }
        }
        Ok(Some(target.to_owned()))
    }
}

fn join_kswitcher_path(root: &str, names: &[String]) -> String {
    if names.is_empty() {
        root.to_owned()
    } else {
        format!(
            "{}\\{}",
            root.trim_end_matches(['/', '\\']),
            names.join("\\")
        )
    }
}

fn kswitcher_entry(peer: &str, path: &str, transfer: &TransferSession) -> Result<local::Entry> {
    let name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Choose a KSwitcher LAN item.")?;
    let parent = Path::new(path)
        .parent()
        .and_then(|parent| parent.to_str())
        .ok_or("Choose a KSwitcher LAN folder.")?;
    tauri::async_runtime::block_on(transfer.interrupt(crate::kswitcher_lan::list(peer, parent)))?
        .entries
        .into_iter()
        .find(|entry| entry.name.eq_ignore_ascii_case(name))
        .ok_or_else(|| "The KSwitcher LAN item changed during the move.".to_owned())
}

fn check_kswitcher_stamp(
    peer: &str,
    path: &str,
    stamp: &local::Entry,
    transfer: &TransferSession,
) -> Result<()> {
    let current = kswitcher_entry(peer, path, transfer)?;
    if current.link
        || current.directory != stamp.directory
        || !stamp.directory && (current.size != stamp.size || current.modified != stamp.modified)
    {
        return Err("The KSwitcher LAN item changed during the move.".to_owned());
    }
    Ok(())
}

fn verify_kswitcher_copy(
    peer: &str,
    path: &str,
    local: &Path,
    transfer: &TransferSession,
) -> Result<()> {
    use io::{Seek, SeekFrom};
    let mut remote = tempfile::tempfile().map_err(message)?;
    tauri::async_runtime::block_on(transfer.interrupt(crate::kswitcher_lan::download(
        peer,
        path,
        &mut remote,
        |_, _| transfer.ensure_running(),
    )))?;
    remote.seek(SeekFrom::Start(0)).map_err(message)?;
    let sent = crate::protocol::lan_file_digest(fs::File::open(local).map_err(message)?, || {
        transfer.ensure_running()
    })
    .map_err(message)?;
    let received =
        crate::protocol::lan_file_digest(remote, || transfer.ensure_running()).map_err(message)?;
    if sent != received {
        return Err("The KSwitcher LAN item differs from the verified copy.".to_owned());
    }
    Ok(())
}

fn stage<S: remote_transfer::DownloadSession>(
    source: &mut S,
    segments: &[String],
    staged: &Path,
    progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
) -> Result<()> {
    if !remote_transfer::download(
        source,
        segments,
        staged,
        &stage_options(),
        progress,
        |_| Ok(local_transfer::Decision::Skip),
        |_, _| {},
    )? {
        return Err("Could not stage the complete remote item.".to_owned());
    }
    Ok(())
}

fn stage_options() -> local_transfer::Options {
    local_transfer::Options {
        moving: false,
        policy: local_transfer::Policy::Skip,
        ask_read_only: true,
        copy: local::CopyOptions::default(),
    }
}

#[cfg(test)]
#[test]
fn relay_moves_across_ftp_archive_and_dirlume_server() {
    use crate::{archive_engine, archives::Archive};
    use local_transfer::{Decision, Policy};
    let (Ok(invitation), Ok(port), Some(ftp_root)) = (
        std::env::var("DIRLUME_SERVER_TRANSFER_TEST_INVITATION"),
        std::env::var("DIRLUME_FTP_MOVE_TEST_PORT"),
        std::env::var_os("DIRLUME_FTP_MOVE_TEST_ROOT"),
    ) else {
        return;
    };
    let ftp = crate::ftp::move_test_connection(port.parse().unwrap());
    let ftp_root = Path::new(&ftp_root);
    let original = ftp_root.join("through-sources/nested/note.txt");
    fs::create_dir_all(original.parent().unwrap()).unwrap();
    fs::write(&original, b"cross-provider content").unwrap();
    let server = Connection::connect(&invitation).unwrap();
    let folder = tempfile::tempdir().unwrap();
    fs::create_dir(folder.path().join("inbox")).unwrap();
    let path = folder.path().join("fixture.zip");
    let engine = archive_engine::Engine::find().unwrap();
    let list = archive_engine::list_file(folder.path(), ["inbox"]).unwrap();
    let mut command = engine.command("a");
    command
        .current_dir(folder.path())
        .arg("-tzip")
        .arg(archive_engine::at("-i@", &list));
    archive_engine::archive_args(&mut command, &path);
    archive_engine::run(&mut command, None, io::sink(), |_| Ok(()))
        .unwrap()
        .checked(false)
        .unwrap();
    let archive = Mutex::new(Archive::open(engine, path, None).unwrap());
    let transfer = Arc::new(TransferSession::default());
    let output = Channel::new(|_| Ok(()));
    let run = |from, source, segments: &[String], target, name: &str, archive_destination| {
        let request = TransferRequest {
            source,
            destination: name.to_owned(),
            ftp_destination: None,
            ssh_destination: None,
            server_destination: None,
            archive_destination,
            kswitcher_destination: None,
            kswitcher_broker: false,
            multiple: false,
            moving: true,
            policy: Policy::Ask,
            ask_read_only: true,
            retry: false,
            copy_options: Default::default(),
        };
        Relay {
            request: &request,
            transfer: &transfer,
            output: &output,
        }
        .run(from, segments, target, &mut |_, _, _| Ok(()), &mut |_| {
            Ok(Decision::Skip)
        })
        .unwrap()
    };
    let item = ["through-sources".to_owned()];
    let inbox = ["inbox".to_owned()];
    assert!(matches!(
        run(
            Endpoint::Ftp(&ftp),
            TransferSource::Ftp {
                connection: 0,
                segments: item.to_vec()
            },
            &item,
            Endpoint::Archive(&archive),
            "fixture.zip!/inbox",
            Some(super::ArchiveDestination {
                id: 0,
                segments: inbox.to_vec()
            }),
        ),
        TransferOutcome::Completed
    ));
    assert!(!original.exists());
    let archive_item = [inbox.as_slice(), item.as_slice()].concat();
    assert!(matches!(
        run(
            Endpoint::Archive(&archive),
            TransferSource::Archive {
                archive: 0,
                segments: archive_item.clone()
            },
            &archive_item,
            Endpoint::Server(&server),
            "/stored",
            None,
        ),
        TransferOutcome::Completed
    ));
    assert!(archive.lock().unwrap().list(&archive_item).is_err());
    let served = ["stored".to_owned()];
    assert!(matches!(
        run(
            Endpoint::Server(&server),
            TransferSource::Server {
                connection: 0,
                segments: served.to_vec(),
                writable_server: true,
                folder: true,
                modified: None,
            },
            &served,
            Endpoint::Ftp(&ftp),
            "/returned",
            None,
        ),
        TransferOutcome::Completed
    ));
    assert_eq!(
        fs::read(ftp_root.join("returned/nested/note.txt")).unwrap(),
        b"cross-provider content"
    );
    assert!(tauri::async_runtime::block_on(server.list(served.to_vec())).is_err());
}

#[cfg(test)]
pub(crate) fn verify_file_server_relays(
    ftp: &ftp::Connection,
    ssh: &Arc<ssh::Connection>,
    ftp_root: &Path,
) {
    use local_transfer::{Decision, Policy};
    use remote_transfer::Session;

    let ftp_item = ["relay-input".to_owned()];
    let ssh_home = ["home".to_owned(), "dirlume-fixture".to_owned()];
    let ssh_item = remote_transfer::child(&ssh_home, &ftp_item[0]);
    let original = ftp_root.join("relay-input/nested/note.txt");
    fs::create_dir_all(original.parent().unwrap()).unwrap();
    fs::write(&original, b"verified relay").unwrap();
    let transfer = Arc::new(TransferSession::default());
    let output = Channel::<TransferEvent>::new(|_| Ok(()));
    let run = |source, segments: &[String], target, destination: &str, moving, policy| {
        let request = TransferRequest {
            source: TransferSource::Ftp {
                connection: 0,
                segments: Vec::new(),
            },
            destination: destination.to_owned(),
            ftp_destination: None,
            ssh_destination: None,
            server_destination: None,
            archive_destination: None,
            kswitcher_destination: None,
            kswitcher_broker: false,
            multiple: false,
            moving,
            policy,
            ask_read_only: true,
            retry: false,
            copy_options: Default::default(),
        };
        Relay {
            request: &request,
            transfer: &transfer,
            output: &output,
        }
        .run(source, segments, target, &mut |_, _, _| Ok(()), &mut |_| {
            Ok(Decision::Skip)
        })
        .unwrap()
    };
    let to_ftp = Endpoint::Ftp(ftp);
    let to_ssh = Endpoint::Ssh(ssh);
    assert!(matches!(
        run(
            to_ftp,
            &ftp_item,
            to_ssh,
            "/home/dirlume-fixture",
            false,
            Policy::Ask
        ),
        TransferOutcome::Completed
    ));
    assert!(original.exists());
    let mut ssh_session = ssh_transfer::SshTransfer::open(ssh, true, &transfer, &output).unwrap();
    let remote_file = [
        ssh_item.as_slice(),
        &["nested".to_owned(), "note.txt".to_owned()],
    ]
    .concat();
    assert!(ssh_session.stat(&remote_file).unwrap().is_some());
    assert!(matches!(
        run(
            Endpoint::Ftp(ftp),
            &ftp_item,
            Endpoint::Ssh(ssh),
            "/home/dirlume-fixture",
            true,
            Policy::Skip
        ),
        TransferOutcome::Skipped,
    ));
    assert!(original.exists());
    assert!(matches!(
        run(
            Endpoint::Ssh(ssh),
            &ssh_item,
            Endpoint::Ftp(ftp),
            "/relayed-back",
            true,
            Policy::Ask
        ),
        TransferOutcome::Completed,
    ));
    assert!(ssh_session.stat(&ssh_item).unwrap().is_none());
    assert_eq!(
        fs::read(ftp_root.join("relayed-back/nested/note.txt")).unwrap(),
        b"verified relay"
    );
}
