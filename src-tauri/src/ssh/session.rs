use std::{
    io::{Read, SeekFrom, Write},
    sync::Arc,
    time::SystemTime,
};

use futures_util::StreamExt;
use openssh_sftp_client::{
    error::SftpErrorKind,
    metadata::{FileType, MetaData, MetaDataBuilder, Permissions},
    Error, Sftp,
};
use tokio::io::AsyncSeekExt;
use uuid::Uuid;

use super::{AuthenticatedRoute, SftpFailure, SftpResult};

use crate::{
    desktop::{message, Result},
    local,
    protocol::RemoteListing,
    remote_transfer::{self, DownloadSession as _, Entry as _, Session as _, UploadSession as _},
};

fn wait<T, E: Into<SftpFailure>>(
    operation: impl std::future::Future<Output = std::result::Result<T, E>>,
) -> SftpResult<T> {
    tauri::async_runtime::block_on(async {
        tokio::time::timeout(super::TIMEOUT, operation)
            .await
            .map_err(|_| {
                SftpFailure::ConnectionLost("The SSH server did not respond in time.".to_owned())
            })?
            .map_err(Into::into)
    })
}

const CHUNK: u32 = 32 * 1024;
const MAX_DEPTH: usize = 128;

pub struct Session {
    sftp: Sftp,
    client: Arc<AuthenticatedRoute>,
    preserve_download_timestamps: bool,
}

#[derive(Debug)]
pub struct Entry {
    name: String,
    kind: Option<FileType>,
    size: Option<u64>,
    modified: Option<SystemTime>,
    accessed: Option<u64>,
    permissions: Option<Permissions>,
    uid: Option<u32>,
    gid: Option<u32>,
}

impl PartialEq for Entry {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name && self.revision() == other.revision()
    }
}

impl Entry {
    pub(crate) fn revision(&self) -> impl PartialEq + std::fmt::Debug + '_ {
        (
            self.kind,
            self.size,
            self.modified,
            self.permissions,
            self.uid,
            self.gid,
        )
    }

    fn new(name: String, metadata: MetaData) -> Self {
        Self {
            name,
            kind: metadata.file_type(),
            size: metadata.len(),
            modified: metadata.modified().map(|time| time.as_system_time()),
            accessed: metadata.accessed().and_then(|time| {
                time.as_system_time()
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()
                    .map(|value| value.as_secs())
            }),
            permissions: metadata.permissions(),
            uid: metadata.uid(),
            gid: metadata.gid(),
        }
    }
}

impl remote_transfer::Entry for Entry {
    fn name(&self) -> &str {
        &self.name
    }
    fn is_directory(&self) -> bool {
        self.kind.is_some_and(|kind| kind.is_dir())
    }
    fn is_file(&self) -> bool {
        self.kind.is_some_and(|kind| kind.is_file())
    }
    fn size(&self) -> Option<u64> {
        self.size
    }
    fn modified(&self) -> Option<SystemTime> {
        self.modified
    }
}

fn publish_with_link(overwrite: bool, posix: bool, hardlink: bool) -> Result<bool> {
    if overwrite && !posix {
        return Err("This SSH server does not support safe file replacement.".into());
    }
    if !overwrite && posix && !hardlink {
        return Err(
            "This SSH server cannot publish a new file without replacing an existing name."
                .to_owned(),
        );
    }
    Ok(!overwrite && hardlink)
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && !matches!(name, "." | "..") && !name.contains(['/', '\\', '\0'])
}

impl Session {
    pub(crate) fn verify_uploaded_contents(
        &mut self,
        segments: &[String],
        input: &mut impl Read,
        mut check: impl FnMut() -> Result<()>,
    ) -> Result<()> {
        let changed = "The uploaded SSH file changed. The local source was kept.";
        let original = self.stat(segments)?.filter(Entry::is_file).ok_or(changed)?;
        let mut file = wait(self.sftp.open(Self::absolute(segments)?))?;
        let result = (|| {
            let mut buffer = Default::default();
            let mut local = vec![0; CHUNK as usize];
            while let Some(mut data) = wait(file.read(CHUNK, buffer))? {
                check()?;
                if data.is_empty() || data.len() > local.len() {
                    return Err("The SSH server returned an invalid data packet.".to_owned());
                }
                let bytes = &mut local[..data.len()];
                if let Err(error) = input.read_exact(bytes) {
                    return Err(if error.kind() == std::io::ErrorKind::UnexpectedEof {
                        changed.to_owned()
                    } else {
                        message(error)
                    });
                }
                if bytes != data.as_ref() {
                    return Err(changed.to_owned());
                }
                data.clear();
                buffer = data;
            }
            if input.read(&mut local[..1]).map_err(message)? != 0 {
                return Err(changed.to_owned());
            }
            Ok(())
        })();
        let closed = wait(file.close());
        result.and(closed.map_err(Into::into))?;
        if self.stat(segments)?.as_ref() != Some(&original) {
            return Err(changed.to_owned());
        }
        Ok(())
    }

