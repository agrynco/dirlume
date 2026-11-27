use std::{
    collections::HashMap,
    io,
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex},
};

use percent_encoding::percent_decode_str;
use url::Url;

use crate::desktop::{blocking, message, Result};

use super::{saved_credentials, vault, Connection, Credentials, Mount};

#[cfg(target_os = "linux")]
#[path = "unix/linux.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "unix/macos.rs"]
mod platform;

const INVALID_ADDRESS: &str = "Enter a server address or a full SMB path.";
static SESSION_CREDENTIALS: LazyLock<Mutex<HashMap<String, Arc<Credentials>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct Target {
    server: Url,
    segments: Vec<String>,
}

impl Target {
    fn parse(value: &str) -> Result<Self> {
        let value = value.trim().replace('\\', "/");
        let is_url = value
            .get(..6)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("smb://"));
        let address = if is_url {
            &value[6..]
        } else {
            value.strip_prefix("//").unwrap_or(&value)
        };
        let (host, path) = address.split_once('/').unwrap_or((address, ""));
        if host.is_empty()
            || host.contains(['@', '?', '#', '%'])
            || host.chars().any(char::is_whitespace)
        {
            return Err(INVALID_ADDRESS.to_owned());
        }
        let server =
            Url::parse(&format!("smb://{host}/")).map_err(|_| INVALID_ADDRESS.to_owned())?;
        if !server.has_host() || !server.username().is_empty() || server.password().is_some() {
            return Err(INVALID_ADDRESS.to_owned());
        }
        let segments = path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(|segment| {
                let decoded = if is_url {
                    percent_decode_str(segment)
                        .decode_utf8()
                        .map_err(|_| INVALID_ADDRESS.to_owned())?
                } else {
                    std::borrow::Cow::Borrowed(segment)
                };
                if matches!(decoded.as_ref(), "." | "..")
                    || decoded.contains(['/', '\\'])
                    || decoded.chars().any(char::is_control)
                {
                    return Err(INVALID_ADDRESS.to_owned());
                }
                Ok(decoded.into_owned())
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self { server, segments })
    }

    fn share_url(&self) -> Url {
        let mut url = self.server.clone();
        if let Some(share) = self.segments.first() {
            url.path_segments_mut()
                .expect("SMB URLs have a path")
                .pop_if_empty()
                .push(share);
        }
        url
    }

    fn open(&self, credentials: Option<&Credentials>) -> io::Result<Connection> {
        if self.segments.is_empty() {
            let mut names = platform::list_shares(&self.server, credentials)?;
            names.retain(|name| {
                !matches!(name.as_str(), "" | "." | "..")
                    && !name.contains(['/', '\\'])
                    && !name.chars().any(char::is_control)
            });
            names.sort_by_cached_key(|name| name.to_lowercase());
            names.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
            return Ok(Connection::Shares {
                server: self.server.to_string(),
                names,
                warning: None,
            });
        }
        let root = platform::mount_share(&self.share_url(), credentials)?;
        self.open_mounted(root)
    }

    fn open_mounted(&self, root: PathBuf) -> io::Result<Connection> {
        let path = self
            .segments
            .iter()
            .skip(1)
            .fold(root.clone(), |path, segment| path.join(segment));
        let listing = crate::local::list(&path)?;
        let root = crate::local::display_path(&root)?;
        Ok(Connection::Opened {
            listing,
            warning: None,
            mount: Mount {
                server: self.server.to_string(),
                root,
                share: self.share_url().to_string(),
            },
        })
    }
}

pub(super) async fn connect(
    path: String,
    credentials: Option<Credentials>,
    remember: bool,
) -> Result<Connection> {
    let target = Target::parse(&path)?;
    blocking(move || {
        let location = target.share_url();
        if credentials.as_ref().is_some_and(|value| {
            value.username.trim().is_empty()
                || value.username.contains('\0')
                || value.password.contains('\0')
        }) {
            return Err("Enter a valid SMB username and password.".to_owned());
        }
        let saved = credentials
            .is_none()
            .then(|| {
                let session = SESSION_CREDENTIALS.lock().ok().and_then(|entries| {
                    entries
                        .get(location.as_str())
                        .or_else(|| entries.get(target.server.as_str()))
                        .cloned()
                });
                session.or_else(|| {
                    saved_credentials(location.as_str())
                        .or_else(|| saved_credentials(target.server.as_str()))
                        .map(Arc::new)
                })
            })
            .flatten();
        let selected = credentials.as_ref().or(saved.as_deref());
        match target.open(selected) {
            Ok(mut connection) => {
                if let Some(credentials) = credentials {
                    if remember {
                        let secret = zeroize::Zeroizing::new(
                            serde_json::to_string(&(&credentials.username, &credentials.password))
                                .map_err(message)?,
                        );
                        let warning = vault(location.as_str())
                            .and_then(|entry| entry.set_password(&secret))
                            .err()
                            .map(message);
                        match &mut connection {
                            Connection::Opened { warning: saved, .. }
                            | Connection::Shares { warning: saved, .. } => *saved = warning,
                            Connection::CredentialsRequired { .. } => {}
                        }
                    }
                    if let Ok(mut entries) = SESSION_CREDENTIALS.lock() {
                        entries.insert(location.to_string(), Arc::new(credentials));
                    }
                }
                Ok(connection)
            }
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                Ok(Connection::CredentialsRequired {
                    error: selected.map(|_| message(error)),
                })
            }
            Err(error) => Err(message(error)),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_smb_addresses_without_allowing_embedded_credentials_or_parent_paths() {
        let target = Target::parse("smb://[2001:db8::9]/team%20share/quarterly reports").unwrap();
        assert_eq!(target.server.as_str(), "smb://[2001:db8::9]/");
        assert_eq!(
            target.share_url().as_str(),
            "smb://[2001:db8::9]/team%20share"
        );
        assert_eq!(target.segments, ["team share", "quarterly reports"]);
        assert_eq!(
            Target::parse(r"\\server\share").unwrap().segments,
            ["share"]
        );
        for input in [
            "smb://user:pass@server/share",
            "smb://server/share/%2e%2e",
            "smb://server/share/a%2fb",
            "smb://server/share/%00",
        ] {
            assert!(Target::parse(input).is_err(), "{input}");
        }
    }
}
