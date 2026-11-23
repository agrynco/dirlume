use std::{
    fs,
    io::{self, ErrorKind, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

#[cfg(any(feature = "desktop", feature = "server"))]
pub fn read_byte_page(mut file: fs::File, offset: u64) -> io::Result<crate::protocol::BytePage> {
    let length = file.metadata()?.len();
    file.seek(SeekFrom::Start(offset.min(length)))?;
    let mut data = Vec::new();
    file.take(crate::protocol::BYTE_PAGE_SIZE.min(length.saturating_sub(offset)))
        .read_to_end(&mut data)?;
    Ok(crate::protocol::BytePage { length, data })
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub(crate) name: String,
    pub(crate) directory: bool,
    pub(crate) link: bool,
    hidden: bool,
    #[serde(default)]
    system: bool,
    size: Option<u64>,
    modified: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) hard_links: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) created: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) accessed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) changed: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) allocated: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) allocation_id: Option<String>,
}

#[derive(Default)]
pub(crate) struct EntryAttributes {
    hidden: bool,
    system: bool,
}

impl EntryAttributes {
    #[cfg(windows)]
    pub(crate) fn from_windows(flags: u32) -> Self {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM,
        };
        Self {
            hidden: flags & FILE_ATTRIBUTE_HIDDEN != 0,
            system: flags & FILE_ATTRIBUTE_SYSTEM != 0,
        }
    }
}

impl Entry {
    #[cfg(feature = "desktop")]
    pub(crate) fn is_hidden(&self) -> bool {
        self.hidden
    }

    pub(crate) fn new(
        name: String,
        directory: bool,
        link: bool,
        attributes: EntryAttributes,
        size: Option<u64>,
        modified: Option<SystemTime>,
    ) -> Self {
        Self {
            hidden: name.starts_with('.') || attributes.hidden,
            system: attributes.system,
            name,
            directory,
            link,
            size,
            owner: None,
            hard_links: None,
            created: None,
            accessed: None,
            changed: None,
            allocated: None,
            allocation_id: None,
            modified: modified.and_then(|value| {
                value
                    .duration_since(UNIX_EPOCH)
                    .ok()
                    .map(|time| time.as_secs())
            }),
        }
    }
}

#[derive(Serialize)]
pub struct Listing {
    path: String,
    parent: Option<String>,
    entries: Vec<Entry>,
    omitted: usize,
}

#[derive(Serialize)]
pub struct Location {
    label: String,
    path: String,
}

pub fn absolute(path: &str) -> io::Result<&Path> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "Enter an absolute path.",
        ));
    }
    Ok(path)
}

pub fn name_component(name: &str) -> io::Result<&Path> {
    let path = Path::new(name);
    if matches!(path.components().next(), Some(Component::Normal(component)) if component == name)
        && !name.contains('\0')
        && valid_platform_name(name)
    {
        return Ok(path);
    }
    Err(io::Error::new(
        ErrorKind::InvalidInput,
        "Enter a valid file or folder name.",
    ))
}

#[cfg(windows)]
fn valid_platform_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    !name.contains(['<', '>', ':', '"', '|', '?', '*'])
        && !name.chars().any(char::is_control)
        && !name.ends_with([' ', '.'])
        && !matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        )
        && !["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
}

#[cfg(not(windows))]
fn valid_platform_name(_: &str) -> bool {
    true
}

pub(crate) fn display_path(path: &Path) -> io::Result<String> {
    let path = path.to_str().ok_or_else(|| {
        io::Error::new(
            ErrorKind::InvalidData,
            "This path cannot be represented as text.",
        )
    })?;
    #[cfg(windows)]
    {
        if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
            return Ok(format!(r"\\{rest}"));
        }
        if let Some(rest) = path
            .strip_prefix(r"\\?\")
            .filter(|rest| rest.as_bytes().get(1) == Some(&b':'))
        {
            return Ok(rest.to_owned());
        }
    }
    Ok(path.to_owned())
}

