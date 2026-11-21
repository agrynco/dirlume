use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::local::{self, Entry, EntryAttributes};

#[derive(Serialize)]
pub struct Mount {
    path: String,
    share: bool,
}

#[derive(Serialize)]
pub struct Directory {
    entries: Vec<Entry>,
    omitted: usize,
}

#[tauri::command]
pub async fn space_mount(path: String) -> Result<Mount, String> {
    crate::desktop::blocking(move || {
        let path = local::absolute(&path).map_err(|error| error.to_string())?;
        let (root, share) = platform::mount(path).map_err(|error| error.to_string())?;
        Ok(Mount {
            path: local::display_path(&root).map_err(|error| error.to_string())?,
            share,
        })
    })
    .await
}

#[tauri::command]
pub async fn list_space_directory(
    root: String,
    segments: Vec<String>,
) -> Result<Directory, String> {
    crate::desktop::blocking(move || {
        let root = local::absolute(&root).map_err(|error| error.to_string())?;
        list(root, &segments).map_err(|error| error.to_string())
    })
    .await
}

fn list(root: &Path, segments: &[String]) -> io::Result<Directory> {
    let mut path = root.canonicalize()?;
    let boundary = platform::boundary(&path, &fs::metadata(&path)?);
    for segment in segments {
        path.push(local::name_component(segment)?);
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_dir()
            || local::is_link(&metadata)
            || platform::boundary(&path, &metadata) != boundary
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "The folder is outside the scan scope.",
            ));
        }
    }
    if !segments.is_empty() && path.canonicalize()? != path {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "The folder is outside the scan scope.",
        ));
    }

    let mut entries = Vec::new();
    let mut omitted = 0;
    for item in fs::read_dir(path)? {
        match item.and_then(|item| describe(&item.path(), &boundary)) {
            Ok(Some(entry)) => entries.push(entry),
            Ok(None) => {}
            Err(_) => omitted += 1,
        }
    }
    Ok(Directory { entries, omitted })
}

