use std::{
    fs,
    io::{self, Write},
    path::Path,
};

use crate::{message, Result};

use super::{checked_read, read, revision};

const CONFLICT: &str = "The menu definition changed on disk. Reload before continuing.";

pub(super) fn save(path: &Path, bytes: &[u8], expected: Option<&str>) -> Result<()> {
    let parent = path.parent().ok_or("The menu has no parent folder.")?;
    let transaction = tempfile::Builder::new()
        .prefix(".dirlume-menu-")
        .tempdir_in(parent)
        .map_err(message)?;
    let candidate = transaction.path().join("candidate.json");
    let mut file = fs::File::create_new(&candidate).map_err(message)?;
    file.write_all(bytes).map_err(message)?;
    let previous = checked_read(path, expected)?;
    if previous.is_some() {
        let metadata = path.symlink_metadata().map_err(message)?;
        if metadata.permissions().readonly() {
            return Err("The menu definition is read only.".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o6000 != 0 {
                return Err("The menu definition uses special permissions.".into());
            }
            crate::local::preserve_access(path, &candidate, &metadata).map_err(message)?;
        }
    }
    file.sync_all().map_err(message)?;
    drop(file);
    checked_read(path, expected)?;
    if previous.is_none() {
        return renamest::rename_exclusive(&candidate, path).map_err(message);
    }
    let displaced = transaction.path().join("previous.json");
    if let Err(error) = replace(path, &candidate, &displaced) {
        if displaced.exists() {
            let folder = transaction.keep();
            return Err(format!(
                "{error}. The previous menu is in {}.",
                folder.display()
            ));
        }
        return Err(message(error));
    }
    if read(&displaced).is_ok_and(|found| found == previous) {
        return Ok(());
    }
    let attempted = transaction.path().join("attempted.json");
    let restored = checked_read(path, Some(&revision(bytes))).is_ok()
        && replace(path, &displaced, &attempted).is_ok();
    if restored && read(&attempted).is_ok_and(|found| found.as_deref() == Some(bytes)) {
        return Err(CONFLICT.into());
    }
    let folder = transaction.keep();
    Err(format!(
        "{CONFLICT} Menu versions are available in {}.",
        folder.display()
    ))
}

#[cfg(windows)]
fn replace(path: &Path, incoming: &Path, prior: &Path) -> io::Result<()> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain([0])
            .collect::<Vec<_>>()
    };
    let (path, incoming, prior) = (wide(path), wide(incoming), wide(prior));
    // All three UTF-16 paths stay valid and NUL-terminated until the call returns.
    if unsafe {
        ReplaceFileW(
            path.as_ptr(),
            incoming.as_ptr(),
            prior.as_ptr(),
            0,
            ptr::null(),
            ptr::null(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
fn replace(path: &Path, incoming: &Path, prior: &Path) -> io::Result<()> {
    // The backup must already exist as an atomic exchange endpoint. Move the incoming
    // file to it first so the exchange itself leaves the displaced file at `prior`.
    fs::rename(incoming, prior)?;
    if let Err(error) = exchange(path, prior) {
        let _ = fs::rename(prior, incoming);
        return Err(error);
    }
    Ok(())
}

#[cfg(unix)]
fn exchange(left: &Path, right: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let left = CString::new(left.as_os_str().as_bytes())?;
    let right = CString::new(right.as_os_str().as_bytes())?;
    // Both paths stay valid and NUL-terminated throughout the native exchange.
    #[cfg(target_os = "linux")]
    let status = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            left.as_ptr(),
            libc::AT_FDCWD,
            right.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    };
    #[cfg(target_os = "macos")]
    let status = unsafe { libc::renamex_np(left.as_ptr(), right.as_ptr(), libc::RENAME_SWAP) };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let status = {
        let _ = (left, right);
        return Err(io::ErrorKind::Unsupported.into());
    };
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