pub fn locations() -> Vec<Location> {
    let mut locations = Vec::new();
    for (label, path) in [
        ("Home", dirs::home_dir()),
        ("Desktop", dirs::desktop_dir()),
        ("Documents", dirs::document_dir()),
        ("Downloads", dirs::download_dir()),
    ] {
        if let Some(path) = path
            .filter(|path| path.is_dir())
            .and_then(|path| display_path(&path).ok())
        {
            if !locations.iter().any(|item: &Location| item.path == path) {
                locations.push(Location {
                    label: label.to_owned(),
                    path,
                });
            }
        }
    }
    locations.extend(roots());
    locations
}

#[cfg(feature = "desktop")]
pub(crate) fn local_share_locations() -> Vec<(String, PathBuf)> {
    locations()
        .into_iter()
        .filter_map(|location| {
            let path = fs::canonicalize(location.path).ok()?;
            is_local_location(&path).then_some((location.label, path))
        })
        .collect()
}

#[cfg(all(feature = "desktop", windows))]
fn is_local_location(path: &Path) -> bool {
    matches!(drive_type(path), Some(2 | 3 | 5 | 6))
}

#[cfg(all(feature = "desktop", windows))]
pub(crate) fn drive_type(path: &Path) -> Option<u32> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;

    if !matches!(path.components().next(), Some(Component::Prefix(prefix))
        if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))
    {
        return None;
    }
    let root: PathBuf = path.components().take(2).collect();
    let wide: Vec<_> = root.as_os_str().encode_wide().chain([0]).collect();
    // SAFETY: wide is a NUL-terminated drive root for the duration of the call.
    Some(unsafe { GetDriveTypeW(wide.as_ptr()) })
}

#[cfg(all(feature = "desktop", not(windows)))]
fn is_local_location(_path: &Path) -> bool {
    true
}

#[cfg(windows)]
fn roots() -> Vec<Location> {
    use windows_sys::Win32::Storage::FileSystem::GetLogicalDrives;
    // This API takes no pointers and returns one bit per drive letter.
    let drives = unsafe { GetLogicalDrives() };
    (0..26)
        .filter(|index| drives & (1 << index) != 0)
        .map(|index| {
            let label = format!("{}:", char::from(b'A' + index));
            Location {
                path: format!(r"{label}\"),
                label,
            }
        })
        .collect()
}

#[cfg(not(windows))]
fn roots() -> Vec<Location> {
    vec![Location {
        label: "File system".to_owned(),
        path: "/".to_owned(),
    }]
}

pub fn list(path: &Path) -> io::Result<Listing> {
    // Keep the path the user navigated through, including any directory link.
    let path = std::path::absolute(path)?;
    let mut entries = Vec::new();
    let mut omitted = 0;
    for item in fs::read_dir(&path)? {
        let item = match item {
            Ok(item) => item,
            Err(_) => {
                omitted += 1;
                continue;
            }
        };
        match describe_entry(&item.path()) {
            Ok(entry) => entries.push(entry),
            Err(_) => omitted += 1,
        }
    }
    Ok(Listing {
        path: display_path(&path)?,
        parent: path.parent().map(display_path).transpose()?,
        entries,
        omitted,
    })
}

pub fn describe_entry(path: &Path) -> io::Result<Entry> {
    #[cfg(windows)]
    use std::os::windows::fs::MetadataExt;

    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidData, "The file name is not supported."))?;
    let metadata = fs::symlink_metadata(path)?;
    let link = is_link(&metadata);
    let directory = metadata.is_dir() || (link && path.is_dir());
    #[cfg(windows)]
    let attributes = EntryAttributes::from_windows(metadata.file_attributes());
    #[cfg(not(windows))]
    let attributes = EntryAttributes::default();
    Ok(Entry::new(
        name.to_owned(),
        directory,
        link,
        attributes,
        metadata.is_file().then_some(metadata.len()),
        metadata.modified().ok(),
    ))
}

pub fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    metadata.is_symlink()
}

