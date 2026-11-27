use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    ops::Range,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
};

use ring::digest::{Context, Digest, SHA256};
use tauri::State;

use crate::{
    archives::Archive,
    desktop::{self, Encoding, TEXT_LIMIT},
    ftp, local,
    local_transfer::FileRevision,
    message, remote_transfer, ssh, Result as AppResult,
};

const PAGE_BYTES: u64 = 128 * 1024;
const CHANGED: &str = "The file changed on disk. Reopen it before saving.";

#[derive(Default)]
pub(crate) struct Documents {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Arc<Mutex<Document>>>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageInfo {
    pub(crate) id: u32,
    pub(crate) encoding: Encoding,
    pub(crate) length: u64,
    pub(crate) page_count: u64,
}

impl Documents {
    pub(crate) fn insert(&self, document: Document) -> AppResult<PageInfo> {
        let key = self.next.fetch_add(1, Ordering::Relaxed);
        let info = document.pages.info(key);
        self.sessions
            .lock()
            .map_err(message)?
            .insert(key, Arc::new(Mutex::new(document)));
        Ok(info)
    }

    fn get(&self, id: u32) -> AppResult<Arc<Mutex<Document>>> {
        self.sessions
            .lock()
            .map_err(message)?
            .get(&id)
            .cloned()
            .ok_or_else(|| "The text document is closed.".into())
    }
}

#[tauri::command]
pub(crate) async fn open_local_text_pages(
    directory: String,
    name: String,
    editing: bool,
    state: State<'_, Documents>,
) -> AppResult<Option<PageInfo>> {
    let document = desktop::blocking_for("open_local_text_pages", move || {
        let path = desktop::selected(&directory, &name).map_err(message)?;
        Document::open_local(path, editing)
    })
    .await?;
    document.map(|document| state.insert(document)).transpose()
}

#[tauri::command]
pub(crate) async fn open_ftp_text_pages(
    id: u32,
    segments: Vec<String>,
    editing: bool,
    ftp: State<'_, ftp::FtpState>,
    state: State<'_, Documents>,
) -> AppResult<Option<PageInfo>> {
    let connection = ftp.connection(id)?;
    let document = desktop::blocking_for("open_ftp_text_pages", move || {
        let mut session = connection.open()?;
        let before = session.regular(&segments)?;
        if before.size() as u64 <= TEXT_LIMIT {
            return Ok(None);
        }
        let (file, baseline) = snapshot(editing, |writer| {
            session.download(&segments, writer, |_| Ok(()))
        })?;
        if before != session.regular(&segments)?
            || before.size() as u64 != file.metadata().map_err(message)?.len()
        {
            return Err("The FTP file changed while it was being opened.".into());
        }
        Document::new(Source::Ftp(connection, segments), file, baseline).map(Some)
    })
    .await?;
    document.map(|document| state.insert(document)).transpose()
}

#[tauri::command]
pub(crate) async fn open_ssh_text_pages(
    id: u32,
    segments: Vec<String>,
    editing: bool,
    sudo_password: Option<String>,
    ssh: State<'_, ssh::SshState>,
    state: State<'_, Documents>,
) -> AppResult<Option<PageInfo>> {
    let connection = ssh.connection(id)?;
    let document = desktop::blocking_for("open_ssh_text_pages", move || {
        let sudo = sudo_password.map(zeroize::Zeroizing::new);
        let result = connection.text_operation(sudo, true, |session| {
            let before = session.regular(&segments)?;
            let length = remote_transfer::Entry::size(&before)
                .ok_or("The SSH server did not report the file size.")?;
            if length <= TEXT_LIMIT {
                return Ok(None);
            }
            let mut file = tempfile::tempfile()?;
            let baseline = if editing {
                let mut writer = HashWriter {
                    writer: &mut file,
                    digest: Context::new(&SHA256),
                };
                session.download_file(&segments, &mut writer, |_| Ok(()))?;
                Some(writer.digest.finish())
            } else {
                session.download_file(&segments, &mut file, |_| Ok(()))?;
                None
            };
            if session.regular(&segments)? != before
                || length != file.metadata().map_err(message)?.len()
            {
                return Err("The SSH file changed while it was being opened.".into());
            }
            Ok(Some((file, baseline)))
        })?;
        result
            .map(|(file, baseline)| {
                Document::new(Source::Ssh(connection, segments), file, baseline)
            })
            .transpose()
    })
    .await?;
    document.map(|document| state.insert(document)).transpose()
}

#[tauri::command]
pub(crate) async fn read_text_page(
    id: u32,
    index: u64,
    state: State<'_, Documents>,
) -> AppResult<TextPage> {
    let session = state.get(id)?;
    desktop::blocking_for("read_text_page", move || {
        session
            .lock()
            .map_err(message)?
            .pages
            .page(index)
            .map_err(message)
    })
    .await
}

#[tauri::command]
pub(crate) async fn edit_text_page(
    id: u32,
    index: u64,
    text: String,
    state: State<'_, Documents>,
) -> AppResult<bool> {
    let session = state.get(id)?;
    desktop::blocking_for("edit_text_page", move || {
        let mut document = session.lock().map_err(message)?;
        if document.baseline.is_none() {
            return Err("The text document is read-only.".into());
        }
        document.pages.replace(index, &text).map_err(message)
    })
    .await
}

#[tauri::command]
pub(crate) async fn save_text_pages(
    id: u32,
    sudo_password: Option<String>,
    state: State<'_, Documents>,
) -> AppResult<PageInfo> {
    let session = state.get(id)?;
    desktop::blocking_for("save_text_pages", move || {
        let mut document = session.lock().map_err(message)?;
        document.save(sudo_password.map(zeroize::Zeroizing::new))?;
        Ok(document.pages.info(id))
    })
    .await
}

#[tauri::command]
pub(crate) fn close_text_pages(id: u32, state: State<'_, Documents>) -> AppResult<()> {
    state.sessions.lock().map_err(message)?.remove(&id);
    Ok(())
}

pub(crate) enum Source {
    Local(PathBuf),
    Ftp(Arc<ftp::Connection>, Vec<String>),
    Ssh(Arc<ssh::Connection>, Vec<String>),
    Archive(Arc<Mutex<Archive>>, Vec<String>, String),
    ReadOnly,
}

pub(crate) struct Document {
    source: Source,
    pages: TextPages,
    baseline: Option<Digest>,
}

impl Document {
    fn open_local(path: PathBuf, editing: bool) -> AppResult<Option<Self>> {
        let mut file = desktop::open_regular_file(&path)?;
        let metadata = file.metadata().map_err(message)?;
        if metadata.len() <= TEXT_LIMIT {
            return Ok(None);
        }
        let (file, baseline) = if editing {
            let revision = FileRevision::capture(&path, &metadata).map_err(message)?;
            let mut snapshot = tempfile::tempfile().map_err(message)?;
            let digest = copy_and_hash(&mut file, &mut snapshot).map_err(message)?;
            revision.verify(&path).map_err(message)?;
            (snapshot, Some(digest))
        } else {
            (file, None)
        };
        Self::new(Source::Local(path), file, baseline).map(Some)
    }