    pub(super) fn new(client: AuthenticatedRoute, sftp: Sftp) -> Self {
        Self {
            client: Arc::new(client),
            sftp,
            preserve_download_timestamps: true,
        }
    }

    pub(super) fn with_download_timestamps(mut self, preserve: bool) -> Self {
        self.preserve_download_timestamps = preserve;
        self
    }

    pub(super) fn completion_client(&self) -> Arc<AuthenticatedRoute> {
        Arc::clone(&self.client)
    }

    pub(super) fn is_closed(&self) -> bool {
        self.client.is_closed()
    }

    pub(super) fn initial_directory(&self) -> Result<Vec<String>> {
        let home = wait(self.sftp.fs().canonicalize("."))?;
        Self::parse_path(
            home.to_str()
                .ok_or("The SSH server returned an invalid initial directory.")?,
        )
    }

    fn entries(&self, segments: &[String]) -> SftpResult<(Vec<Entry>, usize)> {
        let directory = wait(self.sftp.fs().open_dir(Self::absolute(segments)?))?;
        let mut stream = Box::pin(directory.clone().read_dir());
        let mut entries = Vec::new();
        let mut omitted = 0;
        let result = (|| {
            while let Some(entry) = wait(async { stream.next().await.transpose() })? {
                match entry.filename().as_os_str().to_str() {
                    Some("." | "..") => {}
                    Some(name) if valid_name(name) => {
                        entries.push(Entry::new(name.to_owned(), entry.metadata()))
                    }
                    _ => omitted += 1,
                }
            }
            Ok((entries, omitted))
        })();
        drop(stream);
        let closed = wait(directory.close());
        result.and_then(|entries| closed.map(|()| entries))
    }

    pub(super) fn listing(&self, segments: &[String]) -> SftpResult<RemoteListing> {
        self.listing_with_links(segments, false)
    }

    pub(super) fn list_profile_directory(
        &self,
        segments: &[String],
        resolve_links: bool,
    ) -> SftpResult<(Vec<String>, RemoteListing)> {
        let canonical = if resolve_links {
            let path = wait(self.sftp.fs().canonicalize(Self::absolute(segments)?))?;
            Self::parse_path(
                path.to_str()
                    .ok_or("The SSH server returned an invalid directory path.")?,
            )?
        } else {
            segments.to_vec()
        };
        let listing = self.listing_with_links(&canonical, resolve_links)?;
        Ok((canonical, listing))
    }

    fn listing_with_links(
        &self,
        segments: &[String],
        resolve_links: bool,
    ) -> SftpResult<RemoteListing> {
        let (entries, omitted) = self.entries(segments)?;
        let entries = entries
            .into_iter()
            .map(|entry| {
                let mut directory = entry.is_directory();
                let link = entry.kind.is_some_and(|kind| kind.is_symlink());
                if resolve_links && link {
                    let path = Self::absolute(&remote_transfer::child(segments, &entry.name))?;
                    match wait(self.sftp.fs().metadata(path)) {
                        Ok(metadata) => {
                            directory = metadata.file_type().is_some_and(|kind| kind.is_dir())
                        }
                        Err(error @ SftpFailure::ConnectionLost(_)) => return Err(error),
                        // A dangling, cyclic, or inaccessible target remains a link without folder navigation.
                        Err(_) => {}
                    }
                }
                let mut result = local::Entry::new(
                    entry.name,
                    directory,
                    link,
                    local::EntryAttributes::default(),
                    entry.size,
                    entry.modified,
                );
                result.owner = entry.uid.map(|uid| uid.to_string());
                result.accessed = entry.accessed;
                Ok(result)
            })
            .collect::<SftpResult<_>>()?;
        Ok(RemoteListing { entries, omitted })
    }

    pub fn regular(&mut self, segments: &[String]) -> SftpResult<Entry> {
        self.stat_entry(segments)?
            .filter(Entry::is_file)
            .ok_or_else(|| "Choose a regular SSH file.".into())
    }

    pub fn remove(&mut self, segments: &[String], recursive: bool) -> Result<()> {
        let entry = self
            .stat(segments)?
            .ok_or("The SSH item no longer exists.")?;
        let path = Self::absolute(segments)?;
        if entry.is_directory() {
            if recursive {
                for child in self.children(segments)? {
                    self.remove(&remote_transfer::child(segments, child.name()), true)?;
                }
            }
            wait(self.sftp.fs().remove_dir(path)).map_err(Into::into)
        } else {
            wait(self.sftp.fs().remove_file(path)).map_err(Into::into)
        }
    }

