use crate::{local, Result};
use serde::Serialize;

#[derive(Serialize)]
pub(crate) struct Listing {
    entries: Vec<local::Entry>,
    omitted: usize,
    parent: Option<String>,
    drives: Option<serde_json::Value>,
}

#[cfg(windows)]
mod windows {
    use super::*;
    use crate::message;
    use serde::Deserialize;
    use serde_json::{json, Value};
    use std::{
        io::{self, Write},
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        path::Path,
        time::{Duration, UNIX_EPOCH},
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::windows::named_pipe::{ClientOptions, NamedPipeClient},
        time::{sleep, timeout, Instant},
    };
    use windows_sys::Win32::{
        Foundation::ERROR_PIPE_BUSY,
        Storage::FileSystem::{
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, SECURITY_IDENTIFICATION,
            SECURITY_SQOS_PRESENT,
        },
        System::{
            Pipes::GetNamedPipeServerProcessId,
            RemoteDesktop::ProcessIdToSessionId,
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    };

    const LIMIT: Duration = Duration::from_secs(15);
    const MAX_LISTING: usize = 8 * 1024 * 1024 + 1024;

    fn verify_server(pipe: &NamedPipeClient) -> Result<()> {
        let mut pid = 0;
        // SAFETY: the live pipe handle and the output pointer are valid.
        if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) } == 0 {
            return Err(message(io::Error::last_os_error()));
        }
        // SAFETY: OpenProcess returns an owned handle when successful.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return Err(message(io::Error::last_os_error()));
        }
        // SAFETY: a non-null handle from OpenProcess belongs to this caller.
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut path = vec![0u16; 32768];
        let mut length = path.len() as u32;
        // SAFETY: path has length UTF-16 elements, and handle stays live during the call.
        let success = unsafe {
            QueryFullProcessImageNameW(handle.as_raw_handle(), 0, path.as_mut_ptr(), &mut length)
        };
        let path = String::from_utf16_lossy(&path[..length as usize]);
        if success == 0
            || !Path::new(&path)
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("KSwitcher.exe"))
        {
            return Err("The local LAN service is not KSwitcher.".into());
        }
        Ok(())
    }

    async fn connect(request: Value) -> Result<NamedPipeClient> {
        let mut session = 0;
        // SAFETY: session points to an initialized writable u32.
        if unsafe { ProcessIdToSessionId(std::process::id(), &mut session) } == 0 {
            return Err(message(io::Error::last_os_error()));
        }
        let name = format!(r"\\.\pipe\KSwitcher.LAN.Clients.v1.{session}");
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut pipe = loop {
            match ClientOptions::new()
                .security_qos_flags(SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION)
                .open(&name)
            {
                Ok(pipe) => break pipe,
                Err(error)
                    if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32)
                        && Instant::now() < deadline =>
                {
                    sleep(Duration::from_millis(75)).await;
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    return Err("Start KSwitcher with support for trusted LAN clients.".into());
                }
                Err(error) => return Err(message(error)),
            }
        };
        verify_server(&pipe)?;
        let body = serde_json::to_vec(&request).map_err(message)?;
        if body.len() > 16384 {
            return Err("The KSwitcher request is too large.".into());
        }
        timeout(LIMIT, async {
            pipe.write_u32_le(body.len() as u32).await?;
            pipe.write_all(&body).await
        })
        .await
        .map_err(message)?
        .map_err(message)?;
        Ok(pipe)
    }

    async fn frame(pipe: &mut NamedPipeClient, limit: usize) -> Result<Vec<u8>> {
        timeout(LIMIT, async {
            let length = pipe.read_u32_le().await.map_err(message)? as usize;
            if length > limit {
                return Err("The KSwitcher response is too large.".into());
            }
            let mut data = vec![0; length];
            pipe.read_exact(&mut data).await.map_err(message)?;
            Ok(data)
        })
        .await
        .map_err(message)?
    }

    async fn header(pipe: &mut NamedPipeClient) -> Result<Value> {
        let data = frame(pipe, MAX_LISTING).await?;
        let reply: Value = serde_json::from_slice(&data).map_err(message)?;
        if let Some(error) = reply.get("error").and_then(Value::as_str) {
            let _ = pipe.write_u8(0).await;
            return Err(error.to_owned());
        }
        Ok(reply)
    }

    pub(super) async fn request(request: Value) -> Result<Value> {
        let mut pipe = connect(request).await?;
        let response = header(&mut pipe).await?;
        pipe.write_u8(0).await.map_err(message)?;
        Ok(response)
    }

    #[derive(Deserialize)]
    struct DirectoryEntry {
        name: String,
        attributes: u32,
        size: u64,
        modified: u64,
    }

    pub(super) async fn list(peer: &str, path: &str) -> Result<Listing> {
        if path.is_empty() {
            let mut drives = request(json!({"action":"drives","peer":peer})).await?;
            let drives = drives
                .as_array_mut()
                .ok_or("Invalid KSwitcher drive listing.")?;
            let mut entries = Vec::new();
            let mut sizes = Vec::new();
            for drive in drives {
                let Some(name) = drive
                    .get("path")
                    .and_then(Value::as_str)
                    .and_then(|path| path.strip_suffix('\\'))
                else {
                    continue;
                };
                if name.len() != 2
                    || !name.as_bytes()[0].is_ascii_alphabetic()
                    || !name.ends_with(':')
                {
                    continue;
                }
                entries.push(local::Entry::new(
                    name.to_owned(),
                    true,
                    false,
                    local::EntryAttributes::default(),
                    None,
                    None,
                ));
                sizes.push(json!({"name":name,"type":drive["type"],"total":drive["total"],"available":drive["free"]}));
            }
            return Ok(Listing {
                entries,
                omitted: 0,
                parent: None,
                drives: Some(json!(sizes)),
            });
        }
        let rows: Vec<DirectoryEntry> = serde_json::from_value(
            request(json!({"action":"list","peer":peer,"path":path})).await?,
        )
        .map_err(message)?;
        let mut omitted = 0;
        let entries = rows
            .into_iter()
            .filter_map(|row| {
                if local::name_component(&row.name).is_err() {
                    omitted += 1;
                    return None;
                }
                let directory = row.attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
                let modified =
                    row.modified
                        .checked_sub(116_444_736_000_000_000)
                        .and_then(|ticks| {
                            UNIX_EPOCH.checked_add(Duration::from_secs(ticks / 10_000_000))
                        });
                Some(local::Entry::new(
                    row.name,
                    directory,
                    row.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
                    local::EntryAttributes::from_windows(row.attributes),
                    (!directory).then_some(row.size),
                    modified,
                ))
            })
            .collect();
        let parent = Path::new(path)
            .parent()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(Listing {
            entries,
            omitted,
            parent: Some(parent),
            drives: None,
        })
    }

    pub(super) async fn download(
        peer: &str,
        path: &str,
        file: &mut std::fs::File,
        mut progress: impl FnMut(u64, Option<u64>) -> io::Result<()>,
    ) -> Result<()> {
        let mut pipe = connect(json!({"action":"download","peer":peer,"path":path})).await?;
        let size = header(&mut pipe)
            .await?
            .get("size")
            .and_then(Value::as_u64)
            .ok_or("Invalid KSwitcher download size.")?;
        let mut received = 0;
        progress(received, Some(size)).map_err(message)?;
        loop {
            let data = frame(&mut pipe, 64 * 1024).await?;
            if data.is_empty() {
                break;
            }
            received += data.len() as u64;
            if received > size {
                return Err("The KSwitcher download exceeded the expected size.".into());
            }
            progress(received, Some(size)).map_err(message)?;
            file.write_all(&data).map_err(message)?;
        }
        if received != size {
            return Err("The KSwitcher download ended before all bytes arrived.".into());
        }
        pipe.write_u8(0).await.map_err(message)?;
        Ok(())
    }
}

pub(crate) async fn peers() -> Result<serde_json::Value> {
    #[cfg(windows)]
    {
        windows::request(serde_json::json!({"action":"peers"})).await
    }
    #[cfg(not(windows))]
    {
        Err("KSwitcher LAN clients run on Windows.".into())
    }
}

pub(crate) async fn list(peer: &str, path: &str) -> Result<Listing> {
    #[cfg(windows)]
    {
        windows::list(peer, path).await
    }
    #[cfg(not(windows))]
    {
        let _ = (peer, path);
        Err("KSwitcher LAN clients run on Windows.".into())
    }
}

pub(crate) async fn download(
    peer: &str,
    path: &str,
    file: &mut std::fs::File,
    progress: impl FnMut(u64, Option<u64>) -> std::io::Result<()>,
) -> Result<()> {
    #[cfg(windows)]
    {
        windows::download(peer, path, file, progress).await
    }
    #[cfg(not(windows))]
    {
        let _ = (peer, path, file, progress);
        Err("KSwitcher LAN clients run on Windows.".into())
    }
}
