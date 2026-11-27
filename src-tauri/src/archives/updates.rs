use std::{
    fs, io,
    path::{Path, PathBuf},
};

use crate::local_transfer::{Decision, Policy};
use crate::remote_transfer::{self, Session, UploadSession};

use super::*;

pub(crate) struct ArchiveMoveCopy(tempfile::TempDir);

impl ArchiveMoveCopy {
    pub(crate) fn verify_file(
        &self,
        target: &[String],
        source: fs::File,
        mut check: impl FnMut() -> io::Result<()>,
    ) -> Result<()> {
        let staged =
            fs::File::open(member_path(&self.0.path().join("update"), target)?).map_err(message)?;
        let source = crate::protocol::lan_file_digest(source, &mut check).map_err(message)?;
        let staged = crate::protocol::lan_file_digest(staged, &mut check).map_err(message)?;
        if source != staged {
            return Err("The local file differs from the archived copy.".to_owned());
        }
        Ok(())
    }
}

impl Archive {
    pub(super) fn can_add(&self) -> bool {
        self.writable && matches!(self.index.format.as_str(), "zip" | "7z")
    }

    fn require_folder(&self, segments: &[String]) -> Result<()> {
        self.verify()?;
        if !self.can_add() {
            return Err("Choose a writable ZIP or 7z archive.".to_owned());
        }
        if !segments.is_empty()
            && !self
                .index
                .members
                .get(segments)
                .is_some_and(|entry| entry.directory && !entry.link)
        {
            return Err("Choose a folder in the archive.".to_owned());
        }
        Ok(())
    }

    pub(crate) fn create_folder(
        &mut self,
        parent: &[String],
        name: &str,
        tick: impl FnMut(u8) -> io::Result<()>,
    ) -> Result<()> {
        self.create_member(parent, name, None, tick)
    }

    pub(crate) fn create_text(
        &mut self,
        parent: &[String],
        name: &str,
        encoding: Encoding,
        tick: impl FnMut(u8) -> io::Result<()>,
    ) -> Result<()> {
        self.create_member(parent, name, Some(&encode_text(encoding, "")), tick)
    }

    fn create_member(
        &mut self,
        parent: &[String],
        name: &str,
        data: Option<&[u8]>,
        mut tick: impl FnMut(u8) -> io::Result<()>,
    ) -> Result<()> {
        self.require_folder(parent)?;
        let target = checked_child(parent, name)?;
        if self.index.members.contains_key(&target) {
            return Err("An archive entry with that name already exists.".to_owned());
        }
        tick(0).map_err(message)?;
        let (workspace, staged) = self.stage_update()?;
        let root = workspace.path().join("update");
        let path = member_path(&root, &target)?;
        if let Some(data) = data {
            fs::create_dir_all(path.parent().ok_or("Choose a folder in the archive.")?)
                .map_err(message)?;
            fs::write(&path, data).map_err(message)?;
        } else {
            fs::create_dir_all(&path).map_err(message)?;
        }
        let mut writer = ArchiveUpload::new(self, root, workspace.path());
        writer.changes.insert(
            target,
            Change {
                directory: data.is_none(),
                size: data.map_or(0, |bytes| bytes.len() as u64),
            },
        );
        let index = writer.add_members(&staged, &mut tick)?;
        self.commit_update(&staged, index, || tick(100).map_err(message))
    }

    pub(crate) fn rename_entry(
        &mut self,
        target: &[String],
        name: &str,
        tick: impl FnMut(u8) -> io::Result<()>,
    ) -> Result<()> {
        let (_, parent) = target.split_last().ok_or("Choose an archive entry.")?;
        self.relocate_entry(target, parent, name, tick)
    }