    pub fn read_limited(
        &mut self,
        segments: &[String],
        offset: u64,
        length: u64,
    ) -> SftpResult<Vec<u8>> {
        let mut file = wait(self.sftp.open(Self::absolute(segments)?))?;
        let result = (|| {
            wait(file.seek(SeekFrom::Start(offset)))?;
            let mut bytes = Vec::new();
            let mut remaining = length;
            while remaining > 0 {
                let data = wait(file.read(remaining.min(CHUNK.into()) as u32, Default::default()))?
                    .filter(|data| !data.is_empty())
                    .ok_or("The SSH file changed during the read.")?;
                remaining = remaining
                    .checked_sub(data.len() as u64)
                    .ok_or("The SSH server returned too much file data.")?;
                bytes.extend_from_slice(&data);
            }
            Ok(bytes)
        })();
        let closed = wait(file.close());
        result.and_then(|bytes| closed.map(|()| bytes))
    }

    pub fn replace_text(
        &mut self,
        segments: &[String],
        original: &Entry,
        bytes: &[u8],
        revalidate: impl FnOnce(&mut Self) -> SftpResult<()>,
    ) -> SftpResult<()> {
        let target = Self::absolute(segments)?;
        let permissions = original
            .permissions
            .ok_or("The SSH server did not report the file permissions.")?;
        if permissions.suid() || permissions.sgid() || permissions.svtx() {
            return Err(
                "Edit this SSH file on the server to preserve its special permissions.".into(),
            );
        }
        if !self.sftp.support_posix_rename() {
            return Err("This SSH server does not support safe file replacement.".into());
        }
        // Confirm write access to the original file without truncating it.
        let writable = wait(self.sftp.options().write(true).open(&target))?;
        wait(writable.close())?;
        let (_, parent) = segments.split_last().ok_or("Choose a regular SSH file.")?;
        let directory =
            remote_transfer::child(parent, &format!(".dirlume-{}.edit", Uuid::new_v4()));
        let directory_path = Self::absolute(&directory)?;
        wait(
            self.sftp
                .fs()
                .dir_builder()
                .permissions(Permissions::from(0o700))
                .create(&directory_path),
        )?;
        let result = (|| {
            let mut content = bytes;
            let staged = self.stage_upload(
                &remote_transfer::child(&directory, "text"),
                &mut content,
                |_| Ok(()),
            )?;
            let result = (|| {
                let metadata = wait(self.sftp.fs().symlink_metadata(&staged))?;
                let mut attributes = MetaDataBuilder::new();
                if (metadata.uid(), metadata.gid()) != (original.uid, original.gid) {
                    let owner = original
                        .uid
                        .zip(original.gid)
                        .ok_or("The SSH file ownership could not be preserved.")?;
                    attributes.id(owner);
                }
                attributes.permissions(permissions);
                wait(self.sftp.fs().set_metadata(&staged, attributes.create()))?;
                revalidate(self)?;
                self.publish_stage(&staged, segments, true)
            })();
            if result.is_err() {
                self.remove_stage(&staged);
            }
            result
        })();
        let _ = wait(self.sftp.fs().remove_dir(directory_path));
        result
    }
}

impl remote_transfer::Session for Session {
    const SOURCE: &'static str = "SSH";
    type Entry = Entry;

    fn stat(&mut self, segments: &[String]) -> Result<Option<Entry>> {
        self.stat_entry(segments).map_err(Into::into)
    }
}
impl Session {
    fn stat_entry(&self, segments: &[String]) -> SftpResult<Option<Entry>> {
        let name = segments.last().ok_or("Choose an SSH file or folder.")?;
        let path = Self::absolute(segments)?;
        wait(async {
            match self.sftp.fs().symlink_metadata(path).await {
                Ok(metadata) => Ok(Some(Entry::new(name.clone(), metadata))),
                Err(Error::SftpError(SftpErrorKind::NoSuchFile, _)) => Ok(None),
                Err(error) => Err(error),
            }
        })
    }
}

impl remote_transfer::DownloadSession for Session {
    fn preserve_download_timestamps(&self) -> bool {
        self.preserve_download_timestamps
    }
    fn children(&mut self, segments: &[String]) -> Result<Vec<Entry>> {
        let (entries, omitted) = self.entries(segments)?;
        if omitted != 0 {
            return Err("The SSH server returned filenames that could not be read.".to_owned());
        }
        Ok(entries)
    }

