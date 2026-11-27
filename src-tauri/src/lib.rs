#[cfg(feature = "desktop")]
mod archive_create;
#[cfg(feature = "desktop")]
mod archive_engine;
#[cfg(feature = "desktop")]
mod archives;
#[cfg(feature = "desktop")]
mod completion;
#[cfg(feature = "desktop")]
mod deletion;
#[cfg(feature = "desktop")]
mod desktop;
#[cfg(feature = "desktop")]
mod desktop_share;
#[cfg(feature = "desktop")]
mod diagnostics;
#[cfg(feature = "desktop")]
mod disk_space;
#[cfg(feature = "desktop")]
pub mod environment;
#[cfg(feature = "desktop")]
mod file_attributes;
#[cfg(feature = "desktop")]
mod file_clipboard;
#[cfg(feature = "desktop")]
mod file_history;
#[cfg(feature = "desktop")]
mod folders;
#[cfg(feature = "desktop")]
mod ftp;
#[cfg(feature = "desktop")]
mod ftp_transfer;
#[cfg(feature = "desktop")]
mod git_view;
#[cfg(feature = "desktop")]
mod image_edit;
#[cfg(feature = "desktop")]
mod kswitcher_lan;
mod local;
#[cfg(feature = "desktop")]
mod local_transfer;
#[cfg(feature = "desktop")]
mod mcp;
#[cfg(feature = "desktop")]
mod netbox_connection;
#[cfg(feature = "desktop")]
mod netbox_directories;
#[cfg(feature = "desktop")]
mod netbox_environment;
#[cfg(feature = "desktop")]
mod netbox_proxy;
#[cfg(all(feature = "desktop", windows))]
mod portable;
#[cfg(feature = "desktop")]
mod processes;
mod protocol;
#[cfg(feature = "desktop")]
mod remote_recycle;
#[cfg(feature = "desktop")]
mod remote_transfer;
#[cfg(feature = "desktop")]
mod screen_color;
#[cfg(any(feature = "server", feature = "desktop"))]
pub mod server;
#[cfg(all(
    feature = "desktop",
    any(windows, target_os = "linux", target_os = "macos")
))]
mod smb;
#[cfg(feature = "desktop")]
mod space_analyzer;
#[cfg(feature = "desktop")]
mod ssh;
#[cfg(feature = "desktop")]
mod terminal;
#[cfg(feature = "desktop")]
mod text_pages;
#[cfg(feature = "desktop")]
mod timestamps;
#[cfg(feature = "desktop")]
mod updates;
#[cfg(feature = "desktop")]
mod user_menu;
#[cfg(feature = "desktop")]
mod watch;
#[cfg(all(feature = "desktop", windows))]
mod windows_elevation;
#[cfg(all(feature = "desktop", windows))]
mod windows_environment;
#[cfg(all(feature = "desktop", windows))]
mod windows_shell;
#[cfg(all(feature = "desktop", windows))]
mod windows_smb;

#[cfg(feature = "desktop")]
pub use desktop::run;

pub const BUILD_VERSION: &str = env!("DIRLUME_BUILD_VERSION");

#[cfg(feature = "desktop")]
pub(crate) type Result<T> = std::result::Result<T, String>;

#[cfg(feature = "desktop")]
pub(crate) fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