    pub(crate) fn relocate_entry(
        &mut self,
        target: &[String],
        parent: &[String],
        name: &str,
        mut tick: impl FnMut(u8) -> io::Result<()>,
    ) -> Result<()> {
        self.require_folder(parent)?;
        let destination = checked_child(parent, name)?;
        let member = self
            .index
            .members
            .get(target)
            .ok_or("Choose an archive entry.")?;
        if destination == target {
            return Ok(());
        }
        if destination.starts_with(target) {
            return Err("Choose an archive destination outside the source folder.".to_owned());
        }
        if self.index.members.contains_key(&destination) {
            return Err("An archive entry with that name already exists.".to_owned());
        }
        if self
            .index
            .members
            .iter()
            .any(|(path, entry)| path.starts_with(target) && entry.link)
        {
            return Err("Choose archive entries without links.".to_owned());
        }
        tick(0).map_err(message)?;
        let (_workspace, staged) = self.stage_update()?;
        let mut command = self.engine.command("rn");
        command.args(["-spd", "-bso2", "-bse2", "-bsp2"]);
        archive_args(&mut command, &staged);
        command.arg(member.raw.clone().unwrap_or_else(|| target.join("/")));
        command.arg(destination.join("/"));
        archive_engine::run(&mut command, None, io::sink(), &mut tick)?.checked(false)?;
        let index = inspect(&self.engine, &staged, None)?;
        validate_index(self, &index)?;
        if self.index.members.iter().any(|(path, entry)| {
            if let Some(tail) = path.strip_prefix(target) {
                let moved = [destination.as_slice(), tail].concat();
                !index.members.get(&moved).is_some_and(|replacement| {
                    replacement.directory == entry.directory
                        && replacement.link == entry.link
                        && replacement.size == entry.size
                        && replacement.crc == entry.crc
                        && replacement.raw.is_some() == entry.raw.is_some()
                })
            } else {
                match index.members.get(path) {
                    Some(member) => member != entry,
                    None => entry.raw.is_some() || !target.starts_with(path),
                }
            }
        }) || index.members.keys().any(|path| {
            !self.index.members.contains_key(path)
                && !path
                    .strip_prefix(destination.as_slice())
                    .is_some_and(|tail| self.index.members.contains_key(&[target, tail].concat()))
        }) {
            return Err("The archive rename did not preserve the original entries.".to_owned());
        }
        self.commit_update(&staged, index, || tick(100).map_err(message))
    }

    pub(crate) fn copy_into(
        &mut self,
        parent: &[String],
        sources: &[(PathBuf, String)],
        policy: Policy,
        progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
        ask: impl FnMut(Conflict) -> io::Result<Decision>,
    ) -> Result<Vec<bool>> {
        self.copy_from_local(parent, sources, policy, progress, ask)
            .map(|(result, _)| result)
    }

    pub(crate) fn copy_for_move(
        &mut self,
        parent: &[String],
        source: (PathBuf, String),
        policy: Policy,
        progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
        ask: impl FnMut(Conflict) -> io::Result<Decision>,
    ) -> Result<Option<ArchiveMoveCopy>> {
        let (result, workspace) = self.copy_from_local(parent, &[source], policy, progress, ask)?;
        Ok(result
            .first()
            .copied()
            .unwrap_or_default()
            .then_some(ArchiveMoveCopy(workspace)))
    }

