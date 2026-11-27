use crate::{local, Result};
use serde::{Deserialize, Serialize};

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Capabilities {
    pub(crate) write: bool,
    pub(crate) delete: bool,
    pub(crate) revision_read: bool,
    pub(crate) on_host_transfer: bool,
    pub(crate) local_endpoint: bool,
    #[serde(default)]
    pub(crate) conflict_prompt: bool,
}

#[derive(Serialize)]
pub(crate) struct Endpoint<'a> {
    pub(crate) peer: Option<&'a str>,
    pub(crate) path: &'a str,
}

#[derive(Deserialize)]
pub(crate) struct TransferCollision {
    pub(crate) path: String,
    pub(crate) incoming: TransferMetadata,
    pub(crate) existing: TransferMetadata,
    pub(crate) replaceable: bool,
}

#[derive(Deserialize)]
pub(crate) struct TransferMetadata {
    pub(crate) attributes: u32,
    pub(crate) size: u64,
    pub(crate) modified: u64,
}

#[cfg_attr(
    not(windows),
    allow(dead_code, reason = "The broker only runs on Windows")
)]
pub(crate) enum TransferResult {
    Finished(bool),
    SourceCleanupFailed(String),
}

#[cfg(windows)]
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TransferReply {
    Progress {
        path: String,
        done: u64,
        total: u64,
        phase: String,
    },
    Conflict(TransferCollision),
    Complete {
        completed: u64,
        skipped: u64,
    },
}

