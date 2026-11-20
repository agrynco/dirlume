use std::{
    collections::HashMap,
    fs,
    io::{self, Read, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use suppaftp::{
    list::{File, ListParser},
    types::FileType,
    FtpError, FtpStream, Mode, Status,
};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use uuid::Uuid;

use crate::{
    desktop::{blocking, message, Result},
    local,
    protocol::RemoteListing,
};

const TIMEOUT: Duration = Duration::from_secs(12);
const MAX_DEPTH: usize = 128;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    id: Uuid,
    label: String,
    host: String,
    port: u16,
    username: String,
    code_page: Option<u16>,
}

#[derive(Deserialize, Serialize)]
struct SavedProfile {
    #[serde(flatten)]
    profile: Profile,
    credential: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    id: Option<Uuid>,
    label: String,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    code_page: Option<u16>,
}

#[derive(Default)]
pub struct FtpState {
    connections: Mutex<HashMap<u32, Arc<Connection>>>,
    searches: Mutex<HashMap<u32, Arc<AtomicBool>>>,
    next: AtomicU32,
}

impl FtpState {
    pub fn connection(&self, id: u32) -> Result<Arc<Connection>> {
        self.connections
            .lock()
            .map_err(message)?
            .get(&id)
            .cloned()
            .ok_or_else(|| "Connect to the FTP server first.".to_owned())
    }
}

fn profiles_path(app: &AppHandle) -> Result<PathBuf> {
    #[cfg(all(windows, feature = "ui-automation"))]
    if let Some(path) = std::env::var_os("DIRLUME_FTP_TEST_CONFIG")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        return Ok(path.join("ftp-profiles.json"));
    }
    Ok(app
        .path()
        .app_config_dir()
        .map_err(message)?
        .join("ftp-profiles.json"))
}

fn load_profiles(path: &Path) -> Result<Vec<SavedProfile>> {
    match fs::File::open(path) {
        Ok(file) => serde_json::from_reader(file).map_err(message),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(message(error)),
    }
}

fn lock_profiles(path: &Path) -> Result<fs::File> {
    let parent = path
        .parent()
        .ok_or("The FTP profile folder is unavailable.")?;
    fs::create_dir_all(parent).map_err(message)?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("lock"))
        .map_err(message)?;
    lock.lock().map_err(message)?;
    Ok(lock)
}

fn persist_profiles(path: &Path, profiles: &[SavedProfile]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or("The FTP profile folder is unavailable.")?;
    fs::create_dir_all(parent).map_err(message)?;
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(message)?;
    serde_json::to_writer_pretty(staged.as_file_mut(), profiles).map_err(message)?;
    staged.as_file().sync_all().map_err(message)?;
    staged.persist(path).map_err(message)?;
    Ok(())
}

fn credential(key: &str) -> Result<keyring::Entry> {
    keyring::Entry::new("Dirlume FTP", key).map_err(message)
}

fn delete_credential(key: &str) {
    let _ = credential(key).and_then(|entry| entry.delete_credential().map_err(message));
}

