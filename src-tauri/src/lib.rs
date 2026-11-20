#[cfg(feature = "desktop")]
mod archive_create;
#[cfg(feature = "desktop")]
mod archive_engine;
#[cfg(feature = "desktop")]
mod archives;
#[cfg(feature = "desktop")]
mod completion;
#[cfg(feature = "desktop")]
mod desktop;
#[cfg(feature = "desktop")]
mod diagnostics;
#[cfg(feature = "desktop")]
mod disk_space;
#[cfg(feature = "desktop")]
mod file_attributes;
#[cfg(feature = "desktop")]
mod file_clipboard;
#[cfg(feature = "desktop")]
mod folders;
#[cfg(feature = "desktop")]
mod ftp;
#[cfg(feature = "desktop")]
mod ftp_transfer;
#[cfg(feature = "desktop")]
mod kswitcher;
mod local;
#[cfg(feature = "desktop")]
mod local_transfer;
#[cfg(feature = "desktop")]
mod mcp;
#[cfg(feature = "desktop")]
mod processes;
mod protocol;
#[cfg(feature = "desktop")]
mod remote_transfer;
#[cfg(feature = "server")]
pub mod server;
#[cfg(feature = "desktop")]
mod ssh;
#[cfg(feature = "desktop")]
mod terminal;
#[cfg(feature = "desktop")]
mod timestamps;
#[cfg(feature = "desktop")]
mod updates;
#[cfg(feature = "desktop")]
mod watch;
#[cfg(all(feature = "desktop", windows))]
mod windows_environment;
#[cfg(all(feature = "desktop", windows))]
mod windows_shell;
#[cfg(all(feature = "desktop", windows))]
mod windows_smb;

#[cfg(feature = "desktop")]
pub use desktop::run;

pub const BUILD_VERSION: &str = env!("DIRLUME_BUILD_VERSION");
