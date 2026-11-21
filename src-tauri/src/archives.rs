use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{self, Read, Seek, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::{
    archive_engine::{self, archive_args, Engine, Limited},
    desktop::{
        blocking, check_preview_image_size, decode_text, encode_text, message, Encoding, Result,
        TextDocument, TEXT_LIMIT,
    },
    local,
    local_transfer::{Conflict, Decision, FileRevision, Options},
    protocol::{BytePage, RemoteListing, BYTE_PAGE_SIZE},
};

#[derive(Default)]
pub struct Archives {
    next: AtomicU32,
    items: Mutex<HashMap<u32, Arc<Mutex<Archive>>>>,
}

impl Archives {
    pub fn get(&self, id: u32) -> Result<Arc<Mutex<Archive>>> {
        self.items
            .lock()
            .map_err(message)?
            .get(&id)
            .cloned()
            .ok_or_else(|| "Open the archive again.".to_owned())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Member {
    raw: Option<String>,
    directory: bool,
    link: bool,
    size: u64,
    crc: Option<String>,
}

struct Index {
    members: BTreeMap<Vec<String>, Member>,
    format: String,
    encrypted: bool,
    omitted: usize,
}

pub struct Archive {
    path: PathBuf,
    engine: Engine,
    password: Option<String>,
    index: Index,
    revision: FileRevision,
    generation: String,
    writable: bool,
    byte_cache: Option<MemberCache>,
}

#[derive(Serialize)]
pub struct OpenedArchive {
    id: u32,
    path: String,
    parent: String,
    writable: bool,
    listing: RemoteListing,
}

#[tauri::command]
pub async fn open_archive(
    path: String,
    password: Option<String>,
    state: State<'_, Archives>,
) -> Result<OpenedArchive> {
    let opened = blocking(move || {
        Archive::open(
            local::absolute(&path).map_err(message)?.to_owned(),
            password,
        )
    })
    .await?;
    let id = state.next.fetch_add(1, Ordering::Relaxed);
    let parent = opened
        .path
        .parent()
        .ok_or("Open an archive inside a folder.")?;
    let view = OpenedArchive {
        id,
        path: local::display_path(&opened.path).map_err(message)?,
        parent: local::display_path(parent).map_err(message)?,
        writable: opened.writable,
        listing: opened.list(&[])?,
    };
    state
        .items
        .lock()
        .map_err(message)?
        .insert(id, Arc::new(Mutex::new(opened)));
    Ok(view)
}

#[tauri::command]
pub fn close_archive(id: u32, state: State<'_, Archives>) -> Result<()> {
    state.items.lock().map_err(message)?.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn list_archive(
    id: u32,
    segments: Vec<String>,
    state: State<'_, Archives>,
) -> Result<RemoteListing> {
    let archive = state.get(id)?;
    blocking(move || archive.lock().map_err(message)?.list(&segments)).await
}

#[tauri::command]
pub async fn read_archive_text(
    id: u32,
    segments: Vec<String>,
    state: State<'_, Archives>,
) -> Result<TextDocument> {
    let archive = state.get(id)?;
    blocking(move || {
        let archive = archive.lock().map_err(message)?;
        let entry = archive.file(&segments)?;
        if entry.size > TEXT_LIMIT {
            return Err("This file is too large for the text viewer.".to_owned());
        }
        let bytes = archive.extract(entry, Vec::new(), |_| Ok(()))?;
        let mut document = decode_text(bytes.as_slice())?;
        document.revision = Some(archive.generation.clone());
        Ok(document)
    })
    .await
}

#[tauri::command]
pub async fn read_archive_bytes(
    id: u32,
    segments: Vec<String>,
    offset: u64,
    state: State<'_, Archives>,
) -> Result<BytePage> {
    let archive = state.get(id)?;
    blocking(move || {
        let mut archive = archive.lock().map_err(message)?;
        archive.byte_page(&segments, offset)
    })
    .await
}

#[tauri::command]
pub async fn save_archive_text(
    id: u32,
    segments: Vec<String>,
    revision: String,
    text: String,
    encoding: Encoding,
    state: State<'_, Archives>,
) -> Result<TextDocument> {
    let archive = state.get(id)?;
    blocking(move || {
        let mut archive = archive.lock().map_err(message)?;
        if archive.generation != revision {
            return Err("The archive changed. Reopen the file before saving.".to_owned());
        }
        archive.file(&segments)?;
        let data = encode_text(encoding, &text)?;
        archive.write(&[segments], Some(data))?;
        Ok(TextDocument {
            text,
            encoding,
            revision: Some(archive.generation.clone()),
        })
    })
    .await
}

#[tauri::command]
pub async fn delete_archive_entries(
    id: u32,
    paths: Vec<Vec<String>>,
    state: State<'_, Archives>,
) -> Result<()> {
    let archive = state.get(id)?;
    blocking(move || archive.lock().map_err(message)?.write(&paths, None)).await
}

const HEX_CACHE_BYTES: u64 = 32 * 1024 * 1024;
struct MemberCache {
    name: Vec<String>,
    start: u64,
    end: u64,
    file: fs::File,
}
// Consume the entire extractor output so its size and integrity checks still run.
struct CacheWriter {
    file: fs::File,
    skip: u64,
    remaining: u64,
}
impl Write for CacheWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let skip = self.skip.min(bytes.len() as u64);
        self.skip -= skip;
        let available = &bytes[skip as usize..];
        let count = self.remaining.min(available.len() as u64) as usize;
        self.file.write_all(&available[..count])?;
        self.remaining -= count as u64;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

impl Archive {
    fn open(path: PathBuf, password: Option<String>) -> Result<Self> {
        let metadata = fs::symlink_metadata(&path).map_err(message)?;
        if !metadata.is_file() || local::is_link(&metadata) {
            return Err("Choose a regular archive file.".to_owned());
        }
        let engine = Engine::find()?;
        let password = password.filter(|value| !value.is_empty());
        let revision = FileRevision::capture(&path, &metadata).map_err(message)?;
        let index = inspect(&engine, &path, password.as_deref())?;
        revision.verify(&path).map_err(message)?;
        if index.encrypted && password.is_none() {
            return Err(archive_engine::PASSWORD_ERROR.to_owned());
        }
        let writable = !metadata.permissions().readonly()
            && index.omitted == 0
            && !index.encrypted
            && matches!(index.format.as_str(), "7z" | "zip" | "tar" | "wim")
            && !path
                .extension()
                .is_some_and(|extension| extension == "001" || extension == "exe");
        Ok(Self {
            path,
            engine,
            password,
            index,
            revision,
            generation: Uuid::new_v4().to_string(),
            writable,
            byte_cache: None,
        })
    }

    fn byte_page(&mut self, segments: &[String], offset: u64) -> Result<BytePage> {
        let entry = self.file(segments)?;
        let length = entry.size;
        let mut data = vec![0; length.saturating_sub(offset).min(BYTE_PAGE_SIZE) as usize];
        if !data.is_empty() {
            let end = offset + data.len() as u64;
            if !self.byte_cache.as_ref().is_some_and(|cache| {
                cache.name == segments && cache.start <= offset && end <= cache.end
            }) {
                let start = if length <= HEX_CACHE_BYTES { 0 } else { offset };
                let end = start.saturating_add(HEX_CACHE_BYTES).min(length);
                let sink = CacheWriter {
                    file: tempfile::tempfile().map_err(message)?,
                    skip: start,
                    remaining: end - start,
                };
                let file = self.extract(entry, sink, |_| Ok(()))?.file;
                self.byte_cache = Some(MemberCache {
                    name: segments.to_vec(),
                    start,
                    end,
                    file,
                });
            }
            let cache = self.byte_cache.as_mut().expect("cached member");
            cache
                .file
                .seek(io::SeekFrom::Start(offset - cache.start))
                .map_err(message)?;
            cache.file.read_exact(&mut data).map_err(message)?;
        }
        Ok(BytePage { length, data })
    }

    fn verify(&self) -> Result<()> {
        self.revision
            .verify(&self.path)
            .map_err(|_| "The archive changed on disk. Open it again.".to_owned())
    }

    fn list(&self, segments: &[String]) -> Result<RemoteListing> {
        self.verify()?;
        if !segments.is_empty()
            && !self
                .index
                .members
                .get(segments)
                .is_some_and(|member| member.directory && !member.link)
        {
            return Err("The archive folder no longer exists.".to_owned());
        }
        let entries = self
            .index
            .members
            .iter()
            .filter(|(name, _)| name.len() == segments.len() + 1 && name.starts_with(segments))
            .map(|(name, member)| {
                local::Entry::new(
                    name.last().expect("child of a directory").clone(),
                    member.directory,
                    member.link,
                    local::EntryAttributes::default(),
                    (!member.directory).then_some(member.size),
                    None,
                )
            })
            .collect();
        Ok(RemoteListing {
            entries,
            omitted: self.index.omitted,
        })
    }

    fn file(&self, segments: &[String]) -> Result<&Member> {
        self.verify()?;
        self.index
            .members
            .get(segments)
            .filter(|entry| !entry.directory && !entry.link)
            .ok_or_else(|| "Choose a regular file in the archive.".to_owned())
    }

    fn extract<W: Write + Send>(
        &self,
        member: &Member,
        sink: W,
        tick: impl FnMut(u8) -> io::Result<()>,
    ) -> Result<W> {
        let sink = extract_member(
            &self.engine,
            &self.path,
            self.password.as_deref(),
            member,
            sink,
            tick,
        )?;
        self.verify()?;
        Ok(sink)
    }

    pub(crate) fn preview_image(&self, segments: &[String]) -> Result<Vec<u8>> {
        let entry = self.file(segments)?;
        check_preview_image_size(entry.size)?;
        self.extract(entry, Vec::new(), |_| Ok(()))
    }

    pub fn copy_to(
        &self,
        segments: &[String],
        target: &Path,
        options: &Options,
        progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
        ask: impl FnMut(Conflict) -> io::Result<Decision>,
    ) -> Result<bool> {
        crate::remote_transfer::download(
            &mut ArchiveReader(self),
            segments,
            target,
            options,
            progress,
            ask,
        )
    }

    fn write(&mut self, selected: &[Vec<String>], updated: Option<Vec<u8>>) -> Result<()> {
        self.verify()?;
        if !self.writable {
            return Err("The archive is read-only.".to_owned());
        }
        if selected.is_empty()
            || selected
                .iter()
                .any(|name| !self.index.members.contains_key(name))
        {
            return Err("Choose entries in the archive.".to_owned());
        }
        let workspace = tempfile::tempdir_in(
            self.path
                .parent()
                .ok_or("Choose an archive inside a folder.")?,
        )
        .map_err(message)?;
        let staged = workspace.path().join(
            self.path
                .file_name()
                .ok_or("Use a valid archive filename.")?,
        );
        fs::copy(&self.path, &staged).map_err(message)?;
        self.verify()?;
        let modifies =
            |name: &[String]| selected.iter().any(|selection| name.starts_with(selection));
        let mut command;
        if let Some(contents) = updated.as_deref() {
            let root = workspace.path().join("update");
            // 7-Zip requires the actual relative member name for the replacement.
            let path = selected[0]
                .iter()
                .fold(root.clone(), |path, name| path.join(name));
            fs::create_dir_all(
                path.parent()
                    .ok_or("The archive member has no directory.")?,
            )
            .map_err(message)?;
            fs::write(&path, contents).map_err(message)?;
            let list = archive_engine::list_file(workspace.path(), [selected[0].join("/")])?;
            command = self.engine.command("a");
            command
                .current_dir(root)
                .args(["-spd", "-bso2", "-bse2", "-bsp0", "-up1q1r2x2y2z2w2"]);
            command.arg(archive_engine::at("-i@", &list));
        } else {
            let list = archive_engine::list_file(
                workspace.path(),
                self.index
                    .members
                    .iter()
                    .filter(|(name, _)| modifies(name))
                    .filter_map(|(_, member)| member.raw.as_deref()),
            )?;
            command = self.engine.command("d");
            command.args(["-spd", "-bso2", "-bse2", "-bsp0"]);
            command.arg(archive_engine::at("-i@", &list));
        }
        archive_args(&mut command, &staged);
        let _ = archive_engine::run(&mut command, self.password.as_deref(), io::sink(), |_| {
            Ok(())
        })?
        .checked(false)?;
        let new_index = inspect(&self.engine, &staged, self.password.as_deref())?;
        if self.index.members.iter().any(|(name, old)| {
            !modifies(name) && (old.raw.is_some() && new_index.members.get(name) != Some(old))
        }) {
            return Err("The archive update would change an unrelated entry.".to_owned());
        }
        if let Some(data) = updated {
            let member = new_index
                .members
                .get(&selected[0])
                .filter(|item| item.size == data.len() as u64)
                .ok_or("The edited file was not saved into the archive.")?;
            let actual =
                extract_member(&self.engine, &staged, None, member, Vec::new(), |_| Ok(()))?;
            if actual != data {
                return Err("The edited file was not saved into the archive.".to_owned());
            }
        } else if new_index.members.keys().any(|name| modifies(name)) {
            return Err("An archive entry could not be deleted.".to_owned());
        }
        fs::OpenOptions::new()
            .write(true)
            .open(&staged)
            .and_then(|file| file.sync_all())
            .map_err(message)?;
        self.verify()?;
        local::replace_file(&staged, &self.path).map_err(message)?;
        self.revision = FileRevision::capture(
            &self.path,
            &fs::symlink_metadata(&self.path).map_err(message)?,
        )
        .map_err(message)?;
        self.byte_cache = None;
        self.index = new_index;
        self.generation = Uuid::new_v4().to_string();
        Ok(())
    }
}

struct ArchiveReader<'a>(&'a Archive);
#[derive(PartialEq)]
struct ArchiveEntry(String, Member);
impl crate::remote_transfer::Entry for ArchiveEntry {
    fn name(&self) -> &str {
        &self.0
    }
    fn is_directory(&self) -> bool {
        self.1.directory && !self.1.link
    }
    fn is_file(&self) -> bool {
        !self.1.directory && !self.1.link
    }
    fn size(&self) -> Option<u64> {
        Some(self.1.size)
    }
    fn modified(&self) -> Option<std::time::SystemTime> {
        None
    }
}
impl crate::remote_transfer::Session for ArchiveReader<'_> {
    const SOURCE: &'static str = "archive";
    type Entry = ArchiveEntry;
    fn stat(&mut self, path: &[String]) -> Result<Option<ArchiveEntry>> {
        self.0.verify()?;
        Ok(self
            .0
            .index
            .members
            .get(path)
            .and_then(|member| Some(ArchiveEntry(path.last()?.clone(), member.clone()))))
    }
}
impl crate::remote_transfer::DownloadSession for ArchiveReader<'_> {
    fn children(&mut self, path: &[String]) -> Result<Vec<ArchiveEntry>> {
        self.0.verify()?;
        Ok(self
            .0
            .index
            .members
            .range(path.to_vec()..)
            .take_while(|(key, _)| key.starts_with(path))
            .filter(|(key, _)| key.len() == path.len() + 1)
            .map(|(key, member)| ArchiveEntry(key[path.len()].clone(), member.clone()))
            .collect())
    }
    fn download(
        &mut self,
        path: &[String],
        file: &mut fs::File,
        mut progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<()> {
        let member = self.0.file(path)?;
        let count = AtomicU64::new(0);
        self.0.extract(
            member,
            Tracked(file.try_clone().map_err(message)?, &count),
            |_| progress(count.load(Ordering::Relaxed)).map_err(io::Error::other),
        )?;
        progress(member.size)
    }
}

fn extract_member<W: Write + Send>(
    engine: &Engine,
    path: &Path,
    password: Option<&str>,
    member: &Member,
    sink: W,
    tick: impl FnMut(u8) -> io::Result<()>,
) -> Result<W> {
    let raw = member
        .raw
        .as_ref()
        .filter(|_| !member.link && !member.directory)
        .ok_or("Choose a regular file in the archive.")?;
    let options = tempfile::tempdir().map_err(message)?;
    let list = archive_engine::list_file(options.path(), [raw])?;
    let mut command = engine.command("x");
    command.args(["-so", "-spd", "-bso2", "-bse2", "-bsp0"]);
    command.arg(archive_engine::at("-i@", &list));
    archive_args(&mut command, path);
    let Limited(sink, remaining) =
        archive_engine::run(&mut command, password, Limited(sink, member.size), tick)?
            .checked(false)?;
    if remaining != 0 {
        return Err("The archive member did not match its listed size.".to_owned());
    }
    Ok(sink)
}

struct Tracked<'a>(fs::File, &'a AtomicU64);
impl Write for Tracked<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let written = self.0.write(bytes)?;
        self.1.fetch_add(written as u64, Ordering::Relaxed);
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

fn inspect(engine: &Engine, path: &Path, password: Option<&str>) -> Result<Index> {
    let mut command = engine.command("l");
    command.args(["-slt", "-bso1", "-bse2", "-bsp0"]);
    archive_args(&mut command, path);
    let output =
        archive_engine::capture(&mut command, password, archive_engine::LIST_LIMIT, |_| {
            Ok(())
        })?;
    parse_index(&output)
}

fn parse_index(output: &str) -> Result<Index> {
    let mut lines = output.lines();
    let mut format = String::new();
    let mut encrypted = false;
    for line in lines.by_ref() {
        if line == "----------" {
            break;
        }
        if let Some(kind) = line.strip_prefix("Type = ") {
            format = kind.to_ascii_lowercase();
        }
        if line.starts_with("Method = ") && line.to_ascii_lowercase().contains("aes") {
            encrypted = true;
        }
    }
    if format.is_empty() {
        return Err("The archive format could not be identified.".to_owned());
    }
    let mut members = BTreeMap::new();
    let mut omitted = 0;
    let mut record = Vec::new();
    for line in lines.chain(std::iter::once("")) {
        if !line.is_empty() {
            record.push(line);
            continue;
        }
        if record.is_empty() {
            continue;
        }
        let field = |name: &str| -> Option<&str> {
            record
                .iter()
                .filter_map(|line| line.split_once(" = "))
                .find_map(|(key, value)| (key == name).then_some(value))
        };
        if let Some(raw) = field("Path") {
            encrypted |= field("Encrypted") == Some("+");
            if let Some(segments) = safe_segments(raw) {
                let attributes = field("Attributes").unwrap_or_default();
                let directory = field("Folder") == Some("+")
                    || attributes.starts_with('D')
                    || raw.ends_with(['/', '\\']);
                let link = field("Symbolic Link").is_some_and(|value| !value.is_empty())
                    || field("Hard Link").is_some_and(|value| !value.is_empty())
                    || field("Mode").is_some_and(|value| value.starts_with('l'))
                    || attributes
                        .split_whitespace()
                        .any(|value| value.starts_with('l'));
                let member = Member {
                    raw: Some(raw.to_owned()),
                    directory,
                    link,
                    size: field("Size")
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(0),
                    crc: field("CRC").map(ToOwned::to_owned),
                };
                let invalid_parent = (1..segments.len()).any(|count| {
                    members
                        .get(&segments[..count])
                        .is_some_and(|parent: &Member| !parent.directory || parent.link)
                });
                if !invalid_parent
                    && !members
                        .get(&segments)
                        .is_some_and(|entry: &Member| entry.raw.is_some())
                {
                    for count in 1..segments.len() {
                        members.entry(segments[..count].to_vec()).or_insert(Member {
                            raw: None,
                            directory: true,
                            link: false,
                            size: 0,
                            crc: None,
                        });
                    }
                    members.insert(segments, member);
                } else {
                    omitted += 1;
                }
            } else {
                omitted += 1;
            }
        }
        record.clear();
    }
    Ok(Index {
        members,
        format,
        encrypted,
        omitted,
    })
}

fn safe_segments(path: &str) -> Option<Vec<String>> {
    let path = path.trim_end_matches(['/', '\\']);
    if path.is_empty()
        || path.contains(['\0', '\r', '\n'])
        || path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic()
    {
        return None;
    }
    path.split(['/', '\\'])
        .map(|part| local::name_component(part).ok().map(|_| part.to_owned()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_archive_member_names_and_infers_virtual_folders() {
        let archive = parse_index("Type = zip\n----------\nPath = docs/readme.md\nSize = 3\n\nPath = ../outside\nSize = 4\n\nPath = C:\\outside\nSize = 4\n\nPath = /etc/example\nSize = 4\n").unwrap();
        assert_eq!(archive.omitted, 3);
        assert_eq!(archive.members.len(), 2);
        assert!(archive.members[&["docs".to_owned()][..]].directory);
    }

    #[test]
    fn lists_extracts_and_updates_supported_archives() {
        if std::env::var("DIRLUME_VERIFY_ARCHIVES").as_deref() != Ok("1") {
            return;
        }
        let engine = Engine::find().unwrap();
        let formats = engine.formats().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let input = fixture.path().join("input");
        fs::create_dir_all(input.join("docs")).unwrap();
        fs::write(input.join("docs/note.txt"), b"archive fixture").unwrap();
        fs::write(input.join("keep.txt"), b"keep me").unwrap();
        let list = archive_engine::list_file(fixture.path(), ["docs", "keep.txt"]).unwrap();
        let note = ["docs".to_owned(), "note.txt".to_owned()];
        let keep = ["keep.txt".to_owned()];
        for kind in ["zip", "tar", "7z"] {
            assert!(formats.iter().any(|available| available == kind));
            let path = fixture.path().join(format!("test.{kind}"));
            let mut command = engine.command("a");
            command
                .current_dir(&input)
                .arg(format!("-t{kind}"))
                .arg(archive_engine::at("-i@", &list));
            archive_args(&mut command, &path);
            archive_engine::run(&mut command, None, io::sink(), |_| Ok(()))
                .unwrap()
                .checked(false)
                .unwrap();
            let mut archive = Archive::open(path.clone(), None).unwrap();
            assert_eq!(archive.list(&[]).unwrap().entries.len(), 2);
            let extract = |archive: &Archive, name: &[String]| {
                archive
                    .extract(archive.file(name).unwrap(), Vec::new(), |_| Ok(()))
                    .unwrap()
            };
            assert_eq!(extract(&archive, &note), b"archive fixture");
            assert_eq!(archive.byte_page(&note, 3).unwrap().data, b"hive fixture");
            assert_eq!(archive.byte_page(&note, 8).unwrap().data, b"fixture");
            let target = fixture.path().join("existing");
            fs::write(&target, "keep").unwrap();
            let options = Options {
                moving: false,
                policy: crate::local_transfer::Policy::Skip,
                ask_read_only: false,
                copy: Default::default(),
            };
            assert!(!archive
                .copy_to(
                    &note,
                    &target,
                    &options,
                    |_, _, _| panic!("must skip before extraction"),
                    |_| panic!("unexpected question")
                )
                .unwrap());
            archive
                .write(&[note.clone().to_vec()], Some(b"updated text".to_vec()))
                .unwrap();
            assert!(archive.byte_cache.is_none());
            assert_eq!(archive.byte_page(&note, 0).unwrap().data, b"updated text");
            assert_eq!(extract(&archive, &note), b"updated text");
            assert_eq!(extract(&archive, &keep), b"keep me");
            archive.write(&[keep.to_vec()], None).unwrap();
            let reopened = Archive::open(path, None).unwrap();
            assert!(reopened.file(&keep).is_err());
            assert_eq!(extract(&reopened, &note), b"updated text");
        }
    }
}
