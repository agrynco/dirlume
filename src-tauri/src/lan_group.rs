use std::{
    collections::BTreeMap,
    net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::{
    aead, digest, hmac,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use tokio::{net::UdpSocket, task::JoinHandle};
use url::Url;
use zeroize::Zeroizing;

use crate::{
    message,
    protocol::{computer_name, Invitation},
    server::DesktopServer,
    Result,
};

const PREFIX: &str = "dirlume-lan-v1:";
const MULTICAST_ADDRESS: Ipv4Addr = Ipv4Addr::new(239, 255, 73, 42);
const PORT: u16 = 45742;
const INTERVAL: Duration = Duration::from_secs(2);
const OFFLINE_AFTER: Duration = Duration::from_secs(12);
const PACKET_LIMIT: usize = 1200;
const NONCE_LENGTH: usize = 12;
const MAX_MEMBERS: usize = 128;

pub(crate) struct GroupKey(Zeroizing<[u8; 32]>);

impl GroupKey {
    fn generate() -> Result<Self> {
        let mut bytes = Zeroizing::new([0; 32]);
        SystemRandom::new()
            .fill(&mut *bytes)
            .map_err(|_| "Could not generate a group code.")?;
        Ok(Self(bytes))
    }

    fn parse(code: &str) -> Result<Self> {
        let invalid = || "Enter a valid Dirlume LAN group code.".to_owned();
        let code = code
            .trim()
            .strip_prefix(PREFIX)
            .filter(|code| code.len() == 43)
            .ok_or_else(invalid)?;
        let mut bytes = Zeroizing::new([0; 32]);
        let length = URL_SAFE_NO_PAD
            .decode_slice(code, &mut *bytes)
            .map_err(|_| invalid())?;
        if length != bytes.len() {
            return Err(invalid());
        }
        Ok(Self(bytes))
    }

    fn code(&self) -> String {
        format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(&self.0[..]))
    }

    fn purpose(&self, label: &[u8]) -> hmac::Key {
        let root = hmac::Key::new(hmac::HMAC_SHA256, &*self.0);
        hmac::Key::new(hmac::HMAC_SHA256, hmac::sign(&root, label).as_ref())
    }

    pub(crate) fn bearer(&self, certificate: &str) -> String {
        let key = self.purpose(b"Dirlume LAN HTTPS bearer v1");
        URL_SAFE_NO_PAD.encode(hmac::sign(&key, certificate.as_bytes()).as_ref())
    }

    fn discovery_key(&self) -> Result<aead::LessSafeKey> {
        let root = hmac::Key::new(hmac::HMAC_SHA256, &*self.0);
        let derived = hmac::sign(&root, b"Dirlume LAN discovery v1");
        aead::UnboundKey::new(&aead::CHACHA20_POLY1305, derived.as_ref())
            .map(aead::LessSafeKey::new)
            .map_err(|_| "Could not initialize LAN discovery.".to_owned())
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct Announcement {
    name: String,
    address: Url,
    certificate: String,
    time: u64,
}

impl Announcement {
    fn packet(&mut self, key: &aead::LessSafeKey) -> Result<Vec<u8>> {
        self.time = now();
        let mut bytes = serde_json::to_vec(self).map_err(message)?;
        let mut nonce = [0; NONCE_LENGTH];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| "Could not create a LAN announcement.")?;
        key.seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::empty(),
            &mut bytes,
        )
        .map_err(|_| "Could not protect a LAN announcement.")?;
        if bytes.len() + NONCE_LENGTH > PACKET_LIMIT {
            return Err("The LAN announcement is too large.".to_owned());
        }
        let mut packet = nonce.to_vec();
        packet.extend_from_slice(&bytes);
        Ok(packet)
    }

    fn read(packet: &mut [u8], sender: IpAddr, key: &aead::LessSafeKey) -> Option<Self> {
        let (nonce, body) = packet.split_at_mut_checked(NONCE_LENGTH)?;
        let nonce = aead::Nonce::try_assume_unique_for_key(nonce).ok()?;
        let body = key.open_in_place(nonce, aead::Aad::empty(), body).ok()?;
        let value: Self = serde_json::from_slice(body).ok()?;
        let url = &value.address;
        let valid_address = matches!(url.host(), Some(url::Host::Ipv4(ip)) if sender == IpAddr::V4(ip) && valid_ip(ip))
            && url.scheme() == "https"
            && url.port().is_some()
            && url.path() == "/"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none();
        (valid_address
            && now().abs_diff(value.time) <= 30
            && !value.name.trim().is_empty()
            && value.name.len() <= 255
            && !value.name.chars().any(char::is_control)
            && !value.certificate.is_empty()
            && value.certificate.len() < PACKET_LIMIT)
            .then_some(value)
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn valid_ip(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_link_local() || ip.is_loopback()
}

fn discovery_socket(ip: Ipv4Addr) -> Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)).map_err(message)?;
    socket.set_reuse_address(true).map_err(message)?;
    socket
        .bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, PORT).into())
        .map_err(message)?;
    socket
        .join_multicast_v4(&MULTICAST_ADDRESS, &ip)
        .map_err(message)?;
    socket.set_multicast_if_v4(&ip).map_err(message)?;
    socket.set_multicast_ttl_v4(1).map_err(message)?;
    socket.set_nonblocking(true).map_err(message)?;
    UdpSocket::from_std(socket.into()).map_err(message)
}

