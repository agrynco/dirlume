use std::{
    fs, io,
    path::{Path, PathBuf},
};

use suppaftp::list::File;

use crate::{
    desktop::{message, Result},
    ftp::{self, Session},
    local,
    local_transfer::{self, Conflict, Decision, Incoming, Options, PlannedTarget},
};

type Progress<'a> = dyn FnMut(&Path, u64, Option<u64>) -> io::Result<()> + 'a;
type Ask<'a> = dyn FnMut(Conflict) -> io::Result<Decision> + 'a;

pub fn download(
    session: &mut Session,
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
    let name = segments.last().ok_or("Choose an FTP item.")?;
    let entry = download_entry(session, segments)?;
    let Some(plan) =
        local_transfer::plan_target(&target, Incoming::ftp(&entry), None, options, &mut ask)
            .map_err(message)?
    else {
        return Ok(false);
    };
    let workspace = tempfile::tempdir_in(parent).map_err(message)?;
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
    prepared.publish(&mut progress).map_err(message)
}

fn download_entry(session: &mut Session, segments: &[String]) -> Result<File> {
    let entry = session
        .stat(segments)?
        .ok_or("The FTP item no longer exists.")?;
    if !entry.is_directory() && !entry.is_file() {
        return Err("Choose FTP files and folders without symbolic links.".to_owned());
    }
    Ok(entry)
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

struct Download<'a> {
    session: &'a mut Session,
    options: &'a Options,
    progress: &'a mut Progress<'a>,
    ask: &'a mut Ask<'a>,
}

impl Download<'_> {
    fn stage(
        &mut self,
        segments: &[String],
        entry: &File,
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
            for listed in self.session.list(segments)?.complete()? {
                let name = local::name_component(listed.name()).map_err(message)?;
                let child = ftp::child(segments, listed.name());
                let entry = download_entry(self.session, &child)?;
                local_transfer::verify_folder(&prepared.target.path, folder).map_err(message)?;
                let target = prepared.target.path.join(name);
                if let Some(plan) = local_transfer::plan_target(
                    &target,
                    Incoming::ftp(&entry),
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
                } else {
                    prepared.complete = false;
                }
            }
        } else {
            self.stage_contents(segments, entry, &prepared.source)?;
        }
        Ok(prepared)
    }

    fn stage_contents(&mut self, segments: &[String], entry: &File, target: &Path) -> Result<()> {
        (self.progress)(target, 0, None).map_err(message)?;
        if entry.is_directory() {
            fs::create_dir(target).map_err(message)?;
            for listed in self.session.list(segments)?.complete()? {
                let child = ftp::child(segments, listed.name());
                let entry = download_entry(self.session, &child)?;
                let destination =
                    target.join(local::name_component(listed.name()).map_err(message)?);
                self.stage_contents(&child, &entry, &destination)?;
            }
            return Ok(());
        }
        let mut staged = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(message)?;
        let size = entry.size() as u64;
        (self.progress)(target, 0, Some(size)).map_err(message)?;
        self.session.download(segments, &mut staged, |bytes| {
            (self.progress)(target, bytes, Some(size)).map_err(message)
        })?;
        if staged.metadata().map_err(message)?.len() != size
            || self.session.stat(segments)?.as_ref() != Some(entry)
        {
            return Err("The FTP file changed during the download.".to_owned());
        }
        staged.set_modified(entry.modified()).map_err(message)?;
        staged.sync_all().map_err(message)?;
        Ok(())
    }
}

pub fn upload_destination(
    session: &mut Session,
    directory: &str,
    name: &str,
    multiple: bool,
) -> Result<Vec<String>> {
    let target = ftp::parse_path(directory)?;
    if target.is_empty()
        || session
            .stat(&target)?
            .is_some_and(|entry| entry.is_directory())
    {
        return Ok(ftp::child(&target, name));
    }
    if multiple || directory.ends_with('/') {
        return Err("Choose an existing FTP destination folder.".to_owned());
    }
    Ok(target)
}

pub fn upload(
    session: &mut Session,
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
            let conflict = local_transfer::Conflict::ftp(
                &ftp::absolute(target)?,
                &incoming,
                entry,
                replaceable,
            );
            if matches!(ask(conflict).map_err(message)?, Decision::Skip) {
                return Ok(false);
            }
        }
        if !replaceable {
            return Err("The FTP destination cannot be replaced.".to_owned());
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
                &ftp::child(target, name),
                policy,
                progress,
                ask,
            )?;
        }
        return Ok(complete);
    }

    let revision = local_transfer::FileRevision::capture(source, &incoming).map_err(message)?;
    let mut input = fs::File::open(source).map_err(message)?;
    let size = incoming.len();
    progress(source, 0, Some(size)).map_err(message)?;
    let staged = session.upload_to_stage(target, &mut input, |bytes| {
        progress(source, bytes, Some(size)).map_err(message)
    })?;
    let result = (|| {
        revision.verify(source).map_err(message)?;
        if session.stat(target)? != existing {
            return Err("The FTP destination changed during the upload.".to_owned());
        }
        progress(source, size, Some(size)).map_err(message)?;
        session.rename_stage(&staged, target)
    })();
    if result.is_err() {
        session.remove_stage(&staged);
    }
    result.map(|()| true)
}
