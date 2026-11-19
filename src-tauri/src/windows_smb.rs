use std::{io, path::PathBuf, ptr};

use serde::{Deserialize, Serialize};
use windows::{
    core::{PCWSTR, PWSTR},
    Win32::NetworkManagement::WNet::{
        WNetAddConnection2W, CONNECT_TEMPORARY, NETRESOURCEW, RESOURCETYPE_ANY, RESOURCETYPE_DISK,
    },
};
use windows_sys::Win32::{
    Foundation::ERROR_MORE_DATA,
    NetworkManagement::NetManagement::NetApiBufferFree,
    Storage::FileSystem::{NetShareEnum, SHARE_INFO_1, STYPE_DISKTREE, STYPE_MASK},
};

use crate::{
    desktop::{blocking, message, Result},
    local,
};

#[derive(Deserialize)]
pub struct Credentials {
    username: String,
    password: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Connection {
    Opened {
        listing: local::Listing,
        warning: Option<String>,
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

struct SmbTarget {
    server: String,
    share: Option<(PathBuf, String)>,
}

fn smb_target(value: &str) -> Result<SmbTarget> {
    let value = value.trim();
    let prefix = value
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("smb://"));
    let value = if prefix {
        format!("\\\\{}", value[6..].replace('/', "\\"))
    } else {
        value.replace('/', "\\")
    };
    let body = match value.strip_prefix("\\\\") {
        Some(body) => body,
        None if !value.contains('\\') => &value,
        None => return Err("Enter a server address or a full SMB path.".into()),
    };
    let parts: Vec<_> = body.split('\\').filter(|part| !part.is_empty()).collect();
    let Some((host, remainder)) = parts.split_first() else {
        return Err("Enter a server address or a full SMB path.".into());
    };
    if parts.iter().any(|part| *part == "." || *part == "..")
        || value
            .chars()
            .any(|ch| ch.is_control() || "<>\"|?*:".contains(ch))
        || host.contains('@')
        || host.chars().any(char::is_whitespace)
    {
        return Err("Enter a server address or a full SMB path.".into());
    }
    let server = format!("\\\\{host}");
    let share = remainder.first().map(|name| {
        (
            PathBuf::from(format!("{server}\\{}", remainder.join("\\"))),
            format!("{server}\\{name}"),
        )
    });
    Ok(SmbTarget { server, share })
}

fn authentication_error(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(5 | 65 | 86 | 1244 | 1272 | 1326 | 1327 | 1328 | 1329 | 1330 | 1331 | 1907 | 1909)
    )
}

fn authenticate(share: &str, credentials: &Credentials, discovery: bool) -> io::Result<()> {
    if credentials.username.trim().is_empty()
        || credentials.username.contains('\0')
        || credentials.password.contains('\0')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Enter a valid SMB username and password.",
        ));
    }
    let mut share: Vec<u16> = share.encode_utf16().chain(Some(0)).collect();
    let username: Vec<u16> = credentials
        .username
        .trim()
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut password: Vec<u16> = credentials.password.encode_utf16().chain(Some(0)).collect();
    let resource = NETRESOURCEW {
        dwType: if discovery {
            RESOURCETYPE_ANY
        } else {
            RESOURCETYPE_DISK
        },
        lpRemoteName: PWSTR(share.as_mut_ptr()),
        ..Default::default()
    };
    // The redirector establishes a UNC session without allocating a drive letter.
    let status = unsafe {
        WNetAddConnection2W(
            &resource,
            PCWSTR(password.as_ptr()),
            PCWSTR(username.as_ptr()),
            CONNECT_TEMPORARY,
        )
    };
    password.fill(0);
    if status.0 == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(status.0 as i32))
    }
}