fn peer_id(certificate: &str) -> String {
    URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, certificate.as_bytes()).as_ref())
}

struct Member {
    announcement: Announcement,
    seen: Instant,
}

#[derive(Serialize)]
pub(crate) struct Peer {
    id: String,
    name: String,
    online: bool,
}

pub(crate) struct LanGroup {
    key: GroupKey,
    server: DesktopServer,
    writable: Arc<AtomicBool>,
    members: Arc<Mutex<BTreeMap<String, Member>>>,
    discovery: JoinHandle<()>,
}

impl LanGroup {
    pub(crate) async fn start(
        ip: Ipv4Addr,
        code: Option<&str>,
        locations: impl Fn() -> Vec<(String, PathBuf)> + Send + Sync + 'static,
    ) -> Result<Self> {
        if !valid_ip(ip) {
            return Err("Enter a local network IP address.".to_owned());
        }
        let key = code.map_or_else(GroupKey::generate, GroupKey::parse)?;
        let socket = discovery_socket(ip)?;
        let writable = Arc::new(AtomicBool::new(false));
        let server = DesktopServer::start_computer_with_group(
            locations,
            ip.into(),
            Some((&key, Arc::clone(&writable))),
        )
        .await
        .map_err(message)?;
        let info = Invitation::parse(&server.invitation)?;
        let mut announcement = Announcement {
            name: computer_name().unwrap_or_else(|| ip.to_string()),
            address: info.address,
            certificate: info.certificate,
            time: 0,
        };
        let discovery_key = key.discovery_key()?;
        announcement.packet(&discovery_key)?;
        let members = Arc::new(Mutex::new(BTreeMap::new()));
        let discovery = tokio::spawn(discover(
            socket,
            announcement,
            discovery_key,
            Arc::clone(&members),
        ));
        Ok(Self {
            key,
            server,
            writable,
            members,
            discovery,
        })
    }

    pub(crate) fn code(&self) -> String {
        self.key.code()
    }

    pub(crate) fn writable(&self) -> bool {
        self.writable.load(Ordering::Acquire)
    }

    pub(crate) fn set_writable(&self, value: bool) {
        self.writable.store(value, Ordering::Release);
    }

    pub(crate) fn peers(&self) -> Result<Vec<Peer>> {
        let members = self.members.lock().map_err(message)?;
        Ok(members
            .iter()
            .map(|(id, member)| Peer {
                id: id.clone(),
                name: member.announcement.name.clone(),
                online: member.seen.elapsed() <= OFFLINE_AFTER,
            })
            .collect())
    }

    pub(crate) fn invitation(&self, id: &str) -> Result<Zeroizing<String>> {
        let members = self.members.lock().map_err(message)?;
        let member = members
            .get(id)
            .filter(|member| member.seen.elapsed() <= OFFLINE_AFTER)
            .ok_or("The Dirlume LAN computer is offline.")?;
        let announcement = &member.announcement;
        Invitation {
            address: announcement.address.clone(),
            certificate: announcement.certificate.clone(),
            token: self.key.bearer(&announcement.certificate),
        }
        .encode()
        .map(Zeroizing::new)
        .map_err(message)
    }

    pub(crate) async fn stop(mut self) -> Result<()> {
        self.discovery.abort();
        self.server.stop().await.map_err(message)
    }
}

impl Drop for LanGroup {
    fn drop(&mut self) {
        self.discovery.abort();
    }
}