#[derive(Clone, Copy, Default, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CopyAccess {
    #[default]
    Default,
    Copy,
    Inherit,
}

#[derive(Clone, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CopyOptions {
    pub access: CopyAccess,
    pub preserve_timestamps: bool,
    pub follow_links: bool,
    pub mask: Option<String>,
}

impl CopyOptions {
    pub fn metadata(&self, path: &Path) -> io::Result<fs::Metadata> {
        if self.follow_links {
            fs::metadata(path)
        } else {
            fs::symlink_metadata(path)
        }
    }

    pub fn includes(&self, path: &Path) -> bool {
        let Some(mask) = &self.mask else { return true };
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            return false;
        };
        let pattern: Vec<_> = mask.to_lowercase().chars().collect();
        let letters: Vec<_> = name.to_lowercase().chars().collect();
        let (mut file, mut mask) = (0, 0);
        let mut star = None;
        while file < letters.len() {
            match pattern.get(mask) {
                Some('*') => {
                    star = Some((mask, file));
                    mask += 1;
                }
                Some(symbol) if *symbol == '?' || *symbol == letters[file] => {
                    mask += 1;
                    file += 1;
                }
                _ => {
                    let Some((index, matched)) = star else {
                        return false;
                    };
                    file = matched + 1;
                    mask = index + 1;
                    star = Some((index, file));
                }
            }
        }
        pattern[mask..].iter().all(|symbol| *symbol == '*')
    }
}

#[cfg(any(feature = "desktop", test))]
pub fn copy_to(
    source: &Path,
    target: &Path,
    replace: bool,
    progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
) -> io::Result<()> {
    copy_with_options(
        source,
        target,
        replace,
        &CopyOptions::default(),
        &mut Vec::new(),
        progress,
    )
}

pub fn copy_with_options(
    source: &Path,
    target: &Path,
    replace: bool,
    options: &CopyOptions,
    ancestors: &mut Vec<PathBuf>,
    mut progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
) -> io::Result<()> {
    let target = transfer_path(source, target)?;
    let directory = target.parent().expect("transfer path has a parent");
    let metadata = options.metadata(source)?;
    if !replace {
        ensure_absent(&target)?;
    }
    let workspace = tempfile::Builder::new()
        .prefix(".dirlume-")
        .tempdir_in(directory)?;
    let staged = workspace.path().join("copy");
    copy_entry(source, &staged, metadata, options, ancestors, &mut progress)?;
    progress(source, 0, None)?;
    if replace {
        replace_file(&staged, &target)
    } else {
        renamest::rename_exclusive(staged, target)
    }
}

pub fn transfer_path(source: &Path, target: &Path) -> io::Result<PathBuf> {
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "Enter a destination name."))?;
    let directory = target
        .parent()
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "Choose a destination folder."))?
        .canonicalize()?;
    let target = directory.join(name);
    if same_file::is_same_file(source, &target).unwrap_or(false) {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "Source and destination are the same item.",
        ));
    }
    let metadata = fs::symlink_metadata(source)?;
    if metadata.is_dir() && !is_link(&metadata) {
        let source = source.canonicalize()?;
        for ancestor in directory.ancestors().filter(|ancestor| ancestor.has_root()) {
            if same_file::is_same_file(&source, ancestor)? {
                return Err(io::Error::new(
                    ErrorKind::InvalidInput,
                    "A folder cannot be copied into itself.",
                ));
            }
        }
    }
    Ok(target)
}

pub fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(target)?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err(io::Error::new(
            ErrorKind::AlreadyExists,
            "The destination is no longer a regular file.",
        ));
    }
    with_writable_file(target, || fs::rename(source, target))
}