    pub(crate) fn new(source: Source, file: File, baseline: Option<Digest>) -> AppResult<Self> {
        Ok(Self {
            source,
            pages: TextPages::open(file).map_err(message)?,
            baseline,
        })
    }

    fn save(&mut self, sudo_password: Option<zeroize::Zeroizing<String>>) -> AppResult<()> {
        let expected = self
            .baseline
            .as_ref()
            .ok_or("The text document is read-only.")?;
        if self.pages.edits.is_empty() {
            return Ok(());
        }
        let (mut snapshot, digest) =
            snapshot(true, |writer| self.pages.write_to(writer).map_err(message))?;
        // Build the replacement view before publishing, leaving the original edit session intact on failures.
        let pages = TextPages::open(snapshot.try_clone().map_err(message)?).map_err(message)?;
        snapshot.seek(SeekFrom::Start(0)).map_err(message)?;
        match &mut self.source {
            Source::Local(path) => save_local(path, &mut snapshot, expected)?,
            Source::Ftp(connection, segments) => {
                save_ftp(connection, segments, &mut snapshot, expected)?
            }
            Source::Ssh(connection, segments) => {
                save_ssh(connection, segments, &mut snapshot, expected, sudo_password)?
            }
            Source::Archive(archive, segments, revision) => {
                let mut archive = archive.lock().map_err(message)?;
                let length = snapshot.metadata().map_err(message)?.len();
                *revision = archive.save_paged_member(
                    segments,
                    revision,
                    &mut snapshot,
                    length,
                    expected,
                    digest.as_ref().expect("editing snapshot digest"),
                )?;
            }
            Source::ReadOnly => return Err("The text document is read-only.".into()),
        }
        self.pages = pages;
        self.baseline = digest;
        Ok(())
    }
}

fn save_local(path: &Path, snapshot: &mut File, expected: &Digest) -> AppResult<()> {
    let _guard = desktop::lock_local_save(path)?;
    let metadata = fs::symlink_metadata(path).map_err(message)?;
    let revision = FileRevision::capture(path, &metadata).map_err(message)?;
    fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(message)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o6000 != 0 {
            return Err("Edit this file with a tool that supports special permissions.".into());
        }
    }
    let parent = path.parent().ok_or("Choose a parent folder.")?;
    let workspace = local::staging_directory(parent).map_err(message)?;
    let mut staged = tempfile::NamedTempFile::new_in(workspace.path()).map_err(message)?;
    #[cfg(windows)]
    local::preserve_access(path, staged.path(), &metadata).map_err(message)?;
    io::copy(snapshot, &mut staged).map_err(message)?;
    #[cfg(unix)]
    local::preserve_access(path, staged.path(), &metadata).map_err(message)?;
    staged.as_file().sync_all().map_err(message)?;
    let mut current = desktop::open_regular_file(path)?;
    let on_disk = copy_and_hash(&mut current, io::sink()).map_err(message)?;
    drop(current);
    if on_disk.as_ref() != expected.as_ref() {
        return Err(CHANGED.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let current = fs::symlink_metadata(path).map_err(message)?;
        if (current.ctime(), current.ctime_nsec()) != (metadata.ctime(), metadata.ctime_nsec()) {
            return Err(CHANGED.into());
        }
    }
    revision.verify(path).map_err(message)?;
    desktop::publish_local_replacement(path, staged)
}

fn save_ftp(
    connection: &ftp::Connection,
    segments: &[String],
    snapshot: &mut File,
    expected: &Digest,
) -> AppResult<()> {
    let mut session = connection.open()?;
    let original = session.regular(segments)?;
    let stage = session.upload_to_stage(segments, snapshot, |_| Ok(()))?;
    let outcome = (|| {
        let actual = hash(|writer| session.download(segments, writer, |_| Ok(())))?;
        if actual.as_ref() != expected.as_ref() || session.regular(segments)? != original {
            return Err("The FTP file changed on the server. Reopen it before saving.".into());
        }
        session.rename_stage(&stage, segments)
    })();
    if outcome.is_err() {
        session.remove_stage(&stage);
    }
    outcome
}

fn save_ssh(
    connection: &ssh::Connection,
    segments: &[String],
    snapshot: &mut File,
    expected: &Digest,
    sudo_password: Option<zeroize::Zeroizing<String>>,
) -> AppResult<()> {
    let snapshot: &File = snapshot;
    connection.text_operation(sudo_password, false, |session| {
        let mut content = snapshot.try_clone()?;
        content.seek(SeekFrom::Start(0))?;
        let original = session.regular(segments)?;
        session.replace_text(segments, &original, content, |session| {
            let mut writer = HashWriter {
                writer: io::sink(),
                digest: Context::new(&SHA256),
            };
            session.download_file(segments, &mut writer, |_| Ok(()))?;
            let actual = writer.digest.finish();
            if actual.as_ref() != expected.as_ref() || session.regular(segments)? != original {
                return Err("The SSH file changed on the server. Reopen it before saving.".into());
            }
            Ok(())
        })
    })
}

pub(crate) fn snapshot(
    editing: bool,
    write: impl FnOnce(&mut (dyn Write + Send)) -> AppResult<()>,
) -> AppResult<(File, Option<Digest>)> {
    let mut file = tempfile::tempfile().map_err(message)?;
    let digest = if editing {
        let mut output = HashWriter {
            writer: &mut file,
            digest: Context::new(&SHA256),
        };
        write(&mut output)?;
        Some(output.digest.finish())
    } else {
        write(&mut file)?;
        None
    };
    Ok((file, digest))
}

pub(crate) fn hash(
    write: impl FnOnce(&mut (dyn Write + Send)) -> AppResult<()>,
) -> AppResult<Digest> {
    let mut output = HashWriter {
        writer: io::sink(),
        digest: Context::new(&SHA256),
    };
    write(&mut output)?;
    Ok(output.digest.finish())
}

struct HashWriter<W> {
    writer: W,
    digest: Context,
}

impl<W: Write> Write for HashWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let written = self.writer.write(bytes)?;
        self.digest.update(&bytes[..written]);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

fn copy_and_hash(mut source: impl Read, destination: impl Write) -> io::Result<Digest> {
    let mut output = HashWriter {
        writer: destination,
        digest: Context::new(&SHA256),
    };
    io::copy(&mut source, &mut output)?;
    Ok(output.digest.finish())
}

#[derive(serde::Serialize)]
pub(crate) struct TextPage {
    pub(crate) text: String,
    pub(crate) original: Range<u64>,
}

pub(crate) struct TextPages {
    original: File,
    encoding: Encoding,
    bytes: u64,
    bom_bytes: u64,
    edited: Option<File>,
    edits: BTreeMap<u64, Range<u64>>,
}

impl TextPages {
    pub(crate) fn open(mut original: File) -> io::Result<Self> {
        original.seek(SeekFrom::Start(0))?;
        let bytes = original.metadata()?.len();
        let mut prefix = Vec::new();
        (&mut original).take(3).read_to_end(&mut prefix)?;
        let (encoding, bom_bytes) = match prefix.as_slice() {
            [0xef, 0xbb, 0xbf] => (Encoding::Utf8Bom, 3),
            [0xff, 0xfe, ..] => (Encoding::Utf16Le, 2),
            [0xfe, 0xff, ..] => (Encoding::Utf16Be, 2),
            _ => (Encoding::Utf8, 0),
        };
        Ok(Self {
            original,
            encoding,
            bytes,
            bom_bytes,
            edited: None,
            edits: BTreeMap::new(),
        })
    }

