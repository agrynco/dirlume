use std::{fs, io, io::Read, ops::Deref, path::Path, time::SystemTime};

use ring::digest::Digest;

use crate::{
    ftp, message,
    remote_transfer::{DownloadSession, Entry, Session, UploadSession},
    text_pages, Result,
};

impl Entry for ftp::FtpEntry {
    fn name(&self) -> &str {
        self.deref().name()
    }
    fn is_directory(&self) -> bool {
        self.deref().is_directory()
    }
    fn is_file(&self) -> bool {
        self.deref().is_file()
    }
    fn size(&self) -> Option<u64> {
        Some(self.deref().size() as u64)
    }
    fn modified(&self) -> Option<SystemTime> {
        Some(self.corrected)
    }
}

impl Session for ftp::Session {
    const SOURCE: &'static str = "FTP";
    type Entry = ftp::FtpEntry;

    fn stat(&mut self, segments: &[String]) -> Result<Option<Self::Entry>> {
        self.stat(segments)
    }
}

impl DownloadSession for ftp::Session {
    fn preserve_download_timestamps(&self) -> bool {
        self.environment.preserve_download_timestamps
    }
    fn children(&mut self, segments: &[String]) -> Result<Vec<Self::Entry>> {
        self.list(segments)?.complete()
    }
    fn matches_file(&mut self, segments: &[String], expected: &Self::Entry) -> Result<bool> {
        self.matches_file(segments, expected)
    }
    fn download(
        &mut self,
        segments: &[String],
        output: &mut fs::File,
        progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<()> {
        self.download(segments, output, progress)
    }
}

impl UploadSession for ftp::Session {
    fn absolute(segments: &[String]) -> Result<String> {
        ftp::absolute(segments)
    }
    fn parse_path(path: &str) -> Result<Vec<String>> {
        ftp::parse_path(path)
    }
    fn check_publication(&self, _overwrite: bool) -> Result<()> {
        Ok(())
    }
    fn mkdir(&mut self, segments: &[String]) -> Result<()> {
        self.mkdir(segments)
    }
    fn upload_to_stage(
        &mut self,
        target: &[String],
        input: &mut (impl Read + std::io::Seek),
        progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<String> {
        self.upload_to_stage(target, input, progress)
    }
    fn remove_stage(&mut self, stage: &str) {
        self.remove_stage(stage);
    }
    fn rename_stage(&mut self, stage: &str, target: &[String], overwrite: bool) -> Result<()> {
        // FTP RNTO has no conditional variant. Check the destination again before publication.
        if self.stat(target)?.is_some() != overwrite {
            return Err("The FTP destination changed during the upload.".to_owned());
        }
        self.rename_stage(stage, target)
    }
}

pub(crate) fn file_digest(
    session: &mut ftp::Session,
    segments: &[String],
    mut check: impl FnMut() -> io::Result<()>,
) -> Result<Digest> {
    check().map_err(message)?;
    text_pages::hash(|writer| session.download(segments, writer, |_| check().map_err(message)))
}

pub(crate) fn local_digest(
    input: &mut fs::File,
    mut check: impl FnMut() -> io::Result<()>,
) -> Result<Digest> {
    text_pages::hash(|writer| {
        let mut buffer = [0; 64 * 1024];
        loop {
            check().map_err(message)?;
            let length = input.read(&mut buffer).map_err(message)?;
            if length == 0 {
                return Ok(());
            }
            writer.write_all(&buffer[..length]).map_err(message)?;
        }
    })
}

enum Original {
    Folder,
    File(ftp::FtpEntry, Digest),
}

pub(crate) struct MoveCleanup(Vec<(Vec<String>, Original)>);

impl MoveCleanup {
    pub(crate) fn capture(
        session: &mut ftp::Session,
        segments: &[String],
        staged: &Path,
        mut check: impl FnMut() -> io::Result<()>,
    ) -> Result<Self> {
        let mut cleanup = Self(Vec::new());
        cleanup.record(session, segments, staged, &mut check)?;
        Ok(cleanup)
    }

    fn record(
        &mut self,
        session: &mut ftp::Session,
        segments: &[String],
        staged: &Path,
        check: &mut impl FnMut() -> io::Result<()>,
    ) -> Result<()> {
        check().map_err(message)?;
        let original = if staged.is_dir() {
            for item in fs::read_dir(staged).map_err(message)? {
                let item = item.map_err(message)?;
                let name = item
                    .file_name()
                    .into_string()
                    .map_err(|_| "A filename cannot be represented as Unicode.")?;
                self.record(
                    session,
                    &crate::remote_transfer::child(segments, &name),
                    &item.path(),
                    check,
                )?;
            }
            Original::Folder
        } else {
            let expected = session.regular(segments)?;
            let digest = local_digest(&mut fs::File::open(staged).map_err(message)?, check)?;
            Original::File(expected, digest)
        };
        self.0.push((segments.to_vec(), original));
        Ok(())
    }

    pub(crate) fn finish(
        self,
        session: &mut ftp::Session,
        mut check: impl FnMut() -> io::Result<()>,
    ) -> Result<()> {
        for (segments, original) in self.0 {
            check().map_err(message)?;
            match original {
                Original::Folder => session.remove_empty_move_folder(&segments)?,
                Original::File(expected, digest) => {
                    let same = session.matches_file(&segments, &expected)?
                        && file_digest(session, &segments, &mut check)?.as_ref() == digest.as_ref();
                    check().map_err(message)?;
                    if !same {
                        return Err("The FTP file changed during the move.".to_owned());
                    }
                    session.remove_move_file(&segments, &expected)?;
                }
            }
        }
        Ok(())
    }
}
