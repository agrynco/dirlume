use std::{ffi::CStr, io, path::PathBuf, ptr, slice, time::Duration};

use core_foundation::{
    array::{CFArray, CFArrayRef},
    base::TCFType,
    dictionary::{CFMutableDictionary, CFMutableDictionaryRef},
    string::{CFString, CFStringRef},
    url::{CFURLCreateWithString, CFURLRef, CFURL},
};
use percent_encoding::percent_decode_str;
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
    let url_address = url.clone();
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
        if status == libc::EEXIST {
            // NetFS reports EEXIST without mount points when the share is already
            // mounted, for example by Finder, so reuse that mount.
            if let Some(path) = existing_mount(&url_address) {
                return Ok(path);
            }
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

/// Finds the folder where macOS already mounted the share at `url`.
fn existing_mount(url: &Url) -> Option<PathBuf> {
    let host = url.host_str()?;
    let share = url.path_segments()?.find(|segment| !segment.is_empty())?;
    let share = percent_decode_str(share).decode_utf8().ok()?;
    let mut mounts: *mut libc::statfs = ptr::null_mut();
    // getmntinfo returns a buffer owned by libc that stays valid until the next call.
    let count = unsafe { libc::getmntinfo(&mut mounts, libc::MNT_NOWAIT) };
    if count <= 0 || mounts.is_null() {
        return None;
    }
    let mounts = unsafe { slice::from_raw_parts(mounts, count as usize) };
    mounts.iter().find_map(|mount| {
        let kind = unsafe { CStr::from_ptr(mount.f_fstypename.as_ptr()) };
        if kind.to_bytes() != b"smbfs" {
            return None;
        }
        let source = unsafe { CStr::from_ptr(mount.f_mntfromname.as_ptr()) };
        if !mounted_share_matches(&source.to_string_lossy(), host, &share) {
            return None;
        }
        let path = unsafe { CStr::from_ptr(mount.f_mntonname.as_ptr()) };
        Some(PathBuf::from(path.to_string_lossy().into_owned())).filter(|path| path.is_dir())
    })
}

/// Compares an smbfs mount source such as `//user@server/share` with a host and share name.
fn mounted_share_matches(source: &str, host: &str, share: &str) -> bool {
    let Some((authority, path)) = source
        .strip_prefix("//")
        .and_then(|source| source.split_once('/'))
    else {
        return false;
    };
    let mounted_host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let Ok(mounted_share) = percent_decode_str(path.trim_end_matches('/')).decode_utf8() else {
        return false;
    };
    mounted_host
        .trim_end_matches('.')
        .eq_ignore_ascii_case(host.trim_end_matches('.'))
        && mounted_share.eq_ignore_ascii_case(share)
}

#[cfg(test)]
mod tests {
    use super::mounted_share_matches;

    #[test]
    fn matches_mount_sources_for_the_requested_share() {
        assert!(mounted_share_matches(
            "//slava@raspi-server.local/shared",
            "raspi-server.local",
            "shared"
        ));
        assert!(mounted_share_matches(
            "//;WORK;anna@NAS.local./Team%20Files",
            "nas.local",
            "team files"
        ));
        assert!(mounted_share_matches("//GUEST:@nas/media", "nas", "media"));
        assert!(!mounted_share_matches("//nas/media", "nas", "music"));
        assert!(!mounted_share_matches("//other/media", "nas", "media"));
        assert!(!mounted_share_matches("/dev/disk3s1", "nas", "media"));
    }
}
