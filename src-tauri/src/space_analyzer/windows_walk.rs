use std::{
    mem::{offset_of, size_of_val},
    os::windows::io::AsRawHandle,
    ptr, slice,
    sync::{atomic::AtomicBool, mpsc},
    thread,
};

use windows_sys::Win32::{
    Foundation::{
        ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER, ERROR_NOT_SUPPORTED, ERROR_NO_MORE_FILES,
    },
    Storage::FileSystem::{
        FileIdExtdDirectoryInfo, GetFileInformationByHandleEx, GetVolumeInformationByHandleW,
        FILE_ATTRIBUTE_COMPRESSED, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_ATTRIBUTE_SPARSE_FILE, FILE_ID_EXTD_DIR_INFO,
    },
};

use super::{
    io, local,
    platform::{self, directory_identity, open_directory},
    Ordering, Output, Path, PathBuf,
};

pub(super) fn local_ntfs(root: &Path) -> Option<(u32, u64)> {
    if platform::mount(root).ok()?.1 {
        return None;
    }
    let file = open_directory(root).ok()?;
    let mut name = [0u16; 32];
    let ok = unsafe {
        GetVolumeInformationByHandleW(
            file.as_raw_handle(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            name.as_mut_ptr(),
            name.len() as u32,
        )
    };
    let name = name.split(|&unit| unit == 0).next().unwrap_or_default();
    if ok == 0 || !name.iter().copied().eq("NTFS".encode_utf16()) {
        return None;
    }
    directory_identity(&file).ok()
}

pub(super) fn unsupported(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error().map(|code| code as u32),
        Some(ERROR_INVALID_FUNCTION | ERROR_INVALID_PARAMETER | ERROR_NOT_SUPPORTED)
    )
}

struct Job {
    parent: usize,
    path: PathBuf,
    index: u128,
}

enum Entry {
    Directory {
        path: PathBuf,
        name: String,
        index: u128,
    },
    File {
        name: String,
        size: u64,
        allocated: Option<u64>,
        index: u128,
    },
}

enum Message {
    Entries(usize, Vec<Entry>),
    Done {
        worker: usize,
        parent: usize,
        result: io::Result<bool>,
    },
}

fn disconnected() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "The directory scanner stopped.")
}

fn enumerate(
    job: &Job,
    volume: u32,
    buffer: &mut [u64],
    stop: &AtomicBool,
    tx: &mpsc::SyncSender<Message>,
) -> io::Result<bool> {
    let file = open_directory(&job.path)?;
    let (current_volume, current_index) = directory_identity(&file)?;
    if current_volume != volume || u128::from(current_index) != job.index {
        return Err(io::Error::other("The directory changed during the scan."));
    }
    let mut partial = false;
    loop {
        if stop.load(Ordering::Relaxed) {
            return Err(io::ErrorKind::Interrupted.into());
        }
        let ok = unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileIdExtdDirectoryInfo,
                buffer.as_mut_ptr().cast(),
                size_of_val(buffer) as u32,
            )
        };
        if ok == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                return Ok(partial);
            }
            return Err(error);
        }
        let mut entries = Vec::new();
        parse_page(buffer, |name, attr, size, allocation, index| {
            if attr & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return;
            }
            let Some(name) = name else {
                partial = true;
                return;
            };
            if name == "." || name == ".." {
                return;
            }
            if local::name_component(&name).is_err() {
                partial = true;
                return;
            }
            if attr & FILE_ATTRIBUTE_DIRECTORY != 0 {
                entries.push(Entry::Directory {
                    path: job.path.join(&name),
                    name,
                    index,
                });
            } else {
                let allocated =
                    if attr & (FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_SPARSE_FILE) != 0 {
                        crate::file_attributes::space_usage(&job.path.join(&name)).0
                    } else {
                        u64::try_from(allocation).ok()
                    };
                entries.push(Entry::File {
                    name,
                    size,
                    allocated,
                    index,
                });
            }
        })?;
        if !entries.is_empty() {
            tx.send(Message::Entries(job.parent, entries))
                .map_err(|_| disconnected())?;
        }
    }
}

// Windows returns aligned, variable-length records terminated by a zero NextEntryOffset.
// Validate both offsets before borrowing the UTF-16 filename from this page.
fn parse_page(
    buffer: &[u64],
    mut visit: impl FnMut(Option<String>, u32, u64, i64, u128),
) -> io::Result<()> {
    const NAME: usize = offset_of!(FILE_ID_EXTD_DIR_INFO, FileName);
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, "Invalid NTFS directory page.");
    let mut pos = 0;
    loop {
        let remaining = size_of_val(buffer) - pos;
        if remaining < size_of::<FILE_ID_EXTD_DIR_INFO>() {
            return Err(invalid());
        }
        // pos is eight-byte aligned and the fixed portion of the record fits in the buffer.
        let record = unsafe {
            &*buffer
                .as_ptr()
                .byte_add(pos)
                .cast::<FILE_ID_EXTD_DIR_INFO>()
        };
        let next = record.NextEntryOffset as usize;
        let len = record.FileNameLength as usize;
        let end = if next == 0 { remaining } else { next };
        if end > remaining
            || !next.is_multiple_of(8)
            || !len.is_multiple_of(2)
            || NAME.checked_add(len).is_none_or(|name_end| name_end > end)
        {
            return Err(invalid());
        }
        let name = unsafe {
            slice::from_raw_parts(buffer.as_ptr().byte_add(pos + NAME).cast::<u16>(), len / 2)
        };
        visit(
            String::from_utf16(name).ok(),
            record.FileAttributes,
            record.EndOfFile.try_into().map_err(|_| invalid())?,
            record.AllocationSize,
            u128::from_le_bytes(record.FileId.Identifier),
        );
        if next == 0 {
            return Ok(());
        }
        pos += next;
    }
}