    fn info(&self, id: u32) -> PageInfo {
        PageInfo {
            id,
            encoding: self.encoding,
            length: self.bytes,
            page_count: self.page_count(),
        }
    }

    pub(crate) fn page_count(&self) -> u64 {
        (self.bytes - self.bom_bytes).div_ceil(PAGE_BYTES).max(1)
    }

    pub(crate) fn page(&mut self, index: u64) -> io::Result<TextPage> {
        let original = self.bounds(index)?;
        let data = if let Some(range) = self.edits.get(&index) {
            read_range(self.edited.as_mut().expect("edit file"), range.clone())?
        } else {
            read_range(&mut self.original, original.clone())?
        };
        let text = self.decode(data)?;
        Ok(TextPage { text, original })
    }

    pub(crate) fn replace(&mut self, index: u64, text: &str) -> io::Result<bool> {
        let bounds = self.bounds(index)?;
        let original = read_range(&mut self.original, bounds)?;
        let original = self.decode(original)?;
        if original == text {
            self.edits.remove(&index);
        } else {
            if text.contains('\0') {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "The text contains a NUL character.",
                ));
            }
            if self.edited.is_none() {
                self.edited = Some(tempfile::tempfile()?);
            }
            let file = self.edited.as_mut().expect("edit file");
            let offset = file.seek(SeekFrom::End(0))?;
            match self.encoding {
                Encoding::Utf8 | Encoding::Utf8Bom => file.write_all(text.as_bytes())?,
                Encoding::Utf16Le | Encoding::Utf16Be => {
                    let mut writer = io::BufWriter::new(&mut *file);
                    for word in text.encode_utf16() {
                        writer.write_all(&word_bytes(self.encoding, word))?;
                    }
                    writer.flush()?;
                }
            }
            self.edits.insert(index, offset..file.stream_position()?);
        }
        if self.edits.is_empty() {
            self.edited = None;
        }
        Ok(!self.edits.is_empty())
    }

    pub(crate) fn write_to(&mut self, mut destination: impl Write) -> io::Result<()> {
        let mut cursor = 0;
        let changes: Vec<_> = self
            .edits
            .iter()
            .map(|(&index, bytes)| (index, bytes.clone()))
            .collect();
        for (index, replacement) in changes {
            let bounds = self.bounds(index)?;
            copy_range(&mut self.original, cursor..bounds.start, &mut destination)?;
            copy_range(
                self.edited.as_mut().expect("edit file"),
                replacement,
                &mut destination,
            )?;
            cursor = bounds.end;
        }
        copy_range(&mut self.original, cursor..self.bytes, &mut destination)
    }

    fn bounds(&mut self, index: u64) -> io::Result<Range<u64>> {
        if index >= self.page_count() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "The text page is outside the file.",
            ));
        }
        let start = self.boundary(self.bom_bytes + index * PAGE_BYTES)?;
        let end = self.boundary(
            self.bom_bytes
                .saturating_add((index + 1).saturating_mul(PAGE_BYTES)),
        )?;
        Ok(start..end)
    }

    fn boundary(&mut self, offset: u64) -> io::Result<u64> {
        if offset <= self.bom_bytes || offset >= self.bytes {
            return Ok(offset.min(self.bytes));
        }
        match self.encoding {
            Encoding::Utf8 | Encoding::Utf8Bom => {
                let data =
                    read_range(&mut self.original, offset - 1..(offset + 4).min(self.bytes))?;
                let previous = data[0];
                if previous == b'\r' && data[1] == b'\n' {
                    return Ok(offset + 1);
                }
                let continuation = data[1..]
                    .iter()
                    .take_while(|byte| **byte & 0xc0 == 0x80)
                    .count();
                if continuation > 3 {
                    return Err(invalid_text());
                }
                Ok(offset + continuation as u64)
            }
            Encoding::Utf16Le | Encoding::Utf16Be => {
                let data =
                    read_range(&mut self.original, offset - 2..(offset + 2).min(self.bytes))?;
                let [last_a, last_b, next_a, next_b] = data.as_slice() else {
                    return Err(invalid_text());
                };
                let last = read_word(self.encoding, [*last_a, *last_b]);
                let next = read_word(self.encoding, [*next_a, *next_b]);
                let surrogate =
                    (0xd800..=0xdbff).contains(&last) && (0xdc00..=0xdfff).contains(&next);
                Ok(if surrogate || (last == 13 && next == 10) {
                    offset + 2
                } else {
                    offset
                })
            }
        }
    }

    fn decode(&self, bytes: Vec<u8>) -> io::Result<String> {
        let text = match self.encoding {
            Encoding::Utf8 | Encoding::Utf8Bom => {
                String::from_utf8(bytes).map_err(|_| invalid_text())?
            }
            Encoding::Utf16Le | Encoding::Utf16Be => {
                let (words, remainder) = bytes.as_chunks::<2>();
                if !remainder.is_empty() {
                    return Err(invalid_text());
                }
                char::decode_utf16(words.iter().map(|&pair| read_word(self.encoding, pair)))
                    .collect::<Result<_, _>>()
                    .map_err(|_| invalid_text())?
            }
        };
        if text.contains('\0') {
            return Err(invalid_text());
        }
        Ok(text)
    }
}