fn describe(path: &Path, boundary: &platform::Boundary) -> io::Result<Option<Entry>> {
    let metadata = fs::symlink_metadata(path)?;
    if local::is_link(&metadata)
        || !(metadata.is_file() || metadata.is_dir())
        || platform::boundary(path, &metadata) != *boundary
    {
        return Ok(None);
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Unsupported file name."))?;
    local::name_component(name)?;
    let mut entry = Entry::new(
        name.to_owned(),
        metadata.is_dir(),
        false,
        EntryAttributes::default(),
        metadata.is_file().then_some(metadata.len()),
        None,
    );
    if metadata.is_file() {
        (entry.allocated, entry.allocation_id) = platform::usage(path, &metadata);
    }
    Ok(Some(entry))
}

#[cfg(windows)]
mod platform {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Component, Prefix};
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetVolumePathNameW};

    use super::*;

    // Windows marks directory volume mount points, junctions, and symlinks as reparse points.
    #[derive(PartialEq, Eq)]
    pub(super) struct Boundary;
    pub(super) fn boundary(_: &Path, _: &fs::Metadata) -> Boundary {
        Boundary
    }

    pub(super) fn usage(path: &Path, _: &fs::Metadata) -> (Option<u64>, Option<String>) {
        crate::file_attributes::space_usage(path)
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    fn share_root(path: &Path) -> Option<PathBuf> {
        matches!(path.components().next(), Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::UNC(..) | Prefix::VerbatimUNC(..)))
        .then(|| path.components().take(2).collect())
    }

    pub(super) fn mount(path: &Path) -> io::Result<(PathBuf, bool)> {
        if let Some(root) = share_root(path) {
            return Ok((root, true));
        }
        let mut output = vec![0u16; 32768];
        let input = wide(path);
        let success =
            unsafe { GetVolumePathNameW(input.as_ptr(), output.as_mut_ptr(), output.len() as u32) };
        if success == 0 {
            return Err(io::Error::last_os_error());
        }
        let length = output
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(output.len());
        let root = PathBuf::from(std::ffi::OsString::from_wide(&output[..length]));
        const DRIVE_REMOTE: u32 = 4;
        let share = unsafe { GetDriveTypeW(output.as_ptr()) } == DRIVE_REMOTE;
        Ok((root, share))
    }

    #[test]
    fn keeps_native_smb_scope_inside_the_selected_share() {
        let path = Path::new(r"\\server\share\folder");
        let (root, share) = mount(path).unwrap();
        assert!(share);
        assert_eq!(root, Path::new(r"\\server\share\"));
    }
}

#[cfg(unix)]
mod platform {
    use std::{
        ffi::CString,
        mem::MaybeUninit,
        os::unix::{ffi::OsStrExt, fs::MetadataExt},
    };

    use super::*;

    pub(super) type Boundary = (u64, Option<u64>);

    pub(super) fn boundary(path: &Path, metadata: &fs::Metadata) -> Boundary {
        (metadata.dev(), mount_id(path))
    }

    #[cfg(target_os = "linux")]
    fn mount_id(path: &Path) -> Option<u64> {
        let path = CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut info = MaybeUninit::<libc::statx>::zeroed();
        let result = unsafe {
            libc::statx(
                libc::AT_FDCWD,
                path.as_ptr(),
                libc::AT_SYMLINK_NOFOLLOW | libc::AT_STATX_DONT_SYNC,
                libc::STATX_MNT_ID,
                info.as_mut_ptr(),
            )
        };
        if result != 0 {
            return None;
        }
        let info = unsafe { info.assume_init() };
        (info.stx_mask & libc::STATX_MNT_ID != 0).then_some(info.stx_mnt_id)
    }

    #[cfg(not(target_os = "linux"))]
    fn mount_id(_: &Path) -> Option<u64> {
        None
    }

    pub(super) fn usage(_: &Path, metadata: &fs::Metadata) -> (Option<u64>, Option<String>) {
        let id = (metadata.nlink() > 1 && metadata.ino() != 0)
            .then(|| format!("{}:{}", metadata.dev(), metadata.ino()));
        (metadata.blocks().checked_mul(512), id)
    }

    #[cfg(not(target_os = "macos"))]
    pub(super) fn mount(path: &Path) -> io::Result<(PathBuf, bool)> {
        let path = path.canonicalize()?;
        let key = boundary(&path, &fs::metadata(&path)?);
        let mut root = path.as_path();
        while let Some(parent) = root.parent() {
            if boundary(parent, &fs::metadata(parent)?) != key {
                break;
            }
            root = parent;
        }
        #[cfg(target_os = "linux")]
        let share = filesystem(root)
            .is_ok_and(|info| matches!(info.f_type as u32, 0xff53_4d42 | 0xfe53_4d42 | 0x517b));
        #[cfg(not(target_os = "linux"))]
        let share = false;
        Ok((root.to_path_buf(), share))
    }

    #[cfg(target_os = "macos")]
    pub(super) fn mount(path: &Path) -> io::Result<(PathBuf, bool)> {
        use std::ffi::{CStr, OsStr};

        let info = filesystem(path)?;
        let root = unsafe { CStr::from_ptr(info.f_mntonname.as_ptr()) }.to_bytes();
        let kind = unsafe { CStr::from_ptr(info.f_fstypename.as_ptr()) }.to_bytes();
        Ok((PathBuf::from(OsStr::from_bytes(root)), kind == b"smbfs"))
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn filesystem(path: &Path) -> io::Result<libc::statfs> {
        let path = CString::new(path.as_os_str().as_bytes())?;
        let mut info = MaybeUninit::<libc::statfs>::zeroed();
        if unsafe { libc::statfs(path.as_ptr(), info.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { info.assume_init() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_file_allocation_and_hard_link_identity_without_following_links() {
        let fixture = tempfile::tempdir().unwrap();
        let folder = fixture.path().join("folder");
        let outside = fixture.path().join("outside");
        fs::create_dir(&folder).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(folder.join(".hidden"), vec![42; 16_384]).unwrap();
        fs::write(outside.join("excluded"), b"outside").unwrap();
        fs::hard_link(folder.join(".hidden"), folder.join("second")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, folder.join("redirect")).unwrap();
        #[cfg(windows)]
        junction::create(&outside, folder.join("redirect")).unwrap();

        let listing = list(&folder, &[]).unwrap();
        assert_eq!(listing.omitted, 0);
        assert_eq!(listing.entries.len(), 2);
        assert!(listing.entries.iter().any(|entry| entry.name == ".hidden"));
        assert!(listing.entries[0].allocated.is_some());
        assert!(listing.entries[0].allocation_id.is_some());
        assert_eq!(
            listing.entries[0].allocation_id,
            listing.entries[1].allocation_id
        );
        assert!(list(&folder, &["redirect".into()]).is_err());
        assert!(list(&folder, &["..".into()]).is_err());
        assert!(list(&folder.join("missing"), &[]).is_err());
        let (root, _) = platform::mount(&folder).unwrap();
        let canonical = folder.canonicalize().unwrap();
        assert!(
            platform::boundary(&canonical, &fs::metadata(&canonical).unwrap())
                == platform::boundary(&root, &fs::metadata(&root).unwrap())
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recognizes_linux_nested_mounts() {
        let target = Path::new("/dev/shm");
        if !target.is_dir() {
            return;
        }
        let mount_info = fs::read_to_string("/proc/self/mountinfo").unwrap_or_default();
        if !mount_info
            .lines()
            .any(|line| line.split_whitespace().nth(4) == Some("/dev/shm"))
        {
            return;
        }
        let (root, share) = platform::mount(target).unwrap();
        assert_eq!(root, target);
        assert!(!share);
        assert!(list(Path::new("/dev"), &["shm".into()]).is_err());
    }
}
