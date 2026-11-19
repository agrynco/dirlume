use std::{io, path::Path};

use serde::Serialize;

/// Space on the volume that contains a folder, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct DiskSpace {
    /// Bytes the current user can still write, which respects quotas.
    pub available: u64,
    pub total: u64,
}

#[cfg(windows)]
pub fn query(path: &Path) -> io::Result<DiskSpace> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    if wide[..wide.len() - 1].contains(&0) {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let mut available = 0u64;
    let mut total = 0u64;
    // SAFETY: `wide` is NUL-terminated and both output pointers refer to live u64 values.
    let succeeded = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            &mut total,
            std::ptr::null_mut(),
        )
    };
    if succeeded == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(DiskSpace { available, total })
}

#[cfg(unix)]
pub fn query(path: &Path) -> io::Result<DiskSpace> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    // SAFETY: statvfs is plain old data, so an all-zero value is valid before the call fills it.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `path` is NUL-terminated and `stat` is a valid output location.
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let fragment = u64::from(stat.f_frsize);
    Ok(DiskSpace {
        available: u64::from(stat.f_bavail).saturating_mul(fragment),
        total: u64::from(stat.f_blocks).saturating_mul(fragment),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_volume_of_an_existing_folder() {
        let folder = tempfile::tempdir().unwrap();
        let space = query(folder.path()).unwrap();
        assert!(space.total > 0);
        assert!(space.available <= space.total);
    }

    #[test]
    fn rejects_a_missing_folder() {
        let folder = tempfile::tempdir().unwrap();
        assert!(query(&folder.path().join("missing")).is_err());
    }
}
