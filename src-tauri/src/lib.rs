#[cfg(feature = "desktop")]
mod desktop;
#[cfg(feature = "desktop")]
mod diagnostics;
#[cfg(feature = "desktop")]
mod file_attributes;
#[cfg(feature = "desktop")]
mod file_clipboard;
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
mod processes;
mod protocol;
#[cfg(feature = "server")]
pub mod server;
#[cfg(feature = "desktop")]
mod terminal;
#[cfg(feature = "desktop")]
mod updates;
#[cfg(feature = "desktop")]
mod watch;
#[cfg(all(feature = "desktop", windows))]
mod windows_environment;
#[cfg(all(feature = "desktop", windows))]
mod windows_shell;

#[cfg(feature = "desktop")]
pub use desktop::run;

pub const BUILD_VERSION: &str = env!("DIRLUME_BUILD_VERSION");