#[cfg_attr(
    windows,
    allow(
        clippy::permissions_set_readonly_false,
        reason = "This only clears the Windows read-only attribute"
    )
)]
pub fn with_writable_file(path: &Path, action: impl FnOnce() -> io::Result<()>) -> io::Result<()> {
    #[cfg(windows)]
    {
        let metadata = fs::symlink_metadata(path)?;
        if metadata.permissions().readonly() && metadata.is_file() && !is_link(&metadata) {
            let original = metadata.permissions();
            let identity = same_file::Handle::from_path(path)?;
            let mut writable = original.clone();
            writable.set_readonly(false);
            fs::set_permissions(path, writable)?;
            let result = action();
            if result.is_err()
                && same_file::Handle::from_path(path).is_ok_and(|handle| handle == identity)
            {
                fs::set_permissions(path, original)?;
            }
            return result;
        }
    }
    #[cfg(not(windows))]
    let _ = path;
    action()
}

fn copy_entry(
    source: &Path,
    destination: &Path,
    metadata: fs::Metadata,
    options: &CopyOptions,
    ancestors: &mut Vec<PathBuf>,
    progress: &mut impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
) -> io::Result<()> {
    if is_link(&metadata) {
        return Err(io::Error::new(
            ErrorKind::Unsupported,
            format!("Copying links is unsupported ({})", source.display()),
        ));
    }
    if metadata.is_dir() {
        with_copy_directory(source, destination, options, ancestors, |ancestors| {
            progress(source, 0, None)?;
            fs::create_dir(destination)?;
            for child in fs::read_dir(source)? {
                let child = child?;
                let path = child.path();
                copy_entry(
                    &path,
                    &destination.join(child.file_name()),
                    options.metadata(&path)?,
                    options,
                    ancestors,
                    progress,
                )?;
            }
            if options.preserve_timestamps {
                preserve_directory_times(destination, &metadata)?;
            }
            if matches!(options.access, CopyAccess::Copy) {
                copy_access(source, destination, &metadata)?;
            }
            Ok(())
        })?;
    } else if metadata.is_file() {
        if !options.includes(source) {
            return Ok(());
        }
        let input = fs::File::open(source)?;
        let mut output = fs::File::create_new(destination)?;
        copy_stream(input, &mut output, Some(metadata.len()), |bytes, total| {
            progress(source, bytes, total)
        })?;
        output.set_times(copy_times(&metadata, options.preserve_timestamps))?;
        output.sync_all()?;
        match options.access {
            CopyAccess::Default => output.set_permissions(metadata.permissions())?,
            CopyAccess::Copy => copy_access(source, destination, &metadata)?,
            CopyAccess::Inherit => {}
        }
    } else {
        return Err(io::Error::new(
            ErrorKind::Unsupported,
            "Only regular files and folders can be copied.",
        ));
    }
    Ok(())
}

pub(crate) fn with_copy_directory<T>(
    source: &Path,
    destination: &Path,
    options: &CopyOptions,
    ancestors: &mut Vec<PathBuf>,
    copy: impl FnOnce(&mut Vec<PathBuf>) -> io::Result<T>,
) -> io::Result<T> {
    if !options.follow_links {
        return copy(ancestors);
    }
    let directory = source.canonicalize()?;
    let target_parent = destination
        .parent()
        .ok_or_else(|| io::Error::other("The destination has no parent folder."))?
        .canonicalize()?;
    if ancestors.contains(&directory) || target_parent.starts_with(&directory) {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "A folder link points back into the copy.",
        ));
    }
    ancestors.push(directory);
    let result = copy(ancestors);
    ancestors.pop();
    result
}

fn copy_times(metadata: &fs::Metadata, preserve_all: bool) -> fs::FileTimes {
    let mut times = fs::FileTimes::new();
    if let Ok(modified) = metadata.modified() {
        times = times.set_modified(modified);
    }
    if preserve_all {
        if let Ok(accessed) = metadata.accessed() {
            times = times.set_accessed(accessed);
        }
        #[cfg(windows)]
        if let Ok(created) = metadata.created() {
            use std::os::windows::fs::FileTimesExt;
            times = times.set_created(created);
        }
    }
    times
}

