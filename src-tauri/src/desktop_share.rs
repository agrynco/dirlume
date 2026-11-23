use std::net::{IpAddr, UdpSocket};

use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;

use crate::{local, message, server::DesktopServer, Result};

#[derive(Default)]
pub(crate) struct DesktopShare(Mutex<Option<(String, DesktopServer)>>);

#[derive(Serialize)]
pub(crate) struct ShareDetails {
    path: String,
    address: String,
    invitation: String,
}

fn details(path: &str, server: &DesktopServer) -> ShareDetails {
    ShareDetails {
        path: path.into(),
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

#[tauri::command]
pub(crate) fn suggest_share_address() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    // UDP connect selects a local interface without sending a packet.
    socket.connect("192.168.0.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (local_address(ip) && !ip.is_loopback()).then(|| ip.to_string())
}

#[tauri::command]
pub(crate) async fn active_desktop_share(
    state: State<'_, DesktopShare>,
) -> Result<Option<ShareDetails>> {
    let sharing = state.0.lock().await;
    Ok(sharing
        .as_ref()
        .and_then(|(path, server)| server.is_running().then(|| details(path, server))))
}

#[tauri::command]
pub(crate) async fn start_desktop_share(
    path: Option<String>,
    address: String,
    share_computer: Option<bool>,
    state: State<'_, DesktopShare>,
) -> Result<ShareDetails> {
    let ip = address
        .trim()
        .parse::<IpAddr>()
        .map_err(|_| "Enter a local network IP address.".to_owned())?;
    if !local_address(ip) {
        return Err("Enter a local network IP address.".to_owned());
    }
    let mut sharing = state.0.lock().await;
    if sharing
        .as_ref()
        .is_some_and(|(_, server)| server.is_running())
    {
        return Err("Stop the current share before starting another.".to_owned());
    }
    let share_computer = share_computer.unwrap_or(false);
    let server = if share_computer {
        DesktopServer::start_computer(local::local_share_locations(), ip).await
    } else {
        let root = local::absolute(path.as_deref().unwrap_or_default()).map_err(message)?;
        DesktopServer::start(root, ip).await
    }
    .map_err(message)?;
    let label = if share_computer {
        String::new()
    } else {
        path.unwrap_or_default()
    };
    let result = details(&label, &server);
    *sharing = Some((label, server));
    Ok(result)
}

#[tauri::command]
pub(crate) async fn stop_desktop_share(state: State<'_, DesktopShare>) -> Result<()> {
    let mut sharing = state.0.lock().await;
    if let Some((_, mut server)) = sharing.take() {
        server.stop().await.map_err(message)?;
    }
    Ok(())
}
