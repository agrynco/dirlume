use std::{
    ffi::CStr,
    fs::{self, File, OpenOptions},
    io,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::Path,
};

use super::{checked_directory, generic_child, local, platform::Boundary, Child, Output};
use libc::{
    attrlist, ATTR_CMN_DEVID, ATTR_CMN_FILEID, ATTR_CMN_NAME, ATTR_CMN_OBJTYPE,
    ATTR_CMN_RETURNED_ATTRS, ATTR_FILE_ALLOCSIZE, ATTR_FILE_DATALENGTH, ATTR_FILE_LINKCOUNT,
};

// Darwin's sys/attr.h defines this attribute, which libc does not export.
const ATTR_CMN_ERROR: u32 = 0x2000_0000;
const COMMON: u32 = ATTR_CMN_NAME
    | ATTR_CMN_DEVID
    | ATTR_CMN_OBJTYPE
    | ATTR_CMN_FILEID
    | ATTR_CMN_RETURNED_ATTRS
    | ATTR_CMN_ERROR;
const FILE: u32 = ATTR_FILE_LINKCOUNT | ATTR_FILE_ALLOCSIZE | ATTR_FILE_DATALENGTH;
const VREG: u32 = 1;

#[derive(Debug)]
pub(super) enum ScanError {
    Fallback,
    Io(io::Error),
}

impl From<io::Error> for ScanError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub(super) fn scan(
    root: &Path,
    boundary: &Boundary,
    out: &mut Output<'_>,
) -> Result<(), ScanError> {
    let mut jobs = vec![(0, root.to_path_buf())];
    let mut buffer = vec![0_u64; 8 * 1024];
    let mut attributes = attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: COMMON,
        volattr: 0,
        dirattr: 0,
        fileattr: FILE,
        forkattr: 0,
    };
    while let Some((parent, folder)) = jobs.pop() {
        out.check()?;
        let directory = match open(&folder, boundary) {
            Ok(directory) => directory,
            Err(error) if parent == 0 => return Err(error.into()),
            Err(error) => {
                out.closed(parent, true, Some(error.to_string()))?;
                continue;
            }
        };
        let mut partial = false;
        loop {
            out.check()?;
            // The descriptor belongs to an open directory and the aligned buffer is writable.
            let count = unsafe {
                libc::getattrlistbulk(
                    directory.as_raw_fd(),
                    (&mut attributes as *mut attrlist).cast(),
                    buffer.as_mut_ptr().cast(),
                    std::mem::size_of_val(buffer.as_slice()),
                    0,
                )
            };
            if count < 0 {
                // Restart from the root so a backend failure cannot duplicate an emitted entry.
                return Err(ScanError::Fallback);
            }
            if count == 0 {
                break;
            }
            // Each u64 is initialized and the syscall has finished writing before we read it.
            let mut records = unsafe {
                std::slice::from_raw_parts(
                    buffer.as_ptr().cast::<u8>(),
                    std::mem::size_of_val(buffer.as_slice()),
                )
            };
            for _ in 0..count {
                out.check()?;
                let length = u32::from_ne_bytes(
                    records
                        .get(..4)
                        .and_then(|b| b.try_into().ok())
                        .ok_or(ScanError::Fallback)?,
                ) as usize;
                let (record, rest) = records
                    .split_at_checked(length)
                    .ok_or(ScanError::Fallback)?;
                records = rest;
                let (name, file) = parse(record).ok_or(ScanError::Fallback)?;
                let Ok(name) = name.to_str() else {
                    partial = true;
                    continue;
                };
                if name == "." || name == ".." {
                    continue;
                }
                if local::name_component(name).is_err() {
                    partial = true;
                    continue;
                }
                let path = folder.join(name);
                let child = match file {
                    Some((device, file)) => Ok((device == boundary.0).then_some(file)),
                    // Directory metadata describes the underlying vnode for mount points and
                    // firmlinks. Check the path as the generic walker does before emitting it.
                    None => fs::symlink_metadata(&path)
                        .map(|meta| generic_child(&path, &meta, boundary)),
                };
                match child {
                    Ok(Some(Child::Directory)) => jobs.push((
                        out.entry(parent, name.to_owned(), true, None, None, None)?,
                        path,
                    )),
                    Ok(Some(Child::File {
                        size,
                        allocated,
                        identity,
                    })) => {
                        out.entry(
                            parent,
                            name.to_owned(),
                            false,
                            Some(size),
                            allocated,
                            identity,
                        )?;
                    }
                    Ok(None) => {}
                    Err(_) => partial = true,
                }
            }
        }
        out.closed(parent, partial, None)?;
    }
    Ok(())
}

