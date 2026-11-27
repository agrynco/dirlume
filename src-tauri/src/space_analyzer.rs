use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{ipc::Channel, State};

use crate::local;

#[cfg(windows)]
mod mft;
#[cfg(windows)]
mod windows_walk;

#[derive(Default)]
pub struct Scans(Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScanEvent {
    Start { strategy: &'static str },
    Batch { changes: Vec<Change> },
    Finished,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum Change {
    Entry {
        parent: usize,
        name: String,
        directory: bool,
        size: Option<u64>,
        allocated: Option<u64>,
        shared: bool,
    },
    Closed {
        closed: usize,
        error: Option<String>,
        partial: bool,
    },
}

struct Output<'a> {
    send: &'a mut dyn FnMut(ScanEvent) -> io::Result<()>,
    stop: &'a AtomicBool,
    changes: Vec<Change>,
    identities: HashSet<(u64, u128)>,
    next_id: usize,
    last: Instant,
}

impl Output<'_> {
    fn check(&self) -> io::Result<()> {
        if self.stop.load(Ordering::Relaxed) {
            return Err(io::ErrorKind::Interrupted.into());
        }
        Ok(())
    }

    fn start(&mut self, strategy: &'static str) -> io::Result<()> {
        self.check()?;
        self.changes.clear();
        self.identities.clear();
        self.next_id = 1;
        (self.send)(ScanEvent::Start { strategy })
    }

    fn flush(&mut self) -> io::Result<()> {
        self.check()?;
        if !self.changes.is_empty() {
            (self.send)(ScanEvent::Batch {
                changes: std::mem::take(&mut self.changes),
            })?;
            self.last = Instant::now();
        }
        Ok(())
    }

    fn push(&mut self, change: Change) -> io::Result<()> {
        self.check()?;
        self.changes.push(change);
        if self.next_id == 2
            || self.changes.len() >= 1024
            || self.last.elapsed() >= Duration::from_millis(75)
        {
            self.flush()?;
        }
        Ok(())
    }

    fn entry(
        &mut self,
        parent: usize,
        name: String,
        directory: bool,
        size: Option<u64>,
        allocated: Option<u64>,
        identity: Option<(u64, u128)>,
    ) -> io::Result<usize> {
        let id = self.next_id;
        self.next_id += 1;
        let shared =
            allocated.is_some() && identity.is_some_and(|key| !self.identities.insert(key));
        self.push(Change::Entry {
            parent,
            name,
            directory,
            size,
            allocated: if shared { Some(0) } else { allocated },
            shared,
        })?;
        Ok(id)
    }

    fn closed(&mut self, id: usize, partial: bool, error: Option<String>) -> io::Result<()> {
        self.push(Change::Closed {
            closed: id,
            partial,
            error,
        })
    }
}

#[tauri::command]
pub async fn scan_local_space(
    root: String,
    id: String,
    output: Channel<ScanEvent>,
    scans: State<'_, Scans>,
) -> Result<(), String> {
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut active = scans.0.lock().map_err(crate::desktop::message)?;
        if active.contains_key(&id) {
            return Err("This scan is already running.".into());
        }
        active.insert(id.clone(), stop.clone());
    }
    let result = crate::desktop::blocking(move || {
        let root = local::absolute(&root).map_err(crate::desktop::message)?;
        let sent = scan(root, &stop, &mut |event| {
            output.send(event).map_err(io::Error::other)
        });
        if stop.load(Ordering::Relaxed) {
            Ok(())
        } else {
            sent.map_err(crate::desktop::message)
        }
    })
    .await;
    scans.0.lock().map_err(crate::desktop::message)?.remove(&id);
    result
}