pub(crate) fn preserve_directory_times(path: &Path, metadata: &fs::Metadata) -> io::Result<()> {
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_WRITE_ATTRIBUTES,
        };
        fs::OpenOptions::new()
            .access_mode(FILE_WRITE_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)?
    };
    #[cfg(not(windows))]
    let file = fs::File::open(path)?;
    file.set_times(copy_times(metadata, true))
}

#[cfg(feature = "desktop")]
pub(crate) fn staging_directory(parent: &Path) -> io::Result<tempfile::TempDir> {
    let mut builder = tempfile::Builder::new();
    builder.prefix(".dirlume-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o700));
    }
    builder.tempdir_in(parent)
}

#[cfg(all(feature = "desktop", unix))]
pub(crate) fn preserve_access(
    source: &Path,
    dest: &Path,
    metadata: &fs::Metadata,
) -> io::Result<()> {
    use std::os::unix::{
        ffi::OsStrExt,
        fs::{chown, MetadataExt},
    };
    let staged = fs::metadata(dest)?;
    if (staged.uid(), staged.gid()) != (metadata.uid(), metadata.gid()) {
        chown(dest, Some(metadata.uid()), Some(metadata.gid()))?;
    }
    fs::set_permissions(dest, metadata.permissions())?;
    let from = std::ffi::CString::new(source.as_os_str().as_bytes())?;
    let to = std::ffi::CString::new(dest.as_os_str().as_bytes())?;
    #[cfg(target_os = "linux")]
    for name in [c"system.posix_acl_access", c"system.posix_acl_default"] {
        if name == c"system.posix_acl_default" && !metadata.is_dir() {
            continue;
        }
        // Linux bounds each extended attribute at 64 KiB.
        let mut data = vec![0u8; 65536];
        let len = unsafe {
            libc::getxattr(
                from.as_ptr(),
                name.as_ptr(),
                data.as_mut_ptr().cast(),
                data.len(),
            )
        };
        let result = if len >= 0 {
            unsafe {
                libc::setxattr(
                    to.as_ptr(),
                    name.as_ptr(),
                    data.as_ptr().cast(),
                    len as usize,
                    0,
                )
            }
        } else {
            let error = io::Error::last_os_error();
            if !matches!(error.raw_os_error(), Some(libc::ENODATA | libc::ENOTSUP)) {
                return Err(error);
            }
            if unsafe { libc::removexattr(to.as_ptr(), name.as_ptr()) } != 0 {
                let error = io::Error::last_os_error();
                if !matches!(error.raw_os_error(), Some(libc::ENODATA | libc::ENOTSUP)) {
                    return Err(error);
                }
            }
            0
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    #[cfg(target_os = "macos")]
    if unsafe {
        libc::copyfile(
            from.as_ptr(),
            to.as_ptr(),
            std::ptr::null_mut(),
            libc::COPYFILE_ACL,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(all(feature = "desktop", windows))]
pub(crate) use copy_access as preserve_access;

#[cfg(not(windows))]
fn copy_access(_source: &Path, destination: &Path, metadata: &fs::Metadata) -> io::Result<()> {
    fs::set_permissions(destination, metadata.permissions())
}

#[cfg(windows)]
pub(crate) fn copy_access(
    source: &Path,
    destination: &Path,
    metadata: &fs::Metadata,
) -> io::Result<()> {
    use std::{
        iter::once,
        os::windows::ffi::OsStrExt,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{GetNamedSecurityInfoW, SetNamedSecurityInfoW, SE_FILE_OBJECT},
            DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        },
    };
    let windows_path = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(once(0))
            .collect::<Vec<_>>()
    };
    let source = windows_path(source);
    let target = windows_path(destination);
    let mut acl = null_mut();
    let mut descriptor = null_mut();
    // The ACL points into the allocated descriptor and is valid until LocalFree.
    let read = unsafe {
        GetNamedSecurityInfoW(
            source.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    };
    if read != 0 {
        return Err(io::Error::from_raw_os_error(read as i32));
    }
    let result = unsafe {
        let result = SetNamedSecurityInfoW(
            target.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            acl,
            null(),
        );
        LocalFree(descriptor);
        result
    };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    fs::set_permissions(destination, metadata.permissions())
}

pub fn copy_stream(
    mut reader: impl Read,
    mut writer: impl Write,
    total: Option<u64>,
    mut progress: impl FnMut(u64, Option<u64>) -> io::Result<()>,
) -> io::Result<()> {
    let mut buffer = vec![0; 256 * 1024];
    let mut written = 0;
    progress(written, total)?;
    let mut last_display = Instant::now();
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        writer.write_all(&buffer[..count])?;
        written += count as u64;
        if last_display.elapsed() >= Duration::from_millis(50) {
            progress(written, total)?;
            last_display = Instant::now();
        }
    }
    if total.is_some_and(|value| value != written) {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "The source changed or the transfer was incomplete.",
        ));
    }
    progress(written, total)
}