    fn copy_from_local(
        &mut self,
        parent: &[String],
        sources: &[(PathBuf, String)],
        policy: Policy,
        mut progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
        mut ask: impl FnMut(Conflict) -> io::Result<Decision>,
    ) -> Result<(Vec<bool>, tempfile::TempDir)> {
        self.require_folder(parent)?;
        if sources.is_empty() || !matches!(policy, Policy::Ask | Policy::Overwrite | Policy::Skip) {
            return Err("Choose local files and folders and a supported copy option.".to_owned());
        }
        progress(&self.path, 0, None).map_err(message)?;
        let (workspace, staged) = self.stage_update()?;
        let root = workspace.path().join("update");
        fs::create_dir(&root).map_err(message)?;
        let mut writer = ArchiveUpload::new(self, root, workspace.path());
        let mut results = Vec::with_capacity(sources.len());
        for (source, name) in sources {
            let target = checked_child(parent, name)?;
            let mut copy_progress = |path: &Path, bytes, total| {
                progress(path, bytes, total)?;
                if total.is_none() {
                    let metadata = fs::symlink_metadata(path)?;
                    if metadata.is_file() && same_file::is_same_file(path, &self.path)? {
                        return Err(io::Error::other("An archive cannot contain itself."));
                    }
                    if metadata.is_dir() && self.path.starts_with(path.canonicalize()?) {
                        return Err(io::Error::other(
                            "Choose a folder outside the destination archive's containing subtree.",
                        ));
                    }
                }
                Ok(())
            };
            results.push(remote_transfer::upload(
                &mut writer,
                source,
                &target,
                policy,
                &mut copy_progress,
                &mut ask,
                &mut |_, _| {},
            )?);
        }
        if !writer.changes.is_empty() {
            let index = writer.add_members(&staged, |_| progress(&self.path, 0, None))?;
            let path = self.path.clone();
            self.commit_update(&staged, index, || progress(&path, 0, None).map_err(message))?;
        }
        Ok((results, workspace))
    }
}

fn checked_child(parent: &[String], name: &str) -> Result<Vec<String>> {
    if name.contains(['\\', '\r', '\n']) {
        return Err("Enter a valid archive entry name.".to_owned());
    }
    local::name_component(name).map_err(message)?;
    Ok(remote_transfer::child(parent, name))
}

fn member_path(root: &Path, path: &[String]) -> Result<PathBuf> {
    let mut full = root.to_owned();
    for name in path {
        if name.contains(['\\', '\r', '\n']) {
            return Err("Enter a valid archive entry name.".to_owned());
        }
        full.push(local::name_component(name).map_err(message)?);
    }
    Ok(full)
}

fn validate_index(archive: &Archive, index: &Index) -> Result<()> {
    if index.omitted != 0 || index.encrypted || index.split || archive.index.format != index.format
    {
        return Err("7-Zip produced an unexpected archive index.".to_owned());
    }
    Ok(())
}

struct Change {
    directory: bool,
    size: u64,
}

struct ArchiveUpload<'a> {
    archive: &'a Archive,
    root: PathBuf,
    workspace: &'a Path,
    changes: BTreeMap<Vec<String>, Change>,
    pending_file: Option<tempfile::NamedTempFile>,
}

impl<'a> ArchiveUpload<'a> {
    fn new(archive: &'a Archive, root: PathBuf, workspace: &'a Path) -> Self {
        Self {
            archive,
            root,
            workspace,
            changes: BTreeMap::new(),
            pending_file: None,
        }
    }

    fn add_members(
        &self,
        staged: &Path,
        mut tick: impl FnMut(u8) -> io::Result<()>,
    ) -> Result<Index> {
        let list = archive_engine::list_file(
            self.workspace,
            self.changes
                .keys()
                .filter(|path| {
                    !(1..path.len()).any(|length| self.changes.contains_key(&path[..length]))
                })
                .map(|path| path.join("/")),
        )?;
        let mut command = self.archive.engine.command("a");
        command
            .current_dir(&self.root)
            .args(["-spd", "-bso2", "-bse2", "-bsp2", "-up1q1r2x2y2z2w2"])
            .arg(archive_engine::at("-i@", &list));
        archive_args(&mut command, staged);
        archive_engine::run(&mut command, None, io::sink(), &mut tick)?.checked(false)?;
        let mut test = self.archive.engine.command("t");
        test.args(["-bso2", "-bse2", "-bsp2"]);
        archive_args(&mut test, staged);
        archive_engine::run(&mut test, None, io::sink(), tick)?.checked(false)?;
        let index = inspect(&self.archive.engine, staged, None)?;
        validate_index(self.archive, &index)?;
        if self.archive.index.members.iter().any(|(path, old)| {
            !self.changes.contains_key(path) && index.members.get(path) != Some(old)
        }) || self.changes.iter().any(|(path, change)| {
            !index.members.get(path).is_some_and(|member| {
                member.directory == change.directory && !member.link && member.size == change.size
            })
        }) || index.members.keys().any(|path| {
            !self.changes.contains_key(path) && !self.archive.index.members.contains_key(path)
        }) {
            return Err("The updated archive does not contain the expected entries.".to_owned());
        }
        Ok(index)
    }
}