#[cfg(windows)]
#[derive(Clone, Copy, Deserialize, Serialize)]
pub(crate) struct Revision {
    pub(crate) size: u64,
    pub(crate) modified: u64,
}

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
        Foundation::{ERROR_PIPE_BUSY, HANDLE},
        Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
        Storage::FileSystem::{
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, SECURITY_IDENTIFICATION,
            SECURITY_IMPERSONATION, SECURITY_SQOS_PRESENT,
        },
        System::{
            Pipes::GetNamedPipeServerProcessId,
            RemoteDesktop::ProcessIdToSessionId,
            Threading::{
                GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    };

    const LIMIT: Duration = Duration::from_secs(15);
    const MAX_LISTING: usize = 8 * 1024 * 1024 + 1024;

    fn elevated(process: HANDLE) -> Result<bool> {
        let mut token = std::ptr::null_mut();
        // SAFETY: process is a live process handle and token is a valid writable pointer.
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return Err(message(io::Error::last_os_error()));
        }
        // SAFETY: successful OpenProcessToken returned an owned handle.
        let _token = unsafe { OwnedHandle::from_raw_handle(token) };
        let mut elevation = TOKEN_ELEVATION::default();
        let mut size = 0;
        // SAFETY: elevation is a correctly sized and aligned output buffer.
        if unsafe {
            GetTokenInformation(
                token,
                TokenElevation,
                (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut size,
            )
        } == 0
        {
            return Err(message(io::Error::last_os_error()));
        }
        Ok(elevation.TokenIsElevated != 0)
    }

    fn verify_server(pipe: &NamedPipeClient, local_endpoint: bool) -> Result<()> {
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
        // SAFETY: GetCurrentProcess returns a pseudo-handle valid for token queries.
        if local_endpoint
            && elevated(unsafe { GetCurrentProcess() })?
            && !elevated(handle.as_raw_handle())?
        {
            return Err("Run Dirlume without administrator privileges to transfer local files through KSwitcher.".into());
        }
        Ok(())
    }

    async fn connect(request: Value) -> Result<NamedPipeClient> {
        connect_with_access(request, false).await
    }

    async fn connect_with_access(request: Value, local_endpoint: bool) -> Result<NamedPipeClient> {
        let mut session = 0;
        // SAFETY: session points to an initialized writable u32.
        if unsafe { ProcessIdToSessionId(std::process::id(), &mut session) } == 0 {
            return Err(message(io::Error::last_os_error()));
        }
        let name = format!(r"\\.\pipe\KSwitcher.LAN.Clients.v1.{session}");
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut pipe = loop {
            let level = if local_endpoint {
                SECURITY_IMPERSONATION
            } else {
                SECURITY_IDENTIFICATION
            };
            match ClientOptions::new()
                .security_qos_flags(SECURITY_SQOS_PRESENT | level)
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
        verify_server(&pipe, local_endpoint)?;
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

    async fn send_frame(pipe: &mut NamedPipeClient, bytes: &[u8]) -> Result<()> {
        timeout(LIMIT, async {
            pipe.write_u32_le(bytes.len() as u32).await?;
            pipe.write_all(bytes).await
        })
        .await
        .map_err(message)?
        .map_err(message)
    }

    pub(super) async fn read_file(
        peer: &str,
        path: &str,
        limit: u64,
    ) -> Result<(Vec<u8>, Revision)> {
        let mut pipe = connect(json!({"action":"readFile","peer":peer,"path":path})).await?;
        let revision: Revision =
            serde_json::from_value(header(&mut pipe).await?).map_err(message)?;
        if revision.size > limit {
            return Err(format!(
                "Files opened from KSwitcher can be at most {} MiB.",
                limit / (1024 * 1024)
            ));
        }
        let mut bytes = Vec::new();
        receive_file(&mut pipe, revision.size, |chunk| {
            bytes.extend_from_slice(chunk);
            Ok(())
        })
        .await?;
        Ok((bytes, revision))
    }

    pub(super) async fn write_file(
        peer: &str,
        path: &str,
        bytes: &[u8],
        expected: Option<Revision>,
    ) -> Result<Revision> {
        let mut request = json!({"action":"writeFile","peer":peer,"path":path,"size":bytes.len()});
        if let Some(expected) = expected {
            request["expected"] = json!(expected);
        }
        let mut pipe = connect(request).await?;
        if header(&mut pipe).await?.get("type").and_then(Value::as_str) != Some("ready") {
            return Err("KSwitcher did not accept the upload.".into());
        }
        for chunk in bytes.chunks(64 * 1024) {
            send_frame(&mut pipe, chunk).await?;
        }
        send_frame(&mut pipe, &[]).await?;
        let revision = serde_json::from_value(header(&mut pipe).await?).map_err(message)?;
        pipe.write_u8(0).await.map_err(message)?;
        Ok(revision)
    }

    pub(super) async fn transfer<
        F: std::future::Future<Output = Result<crate::local_transfer::Decision>>,
    >(
        source: Endpoint<'_>,
        target: Endpoint<'_>,
        moving: bool,
        conflict: &str,
        mut progress: impl FnMut(&str, u64, u64) -> io::Result<()>,
        mut ask: impl FnMut(TransferCollision) -> F,
    ) -> Result<TransferResult> {
        let local_endpoint = source.peer.is_none() || target.peer.is_none();
        let request = json!({"action":"transfer","source":source,"target":target,"move":moving,"conflict":conflict});
        let mut pipe = connect_with_access(request, local_endpoint).await?;
        let mut removing = false;
        loop {
            let reply = match header(&mut pipe).await {
                Err(error) if removing => return Ok(TransferResult::SourceCleanupFailed(error)),
                reply => reply?,
            };
            match serde_json::from_value(reply).map_err(message)? {
                TransferReply::Progress {
                    path,
                    done,
                    total,
                    phase,
                } => {
                    removing = phase == "remove";
                    let response = progress(&path, done, total);
                    let bytes = if response.is_ok() {
                        br#"{"continue":true}"#.as_slice()
                    } else {
                        br#"{"continue":false}"#.as_slice()
                    };
                    send_frame(&mut pipe, bytes).await?;
                    response.map_err(message)?;
                }
                TransferReply::Conflict(collision) => {
                    use crate::local_transfer::Decision;
                    let decision = ask(collision);
                    tokio::pin!(decision);
                    let choice = loop {
                        tokio::select! {
                            answer = &mut decision => break answer,
                            _ = sleep(Duration::from_secs(3)) => send_frame(&mut pipe, br#"{"decision":"wait"}"#).await?,
                        }
                    };
                    let response = match &choice {
                        Ok(Decision::Overwrite | Decision::OverwriteAll) => {
                            br#"{"decision":"replace"}"#.as_slice()
                        }
                        Ok(Decision::Skip) => br#"{"decision":"skip"}"#.as_slice(),
                        Err(_) => br#"{"decision":"cancel"}"#.as_slice(),
                    };
                    send_frame(&mut pipe, response).await?;
                    choice?;
                }
                TransferReply::Complete { completed, skipped } => {
                    pipe.write_u8(0).await.map_err(message)?;
                    return Ok(TransferResult::Finished(completed > 0 && skipped == 0));
                }
            }
        }
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
        progress(0, Some(size)).map_err(message)?;
        receive_file(&mut pipe, size, |data| {
            received += data.len() as u64;
            progress(received, Some(size))?;
            file.write_all(data)
        })
        .await
    }

    async fn receive_file(
        pipe: &mut NamedPipeClient,
        size: u64,
        mut write: impl FnMut(&[u8]) -> io::Result<()>,
    ) -> Result<()> {
        let mut received = 0;
        loop {
            let data = frame(pipe, 64 * 1024).await?;
            if data.is_empty() {
                break;
            }
            received += data.len() as u64;
            if received > size {
                return Err("The KSwitcher download exceeded the expected size.".into());
            }
            write(&data).map_err(message)?;
        }
        if received != size {
            return Err("The KSwitcher download ended before all bytes arrived.".into());
        }
        pipe.write_u8(0).await.map_err(message)?;
        Ok(())
    }
}

pub(crate) async fn transfer<
    F: std::future::Future<Output = Result<crate::local_transfer::Decision>>,
>(
    source: Endpoint<'_>,
    target: Endpoint<'_>,
    moving: bool,
    conflict: &str,
    progress: impl FnMut(&str, u64, u64) -> std::io::Result<()>,
    ask: impl FnMut(TransferCollision) -> F,
) -> Result<TransferResult> {
    #[cfg(windows)]
    {
        windows::transfer(source, target, moving, conflict, progress, ask).await
    }
    #[cfg(not(windows))]
    {
        let _ = (source, target, moving, conflict, progress, ask);
        Err("KSwitcher LAN clients run on Windows.".into())
    }
}

pub(crate) async fn capabilities(peer: &str) -> Result<Capabilities> {
    #[cfg(windows)]
    {
        let result =
            windows::request(serde_json::json!({"action":"capabilities","peer":peer})).await;
        match result {
            Ok(value) => serde_json::from_value(value).map_err(crate::message),
            Err(error) if error == "Unsupported LAN client operation." => {
                Ok(Capabilities::default())
            }
            Err(error) => Err(error),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = peer;
        Err("KSwitcher LAN clients run on Windows.".into())
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Change {
    CreateFile { encoding: crate::desktop::Encoding },
    CreateFolder,
    Rename { name: String },
    Recycle,
    Delete { recursive: bool },
}

pub(crate) async fn change(peer: &str, path: &str, change: Change) -> Result<()> {
    #[cfg(windows)]
    {
        use serde_json::json;
        let request = match change {
            Change::CreateFile { encoding } => {
                return windows::write_file(
                    peer,
                    path,
                    &crate::desktop::encode_text(encoding, ""),
                    None,
                )
                .await
                .map(|_| ())
            }
            Change::CreateFolder => json!({"action":"mkdir","peer":peer,"path":path}),
            Change::Rename { name } => {
                json!({"action":"rename","peer":peer,"path":path,"name":name})
            }
            Change::Recycle => json!({"action":"recycle","peer":peer,"path":path}),
            Change::Delete { recursive } => {
                json!({"action":"delete","peer":peer,"path":path,"recursive":recursive})
            }
        };
        windows::request(request).await.map(|_| ())
    }
    #[cfg(not(windows))]
    {
        let _ = (peer, path);
        match change {
            Change::CreateFile { encoding } => {
                let _ = encoding;
            }
            Change::Rename { name } => drop(name),
            Change::Delete { recursive } => {
                let _ = recursive;
            }
            _ => {}
        }
        Err("KSwitcher LAN clients run on Windows.".into())
    }
}

pub(crate) async fn read_text(peer: &str, path: &str) -> Result<crate::desktop::TextDocument> {
    #[cfg(windows)]
    {
        let (bytes, revision) = windows::read_file(peer, path, crate::desktop::TEXT_LIMIT).await?;
        let mut document = crate::desktop::decode_text(bytes.as_slice())?;
        document.revision = Some(serde_json::to_string(&revision).map_err(crate::message)?);
        Ok(document)
    }
    #[cfg(not(windows))]
    {
        let _ = (peer, path);
        Err("KSwitcher LAN clients run on Windows.".into())
    }
}

pub(crate) async fn preview(peer: &str, path: &str) -> Result<Vec<u8>> {
    #[cfg(windows)]
    {
        windows::read_file(peer, path, 16 * 1024 * 1024)
            .await
            .map(|(bytes, _)| bytes)
    }
    #[cfg(not(windows))]
    {
        let _ = (peer, path);
        Err("KSwitcher LAN clients run on Windows.".into())
    }
}

pub(crate) async fn save_text(
    peer: &str,
    path: &str,
    revision: &str,
    text: String,
    encoding: crate::desktop::Encoding,
) -> Result<crate::desktop::TextDocument> {
    #[cfg(windows)]
    {
        let expected = serde_json::from_str(revision).map_err(crate::message)?;
        let bytes = crate::desktop::encode_text(encoding, &text);
        if bytes.len() as u64 > crate::desktop::TEXT_LIMIT {
            return Err("Text files can be at most 8 MiB.".into());
        }
        let revision = windows::write_file(peer, path, &bytes, Some(expected)).await?;
        Ok(crate::desktop::TextDocument {
            text,
            encoding,
            revision: Some(serde_json::to_string(&revision).map_err(crate::message)?),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (peer, path, revision, text, encoding);
        Err("KSwitcher LAN clients run on Windows.".into())
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

pub(crate) async fn destination_is_folder(peer: &str, path: &std::path::Path) -> Result<bool> {
    if !path.is_absolute() {
        return Err("Choose an absolute destination.".into());
    }
    let Some(parent) = path.parent() else {
        return Ok(true);
    };
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Enter a valid destination name.")?;
    let parent = parent.to_str().ok_or("Choose an absolute destination.")?;
    let entries = list(peer, parent).await?.entries;
    Ok(entries
        .iter()
        .any(|entry| entry.directory && entry.name.to_lowercase() == name.to_lowercase()))
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
