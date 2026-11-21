use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use url::Url;

pub const INVITATION_PREFIX: &str = "dirlume-v1:";
pub const MAX_INVITATION_LENGTH: usize = 8192;

#[cfg(feature = "desktop")]
pub(crate) fn file_server_origin(scheme: &str, host: &str, port: u16, default_port: u16) -> String {
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    if port == default_port {
        format!("{scheme}://{host}")
    } else {
        format!("{scheme}://{host}:{port}")
    }
}

#[cfg(all(test, feature = "desktop"))]
#[test]
fn formats_file_server_origins_with_ipv6_and_non_default_ports() {
    assert_eq!(
        file_server_origin("ftp", "files.example", 21, 21),
        "ftp://files.example"
    );
    assert_eq!(
        file_server_origin("sftp", "2001:db8::1", 2222, 22),
        "sftp://[2001:db8::1]:2222"
    );
}

#[derive(Deserialize, Serialize)]
pub struct Invitation {
    pub address: Url,
    pub certificate: String,
    pub token: String,
}

#[cfg(feature = "desktop")]
impl Invitation {
    pub fn parse(input: &str) -> Result<Self, String> {
        let invalid = || "Enter a valid Dirlume server invitation.".to_owned();
        let input = input.trim();
        if input.len() > MAX_INVITATION_LENGTH {
            return Err(invalid());
        }
        let encoded = input.strip_prefix(INVITATION_PREFIX).ok_or_else(invalid)?;
        let raw = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| invalid())?;
        let invitation: Self = serde_json::from_slice(&raw).map_err(|_| invalid())?;
        let url = &invitation.address;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !URL_SAFE_NO_PAD
                .decode(&invitation.token)
                .is_ok_and(|bytes| bytes.len() == 32)
        {
            return Err(invalid());
        }
        Ok(invitation)
    }
}

#[cfg(feature = "server")]
impl Invitation {
    pub fn encode(&self) -> serde_json::Result<String> {
        Ok(format!(
            "{INVITATION_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(self)?)
        ))
    }
}

#[derive(Deserialize, Serialize)]
pub struct RemotePath {
    pub segments: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteListing {
    pub entries: Vec<crate::local::Entry>,
    pub omitted: usize,
}
#[derive(Deserialize, Serialize)]
pub struct ListRequest {
    #[serde(flatten)]
    pub path: RemotePath,
    #[serde(default)]
    pub paged: bool,
    pub after: Option<String>,
}
#[derive(Deserialize, Serialize)]
pub struct ListPage {
    #[serde(flatten)]
    pub listing: RemoteListing,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}
pub const BYTE_PAGE_SIZE: u64 = 1024;

#[derive(Deserialize, Serialize)]
pub struct ByteRequest {
    pub segments: Vec<String>,
    pub offset: u64,
}

#[derive(Deserialize, Serialize)]
pub struct BytePage {
    pub length: u64,
    pub data: Vec<u8>,
}
