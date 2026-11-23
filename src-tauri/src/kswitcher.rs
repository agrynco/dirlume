use std::{
    io,
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::{desktop::Result, local};

#[cfg(windows)]
mod windows;
#[cfg(any(windows, test))]
mod wire;

#[derive(Serialize)]
pub struct Peer {
    id: String,
    name: String,
}

#[derive(Serialize)]
pub struct Listing {
    entries: Vec<local::Entry>,
    omitted: usize,
    parent: Option<String>,
}

pub fn peers(directory: &str) -> Result<Vec<Peer>> {
    #[cfg(windows)]
    {
        windows::peers(directory)
    }
    #[cfg(not(windows))]
    {
        let _ = directory;
        Err("The KSwitcher client runs on Windows.".into())
    }
}

pub fn list(directory: &str, peer: &str, path: &str, host: Option<&str>) -> Result<Listing> {
    #[cfg(windows)]
    {
        windows::list(directory, peer, path, host)
    }
    #[cfg(not(windows))]
    {
        let _ = (directory, peer, path, host);
        Err("The KSwitcher client runs on Windows.".into())
    }
}

pub fn download(
    directory: &str,
    peer: &str,
    path: &str,
    host: Option<&str>,
    target: PathBuf,
    progress: &mut impl FnMut(&Path, u64, u64) -> io::Result<()>,
) -> Result<()> {
    #[cfg(windows)]
    {
        windows::download(directory, peer, path, host, target, progress)
    }
    #[cfg(not(windows))]
    {
        let _ = (directory, peer, path, host, target, progress);
        Err("The KSwitcher client runs on Windows.".into())
    }
}