#[tauri::command]
pub fn cancel_space_scan(id: String, scans: State<'_, Scans>) -> Result<(), String> {
    if let Some(stop) = scans.0.lock().map_err(crate::desktop::message)?.get(&id) {
        stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn scan(
    root: &Path,
    stop: &AtomicBool,
    send: &mut dyn FnMut(ScanEvent) -> io::Result<()>,
) -> io::Result<()> {
    let mut out = Output {
        send,
        stop,
        changes: Vec::new(),
        identities: HashSet::new(),
        next_id: 1,
        last: Instant::now(),
    };
    let root = root.canonicalize()?;
    #[cfg(windows)]
    if let Some(volume) = mft::open(&root) {
        out.start("mft")?;
        if mft::scan(&root, &volume, &mut out).is_ok() {
            out.flush()?;
            return (out.send)(ScanEvent::Finished);
        }
        out.check()?;
    }
    out.start("walk")?;
    walk(&root, &mut out)?;
    out.flush()?;
    (out.send)(ScanEvent::Finished)
}

pub fn measure_folder(root: &Path, stop: &AtomicBool) -> Option<(u64, bool)> {
    if stop.load(Ordering::Relaxed) {
        return None;
    }
    if !fs::symlink_metadata(root)
        .is_ok_and(|metadata| metadata.is_dir() && !local::is_link(&metadata))
    {
        return Some((0, true));
    }

    let mut bytes = 0u64;
    let mut incomplete = false;
    let result = scan(root, stop, &mut |event| {
        match event {
            ScanEvent::Start { .. } => {
                bytes = 0;
                incomplete = false;
            }
            ScanEvent::Batch { changes } => {
                for change in changes {
                    match change {
                        Change::Entry {
                            directory: false,
                            size,
                            ..
                        } => {
                            bytes = bytes.saturating_add(size.unwrap_or(0));
                            incomplete |= size.is_none();
                        }
                        Change::Closed { partial, .. } => incomplete |= partial,
                        _ => {}
                    }
                }
            }
            ScanEvent::Finished => {}
        }
        Ok(())
    });
    (!stop.load(Ordering::Relaxed)).then_some((bytes, incomplete || result.is_err()))
}

fn walk(root: &Path, out: &mut Output<'_>) -> io::Result<()> {
    #[cfg(windows)]
    if let Some(volume) = windows_walk::local_ntfs(root) {
        match windows_walk::scan(root, volume, out) {
            Err(e) if windows_walk::unsupported(&e) => out.start("walk")?,
            result => return result,
        }
    }
    let boundary = platform::boundary(root, &fs::metadata(root)?);
    #[cfg(target_os = "linux")]
    let lookup = if platform::has_ext_mount_id(root, &boundary) {
        MetadataLookup::Statx
    } else {
        MetadataLookup::Generic
    };
    #[cfg(not(target_os = "linux"))]
    let lookup = MetadataLookup::Generic;
    walk_entries(root, out, &boundary, lookup)
}

#[derive(Clone, Copy)]
enum MetadataLookup {
    Generic,
    #[cfg(target_os = "linux")]
    Statx,
}

#[derive(PartialEq, Eq, Debug)]
enum Child {
    Directory,
    File {
        size: u64,
        allocated: Option<u64>,
        identity: Option<(u64, u128)>,
    },
}

fn metadata_for_scan(
    lookup: MetadataLookup,
    item: &fs::DirEntry,
    path: &Path,
    boundary: &platform::Boundary,
) -> io::Result<Option<Child>> {
    match lookup {
        MetadataLookup::Generic => {}
        #[cfg(target_os = "linux")]
        MetadataLookup::Statx => {
            if let Some(child) = platform::statx_child(path, boundary) {
                return Ok(child);
            }
        }
    }
    let metadata = item.metadata()?;
    if local::is_link(&metadata)
        || !(metadata.is_dir() || metadata.is_file())
        || platform::boundary(path, &metadata) != *boundary
    {
        return Ok(None);
    }
    if metadata.is_dir() {
        return Ok(Some(Child::Directory));
    }
    let (allocated, identity) = platform::usage(path, &metadata);
    Ok(Some(Child::File {
        size: metadata.len(),
        allocated,
        identity,
    }))
}

fn walk_entries(
    root: &Path,
    out: &mut Output<'_>,
    boundary: &platform::Boundary,
    lookup: MetadataLookup,
) -> io::Result<()> {
    let mut jobs = vec![(0, root.to_path_buf())];
    while let Some((parent, folder)) = jobs.pop() {
        out.check()?;
        let children = directory(&folder, boundary);
        let items = match children {
            Ok(items) => items,
            Err(error) if parent == 0 => return Err(error),
            Err(error) => {
                out.closed(parent, true, Some(error.to_string()))?;
                continue;
            }
        };
        let mut omitted = false;
        for item in items {
            out.check()?;
            let child = item.and_then(|item| {
                let path = item.path();
                let Some(kind) = metadata_for_scan(lookup, &item, &path, boundary)? else {
                    return Ok(None);
                };
                let name = item
                    .file_name()
                    .into_string()
                    .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
                local::name_component(&name)?;
                Ok(Some((path, name, kind)))
            });
            match child {
                Ok(Some((path, name, Child::Directory))) => {
                    jobs.push((out.entry(parent, name, true, None, None, None)?, path));
                }
                Ok(Some((
                    _,
                    name,
                    Child::File {
                        size,
                        allocated,
                        identity,
                    },
                ))) => {
                    out.entry(parent, name, false, Some(size), allocated, identity)?;
                }
                Ok(None) => {}
                Err(_) => omitted = true,
            }
        }
        out.closed(parent, omitted, None)?;
    }
    Ok(())
}

fn directory(path: &Path, boundary: &platform::Boundary) -> io::Result<fs::ReadDir> {
    let metadata = fs::symlink_metadata(path)?;
    if local::is_link(&metadata)
        || platform::boundary(path, &metadata) != *boundary
        || path.canonicalize()? != path
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "The folder is outside the scan scope.",
        ));
    }
    fs::read_dir(path)
}

