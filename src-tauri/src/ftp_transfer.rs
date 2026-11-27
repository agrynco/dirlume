use std::{fs, io::Read, ops::Deref, time::SystemTime};

use crate::{
    ftp,
    remote_transfer::{DownloadSession, Entry, Session, UploadSession},
    Result,
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
