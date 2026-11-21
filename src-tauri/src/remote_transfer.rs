use std::{
    collections::HashMap,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    time::SystemTime,
};

use crate::local_transfer::{Conflict, Decision, Incoming, Options, PlannedTarget};
use crate::{local, local_transfer, message, Result};

pub trait Entry: PartialEq {
    fn name(&self) -> &str;
    fn is_directory(&self) -> bool;
    fn is_file(&self) -> bool;
    fn size(&self) -> Option<u64>;
    fn modified(&self) -> Option<SystemTime>;
}

pub trait Session {
    const SOURCE: &'static str;
    type Entry: Entry;

    fn stat(&mut self, segments: &[String]) -> Result<Option<Self::Entry>>;
}

pub trait DownloadSession: Session {
    fn children(&mut self, segments: &[String]) -> Result<Vec<Self::Entry>>;
    fn matches_file(&mut self, segments: &[String], expected: &Self::Entry) -> Result<bool> {
        Ok(self.stat(segments)?.as_ref() == Some(expected))
    }
    fn download(
        &mut self,
        segments: &[String],
        output: &mut fs::File,
        progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<()>;
}

pub trait UploadSession: Session {
    fn absolute(segments: &[String]) -> Result<String>;
    fn parse_path(path: &str) -> Result<Vec<String>>;
    fn check_publication(&self, overwrite: bool) -> Result<()>;
    fn mkdir(&mut self, segments: &[String]) -> Result<()>;
    fn upload_to_stage(
        &mut self,
        target: &[String],
        input: &mut impl Read,
        progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<String>;
    fn remove_stage(&mut self, stage: &str);
    fn rename_stage(&mut self, stage: &str, target: &[String], overwrite: bool) -> Result<()>;
}

pub fn child(segments: &[String], name: &str) -> Vec<String> {
    let mut child = segments.to_vec();
    child.push(name.to_owned());
    child
}

type Progress<'a> = dyn FnMut(&Path, u64, Option<u64>) -> io::Result<()> + 'a;
type Ask<'a> = dyn FnMut(Conflict) -> io::Result<Decision> + 'a;

pub fn download<S: DownloadSession>(
    session: &mut S,
    segments: &[String],
    target: &Path,
    options: &local_transfer::Options,
    mut progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    mut ask: impl FnMut(Conflict) -> io::Result<Decision>,
) -> Result<bool> {
    let parent = target
        .parent()
        .ok_or("Choose a local destination folder.")?
        .canonicalize()
        .map_err(message)?;
    let target = parent.join(target.file_name().ok_or("Enter a destination name.")?);
    let name = segments.last().ok_or("Choose a source item.")?;
    let entry = download_entry(session, segments)?;
    let Some(plan) =
        local_transfer::plan_target(&target, Incoming::remote(&entry), None, options, &mut ask)
            .map_err(message)?
    else {
        return Ok(false);
    };
    let workspace = local::staging_directory(&parent).map_err(message)?;
    let staged = workspace
        .path()
        .join(local::name_component(name).map_err(message)?);
    let mut transfer = Download {
        session,
        options,
        progress: &mut progress,
        ask: &mut ask,
    };
    let prepared = transfer.stage(segments, &entry, staged, plan)?;
    if entry.is_file() && !transfer.session.matches_file(segments, &entry)? {
        return Err(file_changed::<S>());
    }
    prepared.publish(&mut progress).map_err(message)
}

fn download_entry<S: DownloadSession>(session: &mut S, segments: &[String]) -> Result<S::Entry> {
    let entry = session
        .stat(segments)?
        .ok_or("The source item no longer exists.")?;
    validate_entry(&entry)?;
    Ok(entry)
}

fn validate_entry(entry: &impl Entry) -> Result<()> {
    if entry.is_directory() || entry.is_file() {
        Ok(())
    } else {
        Err("Choose regular files and folders without symbolic links.".to_owned())
    }
}

fn file_changed<S: Session>() -> String {
    format!("The {} file changed during the download.", S::SOURCE)
}

struct StagedDownload {
    source: PathBuf,
    target: PlannedTarget,
    children: Vec<StagedDownload>,
    complete: bool,
}

impl StagedDownload {
    fn publish(self, progress: &mut Progress<'_>) -> io::Result<bool> {
        progress(&self.source, 0, None)?;
        let PlannedTarget {
            path,
            replace,
            merge,
        } = self.target;
        let mut complete = self.complete;
        if let Some(folder) = merge {
            local_transfer::verify_folder(&path, &folder)?;
            for child in self.children {
                local_transfer::verify_folder(&path, &folder)?;
                complete &= child.publish(progress)?;
            }
        } else {
            let moved = if let Some(file) = &replace {
                file.verify(&path)?;
                local::replace_file(&self.source, &path)
            } else {
                local::move_item(&self.source, path.clone())
            };
            match moved {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {
                    local::copy_to(&self.source, &path, replace.is_some(), |entry, _, total| {
                        progress(entry, 0, None)?;
                        if entry == self.source && total.is_none() {
                            if let Some(file) = &replace {
                                file.verify(&path)?;
                            }
                        }
                        Ok(())
                    })?;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(complete)
    }
}

struct Download<'a, S> {
    session: &'a mut S,
    options: &'a Options,
    progress: &'a mut Progress<'a>,
    ask: &'a mut Ask<'a>,
}

impl<S: DownloadSession> Download<'_, S> {
    fn stage(
        &mut self,
        segments: &[String],
        entry: &S::Entry,
        source: PathBuf,
        target: PlannedTarget,
    ) -> Result<StagedDownload> {
        let mut prepared = StagedDownload {
            source,
            target,
            children: Vec::new(),
            complete: true,
        };
        if let Some(folder) = &prepared.target.merge {
            (self.progress)(&prepared.source, 0, None).map_err(message)?;
            local_transfer::verify_folder(&prepared.target.path, folder).map_err(message)?;
            fs::create_dir(&prepared.source).map_err(message)?;
            let children = self.session.children(segments)?;
            let mut downloaded = Vec::new();
            for entry in children {
                validate_entry(&entry)?;
                let name = local::name_component(entry.name()).map_err(message)?;
                let child = child(segments, entry.name());
                local_transfer::verify_folder(&prepared.target.path, folder).map_err(message)?;
                let target = prepared.target.path.join(name);
                if let Some(plan) = local_transfer::plan_target(
                    &target,
                    Incoming::remote(&entry),
                    None,
                    self.options,
                    self.ask,
                )
                .map_err(message)?
                {
                    prepared.children.push(self.stage(
                        &child,
                        &entry,
                        prepared.source.join(name),
                        plan,
                    )?);
                    if entry.is_file() {
                        downloaded.push(entry);
                    }
                } else {
                    prepared.complete = false;
                }
            }
            self.verify_files(segments, &downloaded)?;
        } else {
            self.stage_contents(segments, entry, &prepared.source)?;
        }
        Ok(prepared)
    }

    fn stage_contents(
        &mut self,
        segments: &[String],
        entry: &S::Entry,
        target: &Path,
    ) -> Result<()> {
        (self.progress)(target, 0, None).map_err(message)?;
        if entry.is_directory() {
            fs::create_dir(target).map_err(message)?;
            let children = self.session.children(segments)?;
            for entry in &children {
                validate_entry(entry)?;
                let child = child(segments, entry.name());
                let destination =
                    target.join(local::name_component(entry.name()).map_err(message)?);
                self.stage_contents(&child, entry, &destination)?;
            }
            self.verify_files(segments, &children)?;
            return Ok(());
        }
        let mut staged = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(message)?;
        let size = entry.size();
        (self.progress)(target, 0, size).map_err(message)?;
        self.session.download(segments, &mut staged, |bytes| {
            (self.progress)(target, bytes, size).map_err(message)
        })?;
        let actual = staged.metadata().map_err(message)?.len();
        if size.is_some_and(|size| size != actual) {
            return Err(file_changed::<S>());
        }
        if let Some(time) = entry.modified() {
            staged.set_modified(time).map_err(message)?;
        }
        staged.sync_all().map_err(message)?;
        Ok(())
    }

    fn verify_files(&mut self, segments: &[String], expected: &[S::Entry]) -> Result<()> {
        if !expected.iter().any(Entry::is_file) {
            return Ok(());
        }
        let current = self.session.children(segments)?;
        let by_name: HashMap<_, _> = current.iter().map(|entry| (entry.name(), entry)).collect();
        if expected
            .iter()
            .filter(|entry| entry.is_file())
            .any(|entry| by_name.get(entry.name()).copied() != Some(entry))
        {
            return Err(file_changed::<S>());
        }
        Ok(())
    }
}

pub fn upload_destination<S: UploadSession>(
    session: &mut S,
    directory: &str,
    name: &str,
    multiple: bool,
) -> Result<Vec<String>> {
    let target = S::parse_path(directory)?;
    if target.is_empty()
        || session
            .stat(&target)?
            .is_some_and(|entry| entry.is_directory())
    {
        return Ok(child(&target, name));
    }
    if multiple || directory.ends_with('/') {
        return Err(format!(
            "Choose an existing {} destination folder.",
            S::SOURCE
        ));
    }
    Ok(target)
}

pub fn upload<S: UploadSession>(
    session: &mut S,
    source: &Path,
    target: &[String],
    policy: local_transfer::Policy,
    progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    ask: &mut impl FnMut(local_transfer::Conflict) -> io::Result<local_transfer::Decision>,
) -> Result<bool> {
    use local_transfer::{Decision, Policy};
    progress(source, 0, None).map_err(message)?;
    let incoming = fs::symlink_metadata(source).map_err(message)?;
    if local::is_link(&incoming) || (!incoming.is_file() && !incoming.is_dir()) {
        return Err("Choose local files and folders without symbolic links.".to_owned());
    }
    let existing = session.stat(target)?;
    if let Some(entry) = &existing {
        if policy == Policy::Skip {
            return Ok(false);
        }
        let replaceable =
            (incoming.is_file() && entry.is_file()) || (incoming.is_dir() && entry.is_directory());
        if policy != Policy::Overwrite || !replaceable {
            let conflict = local_transfer::Conflict::network(
                S::absolute(target)?,
                &incoming,
                local_transfer::EntryDetails::network(
                    entry.size(),
                    entry.modified(),
                    entry.is_directory(),
                ),
                replaceable,
            );
            if matches!(ask(conflict).map_err(message)?, Decision::Skip) {
                return Ok(false);
            }
        }
        if !replaceable {
            return Err(format!("The {} destination cannot be replaced.", S::SOURCE));
        }
    }

    if incoming.is_dir() {
        let folder = same_file::Handle::from_path(source).map_err(message)?;
        if existing.is_none() {
            session.mkdir(target)?;
        }
        let mut complete = true;
        for item in fs::read_dir(source).map_err(message)? {
            let item = item.map_err(message)?;
            local_transfer::verify_folder(source, &folder).map_err(message)?;
            let name = item.file_name();
            let name = name
                .to_str()
                .ok_or("A local filename cannot be represented as Unicode.")?;
            complete &= upload(
                session,
                &item.path(),
                &child(target, name),
                policy,
                progress,
                ask,
            )?;
        }
        return Ok(complete);
    }

    session.check_publication(existing.is_some())?;
    let revision = local_transfer::FileRevision::capture(source, &incoming).map_err(message)?;
    let mut input = fs::File::open(source).map_err(message)?;
    let size = incoming.len();
    progress(source, 0, Some(size)).map_err(message)?;
    let staged = session.upload_to_stage(target, &mut input, |bytes| {
        progress(source, bytes, Some(size)).map_err(message)
    })?;
    let result = (|| {
        progress(source, size, Some(size)).map_err(message)?;
        revision.verify(source).map_err(message)?;
        if session.stat(target)? != existing {
            return Err(format!(
                "The {} destination changed during the upload.",
                S::SOURCE
            ));
        }
        session.rename_stage(&staged, target, existing.is_some())
    })();
    if result.is_err() {
        session.remove_stage(&staged);
    }
    result.map(|()| true)
}
