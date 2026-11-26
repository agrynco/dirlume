use std::{collections::HashMap, future::Future, io, net::SocketAddr, sync::Mutex, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{message, Result};

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
enum Timing {
    #[default]
    Default,
    Disabled,
    Custom {
        seconds: u32,
    },
}

impl Timing {
    fn duration(self, default: Option<Duration>) -> Option<Duration> {
        match self {
            Self::Default => default,
            Self::Disabled => None,
            Self::Custom { seconds } => Some(Duration::from_secs(seconds.into())),
        }
    }

    fn valid(self) -> bool {
        !matches!(self, Self::Custom { seconds } if !(1..=3600).contains(&seconds))
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AddressFamily {
    #[default]
    Auto,
    Ipv4,
    Ipv6,
}

impl AddressFamily {
    pub(crate) fn connect_error(self, error: io::Error) -> io::Error {
        let detail = match self {
            Self::Ipv4 => "Could not connect using IPv4.",
            Self::Ipv6 => "Could not connect using IPv6.",
            Self::Auto => return error,
        };
        if error.kind() == io::ErrorKind::Interrupted {
            return error;
        }
        io::Error::new(error.kind(), format!("{detail} {error}"))
    }

    pub(crate) async fn resolve(self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        let addresses: Vec<_> = tokio::net::lookup_host((host, port))
            .await?
            .filter(|address| match self {
                Self::Auto => true,
                Self::Ipv4 => address.is_ipv4(),
                Self::Ipv6 => address.is_ipv6(),
            })
            .collect();
        if addresses.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::AddrNotAvailable,
                match self {
                    Self::Auto => "The server has no available IP address.",
                    Self::Ipv4 => "The server has no available IPv4 address.",
                    Self::Ipv6 => "The server has no available IPv6 address.",
                },
            ));
        }
        Ok(addresses)
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ConnectionPreferences {
    timeout: Timing,
    keepalive: Timing,
    pub(crate) address_family: AddressFamily,
    pub(crate) optimize_buffer: bool,
}

impl ConnectionPreferences {
    pub(crate) fn is_default(&self) -> bool {
        *self == Self::default()
    }

    pub(crate) fn validated(self) -> Result<Self> {
        if !self.timeout.valid() || !self.keepalive.valid() {
            return Err("Enter a timeout and keepalive between 1 and 3600 seconds.".to_owned());
        }
        Ok(self)
    }

    pub(crate) fn response_timeout(self, default: Duration) -> Option<Duration> {
        self.timeout.duration(Some(default))
    }

    pub(crate) fn keepalive_interval(self, default: Option<Duration>) -> Option<Duration> {
        self.keepalive.duration(default)
    }
}

#[derive(Debug)]
pub(crate) enum WaitError {
    Canceled,
    TimedOut,
}

impl From<WaitError> for io::Error {
    fn from(error: WaitError) -> Self {
        match error {
            WaitError::Canceled => io::Error::new(
                io::ErrorKind::Interrupted,
                "The connection operation was canceled.",
            ),
            WaitError::TimedOut => io::Error::new(
                io::ErrorKind::TimedOut,
                "The server did not respond in time.",
            ),
        }
    }
}

pub(crate) async fn wait<F: Future>(
    timeout: Option<Duration>,
    stop: Option<&CancellationToken>,
    operation: F,
) -> std::result::Result<F::Output, WaitError> {
    let limited = async {
        match timeout {
            Some(timeout) => tokio::time::timeout(timeout, operation)
                .await
                .map_err(|_| WaitError::TimedOut),
            None => Ok(operation.await),
        }
    };
    match stop {
        Some(stop) => stop
            .run_until_cancelled(limited)
            .await
            .ok_or(WaitError::Canceled)?,
        None => limited.await,
    }
}

#[derive(Default)]
pub(crate) struct Requests(Mutex<HashMap<Uuid, CancellationToken>>);

impl Requests {
    pub(crate) fn token(&self, id: Option<Uuid>) -> Result<Option<CancellationToken>> {
        id.map(|id| {
            self.0
                .lock()
                .map_err(message)?
                .get(&id)
                .cloned()
                .ok_or_else(|| "The connection request is no longer active.".to_owned())
        })
        .transpose()
    }
}

#[tauri::command]
pub(crate) fn begin_netbox_request(requests: State<'_, Requests>) -> Result<Uuid> {
    let id = Uuid::new_v4();
    requests
        .0
        .lock()
        .map_err(message)?
        .insert(id, CancellationToken::new());
    Ok(id)
}

#[tauri::command]
pub(crate) fn finish_netbox_request(id: Uuid, requests: State<'_, Requests>) -> Result<()> {
    if let Some(token) = requests.0.lock().map_err(message)?.remove(&id) {
        token.cancel();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::pending;

    #[tokio::test]
    async fn distinguishes_timeout_and_cancellation() {
        assert!(matches!(
            wait(Some(Duration::from_millis(5)), None, pending::<()>()).await,
            Err(WaitError::TimedOut)
        ));
        let stop = CancellationToken::new();
        let signal = stop.clone();
        tokio::spawn(async move { signal.cancel() });
        assert!(matches!(
            wait(None, Some(&stop), pending::<()>()).await,
            Err(WaitError::Canceled)
        ));
    }

    #[tokio::test]
    async fn direct_address_families_filter_single_stack_literals() {
        let ipv4 = AddressFamily::Ipv4.resolve("127.0.0.1", 21).await.unwrap();
        let ipv6 = AddressFamily::Ipv6.resolve("::1", 21).await.unwrap();
        assert!(ipv4[0].is_ipv4() && ipv6[0].is_ipv6());
        let incompatible = AddressFamily::Ipv6
            .resolve("127.0.0.1", 21)
            .await
            .unwrap_err();
        assert_eq!(incompatible.kind(), io::ErrorKind::AddrNotAvailable);
        assert!(incompatible.to_string().contains("IPv6"));
    }
}
