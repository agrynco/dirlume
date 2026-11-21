use std::{
    collections::HashMap,
    fs::OpenOptions,
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::{Component, Prefix},
};

use ntfs_mft::{RawMftScanOptions, Volume};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES,
};

use super::{fs, io, local, platform, Output, Path, PathBuf};

pub(super) fn open(root: &Path) -> Option<Volume> {
    let (mount, share) = platform::mount(root).ok()?;
    if share || mount.canonicalize().ok()? != root {
        return None;
    }
    if let Some(Component::Prefix(prefix)) = root.components().next() {
        if let Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) = prefix.kind() {
            if root.parent().is_none() {
                return Volume::from_drive_letter(char::from(letter)).ok();
            }
        }
    }
    Volume::from_mount_point(root).ok()
}

// Directory access also verifies the live file reference (including its sequence number).
// A rename or a recycled record must not attach another directory's children here.
fn directory_reference(path: &Path) -> io::Result<u64> {
    let file = OpenOptions::new()
        .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let current = u64::from(info.nFileIndexHigh) << 32 | u64::from(info.nFileIndexLow);
    if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
        != FILE_ATTRIBUTE_DIRECTORY
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "The directory changed during the scan.",
        ));
    }
    Ok(current)
}

fn check_directory(path: &Path, reference: u64) -> io::Result<()> {
    if directory_reference(path)? != reference {
        return Err(io::Error::other("The directory changed during the scan."));
    }
    Ok(())
}

struct Item {
    reference: u64,
    name: Option<String>,
    directory: bool,
    size: Option<u64>,
    allocated: Option<u64>,
    reparse: bool,
    verify_file: bool,
    linked: bool,
}

struct Branch {
    path: PathBuf,
    id: usize,
    partial: bool,
}

impl Branch {
    fn attach(&mut self, item: Item, out: &mut Output<'_>) -> io::Result<Option<Branch>> {
        let Some(name) = item.name.filter(|name| local::name_component(name).is_ok()) else {
            self.partial = true;
            return Ok(None);
        };
        if item.directory {
            if item.reparse {
                return Ok(None);
            }
            let path = self.path.join(&name);
            let id = out.entry(self.id, name, true, None, None, None)?;
            if let Err(error) = check_directory(&path, item.reference) {
                out.closed(id, true, Some(error.to_string()))?;
                return Ok(None);
            }
            return Ok(Some(Branch {
                path,
                id,
                partial: false,
            }));
        }

        let (size, allocated) = if item.verify_file {
            let path = self.path.join(&name);
            match fs::symlink_metadata(&path) {
                Ok(md) if md.is_file() && !local::is_link(&md) => {
                    (Some(md.len()), platform::usage(&path, &md).0)
                }
                Ok(_) => return Ok(None),
                Err(_) => {
                    self.partial = true;
                    return Ok(None);
                }
            }
        } else {
            (item.size, item.allocated)
        };
        let identity = item.linked.then(|| item.reference.to_string());
        out.entry(self.id, name, false, size, allocated, identity)?;
        Ok(None)
    }
}

struct Tree {
    // None marks a known, excluded directory. This also handles children read before their parent.
    branches: HashMap<u64, Option<Branch>>,
    waiting: HashMap<u64, Vec<Item>>,
    ready: Vec<(u64, Item)>,
}

impl Tree {
    fn attach(&mut self, parent: u64, item: Item, out: &mut Output<'_>) -> io::Result<()> {
        self.ready.push((parent, item));
        while let Some((parent, item)) = self.ready.pop() {
            out.check()?;
            let reference = item.reference;
            let directory = item.directory;
            if directory && self.branches.contains_key(&reference) {
                // A live scan may observe a directory move. Reusing its UI node could form a cycle.
                continue;
            }
            let child = match self.branches.get_mut(&parent) {
                None => {
                    self.waiting.entry(parent).or_default().push(item);
                    continue;
                }
                Some(Some(branch)) => branch.attach(item, out)?,
                Some(None) => None,
            };
            if directory {
                self.branches.insert(reference, child);
                if let Some(children) = self.waiting.remove(&reference) {
                    self.ready
                        .extend(children.into_iter().map(|child| (reference, child)));
                }
            }
        }
        Ok(())
    }
}