pub(super) fn scan(
    root: &Path,
    (volume, index): (u32, u64),
    out: &mut Output<'_>,
) -> io::Result<()> {
    let workers = thread::available_parallelism().map_or(2, |n| n.get().clamp(1, 4));
    let stop = out.stop;
    thread::scope(|scope| {
        let (tx, results) = mpsc::sync_channel(workers * 2);
        let mut senders = Vec::new();
        let mut idle: Vec<_> = (0..workers).collect();
        for worker in 0..workers {
            let (jobs, queue) = mpsc::channel::<Job>();
            senders.push(jobs);
            let tx = tx.clone();
            scope.spawn(move || {
                let mut buffer = vec![0u64; 8192];
                for job in queue {
                    let result = enumerate(&job, volume, &mut buffer, stop, &tx);
                    if tx
                        .send(Message::Done {
                            worker,
                            parent: job.parent,
                            result,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }
        drop(tx);
        let mut pending = vec![Job {
            parent: 0,
            path: root.to_owned(),
            index: u128::from(index),
        }];
        loop {
            out.check()?;
            while !idle.is_empty() && !pending.is_empty() {
                senders[idle.pop().unwrap()]
                    .send(pending.pop().unwrap())
                    .map_err(|_| disconnected())?;
            }
            if idle.len() == workers {
                return Ok(());
            }
            match results.recv().map_err(|_| disconnected())? {
                Message::Entries(parent, entries) => {
                    for item in entries {
                        match item {
                            Entry::Directory { path, name, index } => {
                                let parent = out.entry(parent, name, true, None, None, None)?;
                                pending.push(Job {
                                    parent,
                                    path,
                                    index,
                                });
                            }
                            Entry::File {
                                name,
                                size,
                                allocated,
                                index,
                            } => {
                                let identity = (index != 0).then_some((u64::from(volume), index));
                                out.entry(parent, name, false, Some(size), allocated, identity)?;
                            }
                        }
                    }
                }
                Message::Done {
                    worker,
                    parent,
                    result,
                } => {
                    idle.push(worker);
                    match result {
                        Ok(partial) => out.closed(parent, partial, None)?,
                        Err(e) if parent == 0 || unsupported(&e) => return Err(e),
                        Err(e) => out.closed(parent, true, Some(e.to_string()))?,
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space_analyzer::{Change, ScanEvent};
    use std::{collections::HashSet, fs, time::Instant};

    #[test]
    fn streams_multiple_directory_pages_and_deduplicates_across_workers() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let Some(volume) = local_ntfs(&root) else {
            return;
        };
        let source = root.join("payload");
        fs::write(&source, vec![1; 16_384]).unwrap();
        for i in 0..8 {
            let directory = root.join(format!("dir{i}"));
            fs::create_dir(&directory).unwrap();
            fs::hard_link(&source, directory.join("another name")).unwrap();
        }
        let directory = root.join("dir0");
        for i in 0..600 {
            fs::write(
                directory.join(format!("page-entry-{i:04}-long-filename-0123456789")),
                [],
            )
            .unwrap();
        }
        let mut files = 0;
        let mut folders = 0;
        let mut shared = 0;
        let mut allocated = 0;
        let mut closed = 0;
        let mut out = Output {
            send: &mut |event| {
                if let ScanEvent::Batch { changes } = event {
                    for change in changes {
                        match change {
                            Change::Entry {
                                directory: true, ..
                            } => folders += 1,
                            Change::Entry {
                                allocated: bytes,
                                shared: duplicate,
                                ..
                            } => {
                                files += 1;
                                allocated += bytes.unwrap();
                                shared += usize::from(duplicate);
                            }
                            Change::Closed { partial, error, .. } => {
                                assert!(!partial && error.is_none());
                                closed += 1;
                            }
                        }
                    }
                }
                Ok(())
            },
            stop: &AtomicBool::new(false),
            changes: Vec::new(),
            identities: HashSet::new(),
            next_id: 1,
            last: Instant::now(),
        };
        scan(&root, volume, &mut out).unwrap();
        out.flush().unwrap();
        assert_eq!((files, folders, shared, closed), (609, 8, 8, 9));
        assert_eq!(
            Some(allocated),
            crate::file_attributes::space_usage(&source).0
        );
    }
}