#[derive(PartialEq)]
struct DestinationEntry {
    name: String,
    directory: bool,
    link: bool,
    size: u64,
}

impl remote_transfer::Entry for DestinationEntry {
    fn name(&self) -> &str {
        &self.name
    }
    fn is_directory(&self) -> bool {
        self.directory && !self.link
    }
    fn is_file(&self) -> bool {
        !self.directory && !self.link
    }
    fn size(&self) -> Option<u64> {
        (!self.directory).then_some(self.size)
    }
    fn modified(&self) -> Option<std::time::SystemTime> {
        None
    }
}

impl Session for ArchiveUpload<'_> {
    const SOURCE: &'static str = "archive";
    type Entry = DestinationEntry;

    fn stat(&mut self, segments: &[String]) -> Result<Option<Self::Entry>> {
        let name = segments.last().ok_or("Choose an archive entry.")?.clone();
        member_path(&self.root, segments)?;
        if let Some(change) = self.changes.get(segments) {
            return Ok(Some(DestinationEntry {
                name,
                directory: change.directory,
                link: false,
                size: change.size,
            }));
        }
        Ok(self
            .archive
            .index
            .members
            .get(segments)
            .map(|member| DestinationEntry {
                name,
                directory: member.directory,
                link: member.link,
                size: member.size,
            }))
    }
}

impl UploadSession for ArchiveUpload<'_> {
    fn absolute(segments: &[String]) -> Result<String> {
        Ok(format!("/{}", segments.join("/")))
    }

    fn parse_path(path: &str) -> Result<Vec<String>> {
        if path == "/" {
            return Ok(Vec::new());
        }
        safe_segments(path.strip_prefix('/').unwrap_or(path))
            .ok_or_else(|| "Enter a valid archive folder.".to_owned())
    }

    fn check_publication(&self, _overwrite: bool) -> Result<()> {
        self.archive.verify()
    }

    fn mkdir(&mut self, segments: &[String]) -> Result<()> {
        fs::create_dir_all(member_path(&self.root, segments)?).map_err(message)?;
        self.changes.insert(
            segments.to_vec(),
            Change {
                directory: true,
                size: 0,
            },
        );
        Ok(())
    }

    fn upload_to_stage(
        &mut self,
        _target: &[String],
        input: &mut (impl Read + std::io::Seek),
        mut progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<String> {
        let mut pending = tempfile::NamedTempFile::new_in(self.workspace).map_err(message)?;
        let mut bytes = 0;
        let mut buffer = vec![0; 256 * 1024];
        loop {
            let count = input.read(&mut buffer).map_err(message)?;
            if count == 0 {
                break;
            }
            pending.write_all(&buffer[..count]).map_err(message)?;
            bytes += count as u64;
            progress(bytes)?;
        }
        self.pending_file = Some(pending);
        Ok(String::new())
    }

    fn remove_stage(&mut self, _stage: &str) {
        self.pending_file = None;
    }

    fn rename_stage(&mut self, _stage: &str, target: &[String], _overwrite: bool) -> Result<()> {
        let path = member_path(&self.root, target)?;
        fs::create_dir_all(path.parent().ok_or("Choose an archive folder.")?).map_err(message)?;
        let pending = self
            .pending_file
            .take()
            .ok_or("The staged file is missing.")?;
        let size = pending.as_file().metadata().map_err(message)?.len();
        pending.persist(path).map_err(message)?;
        self.changes.insert(
            target.to_vec(),
            Change {
                directory: false,
                size,
            },
        );
        Ok(())
    }
}
