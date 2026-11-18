#[cfg(feature = "desktop")]
mod desktop;
#[cfg(feature = "desktop")]
mod kswitcher;
mod local;
mod protocol;
#[cfg(feature = "server")]
pub mod server;

#[cfg(feature = "desktop")]
pub use desktop::run;
