use std::{
    fs, io,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Flag {
    ReadOnly,
    Archive,
    Hidden,
    System,
    Compressed,
    Encrypted,
    NotIndexed,
    OwnerWritable,
}

#[derive(Serialize)]
struct FlagValue {
    flag: Flag,
    enabled: bool,
    writable: bool,
}

#[derive(Deserialize)]
pub struct Change {
    flag: Flag,
    enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attributes {
    flags: Vec<FlagValue>,
    created: Option<u64>,
    accessed: Option<u64>,
    modified: Option<u64>,
    owner: Option<String>,
    mode: Option<String>,
}

fn seconds(time: io::Result<SystemTime>) -> Option<u64> {
    time.ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_secs())
}

pub fn read(path: &Path) -> io::Result<Attributes> {
    let metadata = fs::symlink_metadata(path)?;
    let (flags, owner, mode) = platform::read(path, &metadata);
    Ok(Attributes {
        flags,
        created: seconds(metadata.created()),
        accessed: seconds(metadata.accessed()),
        modified: seconds(metadata.modified()),
        owner,
        mode,
    })
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SortField {
    Created,
    Accessed,
    Changed,
    Allocated,
    StreamCount,
    StreamSize,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PanelMetadata {
    owner: Option<String>,
    hard_links: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    accessed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    changed: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    allocated: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_size: Option<u64>,
}

impl PanelMetadata {
    pub fn read(path: &Path, owner: bool, links: bool, fields: &[SortField]) -> Self {
        let Ok(metadata) = fs::symlink_metadata(path) else {
            return Self::default();
        };
        let mut result = Self {
            owner: owner.then(|| platform::owner(path, &metadata)).flatten(),
            hard_links: (links && metadata.is_file() && !crate::local::is_link(&metadata))
                .then(|| platform::hard_links(path, &metadata))
                .flatten(),
            ..Self::default()
        };
        if fields.contains(&SortField::Created) {
            result.created = seconds(metadata.created());
        }
        if fields.contains(&SortField::Accessed) {
            result.accessed = seconds(metadata.accessed());
        }
        platform::read_sort_fields(path, &metadata, fields, &mut result);
        result
    }
}

pub fn stream_sort_supported(directory: &Path) -> bool {
    platform::stream_sort_supported(directory)
}

#[cfg(windows)]
pub fn space_usage(path: &Path) -> (Option<u64>, Option<(u64, u128)>) {
    platform::space_usage(path)
}

pub fn update(path: &Path, changes: &[Change]) -> io::Result<Attributes> {
    if !changes.is_empty() {
        platform::update(path, changes)?;
    }
    let attributes = read(path)?;
    if changes.iter().any(|change| {
        !attributes
            .flags
            .iter()
            .any(|value| value.flag == change.flag && value.enabled == change.enabled)
    }) {
        return Err(io::Error::other(
            "The file system did not apply every requested attribute.",
        ));
    }
    Ok(attributes)
}

fn unsupported_flag() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "This attribute cannot be changed for this item.",
    )
}

#[cfg(windows)]
mod platform {
    use std::{
        os::windows::{ffi::OsStrExt, fs::MetadataExt},
        ptr,
    };

    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT},
            LookupAccountSidW, OWNER_SECURITY_INFORMATION,
        },
        Storage::FileSystem::{
            SetFileAttributesW, FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_COMPRESSED,
            FILE_ATTRIBUTE_ENCRYPTED, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL,
            FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_READONLY,
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_SYSTEM, FILE_ATTRIBUTE_TEMPORARY,
        },
    };

    use super::*;

    const FLAGS: [(Flag, u32, bool); 7] = [
        (Flag::ReadOnly, FILE_ATTRIBUTE_READONLY, true),
        (Flag::Archive, FILE_ATTRIBUTE_ARCHIVE, true),
        (Flag::Hidden, FILE_ATTRIBUTE_HIDDEN, true),
        (Flag::System, FILE_ATTRIBUTE_SYSTEM, true),
        (Flag::Compressed, FILE_ATTRIBUTE_COMPRESSED, false),
        (Flag::Encrypted, FILE_ATTRIBUTE_ENCRYPTED, false),
        (Flag::NotIndexed, FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, true),
    ];

    fn writable(metadata: &fs::Metadata, flag: Flag) -> bool {
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
            && !(flag == Flag::ReadOnly && metadata.is_dir())
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn metadata_handle(path: &Path) -> io::Result<fs::File> {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        };
        fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
    }

    pub(super) fn stream_sort_supported(path: &Path) -> bool {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationByHandleW;

        let Ok(file) = metadata_handle(path) else {
            return false;
        };
        let mut flags = 0;
        let success = unsafe {
            GetVolumeInformationByHandleW(
                file.as_raw_handle(),
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut flags,
                ptr::null_mut(),
                0,
            )
        };
        const FILE_NAMED_STREAMS: u32 = 0x0004_0000;
        success != 0 && flags & FILE_NAMED_STREAMS != 0
    }

    pub(super) fn read_sort_fields(
        path: &Path,
        metadata: &fs::Metadata,
        fields: &[SortField],
        out: &mut PanelMetadata,
    ) {
        use std::{mem::size_of_val, os::windows::io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            FileBasicInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO,
        };

        let needs_handle =
            fields.contains(&SortField::Changed) || fields.contains(&SortField::Allocated);
        if let Some(file) = needs_handle.then(|| metadata_handle(path).ok()).flatten() {
            if fields.contains(&SortField::Changed) {
                let mut info = FILE_BASIC_INFO::default();
                let success = unsafe {
                    GetFileInformationByHandleEx(
                        file.as_raw_handle(),
                        FileBasicInfo,
                        (&mut info as *mut FILE_BASIC_INFO).cast(),
                        size_of_val(&info) as u32,
                    )
                };
                if success != 0 && info.ChangeTime > 0 {
                    out.changed = Some(info.ChangeTime - 116_444_736_000_000_000);
                }
            }
            if fields.contains(&SortField::Allocated) {
                out.allocated = allocated_bytes(&file);
            }
        }
        let needs_streams = metadata.is_file()
            && !crate::local::is_link(metadata)
            && (fields.contains(&SortField::StreamCount)
                || fields.contains(&SortField::StreamSize));
        if let Some((count, size)) = needs_streams.then(|| streams(path)).flatten() {
            out.stream_count = Some(count);
            out.stream_size = Some(size);
        }
    }

    fn allocated_bytes(file: &fs::File) -> Option<u64> {
        use std::{mem::size_of_val, os::windows::io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            FileStandardInfo, GetFileInformationByHandleEx, FILE_STANDARD_INFO,
        };
        let mut info = FILE_STANDARD_INFO::default();
        let success = unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileStandardInfo,
                (&mut info as *mut FILE_STANDARD_INFO).cast(),
                size_of_val(&info) as u32,
            )
        };
        (success != 0)
            .then(|| u64::try_from(info.AllocationSize).ok())
            .flatten()
    }

    pub(super) fn space_usage(path: &Path) -> (Option<u64>, Option<(u64, u128)>) {
        use std::{mem::size_of_val, os::windows::io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            FileIdInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
            BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ID_INFO,
        };
        let Ok(file) = metadata_handle(path) else {
            return (None, None);
        };
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        let success = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) };
        if success != 0
            && info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
                != 0
        {
            return (None, None);
        }
        let id = (success != 0 && info.nNumberOfLinks > 1)
            .then(|| {
                let mut identity = FILE_ID_INFO::default();
                let success = unsafe {
                    GetFileInformationByHandleEx(
                        file.as_raw_handle(),
                        FileIdInfo,
                        (&mut identity as *mut FILE_ID_INFO).cast(),
                        size_of_val(&identity) as u32,
                    )
                };
                let id = u128::from_le_bytes(identity.FileId.Identifier);
                (success != 0 && id != 0).then_some((identity.VolumeSerialNumber, id))
            })
            .flatten();
        (allocated_bytes(&file), id)
    }

    fn streams(path: &Path) -> Option<(u64, u64)> {
        use windows_sys::Win32::{
            Foundation::{GetLastError, ERROR_HANDLE_EOF, INVALID_HANDLE_VALUE},
            Storage::FileSystem::{
                FindClose, FindFirstStreamW, FindNextStreamW, FindStreamInfoStandard,
                WIN32_FIND_STREAM_DATA,
            },
        };
        let mut info = WIN32_FIND_STREAM_DATA::default();
        let path = wide_path(path);
        let target = (&mut info as *mut WIN32_FIND_STREAM_DATA).cast();
        let search = unsafe { FindFirstStreamW(path.as_ptr(), FindStreamInfoStandard, target, 0) };
        if search == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut count = 0;
        let mut total = 0u64;
        let complete = loop {
            count += 1;
            total = total.saturating_add(info.StreamSize.max(0) as u64);
            if unsafe { FindNextStreamW(search, target) } == 0 {
                break unsafe { GetLastError() } == ERROR_HANDLE_EOF;
            }
        };
        unsafe { FindClose(search) };
        complete.then_some((count, total))
    }

    pub(super) fn hard_links(path: &Path, _: &fs::Metadata) -> Option<u64> {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};

        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_OPEN_REPARSE_POINT,
        };

        let file = fs::OpenOptions::new()
            .access_mode(0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .ok()?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        let result = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) };
        (result != 0
            && info.nNumberOfLinks > 0
            && info.dwFileAttributes
                & (FILE_ATTRIBUTE_REPARSE_POINT
                    | windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY)
                == 0)
            .then_some(u64::from(info.nNumberOfLinks))
    }

    pub(super) fn owner(path: &Path, _: &fs::Metadata) -> Option<String> {
        let mut sid = ptr::null_mut();
        let mut descriptor = ptr::null_mut();
        let path = wide_path(path);
        let status = unsafe {
            GetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut sid,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return None;
        }
        let mut account_len = 0;
        let mut domain_len = 0;
        let mut kind = 0;
        let name = if sid.is_null() {
            None
        } else {
            unsafe {
                LookupAccountSidW(
                    ptr::null(),
                    sid,
                    ptr::null_mut(),
                    &mut account_len,
                    ptr::null_mut(),
                    &mut domain_len,
                    &mut kind,
                );
            }
            let mut account = vec![0; account_len as usize];
            let mut domain = vec![0; domain_len as usize];
            let found = unsafe {
                LookupAccountSidW(
                    ptr::null(),
                    sid,
                    account.as_mut_ptr(),
                    &mut account_len,
                    domain.as_mut_ptr(),
                    &mut domain_len,
                    &mut kind,
                )
            };
            (found != 0).then(|| {
                let account = String::from_utf16_lossy(&account[..account_len as usize]);
                let domain = String::from_utf16_lossy(&domain[..domain_len as usize]);
                if domain.is_empty() {
                    account
                } else {
                    format!("{domain}\\{account}")
                }
            })
        };
        unsafe { LocalFree(descriptor) };
        name
    }

    pub(super) fn read(
        path: &Path,
        metadata: &fs::Metadata,
    ) -> (Vec<FlagValue>, Option<String>, Option<String>) {
        let mask = metadata.file_attributes();
        let flags = FLAGS
            .iter()
            .map(|&(flag, bit, editable)| FlagValue {
                flag,
                enabled: mask & bit != 0,
                writable: editable && writable(metadata, flag),
            })
            .collect();
        (flags, owner(path, metadata), None)
    }

    pub(super) fn update(path: &Path, changes: &[Change]) -> io::Result<()> {
        let metadata = fs::symlink_metadata(path)?;
        // Keep existing flags that SetFileAttributesW accepts, including those not shown in the dialog.
        let settable = FLAGS.iter().filter(|(_, _, editable)| *editable).fold(
            FILE_ATTRIBUTE_TEMPORARY | FILE_ATTRIBUTE_OFFLINE,
            |mask, (_, bit, _)| mask | bit,
        );
        let mut mask = metadata.file_attributes() & settable;
        for change in changes {
            let &(_, bit, _) = FLAGS
                .iter()
                .find(|&&(flag, _, editable)| {
                    editable && flag == change.flag && writable(&metadata, flag)
                })
                .ok_or_else(unsupported_flag)?;
            if change.enabled {
                mask |= bit;
            } else {
                mask &= !bit;
            }
        }
        let path = wide_path(path);
        if mask == 0 {
            mask = FILE_ATTRIBUTE_NORMAL;
        }
        if unsafe { SetFileAttributesW(path.as_ptr(), mask) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(unix)]
mod platform {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

    use super::*;

    const OWNER_WRITE: u32 = 0o200;

    pub(super) fn stream_sort_supported(_: &Path) -> bool {
        false
    }

    pub(super) fn read_sort_fields(
        _: &Path,
        metadata: &fs::Metadata,
        fields: &[SortField],
        out: &mut PanelMetadata,
    ) {
        if fields.contains(&SortField::Changed) {
            out.changed = Some(
                metadata
                    .ctime()
                    .saturating_mul(10_000_000)
                    .saturating_add(metadata.ctime_nsec() / 100),
            );
        }
        if fields.contains(&SortField::Allocated) {
            out.allocated = metadata.blocks().checked_mul(512);
        }
    }

    pub(super) fn hard_links(_: &Path, metadata: &fs::Metadata) -> Option<u64> {
        Some(metadata.nlink())
    }

    pub(super) fn owner(_: &Path, metadata: &fs::Metadata) -> Option<String> {
        use std::{ffi::CStr, ptr};

        let uid = metadata.uid();
        let mut size = 1024;
        while size <= 64 * 1024 {
            let mut buffer = vec![0; size];
            let mut user = std::mem::MaybeUninit::<libc::passwd>::uninit();
            let mut result = ptr::null_mut();
            let status = unsafe {
                libc::getpwuid_r(
                    uid,
                    user.as_mut_ptr(),
                    buffer.as_mut_ptr(),
                    buffer.len(),
                    &mut result,
                )
            };
            if status == libc::ERANGE {
                size *= 2;
                continue;
            }
            if status == 0 && !result.is_null() {
                let user = unsafe { user.assume_init() };
                if !user.pw_name.is_null() {
                    return Some(
                        unsafe { CStr::from_ptr(user.pw_name) }
                            .to_string_lossy()
                            .into_owned(),
                    );
                }
            }
            break;
        }
        Some(uid.to_string())
    }

    pub(super) fn read(
        path: &Path,
        metadata: &fs::Metadata,
    ) -> (Vec<FlagValue>, Option<String>, Option<String>) {
        let flags = vec![
            FlagValue {
                flag: Flag::Hidden,
                enabled: path
                    .file_name()
                    .is_some_and(|name| name.as_encoded_bytes().starts_with(b".")),
                writable: false,
            },
            FlagValue {
                flag: Flag::OwnerWritable,
                enabled: metadata.mode() & OWNER_WRITE != 0,
                writable: metadata.is_file() || metadata.is_dir(),
            },
        ];
        (
            flags,
            Some(metadata.uid().to_string()),
            Some(format!("{:04o}", metadata.mode() & 0o7777)),
        )
    }

    pub(super) fn update(path: &Path, changes: &[Change]) -> io::Result<()> {
        let [change] = changes else {
            return Err(unsupported_flag());
        };
        if change.flag != Flag::OwnerWritable {
            return Err(unsupported_flag());
        }
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err(unsupported_flag());
        }
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err(unsupported_flag());
        }
        let mut permissions = metadata.permissions();
        let mode = permissions.mode();
        permissions.set_mode(if change.enabled {
            mode | OWNER_WRITE
        } else {
            mode & !OWNER_WRITE
        });
        file.set_permissions(permissions)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn changes_only_the_owner_write_bit_and_does_not_follow_links() {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("document");
            fs::write(&path, "hello").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o664)).unwrap();
            let disable = [Change {
                flag: Flag::OwnerWritable,
                enabled: false,
            }];
            let attributes = super::super::update(&path, &disable).unwrap();
            assert_eq!(attributes.mode.as_deref(), Some("0464"));

            let link = directory.path().join("link");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            let enable = [Change {
                flag: Flag::OwnerWritable,
                enabled: true,
            }];
            assert!(super::super::update(&link, &enable).is_err());
            assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o464);

            let attributes = super::super::update(&path, &enable).unwrap();
            assert_eq!(attributes.mode.as_deref(), Some("0664"));
        }
    }
}
