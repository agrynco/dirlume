use std::{
    fs,
    io::{self, ErrorKind},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    directory: bool,
    link: bool,
    hidden: bool,
    size: Option<u64>,
    modified: Option<u64>,
}

impl Entry {
    pub fn new(
        name: String,
        directory: bool,
        link: bool,
        hidden: bool,
        size: Option<u64>,
        modified: Option<SystemTime>,
    ) -> Self {
        Self {
            name,
            directory,
            link,
            hidden,
            size,
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

fn display_path(path: &Path) -> io::Result<String> {
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
        let Some(name) = item.file_name().into_string().ok() else {
            omitted += 1;
            continue;
        };
        let Ok(metadata) = fs::symlink_metadata(item.path()) else {
            omitted += 1;
            continue;
        };
        let link = is_link(&metadata);
        let directory = metadata.is_dir() || (link && item.path().is_dir());
        let hidden = name.starts_with('.') || hidden_attribute(&metadata);
        entries.push(Entry::new(
            name,
            directory,
            link,
            hidden,
            metadata.is_file().then_some(metadata.len()),
            metadata.modified().ok(),
        ));
    }
    Ok(Listing {
        path: display_path(&path)?,
        parent: path.parent().map(display_path).transpose()?,
        entries,
        omitted,
    })
}

#[cfg(windows)]
fn hidden_attribute(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_HIDDEN;
    metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}

#[cfg(not(windows))]
fn hidden_attribute(_: &fs::Metadata) -> bool {
    false
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

pub fn copy_into(source: &Path, directory: &Path) -> io::Result<()> {
    let name = source.file_name().ok_or_else(|| {
        io::Error::new(ErrorKind::InvalidInput, "Choose a file or folder to copy.")
    })?;
    let directory = directory.canonicalize()?;
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
    let target = directory.join(name);
    ensure_absent(&target)?;
    let workspace = tempfile::Builder::new()
        .prefix(".dirlume-")
        .tempdir_in(directory)?;
    let staged = workspace.path().join("copy");
    copy_entry(source, &staged, metadata)?;
    renamest::rename_exclusive(staged, target)
}

fn copy_entry(source: &Path, destination: &Path, metadata: fs::Metadata) -> io::Result<()> {
    if is_link(&metadata) {
        return Err(io::Error::new(
            ErrorKind::Unsupported,
            format!("Copying links is unsupported ({})", source.display()),
        ));
    }
    if metadata.is_dir() {
        fs::create_dir(destination)?;
        for child in fs::read_dir(source)? {
            let child = child?;
            let path = child.path();
            copy_entry(
                &path,
                &destination.join(child.file_name()),
                fs::symlink_metadata(&path)?,
            )?;
        }
    } else if metadata.is_file() {
        fs::copy(source, destination)?;
    } else {
        return Err(io::Error::new(
            ErrorKind::Unsupported,
            "Only regular files and folders can be copied.",
        ));
    }
    Ok(())
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
    renamest::rename_exclusive(source, target).map_err(|error| {
        if error.kind() == ErrorKind::CrossesDevices {
            io::Error::new(
                ErrorKind::CrossesDevices,
                "Move requires the same volume. Use Copy between volumes.",
            )
        } else {
            error
        }
    })
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
        copy_into(&source, &target).unwrap();
        let copy = target.join("source/nested/test.txt");
        assert_eq!(fs::read(&copy).unwrap(), b"original");
        fs::write(&copy, b"destination").unwrap();
        assert!(copy_into(&source, &target).is_err());
        assert_eq!(fs::read(&copy).unwrap(), b"destination");
        assert!(copy_into(&source, &source.join("nested")).is_err());
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
