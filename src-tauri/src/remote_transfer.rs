use std::{
    fs,
    io::{self, Read, Write},
    path::Path,
    time::SystemTime,
};

use crate::{
    desktop::{message, Result},
    ftp, local, local_transfer,
};

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

    fn absolute(segments: &[String]) -> Result<String>;
    fn parse_path(path: &str) -> Result<Vec<String>>;
    fn stat(&mut self, segments: &[String]) -> Result<Option<Self::Entry>>;
    fn children(&mut self, segments: &[String]) -> Result<Vec<Self::Entry>>;
    fn mkdir(&mut self, segments: &[String]) -> Result<()>;
    fn download(
        &mut self,
        segments: &[String],
        output: &mut impl Write,
        progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<()>;
    fn upload_to_stage(
        &mut self,
        target: &[String],
        input: &mut impl Read,
        progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<String>;
    fn remove_stage(&mut self, stage: &str);
    fn rename_stage(&mut self, stage: &str, target: &[String], overwrite: bool) -> Result<()>;
}

impl Entry for suppaftp::list::File {
    fn name(&self) -> &str {
        self.name()
    }
    fn is_directory(&self) -> bool {
        self.is_directory()
    }
    fn is_file(&self) -> bool {
        self.is_file()
    }
    fn size(&self) -> Option<u64> {
        Some(self.size() as u64)
    }
    fn modified(&self) -> Option<SystemTime> {
        Some(self.modified())
    }
}

impl Session for ftp::Session {
    const SOURCE: &'static str = "FTP";
    type Entry = suppaftp::list::File;

    fn absolute(segments: &[String]) -> Result<String> {
        ftp::absolute(segments)
    }
    fn parse_path(path: &str) -> Result<Vec<String>> {
        ftp::parse_path(path)
    }
    fn stat(&mut self, segments: &[String]) -> Result<Option<Self::Entry>> {
        self.stat(segments)
    }
    fn children(&mut self, segments: &[String]) -> Result<Vec<Self::Entry>> {
        self.list(segments)?.complete()
    }
    fn mkdir(&mut self, segments: &[String]) -> Result<()> {
        self.mkdir(segments)
    }
    fn download(
        &mut self,
        segments: &[String],
        output: &mut impl Write,
        progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<()> {
        self.download(segments, output, progress)
    }
    fn upload_to_stage(
        &mut self,
        target: &[String],
        input: &mut impl Read,
        progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<String> {
        self.upload_to_stage(target, input, progress)
    }
    fn remove_stage(&mut self, stage: &str) {
        self.remove_stage(stage);
    }
    fn rename_stage(&mut self, stage: &str, target: &[String], _overwrite: bool) -> Result<()> {
        self.rename_stage(stage, target)
    }
}

pub fn child(segments: &[String], name: &str) -> Vec<String> {
    let mut child = segments.to_vec();
    child.push(name.to_owned());
    child
}

pub fn download(
    session: &mut impl Session,
    segments: &[String],
    target: &Path,
    options: &local_transfer::Options,
    mut progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
    ask: impl FnMut(local_transfer::Conflict) -> io::Result<local_transfer::Decision>,
) -> Result<bool> {
    let parent = target
        .parent()
        .ok_or("Choose a local destination folder.")?;
    let workspace = tempfile::tempdir_in(parent).map_err(message)?;
    let name = segments.last().ok_or("Choose a remote item.")?;
    let staged = workspace
        .path()
        .join(local::name_component(name).map_err(message)?);
    stage_download(session, segments, &staged, &mut progress)?;
    let options = local_transfer::Options {
        moving: true,
        ..options.clone()
    };
    local_transfer::transfer(
        &staged,
        target,
        &options,
        |file, _, _| progress(file, 0, None),
        ask,
    )
    .map_err(message)
}

fn stage_download<S: Session>(
    session: &mut S,
    segments: &[String],
    target: &Path,
    progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
) -> Result<()> {
    progress(target, 0, None).map_err(message)?;
    let entry = session
        .stat(segments)?
        .ok_or_else(|| format!("The {} item no longer exists.", S::SOURCE))?;
    if entry.is_directory() {
        fs::create_dir(target).map_err(message)?;
        for entry in session.children(segments)? {
            stage_download(
                session,
                &child(segments, entry.name()),
                &target.join(local::name_component(entry.name()).map_err(message)?),
                progress,
            )?;
        }
    } else if entry.is_file() {
        let mut staged = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(message)?;
        let size = entry.size();
        progress(target, 0, size).map_err(message)?;
        session.download(segments, &mut staged, |bytes| {
            progress(target, bytes, size).map_err(message)
        })?;
        if (if let Some(size) = size {
            staged.metadata().map_err(message)?.len() != size
        } else {
            false
        }) || session.stat(segments)?.as_ref() != Some(&entry)
        {
            return Err(format!(
                "The {} file changed during the download.",
                S::SOURCE
            ));
        }
        if let Some(modified) = entry.modified() {
            staged.set_modified(modified).map_err(message)?;
        }
        staged.sync_all().map_err(message)?;
    } else {
        return Err(format!(
            "Choose {} files and folders without symbolic links.",
            S::SOURCE
        ));
    }
    Ok(())
}

pub fn upload_destination<S: Session>(
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

pub fn upload<S: Session>(
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
            return Err(format!(
                "The {} destination changed during the upload.",
                S::SOURCE
            ));
        }
        progress(source, size, Some(size)).map_err(message)?;
        session.rename_stage(&staged, target, existing.is_some())
    })();
    if result.is_err() {
        session.remove_stage(&staged);
    }
    result.map(|()| true)
}
