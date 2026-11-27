use std::{io, path::PathBuf, ptr, time::Duration};

use core_foundation::{
    array::{CFArray, CFArrayRef},
    base::TCFType,
    dictionary::{CFMutableDictionary, CFMutableDictionaryRef},
    string::{CFString, CFStringRef},
    url::{CFURLCreateWithString, CFURLRef, CFURL},
};
use url::Url;

use super::Credentials;

// NetFS can return either a positive errno or a negative OSStatus.
const ACCOUNT_RESTRICTED: i32 = -5999;
const GUEST_NOT_SUPPORTED: i32 = -6004;
const USER_CANCELLED: i32 = -128;

#[link(name = "NetFS", kind = "framework")]
unsafe extern "C" {
    fn NetFSMountURLSync(
        url: CFURLRef,
        mount_path: CFURLRef,
        user: CFStringRef,
        password: CFStringRef,
        open_options: CFMutableDictionaryRef,
        mount_options: CFMutableDictionaryRef,
        mount_points: *mut CFArrayRef,
    ) -> i32;
}

pub(super) fn list_shares(url: &Url, credentials: Option<&Credentials>) -> io::Result<Vec<String>> {
    let host = url
        .host_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Missing SMB server"))?;
    let username = credentials.map_or("", |value| value.username.trim());
    let (domain, username) = username.split_once('\\').unwrap_or(("", username));
    let config = smb2::ClientConfig {
        addr: format!("{host}:{}", url.port().unwrap_or(445)),
        username: username.to_owned(),
        domain: domain.to_owned(),
        password: credentials.map_or_else(String::new, |value| value.password.clone()),
        auto_reconnect: false,
        dfs_enabled: false,
        ..Default::default()
    };
    let response = tokio::runtime::Handle::current()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(15), async {
                let mut client = smb2::SmbClient::connect(config).await?;
                client.list_shares().await
            })
            .await
        })
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "The SMB server did not respond."))?;
    response
        .map(|shares| shares.into_iter().map(|share| share.name).collect())
        .map_err(|error| {
            let kind = match error.kind() {
                smb2::ErrorKind::AuthRequired
                | smb2::ErrorKind::AccessDenied
                | smb2::ErrorKind::SigningRequired => io::ErrorKind::PermissionDenied,
                _ => io::ErrorKind::Other,
            };
            io::Error::new(kind, error.to_string())
        })
}

pub(super) fn mount_share(url: &Url, credentials: Option<&Credentials>) -> io::Result<PathBuf> {
    let address = CFString::new(url.as_str());
    // Core Foundation returns an owned URL on success and null for an invalid address.
    let url =
        unsafe { CFURLCreateWithString(ptr::null(), address.as_concrete_TypeRef(), ptr::null()) };
    if url.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid SMB share address",
        ));
    }
    let url = unsafe { CFURL::wrap_under_create_rule(url) };
    let username = credentials.map(|value| CFString::new(value.username.trim()));
    let password = credentials.map(|value| CFString::new(&value.password));
    let mut options = CFMutableDictionary::new();
    options.set(CFString::new("UIOption"), CFString::new("NoUI"));
    let mut mount_points = ptr::null();
    // NetFS borrows the arguments and returns a retained array of POSIX mount paths.
    let status = unsafe {
        NetFSMountURLSync(
            url.as_concrete_TypeRef(),
            ptr::null(),
            username
                .as_ref()
                .map_or(ptr::null(), TCFType::as_concrete_TypeRef),
            password
                .as_ref()
                .map_or(ptr::null(), TCFType::as_concrete_TypeRef),
            options.as_concrete_TypeRef(),
            ptr::null_mut(),
            &mut mount_points,
        )
    };
    let mount_points = (!mount_points.is_null())
        .then(|| unsafe { CFArray::<CFString>::wrap_under_create_rule(mount_points) });
    if status != 0 {
        if matches!(
            status,
            libc::EAUTH | libc::EACCES | libc::EPERM | ACCOUNT_RESTRICTED | GUEST_NOT_SUPPORTED
        ) || (credentials.is_none() && status == USER_CANCELLED)
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "SMB sign-in was denied.",
            ));
        }
        if status < 0 {
            return Err(io::Error::other(format!(
                "macOS SMB mount failed ({status})."
            )));
        }
        return Err(io::Error::from_raw_os_error(status));
    }
    mount_points
        .as_ref()
        .and_then(|paths| {
            paths
                .iter()
                .map(|path| PathBuf::from(path.to_string()))
                .find(|path| path.is_dir())
        })
        .ok_or_else(|| io::Error::other("The SMB share did not provide a mounted folder."))
}