async fn discover(
    socket: UdpSocket,
    mut own: Announcement,
    key: aead::LessSafeKey,
    members: Arc<Mutex<BTreeMap<String, Member>>>,
) {
    let destination = SocketAddr::V4(SocketAddrV4::new(MULTICAST_ADDRESS, PORT));
    let mut tick = tokio::time::interval(INTERVAL);
    let mut packet = vec![0; u16::MAX as usize];
    loop {
        tokio::select! {
            _ = tick.tick() => {
                if let Ok(packet) = own.packet(&key) {
                    let _ = socket.send_to(&packet, destination).await;
                }
            }
            received = socket.recv_from(&mut packet) => {
                let Ok((length, sender)) = received else { break };
                if length > PACKET_LIMIT { continue }
                let Some(announcement) = Announcement::read(&mut packet[..length], sender.ip(), &key) else { continue };
                if announcement.certificate == own.certificate { continue }
                let Ok(mut members) = members.lock() else { break };
                let id = peer_id(&announcement.certificate);
                if members.get(&id).is_some_and(|member| announcement.time <= member.announcement.time) { continue }
                if !members.contains_key(&id) && members.len() >= MAX_MEMBERS {
                    let oldest = members.iter().min_by_key(|(_, member)| member.seen).map(|(id, _)| id.clone());
                    if let Some(oldest) = oldest { members.remove(&oldest); }
                }
                members.insert(id, Member { announcement, seen: Instant::now() });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_group_and_address_before_accepting_discovery() {
        let root = GroupKey::generate().unwrap();
        let joined = GroupKey::parse(&root.code()).unwrap();
        let outsider = GroupKey::generate().unwrap();
        assert_eq!(root.bearer("certificate"), joined.bearer("certificate"));
        assert_ne!(root.bearer("certificate"), outsider.bearer("certificate"));
        let mut announcement = Announcement {
            name: "Computer A".into(),
            address: Url::parse("https://192.168.1.10:12345/").unwrap(),
            certificate: "certificate".into(),
            time: 0,
        };
        let key = joined.discovery_key().unwrap();
        let mut packet = announcement.packet(&root.discovery_key().unwrap()).unwrap();
        let sender = "192.168.1.10".parse().unwrap();
        assert!(Announcement::read(&mut packet.clone(), sender, &key).is_some());
        assert!(Announcement::read(
            &mut packet.clone(),
            sender,
            &outsider.discovery_key().unwrap()
        )
        .is_none());
        assert!(
            Announcement::read(&mut packet.clone(), "192.168.1.11".parse().unwrap(), &key)
                .is_none()
        );
        packet[0] ^= 1;
        assert!(Announcement::read(&mut packet, sender, &key).is_none());
    }

    #[tokio::test]
    async fn three_computers_discover_one_another_using_one_code() {
        let fixture = tempfile::tempdir().unwrap();
        let locations = |name: &str| {
            let name = name.to_owned();
            let root = fixture.path().join(&name);
            std::fs::create_dir(&root).unwrap();
            move || vec![(name.clone(), root.clone())]
        };
        let ip = Ipv4Addr::LOCALHOST;
        let a = LanGroup::start(ip, None, locations("Drive A"))
            .await
            .unwrap();
        let code = a.code();
        let b = LanGroup::start(ip, Some(&code), locations("Drive B"))
            .await
            .unwrap();
        let c = LanGroup::start(ip, Some(&code), locations("Drive C"))
            .await
            .unwrap();
        let groups = [(&a, "Drive A"), (&b, "Drive B"), (&c, "Drive C")];
        let identities = groups
            .map(|(group, drive)| {
                let invitation = Invitation::parse(&group.server.invitation).unwrap();
                (peer_id(&invitation.certificate), drive)
            })
            .into_iter()
            .collect::<BTreeMap<_, _>>();
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if [&a, &b, &c]
                    .iter()
                    .all(|group| group.peers().unwrap().len() == 2)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        for (group, own_drive) in groups {
            for peer in group.peers().unwrap() {
                let code = group.invitation(&peer.id).unwrap();
                let invitation = Invitation::parse(&code).unwrap();
                let certificate = URL_SAFE_NO_PAD.decode(&invitation.certificate).unwrap();
                let client = reqwest::Client::builder()
                    .no_proxy()
                    .tls_built_in_root_certs(false)
                    .add_root_certificate(reqwest::Certificate::from_der(&certificate).unwrap())
                    .build()
                    .unwrap();
                let response = client
                    .post(invitation.address.join("v1/drives").unwrap())
                    .bearer_auth(&invitation.token)
                    .send()
                    .await
                    .unwrap();
                assert!(response.status().is_success());
                let drives: Vec<serde_json::Value> = response.json().await.unwrap();
                let drive = identities[&peer.id];
                assert_ne!(drive, own_drive);
                assert_eq!(drives[0]["name"], drive);

                if drive == "Drive B" && own_drive == "Drive A" {
                    use crate::{
                        desktop::Encoding,
                        protocol::{lan_text_revision, LanChange, LanChangeRequest, LanTextSave},
                    };
                    let post = |route| {
                        client
                            .post(invitation.address.join(route).unwrap())
                            .bearer_auth(&invitation.token)
                    };
                    let request = |parts: &[&str], change| LanChangeRequest {
                        segments: std::iter::once(drive.to_owned())
                            .chain(parts.iter().map(|part| (*part).to_owned()))
                            .collect(),
                        change,
                    };
                    let folder = request(&["New folder"], LanChange::Folder);
                    let result: Result<()> = post("v1/lan/change")
                        .json(&folder)
                        .send()
                        .await
                        .unwrap()
                        .json()
                        .await
                        .unwrap();
                    assert_eq!(
                        result.unwrap_err(),
                        "The remote computer allows read access only."
                    );
                    assert!(!fixture.path().join("Drive B").join("New folder").exists());
                    b.set_writable(true);
                    let result: Result<()> = post("v1/lan/change")
                        .json(&folder)
                        .send()
                        .await
                        .unwrap()
                        .json()
                        .await
                        .unwrap();
                    result.unwrap();
                    assert!(fixture.path().join("Drive B").join("New folder").is_dir());
                    assert!(!fixture.path().join("Drive A").join("New folder").exists());
                    let host = fixture.path().join(drive);
                    let text_path = host.join("New folder").join("note.txt");
                    let create = request(
                        &["New folder", "note.txt"],
                        LanChange::CreateText {
                            encoding: Encoding::Utf8Bom,
                        },
                    );
                    let result: Result<()> = post("v1/lan/change")
                        .json(&create)
                        .send()
                        .await
                        .unwrap()
                        .json()
                        .await
                        .unwrap();
                    result.unwrap();
                    let original = std::fs::read(&text_path).unwrap();
                    assert_eq!(original, [0xef, 0xbb, 0xbf]);

                    let saved = "Saved text\n".repeat(9_000);
                    let edit = LanTextSave {
                        segments: create.segments,
                        revision: lan_text_revision(&original),
                        text: saved.clone(),
                    };
                    let result: Result<String> = post("v1/lan/save-text")
                        .json(&edit)
                        .send()
                        .await
                        .unwrap()
                        .json()
                        .await
                        .unwrap();
                    let new_contents = std::fs::read(&text_path).unwrap();
                    assert_eq!(result.unwrap(), lan_text_revision(&new_contents));
                    assert_eq!(&new_contents[..3], &[0xef, 0xbb, 0xbf]);
                    assert_eq!(&new_contents[3..], saved.as_bytes());
                    let result: Result<String> = post("v1/lan/save-text")
                        .json(&edit)
                        .send()
                        .await
                        .unwrap()
                        .json()
                        .await
                        .unwrap();
                    assert!(result.unwrap_err().contains("changed outside"));

                    let occupied = host.join("Occupied");
                    std::fs::create_dir(&occupied).unwrap();
                    let conflict = request(
                        &["New folder"],
                        LanChange::Rename {
                            name: "Occupied".into(),
                        },
                    );
                    let result: Result<()> = post("v1/lan/change")
                        .json(&conflict)
                        .send()
                        .await
                        .unwrap()
                        .json()
                        .await
                        .unwrap();
                    assert!(result.is_err());
                    assert!(occupied.is_dir() && text_path.is_file());
                    let renamed = request(
                        &["New folder"],
                        LanChange::Rename {
                            name: "Renamed".into(),
                        },
                    );
                    let result: Result<()> = post("v1/lan/change")
                        .json(&renamed)
                        .send()
                        .await
                        .unwrap()
                        .json()
                        .await
                        .unwrap();
                    result.unwrap();
                    assert!(host.join("Renamed").join("note.txt").is_file());
                    for recursive in [false, true] {
                        let deletion = request(&["Renamed"], LanChange::Delete { recursive });
                        let result: Result<()> = post("v1/lan/change")
                            .json(&deletion)
                            .send()
                            .await
                            .unwrap()
                            .json()
                            .await
                            .unwrap();
                        assert_eq!(result.is_ok(), recursive);
                    }
                    assert!(!host.join("Renamed").exists());
                    b.set_writable(false);
                }
            }
        }
        a.stop().await.unwrap();
        b.stop().await.unwrap();
        c.stop().await.unwrap();
    }
}