pub(super) fn scan(root: &Path, volume: &Volume, out: &mut Output<'_>) -> io::Result<()> {
    let raw = volume.raw_mft().map_err(io::Error::other)?;
    let root_ref = raw
        .read_record(5)
        .map_err(io::Error::other)?
        .ok_or_else(|| io::Error::other("Missing NTFS root record."))?
        .file_reference
        .get();
    check_directory(root, root_ref)?;
    let mut tree = Tree {
        branches: HashMap::from([(
            root_ref,
            Some(Branch {
                path: root.to_owned(),
                id: 0,
                partial: false,
            }),
        )]),
        waiting: HashMap::new(),
        ready: Vec::new(),
    };
    let options = RawMftScanOptions::builder()
        .collect_alternate_data_streams(false)
        .collect_dos_file_name_links(false)
        .build();
    let records = raw
        .scan_entries_with_options(options)
        .map_err(io::Error::other)?;
    for record in records {
        out.check()?;
        let record = record.map_err(io::Error::other)?;
        let reference = record.file_reference.get();
        let reparse = record.is_reparse_point || record.si_file_attributes.is_reparse_point();
        let linked = record.hard_link_count > 1 || record.links.len() > 1;
        for link in record.links {
            let parent = link.parent_reference;
            // Records below 24 are NTFS housekeeping files. Only the volume root has browsable children.
            if parent.record_number() < 24 && parent.get() != root_ref {
                tree.branches.entry(parent.get()).or_insert(None);
            }
            tree.attach(
                parent.get(),
                Item {
                    reference,
                    name: link.file_name.try_to_string().ok(),
                    directory: record.is_directory,
                    size: Some(record.real_size),
                    // FileStandardInfo reports resident allocations rounded to an eight-byte boundary.
                    allocated: if record.is_resident {
                        record.real_size.checked_next_multiple_of(8)
                    } else {
                        Some(record.allocated_size)
                    },
                    reparse,
                    verify_file: !record.has_unnamed_data
                        || record.is_compressed
                        || record.is_sparse
                        || reparse,
                    linked,
                },
                out,
            )?;
        }
    }
    // A deleted or unobserved parent can leave otherwise live records unplaceable.
    if !tree.waiting.is_empty() {
        if let Some(Some(root)) = tree.branches.get_mut(&root_ref) {
            root.partial = true;
        }
    }
    for branch in tree.branches.into_values().flatten() {
        out.closed(branch.id, branch.partial, None)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space_analyzer::{Change, ScanEvent};
    use std::{collections::HashSet, sync::atomic::AtomicBool, time::Instant};

    #[test]
    fn holds_children_until_their_parent_is_read_and_excludes_unreadable_subtrees() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        assert!(open(&root).is_none());
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        let sub_ref = directory_reference(&sub).unwrap();
        let mut tree = Tree {
            branches: HashMap::from([(
                5,
                Some(Branch {
                    path: root,
                    id: 0,
                    partial: false,
                }),
            )]),
            waiting: HashMap::new(),
            ready: Vec::new(),
        };
        let child = |name: &str, reference, directory| Item {
            name: Some(name.to_owned()),
            reference,
            directory,
            size: Some(17),
            allocated: Some(24),
            reparse: false,
            verify_file: false,
            linked: !directory,
        };
        let mut changes = Vec::new();
        let mut send = |event| {
            if let ScanEvent::Batch { changes: batch } = event {
                changes.extend(batch);
            }
            Ok(())
        };
        let mut out = Output {
            send: &mut send,
            stop: &AtomicBool::new(false),
            changes: Vec::new(),
            identities: HashSet::new(),
            next_id: 1,
            last: Instant::now(),
        };
        tree.attach(sub_ref, child("first", 42, false), &mut out)
            .unwrap();
        tree.attach(77, child("unreachable", 44, false), &mut out)
            .unwrap();
        tree.attach(5, child("missing", 77, true), &mut out)
            .unwrap();
        tree.attach(5, child("sub", sub_ref, true), &mut out)
            .unwrap();
        tree.attach(5, child("second", 42, false), &mut out)
            .unwrap();
        assert!(tree.waiting.is_empty());
        out.flush().unwrap();
        let mut total = 0;
        let mut shared = 0;
        let mut unavailable = 0;
        for change in changes {
            match change {
                Change::Entry {
                    name,
                    allocated,
                    shared: same_file,
                    ..
                } => {
                    assert_ne!(name, "unreachable");
                    total += allocated.unwrap_or(0);
                    shared += usize::from(same_file);
                }
                Change::Closed { partial: true, .. } => unavailable += 1,
                _ => {}
            }
        }
        assert_eq!((total, shared, unavailable), (24, 1, 1));
    }
}