fn read_word(encoding: Encoding, bytes: [u8; 2]) -> u16 {
    if encoding == Encoding::Utf16Le {
        u16::from_le_bytes(bytes)
    } else {
        u16::from_be_bytes(bytes)
    }
}

fn word_bytes(encoding: Encoding, word: u16) -> [u8; 2] {
    if encoding == Encoding::Utf16Le {
        word.to_le_bytes()
    } else {
        word.to_be_bytes()
    }
}

fn invalid_text() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "The file is outside the supported UTF-8 and UTF-16 text formats.",
    )
}

fn read_range(file: &mut File, range: Range<u64>) -> io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(range.start))?;
    let length = usize::try_from(range.end - range.start).map_err(io::Error::other)?;
    let mut result = vec![0; length];
    file.read_exact(&mut result)?;
    Ok(result)
}

fn copy_range(file: &mut File, range: Range<u64>, destination: &mut impl Write) -> io::Result<()> {
    file.seek(SeekFrom::Start(range.start))?;
    let expected = range.end - range.start;
    if io::copy(&mut file.take(expected), destination)? != expected {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "The file changed while it was being saved.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_large_local_edits_atomically_and_keeps_an_external_change() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.txt");
        let length = TEXT_LIMIT + 2;
        {
            let mut file = File::create(&path).unwrap();
            io::copy(&mut io::repeat(b'x').take(length), &mut file).unwrap();
        }
        let mut document = Document::open_local(path.clone(), true).unwrap().unwrap();
        let middle = document.pages.page_count() / 2;
        let last = document.pages.page_count() - 1;
        for (index, value) in [(0, "start"), (middle, "middle"), (last, "end")] {
            let mut page = document.pages.page(index).unwrap().text;
            page.push_str(value);
            assert!(document.pages.replace(index, &page).unwrap());
        }
        document.save(None).unwrap();
        assert_eq!(document.pages.bytes, length + 14);
        let mut saved = File::open(&path).unwrap();
        let first = read_range(&mut saved, PAGE_BYTES - 2..PAGE_BYTES + 7).unwrap();
        assert_eq!(first, b"xxstartxx");
        let middle_end = (middle + 1) * PAGE_BYTES + 5;
        assert_eq!(
            read_range(&mut saved, middle_end..middle_end + 8).unwrap(),
            b"middlexx"
        );
        assert_eq!(
            read_range(&mut saved, length + 9..length + 14).unwrap(),
            b"xxend"
        );
        drop(saved);

        assert!(document.pages.replace(0, "would overwrite").unwrap());
        let mut outside = fs::OpenOptions::new().write(true).open(&path).unwrap();
        outside.write_all(b"outside").unwrap();
        drop(outside);
        assert_eq!(document.save(None).unwrap_err(), CHANGED);
        let mut file = File::open(&path).unwrap();
        assert_eq!(read_range(&mut file, 0..7).unwrap(), b"outside");
    }

    #[test]
    fn retains_utf8_bom_and_does_not_split_characters_or_crlf_between_pages() {
        let mut source = tempfile::tempfile().unwrap();
        let prefix = "x".repeat(PAGE_BYTES as usize - 1);
        write!(source, "\u{feff}{prefix}🦊").unwrap();
        source
            .write_all(&vec![b'y'; PAGE_BYTES as usize - 4])
            .unwrap();
        source.write_all(b"\r\nlast").unwrap();
        let mut document = TextPages::open(source).unwrap();
        assert!(document.encoding == Encoding::Utf8Bom);
        assert_eq!(document.page_count(), 3);
        assert_eq!(document.page(0).unwrap().text, prefix + "🦊");
        assert!(document.page(1).unwrap().text.ends_with("\r\n"));
        assert_eq!(document.page(2).unwrap().text, "last");
        assert!(document.replace(2, "updated").unwrap());
        let mut output = Vec::new();
        document.write_to(&mut output).unwrap();
        assert!(output.starts_with(&[0xef, 0xbb, 0xbf]));
        assert!(output.ends_with(b"\r\nupdated"));
        assert_eq!(output.len() as u64, document.bytes + 3);
    }

    #[test]
    fn retains_both_utf16_encodings_and_keeps_surrogate_pairs_together() {
        for encoding in [Encoding::Utf16Le, Encoding::Utf16Be] {
            let mut source = tempfile::tempfile().unwrap();
            let first = "x".repeat(PAGE_BYTES as usize / 2 - 1) + "🦊";
            let remainder = "\r\nlast";
            let original = first.clone() + remainder;
            source
                .write_all(&crate::desktop::encode_text(encoding, &original))
                .unwrap();
            let mut document = TextPages::open(source).unwrap();
            assert!(document.encoding == encoding);
            assert_eq!(document.page(0).unwrap().text, first);
            assert_eq!(document.page(1).unwrap().text, remainder);
            assert!(document.replace(1, "\r\nchanged").unwrap());
            let mut output = Vec::new();
            document.write_to(&mut output).unwrap();
            assert_eq!(
                output,
                crate::desktop::encode_text(encoding, &(first + "\r\nchanged"))
            );
        }
    }

    #[test]
    #[ignore = "writes a 2 GiB temporary file"]
    fn reads_the_beginning_middle_and_end_of_a_multi_gigabyte_text_file() {
        let mut source = tempfile::tempfile().unwrap();
        let half = 1024 * 1024 * 1024;
        source.write_all(b"start\r\n").unwrap();
        io::copy(&mut io::repeat(b'x').take(half - 7), &mut source).unwrap();
        source.write_all(b"middle\r\n").unwrap();
        io::copy(&mut io::repeat(b'y').take(half - 8), &mut source).unwrap();
        source.write_all(b"end\r\n").unwrap();
        let mut document = TextPages::open(source).unwrap();
        assert!(document.page(0).unwrap().text.starts_with("start\r\n"));
        assert!(document
            .page(half / PAGE_BYTES)
            .unwrap()
            .text
            .starts_with("middle\r\n"));
        assert_eq!(
            document.page(document.page_count() - 1).unwrap().text,
            "end\r\n"
        );
    }

    #[test]
    fn retains_existing_document_handling_at_and_just_below_the_paging_threshold() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("threshold.txt");
        for length in [TEXT_LIMIT - 1, TEXT_LIMIT, TEXT_LIMIT + 1] {
            let file = File::create(&path).unwrap();
            file.set_len(length).unwrap();
            drop(file);
            assert_eq!(
                Document::open_local(path.clone(), false).unwrap().is_some(),
                length > TEXT_LIMIT
            );
        }
    }
}
