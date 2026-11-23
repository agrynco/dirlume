use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    ptr,
    time::{Duration, UNIX_EPOCH},
};

use serde::Deserialize;
use serde_json::json;
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB},
    Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT},
};
use zeroize::Zeroize;

use super::{
    wire::{valid_hex, Channel},
    Listing, Peer,
};
use crate::{desktop::Result, local, message};

const PORT: u16 = 45885;
const PAIRING_LIMIT: u64 = 256 * 1024;
const CHUNK_SIZE: usize = 64 * 1024;

#[derive(Deserialize)]
struct Pairing {
    version: u32,
    enabled: bool,
    id: String,
    trusted: BTreeMap<String, PairedComputer>,
}

#[derive(Deserialize)]
struct PairedComputer {
    name: String,
    key: String,
}

impl Drop for PairedComputer {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

fn running_installation() -> Option<PathBuf> {
    let mut processes = sysinfo::System::new().ok()?;
    processes.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        false,
        sysinfo::ProcessRefreshKind::nothing()
            .with_exe(sysinfo::UpdateKind::OnlyIfNotSet)
            .with_user(sysinfo::UpdateKind::OnlyIfNotSet),
    );
    let current_user = processes
        .process(sysinfo::get_current_pid().ok()?)?
        .user_id()?;
    processes
        .processes()
        .values()
        .filter(|process| process.user_id() == Some(current_user))
        .filter_map(|process| process.exe())
        .find_map(|path| {
            let name = path.file_name()?.to_str()?;
            name.eq_ignore_ascii_case("KSwitcher.exe")
                .then(|| path.parent().map(Path::to_path_buf))
                .flatten()
        })
}

fn pairing_path(directory: &str) -> Result<PathBuf> {
    let installation = if directory.trim().is_empty() {
        running_installation()
    } else {
        Some(local::absolute(directory).map_err(message)?.to_path_buf())
    };
    let portable = installation.map(|folder| folder.join("data").join("lan-pairing.bin"));
    if let Some(path) = portable.as_ref() {
        match path.try_exists() {
            Ok(true) => return Ok(path.clone()),
            Ok(false) => {}
            Err(error) => return Err(message(error)),
        }
    }
    dirs::data_local_dir()
        .map(|folder| folder.join("KSwitcher").join("lan-pairing.bin"))
        .ok_or_else(|| "Cannot locate the KSwitcher pairing data.".to_owned())
}

fn read_pairing(directory: &str) -> Result<Pairing> {
    let mut encrypted = Vec::new();
    let file = File::open(pairing_path(directory)?).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            "Pair the computers in KSwitcher first.".to_owned()
        } else {
            message(error)
        }
    })?;
    file.take(PAIRING_LIMIT + 1)
        .read_to_end(&mut encrypted)
        .map_err(message)?;
    if encrypted.is_empty() || encrypted.len() as u64 > PAIRING_LIMIT {
        return Err("Invalid KSwitcher pairing data.".into());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: encrypted.len() as u32,
        pbData: encrypted.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // KSwitcher protects the pairing file with Windows DPAPI for this user.
    let unlocked = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if unlocked == 0 {
        return Err("Cannot unlock KSwitcher pairing data for this Windows account.".into());
    }
    if output.pbData.is_null() {
        return Err("Invalid KSwitcher pairing data.".into());
    }
    let pairing = unsafe {
        let bytes = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let result = serde_json::from_slice::<Pairing>(bytes);
        bytes.zeroize();
        LocalFree(output.pbData.cast());
        result
    }
    .map_err(|_| "Invalid KSwitcher pairing data.")?;
    if pairing.version != 1 || !valid_hex(&pairing.id, 32) {
        return Err("Unsupported KSwitcher pairing data.".into());
    }
    if !pairing.enabled {
        return Err("Enable LAN pairing in KSwitcher first.".into());
    }
    Ok(pairing)
}

pub(super) fn peers(directory: &str) -> Result<Vec<Peer>> {
    let mut peers: Vec<_> = read_pairing(directory)?
        .trusted
        .into_iter()
        .filter(|(id, computer)| valid_hex(id, 32) && valid_hex(&computer.key, 64))
        .map(|(id, computer)| Peer {
            id,
            name: computer.name.clone(),
        })
        .collect();
    peers.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    Ok(peers)
}