#[tauri::command]
pub fn ftp_windows_code_page() -> Option<u16> {
    #[cfg(windows)]
    {
        // GetACP reads the process system code page and takes no arguments.
        u16::try_from(unsafe { windows_sys::Win32::Globalization::GetACP() }).ok()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[tauri::command]
pub async fn ftp_profiles(app: AppHandle) -> Result<Vec<Profile>> {
    let path = profiles_path(&app)?;
    blocking(move || {
        let _lock = lock_profiles(&path)?;
        Ok(load_profiles(&path)?
            .into_iter()
            .map(|item| item.profile)
            .collect())
    })
    .await
}

fn safe_argument(text: &str) -> bool {
    !text.contains(['\r', '\n', '\0'])
}

#[tauri::command]
pub async fn save_ftp_profile(input: ProfileInput, app: AppHandle) -> Result<Uuid> {
    let path = profiles_path(&app)?;
    blocking(move || {
        let label = input.label.trim().to_owned();
        let host = input.host.trim().trim_start_matches('[').trim_end_matches(']').to_owned();
        let username = input.username.trim().to_owned();
        if label.is_empty() || host.is_empty() || input.port == 0
            || host.contains(['/', '\\', '@', '?', '#']) || host.chars().any(char::is_whitespace)
            || !safe_argument(&username) || input.password.as_deref().is_some_and(|password| !safe_argument(password)) {
            return Err("Enter a connection name, server host, port, and valid credentials.".to_owned());
        }
        if input.code_page.is_some_and(|page| codepage::to_encoding_no_replacement(page).is_none()) {
            return Err("Enter a supported Windows code page or use UTF-8.".to_owned());
        }
        let _lock = lock_profiles(&path)?;
        let mut saved = load_profiles(&path)?;
        let index = input.id.map(|id| saved.iter().position(|item| item.profile.id == id)
            .ok_or_else(|| "This FTP profile was removed.".to_owned())).transpose()?;
        let previous = index.map(|index| &saved[index]);
        let mut key = previous.filter(|old| old.profile.host == host && old.profile.port == input.port
            && old.profile.username == username).and_then(|old| old.credential.clone());
        let updated_key = if let Some(password) = input.password {
            key = None;
            if password.is_empty() {
                None
            } else {
                let updated_key = Uuid::new_v4().to_string();
                credential(&updated_key)?.set_password(&password)
                    .map_err(|error| format!("Could not save the FTP password in the system credential store: {error}"))?;
                key = Some(updated_key.clone());
                Some(updated_key)
            }
        } else {
            None
        };
        let old_key = previous.and_then(|old| old.credential.clone()).filter(|old| Some(old) != key.as_ref());
        let id = input.id.unwrap_or_else(Uuid::new_v4);
        let item = SavedProfile {
            profile: Profile { id, label, host, port: input.port, username, code_page: input.code_page.filter(|&page| page != 65001) },
            credential: key,
        };
        if let Some(index) = index { saved[index] = item; } else { saved.push(item); }
        if let Err(error) = persist_profiles(&path, &saved) {
            if let Some(key) = updated_key { delete_credential(&key); }
            return Err(error);
        }
        if let Some(key) = old_key { delete_credential(&key); }
        Ok(id)
    }).await
}

#[tauri::command]
pub async fn remove_ftp_profile(id: Uuid, app: AppHandle) -> Result<()> {
    let path = profiles_path(&app)?;
    blocking(move || {
        let _lock = lock_profiles(&path)?;
        let mut saved = load_profiles(&path)?;
        let index = saved
            .iter()
            .position(|item| item.profile.id == id)
            .ok_or("This FTP profile was removed.")?;
        let removed = saved.remove(index);
        persist_profiles(&path, &saved)?;
        if let Some(key) = removed.credential {
            delete_credential(&key);
        }
        Ok(())
    })
    .await
}

pub struct Connection {
    profile: Profile,
    password: String,
}

#[derive(Debug)]
struct LegacyEncoding(&'static encoding_rs::Encoding);

impl suppaftp::Encoding for LegacyEncoding {
    fn decode(&self, bytes: &[u8]) -> String {
        self.0.decode_without_bom_handling(bytes).0.into_owned()
    }

    fn encode(&self, text: &str) -> io::Result<Vec<u8>> {
        let (bytes, _, unrepresentable) = self.0.encode(text);
        if unrepresentable {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "The FTP server's selected encoding cannot represent this name.",
            ));
        }
        Ok(bytes.into_owned())
    }
}

fn dial(addr: SocketAddr) -> io::Result<TcpStream> {
    let stream = TcpStream::connect_timeout(&addr, TIMEOUT)?;
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    Ok(stream)
}

impl Connection {
    pub fn open(&self) -> Result<Session> {
        let control = (self.profile.host.as_str(), self.profile.port)
            .to_socket_addrs()
            .map_err(message)?
            .find_map(|addr| dial(addr).ok())
            .ok_or("Could not reach the FTP server.")?;
        let peer = control.peer_addr().map_err(message)?.ip();
        let mut stream = FtpStream::connect_with_stream(control)
            .map_err(message)?
            .passive_stream_builder(move |addr| {
                dial(SocketAddr::new(peer, addr.port())).map_err(FtpError::ConnectionError)
            });
        if peer.is_ipv6() {
            stream.set_mode(Mode::ExtendedPassive);
        }
        let user = if self.profile.username.is_empty() {
            "anonymous"
        } else {
            &self.profile.username
        };
        stream
            .login(user, &self.password)
            .map_err(|_| "FTP login failed. Check the username and password.".to_owned())?;
        if let Some(page) = self.profile.code_page {
            let encoding = codepage::to_encoding_no_replacement(page)
                .ok_or("The FTP name encoding is unavailable.")?;
            stream.set_encoding(LegacyEncoding(encoding));
            let _ = stream.opts("UTF8", Some("OFF"));
        } else {
            let _ = stream.opts("UTF8", Some("ON"));
        }
        stream.transfer_type(FileType::Binary).map_err(message)?;
        Ok(Session {
            stream,
            use_mlsd: true,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    id: u32,
    address: String,
    origin: String,
    segments: Vec<String>,
    listing: RemoteListing,
}

#[tauri::command]
pub async fn connect_ftp(
    id: Uuid,
    segments: Option<Vec<String>>,
    app: AppHandle,
    state: State<'_, FtpState>,
) -> Result<Connected> {
    let path = profiles_path(&app)?;
    let (connection, segments, listing) = blocking(move || {
        let (profile, password) = {
            let _lock = lock_profiles(&path)?;
            let item = load_profiles(&path)?.into_iter().find(|item| item.profile.id == id)
                .ok_or("This FTP profile was removed.")?;
            let password = item.credential.as_deref().map(|key| credential(key)?.get_password()
                .map_err(|error| format!("Could not read the FTP password from the system credential store: {error}")))
                .transpose()?.unwrap_or_default();
            (item.profile, password)
        };
        let connection = Arc::new(Connection { profile, password });
        let mut session = connection.open()?;
        let segments = match segments {
            Some(segments) => segments,
            None => parse_path(&session.stream.pwd().map_err(message)?)?,
        };
        let listing = session.list(&segments)?.into_listing();
        Ok((connection, segments, listing))
    }).await?;
    let address = connection.profile.label.clone();
    let host = &connection.profile.host;
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.clone()
    };
    let port = connection.profile.port;
    let origin = if port == 21 {
        format!("ftp://{host}")
    } else {
        format!("ftp://{host}:{port}")
    };
    let id = state.next.fetch_add(1, Ordering::Relaxed);
    state
        .connections
        .lock()
        .map_err(message)?
        .insert(id, connection);
    Ok(Connected {
        id,
        address,
        origin,
        segments,
        listing,
    })
}

#[tauri::command]
pub fn disconnect_ftp(id: u32, state: State<'_, FtpState>) -> Result<()> {
    state.connections.lock().map_err(message)?.remove(&id);
    Ok(())
}

pub struct Session {
    stream: FtpStream,
    use_mlsd: bool,
}

pub struct Entries {
    pub files: Vec<File>,
    omitted: usize,
}

impl Entries {
    fn into_listing(self) -> RemoteListing {
        RemoteListing {
            entries: self.files.into_iter().map(listing_entry).collect(),
            omitted: self.omitted,
        }
    }

    pub fn complete(self) -> Result<Vec<File>> {
        if self.omitted > 0 {
            return Err(
                "The FTP server returned items whose names or attributes could not be read."
                    .to_owned(),
            );
        }
        Ok(self.files)
    }
}

fn listing_entry(file: File) -> local::Entry {
    local::Entry::new(
        file.name().to_owned(),
        file.is_directory(),
        file.is_symlink(),
        local::EntryAttributes::default(),
        file.is_file().then_some(file.size() as u64),
        Some(file.modified()),
    )
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !matches!(name, "." | "..")
        && !name.contains(['/', '\\', '\u{fffd}'])
        && safe_argument(name)
}

pub fn parse_path(path: &str) -> Result<Vec<String>> {
    let path = path
        .strip_prefix('/')
        .ok_or("Enter an absolute FTP path starting with /.")?;
    let segments: Vec<_> = path
        .trim_end_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect();
    absolute(&segments)?;
    Ok(segments)
}

pub fn absolute(segments: &[String]) -> Result<String> {
    if segments.len() > MAX_DEPTH || segments.iter().any(|name| !valid_name(name)) {
        return Err("Invalid FTP file or folder path.".to_owned());
    }
    Ok(format!("/{}", segments.join("/")))
}

pub fn child(segments: &[String], name: &str) -> Vec<String> {
    let mut result = segments.to_vec();
    result.push(name.to_owned());
    result
}

fn unsupported(error: &FtpError) -> bool {
    matches!(error, FtpError::UnexpectedResponse(response) if matches!(response.status,
        Status::BadCommand | Status::BadArguments | Status::NotImplemented | Status::NotImplementedParameter))
}

impl Session {
    pub fn list(&mut self, segments: &[String]) -> Result<Entries> {
        self.stream.cwd(absolute(segments)?).map_err(message)?;
        let lines = if self.use_mlsd {
            match self.stream.mlsd(None) {
                Ok(lines) => lines,
                Err(error) if unsupported(&error) => {
                    self.use_mlsd = false;
                    self.stream.list(None).map_err(message)?
                }
                Err(error) => return Err(message(error)),
            }
        } else {
            self.stream.list(None).map_err(message)?
        };
        let mut result = Entries {
            files: Vec::new(),
            omitted: 0,
        };
        for line in lines {
            if line.is_empty() || (!self.use_mlsd && line.starts_with("total ")) {
                continue;
            }
            if self.use_mlsd
                && line.split_once(' ').is_some_and(|(facts, _)| {
                    facts.split(';').any(|fact| {
                        fact.eq_ignore_ascii_case("type=cdir")
                            || fact.eq_ignore_ascii_case("type=pdir")
                    })
                })
            {
                continue;
            }
            let parsed = if self.use_mlsd {
                ListParser::parse_mlsd(&line)
            } else {
                line.parse()
            };
            match parsed {
                Ok(file) if valid_name(file.name()) => result.files.push(file),
                Ok(file) if matches!(file.name(), "." | "..") => {}
                _ => result.omitted += 1,
            }
        }
        Ok(result)
    }

    pub fn stat(&mut self, segments: &[String]) -> Result<Option<File>> {
        let (name, parent) = segments
            .split_last()
            .ok_or("Choose an FTP file or folder.")?;
        absolute(segments)?;
        let listing = self.list(parent)?;
        let found = listing.files.into_iter().find(|file| file.name() == name);
        if found.is_none() && listing.omitted > 0 {
            return Err(
                "The FTP listing is incomplete. The destination could not be checked.".to_owned(),
            );
        }
        Ok(found)
    }

    pub fn matches_file(&mut self, segments: &[String], expected: &File) -> Result<bool> {
        if self.use_mlsd {
            // MLST may use an absolute name where the directory listing uses a bare name.
            let path = absolute(segments)?;
            if let Ok(reply) = self.stream.mlst(Some(&path)) {
                if let Some((facts, name)) = reply.split_once("; ") {
                    if (name == path || name == expected.name())
                        && ListParser::parse_mlst(&format!("{facts}; {}", expected.name()))
                            .is_ok_and(|file| file == *expected)
                    {
                        return Ok(true);
                    }
                }
            }
        }
        // Legacy servers and replies with different facts use the listing check.
        Ok(self.stat(segments)?.as_ref() == Some(expected))
    }

    pub fn folder_size(&mut self, segments: &[String], stop: &AtomicBool) -> Option<(u64, bool)> {
        if stop.load(Ordering::Relaxed) {
            return None;
        }
        let Ok(listing) = self.list(segments) else {
            return Some((0, true));
        };
        let mut bytes = 0_u64;
        let mut incomplete = listing.omitted > 0;
        for file in listing.files {
            if stop.load(Ordering::Relaxed) {
                return None;
            }
            if file.is_directory() {
                let (child_bytes, partial) =
                    self.folder_size(&child(segments, file.name()), stop)?;
                bytes = bytes.saturating_add(child_bytes);
                incomplete |= partial;
            } else if file.is_file() {
                bytes = bytes.saturating_add(file.size() as u64);
            }
        }
        Some((bytes, incomplete))
    }

    pub fn regular(&mut self, segments: &[String]) -> Result<File> {
        self.stat(segments)?
            .filter(|file| file.is_file())
            .ok_or_else(|| "Choose a regular FTP file.".to_owned())
    }

    pub fn download(
        &mut self,
        segments: &[String],
        output: &mut impl Write,
        mut progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<()> {
        let mut stream = self
            .stream
            .retr_as_stream(absolute(segments)?)
            .map_err(message)?;
        let mut buffer = vec![0; 64 * 1024];
        let mut total = 0;
        loop {
            let count = stream.read(&mut buffer).map_err(message)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count]).map_err(message)?;
            total += count as u64;
            progress(total)?;
        }
        stream.finish().map_err(message)
    }

    pub fn read_limited(
        &mut self,
        segments: &[String],
        offset: u64,
        limit: u64,
        length: u64,
    ) -> Result<Vec<u8>> {
        let count = limit.min(length.saturating_sub(offset));
        if count == 0 && (length > 0 || offset > 0) {
            return Ok(Vec::new());
        }
        if offset > 0 {
            self.stream
                .resume_transfer(usize::try_from(offset).map_err(message)?)
                .map_err(message)?;
        }
        let mut bytes = Vec::new();
        let mut stream = self
            .stream
            .retr_as_stream(absolute(segments)?)
            .map_err(message)?;
        (&mut stream)
            .take(count)
            .read_to_end(&mut bytes)
            .map_err(message)?;
        if offset + count == length {
            let mut extra = [0];
            if stream.read(&mut extra).map_err(message)? > 0 {
                return Err("The FTP file changed during the read.".to_owned());
            }
            stream.finish().map_err(message)?;
        }
        if bytes.len() as u64 != count {
            return Err("The FTP file changed during the read.".to_owned());
        }
        Ok(bytes)
    }

    pub fn upload_to_stage(
        &mut self,
        target: &[String],
        input: &mut impl Read,
        mut progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<String> {
        let (_, parent) = target
            .split_last()
            .ok_or("Choose an FTP destination file.")?;
        let stage = absolute(&child(parent, &format!(".dirlume-{}.part", Uuid::new_v4())))?;
        let result = (|| {
            let mut stream = self.stream.put_with_stream(&stage).map_err(message)?;
            let mut buffer = vec![0; 64 * 1024];
            let mut total = 0;
            loop {
                let count = input.read(&mut buffer).map_err(message)?;
                if count == 0 {
                    break;
                }
                stream.write_all(&buffer[..count]).map_err(message)?;
                total += count as u64;
                progress(total)?;
            }
            stream.finish().map_err(message)
        })();
        if let Err(error) = result {
            self.remove_stage(&stage);
            return Err(error);
        }
        Ok(stage)
    }

    pub fn remove_stage(&mut self, stage: &str) {
        let _ = self.stream.rm(stage);
    }

    pub fn rename_stage(&mut self, stage: &str, target: &[String]) -> Result<()> {
        let target = absolute(target)?;
        self.stream.rename(stage, &target).map_err(message)
    }

    pub fn mkdir(&mut self, segments: &[String]) -> Result<()> {
        self.stream.mkdir(absolute(segments)?).map_err(message)
    }

    fn remove(&mut self, segments: &[String], recursive: bool) -> Result<()> {
        let file = self
            .stat(segments)?
            .ok_or("The FTP item no longer exists.")?;
        let path = absolute(segments)?;
        if file.is_directory() {
            if recursive {
                for entry in self.list(segments)?.complete()? {
                    self.remove(&child(segments, entry.name()), true)?;
                }
            }
            self.stream.rmdir(path).map_err(message)
        } else {
            self.stream.rm(path).map_err(message)
        }
    }
}

#[tauri::command]
pub async fn list_ftp(
    id: u32,
    segments: Vec<String>,
    state: State<'_, FtpState>,
) -> Result<RemoteListing> {
    let connection = state.connection(id)?;
    blocking(move || {
        connection
            .open()?
            .list(&segments)
            .map(Entries::into_listing)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpSearchRequest {
    connection: u32,
    segments: Vec<String>,
    mask: String,
    show_hidden: bool,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FtpSearchEvent {
    Batch {
        segments: Vec<String>,
        prefix: String,
        entries: Vec<local::Entry>,
    },
    Done {
        omitted: usize,
    },
}

#[tauri::command]
pub async fn search_ftp(
    id: u32,
    request: FtpSearchRequest,
    output: Channel<FtpSearchEvent>,
    state: State<'_, FtpState>,
) -> Result<()> {
    let connection = state.connection(request.connection)?;
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut searches = state.searches.lock().map_err(message)?;
        if searches.contains_key(&id) {
            return Err("An FTP search is already running.".to_owned());
        }
        searches.insert(id, Arc::clone(&stop));
    }
    let result = blocking(move || {
        let mut session = connection.open()?;
        let search = search_session(&mut session, request, &stop, &output);
        let _ = session.stream.quit();
        search
    })
    .await;
    state.searches.lock().map_err(message)?.remove(&id);
    result
}

#[tauri::command]
pub fn cancel_ftp_search(id: u32, state: State<'_, FtpState>) -> Result<()> {
    if let Some(stop) = state.searches.lock().map_err(message)?.get(&id) {
        stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn search_session(
    session: &mut Session,
    request: FtpSearchRequest,
    stop: &AtomicBool,
    output: &Channel<FtpSearchEvent>,
) -> Result<()> {
    const BATCH_SIZE: usize = 128;
    let mask: Vec<_> = request.mask.to_lowercase().chars().collect();
    let mut omitted = 0;
    let mut pending = vec![(request.segments, String::new())];
    while let Some((segments, prefix)) = pending.pop() {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        let listing = match session.list(&segments) {
            Ok(listing) => listing,
            Err(error) if prefix.is_empty() => return Err(error),
            Err(_) => {
                omitted += 1;
                continue;
            }
        };
        omitted += listing.omitted;
        let mut matches = Vec::new();
        let send = |entries| {
            output
                .send(FtpSearchEvent::Batch {
                    segments: segments.clone(),
                    prefix: prefix.clone(),
                    entries,
                })
                .map_err(message)
        };
        for file in listing.files {
            if stop.load(Ordering::Relaxed) {
                return Ok(());
            }
            let entry = listing_entry(file);
            if entry.is_hidden() && !request.show_hidden {
                continue;
            }
            if entry.directory {
                if !entry.link {
                    pending.push((
                        child(&segments, &entry.name),
                        format!("{}{}/", prefix, entry.name),
                    ));
                }
            } else if matches_mask(&mask, &entry.name) {
                matches.push(entry);
                if matches.len() == BATCH_SIZE {
                    send(std::mem::take(&mut matches))?;
                }
            }
        }
        if !matches.is_empty() {
            send(matches)?;
        }
    }
    if !stop.load(Ordering::Relaxed) {
        output
            .send(FtpSearchEvent::Done { omitted })
            .map_err(message)?;
    }
    Ok(())
}

pub(crate) fn matches_mask(pattern: &[char], name: &str) -> bool {
    let name: Vec<_> = name.to_lowercase().chars().collect();
    let (mut index, mut next) = (0, 0);
    let mut wildcard = None;
    while index < name.len() {
        match pattern.get(next) {
            Some('*') => {
                next += 1;
                wildcard = Some((next, index));
            }
            Some(letter) if *letter == '?' || *letter == name[index] => {
                index += 1;
                next += 1;
            }
            _ => {
                let Some((after, previous)) = wildcard else {
                    return false;
                };
                index = previous + 1;
                next = after;
                wildcard = Some((after, index));
            }
        }
    }
    pattern[next..].iter().all(|&letter| letter == '*')
}

#[tauri::command]
pub async fn rename_ftp(
    id: u32,
    segments: Vec<String>,
    name: String,
    state: State<'_, FtpState>,
) -> Result<()> {
    let connection = state.connection(id)?;
    blocking(move || {
        let mut session = connection.open()?;
        let (old, parent) = segments
            .split_last()
            .ok_or("Choose an FTP file or folder.")?;
        if old == &name {
            return Ok(());
        }
        let target = child(parent, &name);
        if session.stat(&target)?.is_some() {
            return Err("An item with that name already exists.".to_owned());
        }
        session
            .stream
            .rename(absolute(&segments)?, absolute(&target)?)
            .map_err(message)
    })
    .await
}

#[tauri::command]
pub async fn delete_ftp(
    id: u32,
    segments: Vec<String>,
    recursive: bool,
    state: State<'_, FtpState>,
) -> Result<()> {
    let connection = state.connection(id)?;
    blocking(move || connection.open()?.remove(&segments, recursive)).await
}