#[derive(Serialize)]
pub struct Mount {
    path: String,
    share: bool,
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

#[derive(Serialize)]
pub struct VolumeInformation {
    path: String,
    share: bool,
    label: Option<String>,
    filesystem: Option<String>,
    capacity: Option<crate::disk_space::DiskSpace>,
}

#[tauri::command]
pub async fn volume_information(path: String) -> Result<VolumeInformation, String> {
    crate::desktop::blocking(move || {
        let path = local::absolute(&path).map_err(|error| error.to_string())?;
        let (root, share) = platform::mount(path).map_err(|error| error.to_string())?;
        let (label, filesystem) = platform::volume_details(&root);
        Ok(VolumeInformation {
            path: local::display_path(&root).map_err(|error| error.to_string())?,
            share,
            label,
            filesystem,
            capacity: crate::disk_space::query(path).ok(),
        })
    })
    .await
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        fs::{File, OpenOptions},
        os::windows::{
            ffi::{OsStrExt, OsStringExt},
            fs::OpenOptionsExt,
            io::AsRawHandle,
        },
        path::{Component, Prefix},
    };
    use windows_sys::Win32::Storage::FileSystem::{
        GetDriveTypeW, GetFileInformationByHandle, GetVolumeInformationW, GetVolumePathNameW,
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
        FILE_READ_ATTRIBUTES,
    };

    pub(super) fn open_directory(path: &Path) -> io::Result<File> {
        OpenOptions::new()
            .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
    }

    pub(super) fn directory_identity(file: &File) -> io::Result<(u32, u64)> {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
            != FILE_ATTRIBUTE_DIRECTORY
        {
            return Err(io::Error::other("The directory changed during the scan."));
        }
        let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
        Ok((info.dwVolumeSerialNumber, index))
    }

    // Windows marks directory volume mount points, junctions, and symlinks as reparse points.
    #[derive(PartialEq, Eq)]
    pub(super) struct Boundary;
    pub(super) fn boundary(_: &Path, _: &fs::Metadata) -> Boundary {
        Boundary
    }