fn connect(directory: &str, peer: &str, host: Option<&str>) -> Result<Channel> {
    let pairing = read_pairing(directory)?;
    let computer = pairing
        .trusted
        .get(peer)
        .ok_or("Choose a paired KSwitcher computer.")?;
    let host = host
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .unwrap_or(&computer.name);
    let addresses = (host, PORT)
        .to_socket_addrs()
        .map_err(|_| "KSwitcher computer address could not be resolved. Enter its IPv4 address.")?;
    let mut last_error = None;
    for address in addresses.filter(|address| address.is_ipv4()).take(4) {
        match TcpStream::connect_timeout(&address, Duration::from_secs(2))
            .map_err(message)
            .and_then(|stream| Channel::authenticate(stream, &pairing.id, peer, &computer.key))
        {
            Ok(channel) => return Ok(channel),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error
        .unwrap_or_else(|| "Enter the IPv4 address of the paired KSwitcher computer.".into()))
}

fn remote_path(value: &str) -> Result<String> {
    let path = value.replace('/', "\\");
    if path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && path.as_bytes().get(1..3) == Some(b":\\")
        && !path.contains('\0')
    {
        Ok(path)
    } else {
        Err("Enter a full Windows drive path.".into())
    }
}

#[derive(Deserialize)]
struct FileInfo {
    attributes: u32,
    size: u64,
    modified: u64,
}

impl FileInfo {
    fn directory(&self) -> bool {
        self.attributes & FILE_ATTRIBUTE_DIRECTORY != 0
    }
    fn link(&self) -> bool {
        self.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }

    fn entry(&self, name: String) -> local::Entry {
        let modified = self
            .modified
            .checked_sub(116_444_736_000_000_000)
            .and_then(|ticks| UNIX_EPOCH.checked_add(Duration::from_secs(ticks / 10_000_000)));
        local::Entry::new(
            name,
            self.directory(),
            self.link(),
            local::EntryAttributes::from_windows(self.attributes),
            (!self.directory()).then_some(self.size),
            modified,
        )
    }
}

pub(super) fn list(directory: &str, peer: &str, path: &str, host: Option<&str>) -> Result<Listing> {
    let mut channel = connect(directory, peer, host)?;
    if path.is_empty() {
        #[derive(Deserialize)]
        struct Drive {
            path: String,
        }
        #[derive(Deserialize)]
        struct Drives {
            drives: Vec<Drive>,
        }
        let response: Drives = channel.request(&json!({ "action": "drives" }))?;
        let entries = response
            .drives
            .into_iter()
            .filter_map(|drive| {
                let root = remote_path(&drive.path).ok()?;
                let name = root.strip_suffix('\\').filter(|name| name.len() == 2)?;
                Some(local::Entry::new(
                    name.to_owned(),
                    true,
                    false,
                    local::EntryAttributes::default(),
                    None,
                    None,
                ))
            })
            .collect();
        return Ok(Listing {
            entries,
            omitted: 0,
            parent: None,
        });
    }

    #[derive(Deserialize)]
    struct Row {
        name: String,
        #[serde(flatten)]
        info: FileInfo,
    }
    #[derive(Deserialize)]
    struct Page {
        entries: Vec<Row>,
        more: bool,
    }

    let path = remote_path(path)?;
    let mut page: Page = channel.request(&json!({ "action": "list", "path": path }))?;
    let mut entries = Vec::new();
    let mut omitted = 0;
    loop {
        if page.more && page.entries.is_empty() {
            return Err("KSwitcher returned an empty directory page.".into());
        }
        for row in page.entries {
            if local::name_component(&row.name).is_ok() {
                entries.push(row.info.entry(row.name));
            } else {
                omitted += 1;
            }
        }
        if !page.more {
            break;
        }
        page = channel.request(&json!({ "action": "listNext" }))?;
    }
    let parent = Path::new(&path)
        .parent()
        .unwrap_or(Path::new(""))
        .to_string_lossy()
        .into_owned();
    Ok(Listing {
        entries,
        omitted,
        parent: Some(parent),
    })
}

pub(super) fn download(
    directory: &str,
    peer: &str,
    path: &str,
    host: Option<&str>,
    target: PathBuf,
    progress: &mut impl FnMut(&Path, u64, u64) -> io::Result<()>,
) -> Result<()> {
    local::ensure_absent(&target).map_err(message)?;
    let parent = target
        .parent()
        .ok_or("Choose a local destination folder.")?;
    let path = remote_path(path)?;
    let mut channel = connect(directory, peer, host)?;
    let info: FileInfo = channel.request(&json!({ "action": "stat", "path": path }))?;
    if info.directory() || info.link() {
        return Err("Choose a regular remote file.".into());
    }
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(message)?;
    progress(&target, 0, info.size).map_err(message)?;
    channel.call(&json!({ "action": "openRead", "path": path, "size": info.size, "modified": info.modified }))?;
    let mut written = 0;
    loop {
        let reply = channel.call(&json!({ "action": "read" }))?;
        let data = reply
            .as_map()
            .and_then(|fields| {
                fields
                    .iter()
                    .find_map(|(key, value)| (key.as_text() == Some("data")).then_some(value))
            })
            .and_then(ciborium::Value::as_bytes)
            .ok_or("Invalid KSwitcher file data.")?;
        if data.is_empty() {
            break;
        }
        if data.len() > CHUNK_SIZE || data.len() as u64 > info.size - written {
            return Err("KSwitcher returned more data than expected.".into());
        }
        staged.write_all(data).map_err(message)?;
        written += data.len() as u64;
        progress(&target, written, info.size).map_err(message)?;
    }
    if written != info.size {
        return Err("KSwitcher returned an incomplete file.".into());
    }
    channel.call(&json!({ "action": "closeRead" }))?;
    progress(&target, written, info.size).map_err(message)?;
    staged.persist_noclobber(target).map_err(message)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use windows_sys::Win32::Security::Cryptography::CryptProtectData;

    #[test]
    fn reads_windows_pairings_from_a_portable_installation() {
        let installation = tempfile::tempdir().unwrap();
        let folder = installation.path().join("data");
        fs::create_dir(&folder).unwrap();
        let client = "01".repeat(16);
        let peer = "02".repeat(16);
        let mut bytes = serde_json::to_vec(&json!({
            "version": 1, "enabled": true, "id": client,
            "trusted": { (&peer): { "name": "paired-fixture", "key": "ab".repeat(32) } },
        }))
        .unwrap();
        let input = CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_mut_ptr(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            assert_ne!(
                CryptProtectData(
                    &input,
                    ptr::null(),
                    ptr::null(),
                    ptr::null(),
                    ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output
                ),
                0
            );
            let result = fs::write(
                folder.join("lan-pairing.bin"),
                std::slice::from_raw_parts(output.pbData, output.cbData as usize),
            );
            LocalFree(output.pbData.cast());
            result.unwrap();
        }
        let peers = peers(installation.path().to_str().unwrap()).unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].id, peer);
        assert_eq!(peers[0].name, "paired-fixture");
    }
}
