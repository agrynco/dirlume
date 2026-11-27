use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::{local, Result};

#[derive(Deserialize)]
pub struct Credentials {
    pub(crate) username: String,
    pub(crate) password: String,
}

impl Drop for Credentials {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Connection {
    Opened {
        listing: local::Listing,
        warning: Option<String>,
        #[cfg(unix)]
        mount: Mount,
    },
    Shares {
        server: String,
        names: Vec<String>,
        warning: Option<String>,
    },
    CredentialsRequired {
        error: Option<String>,
    },
}

pub(crate) fn vault(location: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new("Dirlume SMB", &location.to_lowercase())
}

pub(crate) fn saved_credentials(location: &str) -> Option<Credentials> {
    let value = vault(location)
        .and_then(|entry| entry.get_password())
        .ok()?;
    let (username, password) = serde_json::from_str::<(String, String)>(&value).ok()?;
    Some(Credentials { username, password })
}

#[tauri::command]
pub async fn connect_smb(
    path: String,
    credentials: Option<Credentials>,
    remember: bool,
) -> Result<Connection> {
    #[cfg(windows)]
    return crate::windows_smb::connect(path, credentials, remember).await;
    #[cfg(unix)]
    unix::connect(path, credentials, remember).await
}

#[cfg(unix)]
mod unix;

#[cfg(unix)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mount {
    server: String,
    root: String,
    share: String,
}
