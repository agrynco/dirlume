use std::{
    io::{Read, SeekFrom, Write},
    time::SystemTime,
};

use futures_util::StreamExt;
use openssh_sftp_client::{
    error::SftpErrorKind,
    metadata::{FileType, MetaData, MetaDataBuilder, Permissions},
    Error, Sftp,
};
use russh::client::Handle;
use tokio::io::AsyncSeekExt;
use uuid::Uuid;

use super::{wait, VerifyHost};
use crate::{
    desktop::{message, Result},
    local,
    protocol::RemoteListing,
    remote_transfer::{self, Entry as _, Session as _},
};

const CHUNK: u32 = 32 * 1024;
const MAX_DEPTH: usize = 128;

pub struct Session {
    sftp: Sftp,
    client: Handle<VerifyHost>,
}

#[derive(Debug, PartialEq)]
pub struct Entry {
    name: String,
    kind: Option<FileType>,
    size: Option<u64>,
    modified: Option<SystemTime>,
    permissions: Option<Permissions>,
    uid: Option<u32>,
    gid: Option<u32>,
}

impl Entry {
    fn new(name: String, metadata: MetaData) -> Self {
        Self {
            name,
            kind: metadata.file_type(),
            size: metadata.len(),
            modified: metadata.modified().map(|time| time.as_system_time()),
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

fn valid_name(name: &str) -> bool {
    !name.is_empty() && !matches!(name, "." | "..") && !name.contains(['/', '\\', '\0'])
}

impl Session {
    pub(super) fn new(client: Handle<VerifyHost>, sftp: Sftp) -> Self {
        Self { client, sftp }
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

    fn entries(&self, segments: &[String]) -> Result<(Vec<Entry>, usize)> {
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

    pub(super) fn listing(&self, segments: &[String]) -> Result<RemoteListing> {
        let (entries, omitted) = self.entries(segments)?;
        let entries = entries
            .into_iter()
            .map(|entry| {
                let directory = entry.is_directory();
                let link = entry.kind.is_some_and(|kind| kind.is_symlink());
                let mut result = local::Entry::new(
                    entry.name,
                    directory,
                    link,
                    local::EntryAttributes::default(),
                    entry.size,
                    entry.modified,
                );
                result.owner = entry.uid.map(|uid| uid.to_string());
                result
            })
            .collect();
        Ok(RemoteListing { entries, omitted })
    }

    pub fn regular(&mut self, segments: &[String]) -> Result<Entry> {
        self.stat(segments)?
            .filter(Entry::is_file)
            .ok_or_else(|| "Choose a regular SSH file.".to_owned())
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
            wait(self.sftp.fs().remove_dir(path))
        } else {
            wait(self.sftp.fs().remove_file(path))
        }
    }

    pub fn read_limited(
        &mut self,
        segments: &[String],
        offset: u64,
        length: u64,
    ) -> Result<Vec<u8>> {
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
        revalidate: impl FnOnce(&mut Self) -> Result<()>,
    ) -> Result<()> {
        let target = Self::absolute(segments)?;
        let permissions = original
            .permissions
            .ok_or("The SSH server did not report the file permissions.")?;
        if permissions.suid() || permissions.sgid() || permissions.svtx() {
            return Err(
                "Edit this SSH file on the server to preserve its special permissions.".to_owned(),
            );
        }
        if !self.sftp.support_posix_rename() {
            return Err("This SSH server does not support safe file replacement.".to_owned());
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
            let staged = self.upload_to_stage(
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
                self.rename_stage(&staged, segments, true)
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

    fn stat(&mut self, segments: &[String]) -> Result<Option<Entry>> {
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

    fn children(&mut self, segments: &[String]) -> Result<Vec<Entry>> {
        let (entries, omitted) = self.entries(segments)?;
        if omitted != 0 {
            return Err("The SSH server returned filenames that could not be read.".to_owned());
        }
        Ok(entries)
    }

    fn mkdir(&mut self, segments: &[String]) -> Result<()> {
        wait(self.sftp.fs().create_dir(Self::absolute(segments)?))
    }

    fn download(
        &mut self,
        segments: &[String],
        output: &mut impl Write,
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
        result.and(closed)
    }

    fn upload_to_stage(
        &mut self,
        target: &[String],
        input: &mut impl Read,
        mut progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<String> {
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

    fn remove_stage(&mut self, stage: &str) {
        let _ = wait(self.sftp.fs().remove_file(stage));
    }

    fn rename_stage(&mut self, stage: &str, target: &[String], overwrite: bool) -> Result<()> {
        let target = Self::absolute(target)?;
        if overwrite {
            if !self.sftp.support_posix_rename() {
                return Err("This SSH server does not support safe file replacement.".to_owned());
            }
        } else if self.sftp.support_posix_rename() {
            // The POSIX rename extension replaces existing names. Link the new file
            // instead so that an item created concurrently is preserved.
            wait(self.sftp.fs().hard_link(stage, &target))?;
            self.remove_stage(stage);
            return Ok(());
        }
        wait(self.sftp.fs().rename(stage, target))
    }
}