pub fn permanently_delete(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() && !is_link(&metadata) {
        return fs::remove_dir_all(path);
    }
    remove_entry(path, &metadata)
}

pub(crate) fn remove_entry(path: &Path, metadata: &fs::Metadata) -> io::Result<()> {
    if metadata.is_dir() && !is_link(metadata) {
        return fs::remove_dir(path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY;
        if metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0 {
            return fs::remove_dir(path);
        }
    }
    fs::remove_file(path)
}

pub fn ensure_absent(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(io::Error::new(
            ErrorKind::AlreadyExists,
            "An item with that name already exists.",
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn move_item(source: &Path, target: PathBuf) -> io::Result<()> {
    renamest::rename_exclusive(source, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_a_tree_and_preserves_both_items_on_conflict() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(source.join("nested/test.txt"), b"original").unwrap();
        copy_to(&source, &target.join("source"), false, |_, _, _| Ok(())).unwrap();
        let copy = target.join("source/nested/test.txt");
        assert_eq!(fs::read(&copy).unwrap(), b"original");
        fs::write(&copy, b"destination").unwrap();
        assert!(copy_to(&source, &target.join("source"), false, |_, _, _| Ok(())).is_err());
        assert_eq!(fs::read(&copy).unwrap(), b"destination");
        assert!(
            copy_to(&source, &source.join("nested/source"), false, |_, _, _| Ok(
                ()
            ))
            .is_err()
        );
    }

    #[test]
    fn canceled_copy_keeps_the_existing_destination() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.bin");
        let destination = temp.path().join("destination.bin");
        fs::write(&source, b"abcdefgh").unwrap();
        fs::write(&destination, b"keep").unwrap();
        let mut observed = 0;
        let result = copy_to(&source, &destination, true, |_, bytes, total| {
            if bytes > 0 {
                assert_eq!(total, Some(8));
                observed = bytes;
                return Err(io::Error::new(ErrorKind::Interrupted, "Transfer canceled."));
            }
            Ok(())
        });
        assert_eq!(result.unwrap_err().kind(), ErrorKind::Interrupted);
        assert_eq!(observed, 8);
        assert_eq!(fs::read(&source).unwrap(), b"abcdefgh");
        assert_eq!(fs::read(&destination).unwrap(), b"keep");
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 2);
    }

    #[test]
    fn moves_without_overwriting() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("a");
        let target = temp.path().join("b");
        fs::write(&source, b"a").unwrap();
        fs::write(&target, b"b").unwrap();
        assert!(move_item(&source, target.clone()).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"a");
        assert_eq!(fs::read(&target).unwrap(), b"b");
        fs::remove_file(&target).unwrap();
        move_item(&source, target.clone()).unwrap();
        assert!(!source.exists());
        assert_eq!(fs::read(&target).unwrap(), b"a");
    }

    #[test]
    fn rejects_names_that_are_paths() {
        for name in ["", ".", "..", "a/b", "a/", "name\0"] {
            assert!(name_component(name).is_err(), "{name:?}");
        }
        assert!(name_component("файл.txt").is_ok());
    }
}
