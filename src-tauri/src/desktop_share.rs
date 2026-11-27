use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};

use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

use crate::{
    lan_group::{LanGroup, Peer},
    local, message,
    protocol::Invitation,
    server::DesktopServer,
    Result,
};

#[derive(Default)]
pub(crate) struct DesktopShare {
    legacy: Mutex<Option<DesktopServer>>,
    group: Mutex<Option<LanGroup>>,
}

impl DesktopShare {
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
            .as_ref()
            .ok_or("Join a Dirlume LAN group first.")?
            .invitation(id)
    }
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
pub(crate) async fn active_lan_group(state: State<'_, DesktopShare>) -> Result<bool> {
    Ok(state.group.lock().await.is_some())
}

#[tauri::command]
pub(crate) async fn lan_group_writable(state: State<'_, DesktopShare>) -> Result<bool> {
    Ok(state
        .group
        .lock()
        .await
        .as_ref()
        .is_some_and(LanGroup::writable))
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
) -> Result<()> {
    let ip = match address {
        Some(ip) if cfg!(feature = "ui-automation") => ip,
        _ => pairing_address()?
            .parse()
            .map_err(|_| "An IPv4 local network address is required.")?,
    };
    let code = code.map(zeroize::Zeroizing::new);
    let mut group = state.group.lock().await;
    if group.is_some() {
        return Err("Leave the current Dirlume LAN group before joining another.".to_owned());
    }
    *group = Some(
        LanGroup::start(
            ip,
            code.as_deref().map(String::as_str),
            local::local_share_locations,
        )
        .await?,
    );
    Ok(())
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
        .as_ref()
        .map(LanGroup::code)
        .ok_or("Join a Dirlume LAN group first.")?;
    crate::file_clipboard::copy_path(code, app).await
}

#[tauri::command]
pub(crate) async fn list_lan_group_peers(state: State<'_, DesktopShare>) -> Result<Vec<Peer>> {
    match state.group.lock().await.as_ref() {
        Some(group) => group.peers(),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub(crate) async fn leave_lan_group(state: State<'_, DesktopShare>) -> Result<()> {
    if let Some(group) = state.group.lock().await.take() {
        group.stop().await?;
    }
    Ok(())
}
