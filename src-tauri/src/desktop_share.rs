use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    path::PathBuf,
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use zeroize::Zeroizing;

use crate::{
    lan_group::{GroupIdentity, LanGroup, Peer},
    local, message,
    protocol::Invitation,
    server::DesktopServer,
    Result,
};

pub(crate) struct DesktopShare {
    legacy: Mutex<Option<DesktopServer>>,
    group: Mutex<GroupSession>,
    group_store: Option<GroupStore>,
}

#[derive(Clone)]
struct GroupStore {
    profile: String,
    lock: PathBuf,
}

const GROUP_IN_USE: &str = "The Dirlume LAN group is managed by another running Dirlume instance.";

fn decode_membership(value: &str) -> Option<(GroupIdentity, &str)> {
    let (identity, code) = value.split_once('\n')?;
    if !crate::lan_group::valid_code(code) {
        return None;
    }
    Some((GroupIdentity::decode(identity)?, code))
}

fn encode_membership(group: &LanGroup, identity: &GroupIdentity) -> Zeroizing<String> {
    let code = Zeroizing::new(group.code());
    let mut value = identity.encode();
    value.push('\n');
    value.push_str(&code);
    value
}

impl GroupStore {
    fn entry(&self) -> keyring::Result<keyring::Entry> {
        keyring::Entry::new("Dirlume LAN group", &self.profile)
    }

    fn acquire(&self) -> io::Result<Option<File>> {
        if let Some(directory) = self.lock.parent() {
            fs::create_dir_all(directory)?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&self.lock)?;
        match file.try_lock() {
            Ok(()) => Ok(Some(file)),
            Err(TryLockError::WouldBlock) => Ok(None),
            Err(TryLockError::Error(error)) => Err(error),
        }
    }
}

#[derive(Default)]
struct GroupSession {
    active: Option<LanGroup>,
    remembered: Option<Zeroizing<String>>,
    loaded: bool,
    restore_disabled: bool,
    storage_error: Option<&'static str>,
    profile_lock: Option<File>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupStatus {
    active: bool,
    remembered: bool,
    writable: bool,
    storage_error: Option<&'static str>,
}

impl GroupSession {
    fn status(&self) -> GroupStatus {
        GroupStatus {
            active: self.active.is_some(),
            remembered: self.remembered.is_some(),
            writable: self.active.as_ref().is_some_and(LanGroup::writable),
            storage_error: self.storage_error,
        }
    }

    async fn reconnect(
        &mut self,
        address: impl FnOnce() -> Result<Ipv4Addr>,
        locations: impl Fn() -> Vec<(String, PathBuf)> + Send + Sync + 'static,
    ) -> bool {
        let Some(code) = self.remembered.as_ref().filter(|_| {
            self.active.is_none() && !self.restore_disabled && self.storage_error.is_none()
        }) else {
            return false;
        };
        let Ok(ip) = address() else {
            return true;
        };
        let Some((identity, code)) = decode_membership(code) else {
            return false;
        };
        match LanGroup::start(ip, Some(code), &identity, locations).await {
            Ok(group) => {
                self.active = Some(group);
                false
            }
            Err(_) => true,
        }
    }
}

impl DesktopShare {
    pub(crate) fn new(profile: &str) -> Self {
        let unattended =
            !cfg!(feature = "ui-automation") || std::env::var_os("DIRLUME_CDP_PORT").is_none();
        #[cfg(windows)]
        let unattended = unattended && !crate::windows_elevation::is_elevated();
        let mut profile = profile.to_owned();
        if cfg!(debug_assertions) {
            profile.push_str(".debug");
        }
        #[cfg(windows)]
        if let Some(portable) = crate::portable::root() {
            use std::os::windows::ffi::OsStrExt;
            let path: Vec<u8> = portable
                .as_os_str()
                .encode_wide()
                .flat_map(u16::to_le_bytes)
                .collect();
            let tag = ring::digest::digest(&ring::digest::SHA256, &path);
            for byte in tag.as_ref() {
                use std::fmt::Write;
                let _ = write!(profile, "{byte:02x}");
            }
        }
        Self {
            legacy: Mutex::default(),
            group: Mutex::default(),
            group_store: dirs::data_local_dir()
                .filter(|_| unattended)
                .map(|directory| GroupStore {
                    lock: directory.join(&profile).join("lan-group.lock"),
                    profile,
                }),
        }
    }

    async fn load_group(&self, session: &mut GroupSession) {
        if session.loaded {
            return;
        }
        session.loaded = true;
        let Some(store) = self.group_store.clone() else {
            return;
        };
        match store.acquire() {
            Ok(Some(lock)) => session.profile_lock = Some(lock),
            Ok(None) => {
                session.loaded = false;
                session.storage_error = Some(GROUP_IN_USE);
                return;
            }
            Err(_) => {
                session.storage_error =
                    Some("Could not open the local Dirlume LAN group settings.");
                return;
            }
        }
        let result = tokio::task::spawn_blocking(move || match store.entry()?.get_password() {
            Ok(code) => Ok(Some(Zeroizing::new(code))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error),
        })
        .await;
        match result {
            Ok(Ok(code)) => {
                session.storage_error = code.as_ref().and_then(|value| {
                    decode_membership(value).is_none().then_some(
                        "The saved Dirlume LAN group code is invalid. Leave the group and join again.",
                    )
                });
                session.remembered = code;
            }
            _ => {
                session.storage_error =
                    Some("Could not read the Dirlume LAN group from the system credential store.")
            }
        }
    }