    fn download(
        &mut self,
        segments: &[String],
        output: &mut std::fs::File,
        mut progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<()> {
        let mut file = wait(self.sftp.open(Self::absolute(segments)?))?;
        let result = (|| {
            let mut buffer = Default::default();
            let mut total = 0;
            while let Some(mut data) = wait(file.read(CHUNK, buffer))? {
                if data.is_empty() {
                    return Err("The SSH server returned an empty data packet.".to_owned());
                }
                output.write_all(&data).map_err(message)?;
                total += data.len() as u64;
                progress(total)?;
                data.clear();
                buffer = data;
            }
            Ok(())
        })();
        let closed = wait(file.close());
        result.and(closed.map_err(Into::into))
    }
}

impl remote_transfer::UploadSession for Session {
    fn absolute(segments: &[String]) -> Result<String> {
        if segments.len() > MAX_DEPTH || segments.iter().any(|name| !valid_name(name)) {
            return Err("Invalid SSH file or folder path.".to_owned());
        }
        Ok(format!("/{}", segments.join("/")))
    }

    fn parse_path(path: &str) -> Result<Vec<String>> {
        let path = path
            .strip_prefix('/')
            .ok_or("Enter an absolute SSH path starting with /.")?;
        let segments: Vec<_> = path
            .split('/')
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect();
        Self::absolute(&segments)?;
        Ok(segments)
    }

    fn check_publication(&self, overwrite: bool) -> Result<()> {
        publish_with_link(
            overwrite,
            self.sftp.support_posix_rename(),
            self.sftp.support_hardlink(),
        )
        .map(|_| ())
    }
    fn mkdir(&mut self, segments: &[String]) -> Result<()> {
        wait(self.sftp.fs().create_dir(Self::absolute(segments)?)).map_err(Into::into)
    }

    fn upload_to_stage(
        &mut self,
        target: &[String],
        input: &mut impl Read,
        progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<String> {
        self.stage_upload(target, input, progress)
            .map_err(Into::into)
    }
    fn remove_stage(&mut self, stage: &str) {
        let _ = wait(self.sftp.fs().remove_file(stage));
    }

    fn rename_stage(&mut self, stage: &str, target: &[String], overwrite: bool) -> Result<()> {
        self.publish_stage(stage, target, overwrite)
            .map_err(Into::into)
    }
}
impl Session {
    fn stage_upload(
        &mut self,
        target: &[String],
        input: &mut impl Read,
        mut progress: impl FnMut(u64) -> Result<()>,
    ) -> SftpResult<String> {
        let (_, parent) = target
            .split_last()
            .ok_or("Choose an SSH destination file.")?;
        let stage = Self::absolute(&remote_transfer::child(
            parent,
            &format!(".dirlume-{}.part", Uuid::new_v4()),
        ))?;
        let mut file = wait(
            self.sftp
                .options()
                .write(true)
                .create_new(true)
                .open(&stage),
        )?;
        let result = (|| {
            let mut total = 0;
            let mut buffer = vec![0; CHUNK as usize];
            loop {
                let count = input.read(&mut buffer).map_err(message)?;
                if count == 0 {
                    break;
                }
                wait(file.write_all(&buffer[..count]))?;
                total += count as u64;
                progress(total)?;
            }
            Ok(())
        })();
        let closed = wait(file.close());
        if let Err(error) = result.and(closed) {
            self.remove_stage(&stage);
            return Err(error);
        }
        Ok(stage)
    }

    fn publish_stage(&mut self, stage: &str, target: &[String], overwrite: bool) -> SftpResult<()> {
        let target = Self::absolute(target)?;
        if publish_with_link(
            overwrite,
            self.sftp.support_posix_rename(),
            self.sftp.support_hardlink(),
        )? {
            // The POSIX rename extension replaces existing names. Link the new file
            // instead so that an item created concurrently is preserved.
            wait(self.sftp.fs().hard_link(stage, &target))?;
            self.remove_stage(stage);
            return Ok(());
        }
        wait(self.sftp.fs().rename(stage, target))
    }
}

#[cfg(test)]
mod revision_tests {
    use super::*;
    #[test]
    fn selects_a_supported_publication_method_before_upload() {
        for posix in [false, true] {
            for hardlink in [false, true] {
                assert_eq!(
                    publish_with_link(true, posix, hardlink).ok(),
                    posix.then_some(false)
                );
                assert_eq!(
                    publish_with_link(false, posix, hardlink).ok(),
                    (!posix || hardlink).then_some(hardlink)
                );
            }
        }
    }
    #[test]
    fn reads_which_only_update_access_time_keep_the_same_revision() {
        let entry = |time, size| Entry {
            name: String::from("file"),
            kind: None,
            size: Some(size),
            modified: None,
            accessed: Some(time),
            permissions: None,
            uid: None,
            gid: None,
        };
        assert_eq!(entry(1, 3), entry(2, 3));
        assert_ne!(entry(2, 3), entry(2, 4));
    }
}