fn open(path: &Path, boundary: &Boundary) -> io::Result<File> {
    let before = checked_directory(path, boundary)?;
    let handle = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(path)?;
    let after = handle.metadata()?;
    if (before.dev(), before.ino()) != (after.dev(), after.ino()) {
        return Err(io::Error::other("The directory changed during the scan."));
    }
    Ok(handle)
}

fn parse(record: &[u8]) -> Option<(&CStr, Option<(u64, Child)>)> {
    // The attribute bitmap is five 32-bit groups following the record length.
    let mut fields = Fields { record, offset: 4 };
    let common = fields.u32()?;
    fields.u32()?;
    fields.u32()?;
    let file = fields.u32()?;
    fields.u32()?;
    if common & ATTR_CMN_NAME == 0 {
        return None;
    }
    let failed = common & ATTR_CMN_ERROR != 0 && fields.u32()? != 0;
    let reference = fields.offset;
    let offset = i32::from_ne_bytes(fields.take()?);
    let length = fields.u32()? as usize;
    let start = reference.checked_add_signed(offset as isize)?;
    let name = CStr::from_bytes_with_nul(record.get(start..start.checked_add(length)?)?).ok()?;
    let needs = ATTR_CMN_DEVID | ATTR_CMN_OBJTYPE | ATTR_CMN_FILEID;
    if failed || common & needs != needs || file & FILE != FILE {
        return Some((name, None));
    }
    let device = u64::from(fields.u32()?);
    let kind = fields.u32()?;
    if kind != VREG {
        return Some((name, None));
    }
    let id = u64::from_ne_bytes(fields.take()?);
    let links = fields.u32()?;
    let allocated = u64::try_from(i64::from_ne_bytes(fields.take()?)).ok()?;
    let size = u64::try_from(i64::from_ne_bytes(fields.take()?)).ok()?;
    Some((
        name,
        Some((
            device,
            Child::File {
                size,
                // Darwin's st_blocks rounds the total allocation to 512-byte units.
                allocated: allocated.div_ceil(512).checked_mul(512),
                identity: (links > 1 && id != 0).then_some((device, u128::from(id))),
            },
        )),
    ))
}

struct Fields<'a> {
    record: &'a [u8],
    offset: usize,
}

impl Fields<'_> {
    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let end = self.offset.checked_add(N)?;
        let value = self.record.get(self.offset..end)?.try_into().ok()?;
        self.offset = end;
        Some(value)
    }

    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_ne_bytes(self.take()?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_complete_regular_file_attributes() {
        let name = b".hidden\0";
        let mut record = Vec::new();
        for value in [80, COMMON, 0, 0, FILE, 0, 0, 44, name.len() as u32, 1, VREG] {
            record.extend(value.to_ne_bytes());
        }
        record.extend(9_u64.to_ne_bytes());
        record.extend(2_u32.to_ne_bytes());
        record.extend(513_i64.to_ne_bytes());
        record.extend(8192_i64.to_ne_bytes());
        record.extend(name);
        assert_eq!(
            parse(&record).unwrap().1,
            Some((
                1,
                Child::File {
                    size: 8192,
                    allocated: Some(1024),
                    identity: Some((1, 9))
                }
            )),
        );
        record[16..20].copy_from_slice(&0_u32.to_ne_bytes());
        assert!(parse(&record).unwrap().1.is_none());
        assert!(parse(&record[..record.len() - 2]).is_none());
    }
}