    pub(super) fn usage(path: &Path, _: &fs::Metadata) -> (Option<u64>, Option<(u64, u128)>) {
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

    pub(super) fn volume_details(root: &Path) -> (Option<String>, Option<String>) {
        let root = wide(root);
        let mut label = [0u16; 261];
        let mut filesystem = [0u16; 261];
        // SAFETY: the root is NUL-terminated, and the output buffers have the specified lengths.
        let found = unsafe {
            GetVolumeInformationW(
                root.as_ptr(),
                label.as_mut_ptr(),
                label.len() as u32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                filesystem.as_mut_ptr(),
                filesystem.len() as u32,
            )
        };
        if found == 0 {
            return (None, None);
        }
        let read = |buffer: &[u16]| {
            let length = buffer
                .iter()
                .position(|&unit| unit == 0)
                .unwrap_or(buffer.len());
            (length > 0).then(|| String::from_utf16_lossy(&buffer[..length]))
        };
        (read(&label), read(&filesystem))
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
        statx(path, libc::STATX_MNT_ID).map(|info| info.stx_mnt_id)
    }

    #[cfg(target_os = "linux")]
    fn statx(path: &Path, mask: libc::c_uint) -> Option<libc::statx> {
        let path = CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut info = MaybeUninit::<libc::statx>::zeroed();
        let result = unsafe {
            libc::statx(
                libc::AT_FDCWD,
                path.as_ptr(),
                libc::AT_SYMLINK_NOFOLLOW | libc::AT_STATX_DONT_SYNC,
                mask,
                info.as_mut_ptr(),
            )
        };
        if result != 0 {
            return None;
        }
        let info = unsafe { info.assume_init() };
        (info.stx_mask & mask == mask).then_some(info)
    }

    #[cfg(target_os = "linux")]
    pub(super) fn has_ext_mount_id(path: &Path, boundary: &Boundary) -> bool {
        const EXT_SUPER_MAGIC: libc::c_long = 0xef53;
        boundary.1.is_some() && filesystem(path).is_ok_and(|fs| fs.f_type == EXT_SUPER_MAGIC)
    }

    #[cfg(target_os = "linux")]
    pub(super) fn statx_child(path: &Path, boundary: &Boundary) -> Option<Option<Child>> {
        let info = statx(
            path,
            libc::STATX_TYPE
                | libc::STATX_NLINK
                | libc::STATX_INO
                | libc::STATX_SIZE
                | libc::STATX_BLOCKS
                | libc::STATX_MNT_ID,
        )?;
        let device = libc::makedev(info.stx_dev_major, info.stx_dev_minor);
        if (device, Some(info.stx_mnt_id)) != *boundary {
            return Some(None);
        }
        let result = match libc::mode_t::from(info.stx_mode) & libc::S_IFMT {
            libc::S_IFDIR => Some(Child::Directory),
            libc::S_IFREG => Some(Child::File {
                size: info.stx_size,
                allocated: info.stx_blocks.checked_mul(512),
                identity: (info.stx_nlink > 1 && info.stx_ino != 0)
                    .then_some((device, u128::from(info.stx_ino))),
            }),
            _ => None,
        };
        Some(result)
    }

    #[cfg(not(target_os = "linux"))]
    fn mount_id(_: &Path) -> Option<u64> {
        None
    }

    pub(super) fn usage(_: &Path, metadata: &fs::Metadata) -> (Option<u64>, Option<(u64, u128)>) {
        let id = (metadata.nlink() > 1 && metadata.ino() != 0)
            .then_some((metadata.dev(), u128::from(metadata.ino())));
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

    #[cfg(target_os = "linux")]
    pub(super) fn volume_details(root: &Path) -> (Option<String>, Option<String>) {
        let Some(id) = mount_id(root) else {
            return (None, None);
        };
        let Ok(mounts) = fs::read_to_string("/proc/self/mountinfo") else {
            return (None, None);
        };
        for line in mounts.lines() {
            let Some((fields, volume)) = line.split_once(" - ") else {
                continue;
            };
            let mut fields = fields.split_ascii_whitespace();
            if fields.next().and_then(|value| value.parse::<u64>().ok()) != Some(id) {
                continue;
            }
            let device = fields.nth(1);
            let mut volume = volume.split_ascii_whitespace();
            let filesystem = volume.next().map(str::to_owned);
            let label = device.and_then(|device| {
                let info = fs::read_to_string(format!("/run/udev/data/b{device}")).ok()?;
                info.lines().find_map(|line| {
                    line.strip_prefix("E:ID_FS_LABEL=")
                        .filter(|label| !label.is_empty())
                        .map(str::to_owned)
                })
            });
            return (label, filesystem);
        }
        (None, None)
    }

    #[cfg(target_os = "macos")]
    pub(super) fn volume_details(root: &Path) -> (Option<String>, Option<String>) {
        use std::ffi::CStr;

        let kind = filesystem(root).ok().map(|info| {
            // SAFETY: statfs returns a NUL-terminated filesystem name.
            unsafe { CStr::from_ptr(info.f_fstypename.as_ptr()) }
                .to_string_lossy()
                .into_owned()
        });
        let Ok(path) = CString::new(root.as_os_str().as_bytes()) else {
            return (None, kind);
        };
        let mut attributes = libc::attrlist {
            bitmapcount: libc::ATTR_BIT_MAP_COUNT,
            reserved: 0,
            commonattr: 0,
            volattr: libc::ATTR_VOL_INFO | libc::ATTR_VOL_NAME,
            dirattr: 0,
            fileattr: 0,
            forkattr: 0,
        };
        let mut data = [0u8; 1024];
        // SAFETY: both pointers are live for the call, and the supplied buffer size is correct.
        let found = unsafe {
            libc::getattrlist(
                path.as_ptr(),
                (&mut attributes as *mut libc::attrlist).cast(),
                data.as_mut_ptr().cast(),
                data.len(),
                0,
            )
        } == 0;
        let label = found
            .then(|| {
                let offset = i32::from_ne_bytes(data[4..8].try_into().unwrap());
                let length = u32::from_ne_bytes(data[8..12].try_into().unwrap()) as usize;
                let start = 4usize.checked_add_signed(offset as isize)?;
                let name = CStr::from_bytes_until_nul(data.get(start..start.checked_add(length)?)?)
                    .ok()?;
                (!name.is_empty()).then(|| name.to_string_lossy().into_owned())
            })
            .flatten();
        (label, kind)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    pub(super) fn volume_details(_: &Path) -> (Option<String>, Option<String>) {
        (None, None)
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

    #[cfg(target_os = "linux")]
    #[test]
    fn statx_walk_matches_the_generic_entries_and_accounting() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("root");
        let empty = root.join("empty");
        fs::create_dir_all(&empty).unwrap();
        let file = root.join(".allocated");
        fs::write(&file, [42; 4096]).unwrap();
        fs::hard_link(&file, root.join("hard-link")).unwrap();
        let sparse = root.join("sparse");
        fs::File::create(&sparse)
            .unwrap()
            .set_len(256 * 1024)
            .unwrap();
        std::os::unix::fs::symlink(fixture.path(), root.join("redirect")).unwrap();
        let root = root.canonicalize().unwrap();
        let boundary = platform::boundary(&root, &fs::metadata(&root).unwrap());
        if boundary.1.is_none() {
            return;
        }
        for path in [&file, &empty, &sparse] {
            assert!(platform::statx_child(path, &boundary).is_some());
        }
        let collect = |lookup| {
            let mut changes = Vec::new();
            let mut output = Output {
                send: &mut |event| {
                    if let ScanEvent::Batch { changes: batch } = event {
                        changes.extend(
                            batch
                                .into_iter()
                                .map(|change| serde_json::to_value(change).unwrap()),
                        );
                    }
                    Ok(())
                },
                stop: &AtomicBool::new(false),
                changes: Vec::new(),
                identities: HashSet::new(),
                next_id: 1,
                last: Instant::now(),
            };
            walk_entries(&root, &mut output, &boundary, lookup).unwrap();
            output.flush().unwrap();
            changes
        };
        let generic = collect(MetadataLookup::Generic);
        assert_eq!(collect(MetadataLookup::Statx), generic);
        assert_eq!(
            generic
                .iter()
                .filter(|change| change["shared"] == true)
                .count(),
            1
        );
    }

    #[test]
    fn measures_logical_sizes_within_the_scan_boundary() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("selected");
        let outside = temp.path().join("sibling");
        let empty = root.join("empty");
        fs::create_dir_all(&empty).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(root.join("first"), b"123").unwrap();
        fs::hard_link(root.join("first"), root.join("second")).unwrap();
        fs::write(outside.join("oversize"), [0; 1024]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("redirect")).unwrap();
        #[cfg(windows)]
        junction::create(&outside, root.join("redirect")).unwrap();
        let stop = AtomicBool::new(false);
        assert_eq!(measure_folder(&root, &stop), Some((6, false)));
        assert_eq!(measure_folder(&empty, &stop), Some((0, false)));
        assert_eq!(measure_folder(&root.join("gone"), &stop), Some((0, true)));
        stop.store(true, Ordering::Relaxed);
        assert_eq!(measure_folder(&root, &stop), None);
    }

    #[test]
    fn scans_nested_files_counts_hard_links_once_and_skips_redirects() {
        let fixture = tempfile::tempdir().unwrap();
        let folder = fixture.path().join("folder");
        let sub = folder.join("sub");
        let outside = fixture.path().join("outside");
        fs::create_dir_all(&sub).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(sub.join(".hidden"), vec![42; 16_384]).unwrap();
        fs::write(outside.join("excluded"), b"outside").unwrap();
        fs::hard_link(sub.join(".hidden"), folder.join("second")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, folder.join("redirect")).unwrap();
        #[cfg(windows)]
        junction::create(&outside, folder.join("redirect")).unwrap();
        let mut entries = Vec::new();
        let mut started = false;
        let mut finished = false;
        scan(&folder, &AtomicBool::new(false), &mut |event| {
            match event {
                ScanEvent::Start { strategy } => {
                    assert_eq!(strategy, "walk");
                    started = true;
                }
                ScanEvent::Batch { changes } => {
                    assert!(started && !finished);
                    entries.extend(changes.into_iter().filter_map(|c| match c {
                        Change::Entry {
                            name,
                            size,
                            allocated,
                            shared,
                            ..
                        } => Some((name, size, allocated, shared)),
                        Change::Closed { partial, .. } => {
                            assert!(!partial);
                            None
                        }
                    }));
                }
                ScanEvent::Finished => finished = true,
            }
            Ok(())
        })
        .unwrap();
        assert!(finished);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries.iter().filter(|e| e.3).count(), 1);
        assert_eq!(entries.iter().filter_map(|e| e.1).sum::<u64>(), 32_768);
        let expected = platform::usage(
            &sub.join(".hidden"),
            &fs::metadata(sub.join(".hidden")).unwrap(),
        )
        .0
        .unwrap();
        assert_eq!(entries.iter().filter_map(|e| e.2).sum::<u64>(), expected);
        assert!(entries.iter().any(|e| e.0 == ".hidden"));
        assert!(scan(
            &folder.join("missing"),
            &AtomicBool::new(false),
            &mut |_| Ok(())
        )
        .is_err());
    }

    #[test]
    fn cancellation_stops_producing_batches() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("file"), b"hello").unwrap();
        let stop = AtomicBool::new(false);
        let result = scan(temp.path(), &stop, &mut |event| {
            assert!(!stop.load(Ordering::Relaxed));
            if matches!(event, ScanEvent::Batch { .. }) {
                stop.store(true, Ordering::Relaxed);
            }
            Ok(())
        });
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Interrupted);
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
        let dev = Path::new("/dev");
        assert!(directory(
            target,
            &platform::boundary(dev, &fs::metadata(dev).unwrap())
        )
        .is_err());
    }
}