fn list_shares(server: &str) -> io::Result<Vec<String>> {
    let address: Vec<u16> = server.encode_utf16().chain(Some(0)).collect();
    let mut names = Vec::new();
    let mut resume = 0;
    loop {
        let mut buffer = ptr::null_mut();
        let mut count = 0;
        let mut total = 0;
        let previous = resume;
        // NetAPI owns the buffer and its UTF-16 strings until NetApiBufferFree.
        let status = unsafe {
            let status = NetShareEnum(
                address.as_ptr(),
                1,
                &mut buffer,
                u32::MAX,
                &mut count,
                &mut total,
                &mut resume,
            );
            if !buffer.is_null() {
                if matches!(status, 0 | ERROR_MORE_DATA) {
                    for entry in
                        std::slice::from_raw_parts(buffer.cast::<SHARE_INFO_1>(), count as usize)
                    {
                        if entry.shi1_type & STYPE_MASK == STYPE_DISKTREE
                            && !entry.shi1_netname.is_null()
                        {
                            if let Ok(name) = PCWSTR(entry.shi1_netname).to_string() {
                                names.push(name);
                            }
                        }
                    }
                }
                NetApiBufferFree(buffer.cast());
            }
            status
        };
        if status == 0 {
            break;
        }
        if status != ERROR_MORE_DATA || resume == previous {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
    }
    names.sort_by_cached_key(|name| name.to_lowercase());
    names.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    Ok(names)
}

fn vault(location: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new("Dirlume SMB", &location.to_lowercase())
}

fn saved_credentials(location: &str) -> Option<Credentials> {
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
    let target = smb_target(&path)?;
    blocking(move || {
        let discovery = target.share.is_none();
        let location = target
            .share
            .as_ref()
            .map_or(target.server.as_str(), |(_, name)| name);
        let resource = if discovery {
            format!("{}\\IPC$", target.server)
        } else {
            location.to_owned()
        };
        let open = || match &target.share {
            Some((path, _)) => local::list(path).map(|listing| Connection::Opened {
                listing,
                warning: None,
            }),
            None => list_shares(&target.server).map(|names| Connection::Shares {
                server: target.server.clone(),
                names,
                warning: None,
            }),
        };
        let Some(credentials) = credentials else {
            return match open() {
                Ok(connection) => Ok(connection),
                Err(error) if authentication_error(&error) => {
                    let saved = saved_credentials(location).or_else(|| {
                        (!discovery)
                            .then(|| saved_credentials(&target.server))
                            .flatten()
                    });
                    if let Some(saved) = saved {
                        match authenticate(&resource, &saved, discovery).and_then(|()| open()) {
                            Ok(connection) => return Ok(connection),
                            Err(error) if !authentication_error(&error) => {
                                return Err(message(error))
                            }
                            Err(_) => {}
                        }
                    }
                    Ok(Connection::CredentialsRequired { error: None })
                }
                Err(error) => Err(message(error)),
            };
        };
        let result = authenticate(&resource, &credentials, discovery).and_then(|()| open());
        match result {
            Ok(mut connection) => {
                if remember {
                    let value =
                        serde_json::to_string(&(&credentials.username, &credentials.password))
                            .map_err(message)?;
                    let warning = vault(location)
                        .and_then(|entry| entry.set_password(&value))
                        .err()
                        .map(message);
                    match &mut connection {
                        Connection::Opened { warning: saved, .. }
                        | Connection::Shares { warning: saved, .. } => *saved = warning,
                        Connection::CredentialsRequired { .. } => {}
                    }
                }
                Ok(connection)
            }
            Err(error) if authentication_error(&error) => Ok(Connection::CredentialsRequired {
                error: Some(message(error)),
            }),
            Err(error) => Err(message(error)),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_share_and_preserves_its_subfolder() {
        let (path, share) = smb_target(r"smb://server/share/team notes")
            .unwrap()
            .share
            .unwrap();
        assert_eq!(share, r"\\server\share");
        assert_eq!(path, PathBuf::from(r"\\server\share\team notes"));
        let (path, share) = smb_target(r"\\server\\share\\folder\")
            .unwrap()
            .share
            .unwrap();
        assert_eq!(share, r"\\server\share");
        assert_eq!(path, PathBuf::from(r"\\server\share\folder"));
        let server = smb_target("192.0.2.1").unwrap();
        assert_eq!(server.server, r"\\192.0.2.1");
        assert!(server.share.is_none());
        for invalid in [
            r"C:\Users",
            r"\\?\C:\Users",
            r"\\server\share\..\other",
            "smb://user:password@server/share",
        ] {
            assert!(smb_target(invalid).is_err(), "{invalid}");
        }
    }
}
