use std::{fs, io, net::IpAddr, path::Path, sync::Arc};

use super::{
    collect_local_move, ftp, local, local_transfer, message, remote_transfer, ssh, ssh_transfer,
    Channel, LocalOriginal, Result, TransferEvent, TransferOutcome, TransferRequest,
    TransferSession, VerifiedUpload,
};

pub(super) enum Endpoint<'a> {
    Ftp(&'a ftp::Connection),
    Ssh(&'a Arc<ssh::Connection>),
}

impl Endpoint<'_> {
    fn host(&self) -> &str {
        match self {
            Self::Ftp(connection) => connection.host(),
            Self::Ssh(connection) => connection.host(),
        }
    }
}

pub(super) struct Relay<'a> {
    pub request: &'a TransferRequest,
    pub transfer: &'a TransferSession,
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
        let host = source.host().trim_end_matches('.');
        let other = destination.host().trim_end_matches('.');
        let localhost = |host: &str| {
            host.eq_ignore_ascii_case("localhost")
                || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
        };
        let same_host = host.eq_ignore_ascii_case(other) || localhost(host) && localhost(other);
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
                same_host,
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
                same_host,
                progress,
                ask,
            ),
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
                let Some(target) = publish(progress, ask)? else {
                    return Ok(TransferOutcome::Skipped);
                };
                if let Some(cleanup) = cleanup {
                    if let Err(error) =
                        cleanup.finish(&mut source, || self.transfer.ensure_running())
                    {
                        return Ok(TransferOutcome::SourceRetained {
                            source: format!("/{}", segments.join("/")),
                            destination: format!("/{}", target.join("/")),
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
                let Some(target) = publish(progress, ask)? else {
                    return Ok(TransferOutcome::Skipped);
                };
                Ok(cleanup.map_or(TransferOutcome::Completed, |cleanup| {
                    cleanup.finish(&mut source, segments, format!("/{}", target.join("/")))
                }))
            }
        }
    }

    fn publish<S: VerifiedUpload>(
        &self,
        session: &mut S,
        source: &[String],
        staged: &Path,
        same_host: bool,
        progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
        ask: &mut impl FnMut(local_transfer::Conflict) -> io::Result<local_transfer::Decision>,
    ) -> Result<Option<Vec<String>>> {
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
        Ok(Some(target))
    }
}

fn stage<S: remote_transfer::DownloadSession>(
    source: &mut S,
    segments: &[String],
    staged: &Path,
    progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
) -> Result<()> {
    let options = local_transfer::Options {
        moving: false,
        policy: local_transfer::Policy::Skip,
        ask_read_only: true,
        copy: local::CopyOptions::default(),
    };
    if !remote_transfer::download(
        source,
        segments,
        staged,
        &options,
        progress,
        |_| Ok(local_transfer::Decision::Skip),
        |_, _| {},
    )? {
        return Err("Could not stage the complete remote item.".to_owned());
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn verify_file_server_relays(
    ftp: &ftp::Connection,
    ssh: &Arc<ssh::Connection>,
    ftp_root: &Path,
) {
    use super::TransferSource;
    use local_transfer::{Decision, Policy};
    use remote_transfer::Session;

    let ftp_item = ["relay-input".to_owned()];
    let ssh_home = ["home".to_owned(), "dirlume-fixture".to_owned()];
    let ssh_item = remote_transfer::child(&ssh_home, &ftp_item[0]);
    let original = ftp_root.join("relay-input/nested/note.txt");
    fs::create_dir_all(original.parent().unwrap()).unwrap();
    fs::write(&original, b"verified relay").unwrap();
    let transfer = TransferSession::default();
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
