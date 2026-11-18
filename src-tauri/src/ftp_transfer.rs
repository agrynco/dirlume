use std::{fs, io, path::Path};

use crate::{
    desktop::{message, Result},
    ftp::{self, Session},
    local, local_transfer,
};

pub fn download(
    session: &mut Session,
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
    let name = segments.last().ok_or("Choose an FTP item.")?;
    let staged = workspace
        .path()
        .join(local::name_component(name).map_err(message)?);
    stage_download(session, segments, &staged, &mut progress)?;
    let options = local_transfer::Options {
        moving: true,
        ..*options
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

fn stage_download(
    session: &mut Session,
    segments: &[String],
    target: &Path,
    progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
) -> Result<()> {
    progress(target, 0, None).map_err(message)?;
    let entry = session
        .stat(segments)?
        .ok_or("The FTP item no longer exists.")?;
    if entry.is_directory() {
        fs::create_dir(target).map_err(message)?;
        for child in session.list(segments)?.complete()? {
            stage_download(
                session,
                &ftp::child(segments, child.name()),
                &target.join(local::name_component(child.name()).map_err(message)?),
                progress,
            )?;
        }
    } else if entry.is_file() {
        let mut staged = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(message)?;
        let size = entry.size() as u64;
        progress(target, 0, Some(size)).map_err(message)?;
        session.download(segments, &mut staged, |bytes| {
            progress(target, bytes, Some(size)).map_err(message)
        })?;
        if staged.metadata().map_err(message)?.len() != size
            || session.stat(segments)?.as_ref() != Some(&entry)
        {
            return Err("The FTP file changed during the download.".to_owned());
        }
        staged.set_modified(entry.modified()).map_err(message)?;
        staged.sync_all().map_err(message)?;
    } else {
        return Err("Choose FTP files and folders without symbolic links.".to_owned());
    }
    Ok(())
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