    async fn restore_group(&self) -> bool {
        let mut session = self.group.lock().await;
        self.load_group(&mut session).await;
        session
            .reconnect(pairing_ipv4, local::local_share_locations)
            .await
    }

    pub(crate) async fn check_pairing_target(&self, target: &Invitation) -> Result<()> {
        let same_share = self
            .legacy
            .lock()
            .await
            .as_ref()
            .and_then(|server| Invitation::parse(&server.invitation).ok())
            .is_some_and(|own| own.certificate == target.certificate);
        let local_ip = match target.address.host() {
            Some(url::Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
            Some(url::Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
            _ => None,
        };
        let fixture = cfg!(feature = "ui-automation")
            && local_ip.is_some_and(|ip| ip.is_loopback())
            && std::env::var_os("DIRLUME_CDP_PORT").is_some();
        if same_share
            || !fixture
                && local_ip.is_some_and(|ip| {
                    ip.is_loopback()
                        || ip.is_unspecified()
                        || UdpSocket::bind(SocketAddr::new(ip, 0)).is_ok()
                })
        {
            return Err(
                "This pairing code belongs to this computer. Use a code from the other computer."
                    .to_owned(),
            );
        }
        Ok(())
    }

    pub(crate) async fn group_invitation(&self, id: &str) -> Result<zeroize::Zeroizing<String>> {
        self.group
            .lock()
            .await
            .active
            .as_ref()
            .ok_or("Join a Dirlume LAN group first.")?
            .invitation(id)
    }
}

pub(crate) fn restore_group_on_start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while app.state::<DesktopShare>().restore_group().await {
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

#[derive(Serialize)]
pub(crate) struct ShareDetails {
    address: String,
    invitation: String,
}

fn details(server: &DesktopServer) -> ShareDetails {
    ShareDetails {
        address: server.address.clone(),
        invitation: server.invitation.clone(),
    }
}

fn local_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_private() || ip.is_link_local() || ip.is_loopback(),
        IpAddr::V6(ip) => ip.is_unique_local() || ip.is_loopback(),
    }
}

fn pairing_address() -> Result<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(message)?;
    // Select a network interface without transmitting a discovery packet.
    socket.connect("192.168.0.1:9").map_err(message)?;
    let ip = socket.local_addr().map_err(message)?.ip();
    if local_address(ip) && !ip.is_loopback() {
        Ok(ip.to_string())
    } else {
        Err("No local network address is available for pairing.".to_owned())
    }
}

fn pairing_ipv4() -> Result<Ipv4Addr> {
    pairing_address()?
        .parse()
        .map_err(|_| "An IPv4 local network address is required.".to_owned())
}

#[tauri::command]
pub(crate) async fn active_desktop_share(
    state: State<'_, DesktopShare>,
) -> Result<Option<ShareDetails>> {
    let sharing = state.legacy.lock().await;
    Ok(sharing
        .as_ref()
        .filter(|server| server.is_running())
        .map(details))
}

#[tauri::command]
pub(crate) async fn start_desktop_computer_share(
    address: Option<String>,
    state: State<'_, DesktopShare>,
) -> Result<ShareDetails> {
    let address = address.map_or_else(pairing_address, Ok)?;
    let ip = address
        .trim()
        .parse::<IpAddr>()
        .map_err(|_| "Enter a local network IP address.".to_owned())?;
    if !local_address(ip) {
        return Err("Enter a local network IP address.".to_owned());
    }
    let mut sharing = state.legacy.lock().await;
    if sharing.as_ref().is_some_and(DesktopServer::is_running) {
        return Err("Stop the current share before starting another.".to_owned());
    }
    let server = DesktopServer::start_computer(local::local_share_locations, ip)
        .await
        .map_err(message)?;
    let result = details(&server);
    *sharing = Some(server);
    Ok(result)
}

#[tauri::command]
pub(crate) async fn stop_desktop_share(state: State<'_, DesktopShare>) -> Result<()> {
    let mut sharing = state.legacy.lock().await;
    if let Some(mut server) = sharing.take() {
        server.stop().await.map_err(message)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn lan_group_status(state: State<'_, DesktopShare>) -> Result<GroupStatus> {
    state.restore_group().await;
    Ok(state.group.lock().await.status())
}

#[tauri::command]
pub(crate) async fn set_lan_group_writable(
    writable: bool,
    state: State<'_, DesktopShare>,
) -> Result<()> {
    state
        .group
        .lock()
        .await
        .active
        .as_ref()
        .ok_or("Join a Dirlume LAN group first.")?
        .set_writable(writable);
    Ok(())
}

#[tauri::command]
pub(crate) async fn start_lan_group(
    code: Option<String>,
    address: Option<Ipv4Addr>,
    state: State<'_, DesktopShare>,
) -> Result<GroupStatus> {
    let ip = match address {
        Some(ip) if cfg!(feature = "ui-automation") => ip,
        _ => pairing_ipv4()?,
    };
    let code = code.map(Zeroizing::new);
    let mut session = state.group.lock().await;
    state.load_group(&mut session).await;
    if session.storage_error == Some(GROUP_IN_USE) {
        return Err(GROUP_IN_USE.to_owned());
    }
    if session.active.is_some() || session.remembered.is_some() {
        return Err("Leave the current Dirlume LAN group before joining another.".to_owned());
    }
    let identity = GroupIdentity::generate()?;
    let group = LanGroup::start(
        ip,
        code.as_deref().map(String::as_str),
        &identity,
        local::local_share_locations,
    )
    .await?;
    if let Some(store) = state
        .group_store
        .clone()
        .filter(|_| session.profile_lock.is_some())
    {
        let secret = encode_membership(&group, &identity);
        let result = tokio::task::spawn_blocking(move || {
            store.entry()?.set_password(&secret)?;
            Ok::<_, keyring::Error>(secret)
        })
        .await;
        match result {
            Ok(Ok(code)) => {
                session.remembered = Some(code);
                session.storage_error = None;
            }
            _ => {
                session.storage_error =
                    Some("Could not save the Dirlume LAN group in the system credential store.")
            }
        }
    }
    session.restore_disabled = false;
    session.active = Some(group);
    Ok(session.status())
}

#[tauri::command]
pub(crate) async fn copy_lan_group_code(
    state: State<'_, DesktopShare>,
    app: AppHandle,
) -> Result<()> {
    let code = state
        .group
        .lock()
        .await
        .active
        .as_ref()
        .map(LanGroup::code)
        .ok_or("Join a Dirlume LAN group first.")?;
    crate::file_clipboard::copy_path(code, app).await
}

#[tauri::command]
pub(crate) async fn list_lan_group_peers(state: State<'_, DesktopShare>) -> Result<Vec<Peer>> {
    match state.group.lock().await.active.as_ref() {
        Some(group) => group.peers(),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub(crate) async fn leave_lan_group(state: State<'_, DesktopShare>) -> Result<GroupStatus> {
    let mut session = state.group.lock().await;
    state.load_group(&mut session).await;
    session.restore_disabled = true;
    let stopped = match session.active.take() {
        Some(group) => group.stop().await,
        None => Ok(()),
    };
    if let Some(store) = state
        .group_store
        .clone()
        .filter(|_| session.remembered.is_some())
    {
        let result =
            tokio::task::spawn_blocking(move || match store.entry()?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(error),
            })
            .await;
        if !matches!(result, Ok(Ok(()))) {
            session.storage_error =
                Some("Sharing stopped, but the saved Dirlume LAN group could not be removed.");
            return Ok(session.status());
        }
    }
    session.remembered = None;
    session.storage_error = stopped
        .err()
        .map(|_| "Could not confirm that Dirlume LAN sharing stopped.");
    Ok(session.status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_process_can_manage_the_saved_group() {
        let directory = tempfile::tempdir().unwrap();
        let store = GroupStore {
            profile: "fixture".into(),
            lock: directory.path().join("lan-group.lock"),
        };
        let lock = store.acquire().unwrap().unwrap();
        assert!(store.acquire().unwrap().is_none());
        drop(lock);
        assert!(store.acquire().unwrap().is_some());
    }

    #[tokio::test]
    async fn remembered_membership_reconnects_read_only_when_the_network_returns() {
        let _network = crate::lan_group::DISCOVERY_TEST_LOCK.lock().await;
        let directory = tempfile::tempdir().unwrap();
        let drive = directory.path().to_owned();
        let locations = move || vec![("Fixture drive".to_owned(), drive.clone())];
        let ip = Ipv4Addr::LOCALHOST;
        let identity = GroupIdentity::generate().unwrap();
        let group = LanGroup::start(ip, None, &identity, locations.clone())
            .await
            .unwrap();
        group.set_writable(true);
        let expected_code = Zeroizing::new(group.code());
        let expected_id = group.id.clone();
        let code = encode_membership(&group, &identity);
        group.stop().await.unwrap();
        let mut restored = GroupSession {
            remembered: Some(code),
            ..GroupSession::default()
        };
        assert!(
            restored
                .reconnect(|| Err("Network unavailable".to_owned()), locations.clone())
                .await
        );
        assert!(!restored.status().active);
        assert!(!restored.reconnect(|| Ok(ip), locations.clone()).await);
        assert!(restored.status().active);
        assert!(!restored.status().writable);
        assert_eq!(
            restored.active.as_ref().unwrap().code(),
            expected_code.as_str()
        );
        assert_eq!(restored.active.as_ref().unwrap().id, expected_id);
        restored.active.take().unwrap().stop().await.unwrap();
        restored.restore_disabled = true;
        assert!(!restored.reconnect(|| Ok(ip), locations).await);
        assert!(!restored.status().active);
    }
}
