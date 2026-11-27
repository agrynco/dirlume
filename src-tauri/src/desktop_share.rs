use std::net::{IpAddr, SocketAddr, UdpSocket};

use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;

use crate::{local, message, protocol::Invitation, server::DesktopServer, Result};

#[derive(Default)]
pub(crate) struct DesktopShare(Mutex<Option<DesktopServer>>);

impl DesktopShare {
    pub(crate) async fn check_pairing_target(&self, target: &Invitation) -> Result<()> {
        let same_share = self
            .0
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
    let sharing = state.0.lock().await;
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
    let mut sharing = state.0.lock().await;
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
    let mut sharing = state.0.lock().await;
    if let Some(mut server) = sharing.take() {
        server.stop().await.map_err(message)?;
    }
    Ok(())
}
