use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{desktop::Result, local};

#[derive(Deserialize, Serialize)]
pub struct Peer {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize, Serialize)]
pub struct Listing {
    entries: Vec<local::Entry>,
    omitted: usize,
    parent: Option<String>,
}

#[cfg(windows)]
fn executable(directory: &str) -> Result<PathBuf> {
    let directory = local::absolute(directory).map_err(|error| error.to_string())?;
    let path = directory.join("KSwitcher.Files.exe");
    if !path.is_file() {
        return Err("Choose the folder containing KSwitcher.Files.exe.".to_owned());
    }
    Ok(path)
}

#[cfg(windows)]
fn has_bridge(path: &Path) -> bool {
    use std::{iter::once, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::{
        Foundation::FreeLibrary,
        System::LibraryLoader::{FindResourceW, LoadLibraryExW, LOAD_LIBRARY_AS_DATAFILE},
    };
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(once(0)).collect();
    // Map the executable as a data file, without running it, to check its protocol marker.
    unsafe {
        let module = LoadLibraryExW(
            path.as_ptr(),
            std::ptr::null_mut(),
            LOAD_LIBRARY_AS_DATAFILE,
        );
        if module.is_null() {
            return false;
        }
        let present =
            !FindResourceW(module, 1901usize as *const u16, 10usize as *const u16).is_null();
        FreeLibrary(module);
        present
    }
}

pub fn available(directory: &str) -> Result<bool> {
    #[cfg(windows)]
    {
        Ok(has_bridge(&executable(directory)?))
    }
    #[cfg(not(windows))]
    {
        let _ = directory;
        Err("The KSwitcher client runs on Windows.".to_owned())
    }
}

pub fn launch(directory: &str) -> Result<()> {
    #[cfg(windows)]
    {
        let path = executable(directory)?;
        std::process::Command::new(path)
            .current_dir(directory)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = directory;
        Err("The KSwitcher client runs on Windows.".to_owned())
    }
}

fn request<T: serde::de::DeserializeOwned>(
    directory: &str,
    args: &[&std::ffi::OsStr],
) -> Result<T> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let path = executable(directory)?;
        if !has_bridge(&path) {
            return Err("This KSwitcher build does not include the Dirlume bridge.".to_owned());
        }
        let output = std::process::Command::new(path)
            .arg("--dirlume-bridge-v1")
            .args(args)
            .current_dir(directory)
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "The KSwitcher bridge exited with {}.",
                output.status
            ));
        }
        let value: serde_json::Value =
            serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
        if let Some(error) = value.get("error").and_then(serde_json::Value::as_str) {
            return Err(error.to_owned());
        }
        serde_json::from_value(value).map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (directory, args);
        Err("The KSwitcher client runs on Windows.".to_owned())
    }
}

pub fn peers(directory: &str) -> Result<Vec<Peer>> {
    #[derive(Deserialize)]
    struct Response {
        peers: Vec<Peer>,
    }
    request::<Response>(directory, &["peers".as_ref()]).map(|response| response.peers)
}

pub fn list(directory: &str, peer: &str, path: &str) -> Result<Listing> {
    request(directory, &["list".as_ref(), peer.as_ref(), path.as_ref()])
}

pub fn download(directory: &str, peer: &str, path: &str, target: PathBuf) -> Result<()> {
    local::ensure_absent(&target).map_err(|error| error.to_string())?;
    let parent: &Path = target
        .parent()
        .ok_or_else(|| "Choose a local destination folder.".to_owned())?;
    let staged = tempfile::tempdir_in(parent).map_err(|error| error.to_string())?;
    let temporary = staged.path().join("file");
    request::<serde_json::Value>(
        directory,
        &[
            "download".as_ref(),
            peer.as_ref(),
            path.as_ref(),
            temporary.as_os_str(),
        ],
    )?;
    renamest::rename_exclusive(temporary, target).map_err(|error| error.to_string())
}
