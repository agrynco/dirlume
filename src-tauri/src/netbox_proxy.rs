use std::{
    fmt, io,
    net::{IpAddr, SocketAddr},
    sync::Arc,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{desktop::Result, netbox_connection::AddressFamily};

#[cfg(test)]
pub(crate) mod fixture;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Mode {
    #[default]
    None,
    Socks5,
    HttpConnect,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Settings {
    mode: Mode,
    host: String,
    port: u16,
    username: String,
    skip_loopback: bool,
    resolve_locally: bool,
}

#[derive(Debug, PartialEq, Eq, Clone)]
enum Host {
    Ip(IpAddr),
    Domain(String),
}

impl Host {
    fn parse(host: &str) -> io::Result<Self> {
        if let Ok(ip) = host.parse() {
            return Ok(Self::Ip(ip));
        }
        match url::Host::parse(host).map_err(|_| {
            problem(
                io::ErrorKind::InvalidInput,
                "Enter a valid host name for proxy routing.",
            )
        })? {
            url::Host::Ipv4(ip) => Ok(Self::Ip(ip.into())),
            url::Host::Ipv6(ip) => Ok(Self::Ip(ip.into())),
            url::Host::Domain(domain)
                if !domain.is_empty()
                    && domain.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_')
                    }) =>
            {
                Ok(Self::Domain(domain))
            }
            url::Host::Domain(_) => Err(problem(
                io::ErrorKind::InvalidInput,
                "Enter a valid host name for proxy routing.",
            )),
        }
    }

    fn authority(&self, port: u16) -> String {
        match self {
            Self::Ip(ip) => SocketAddr::new(*ip, port).to_string(),
            Self::Domain(domain) => format!("{domain}:{port}"),
        }
    }

    fn loopback(&self) -> bool {
        match self {
            Self::Ip(ip) => ip.is_loopback(),
            Self::Domain(domain) => domain
                .trim_end_matches('.')
                .eq_ignore_ascii_case("localhost"),
        }
    }
}

impl Settings {
    fn applies(&self, host: &str) -> bool {
        self.mode != Mode::None
            && (!self.skip_loopback || !Host::parse(host).is_ok_and(|host| host.loopback()))
    }

    fn validated(mut self) -> Result<Self> {
        if self.mode == Mode::None {
            return Ok(Self::default());
        }
        self.host = self
            .host
            .trim()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned();
        self.username = self.username.trim().to_owned();
        if self.port == 0
            || Host::parse(&self.host).is_err()
            || self.username.chars().any(char::is_control)
            || (self.mode == Mode::Socks5 && self.username.len() > 255)
            || (self.mode == Mode::HttpConnect && self.username.contains(':'))
        {
            return Err("Enter a valid proxy host, port, and user name.".to_owned());
        }
        Ok(self)
    }

    fn same_login(&self, previous: &Self) -> bool {
        self.mode == previous.mode
            && self.host.eq_ignore_ascii_case(&previous.host)
            && self.port == previous.port
            && self.username == previous.username
    }
}

#[derive(Clone, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Stored {
    #[serde(flatten)]
    settings: Settings,
    credential: Option<Uuid>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    #[serde(flatten)]
    settings: Settings,
    has_password: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Input {
    #[serde(flatten)]
    settings: Settings,
    password: Option<String>,
}

impl Stored {
    pub(crate) fn is_default(&self) -> bool {
        self.settings.mode == Mode::None && self.credential.is_none()
    }

    pub(crate) fn summary(&self) -> Summary {
        Summary {
            settings: self.settings.clone(),
            has_password: self.credential.is_some(),
        }
    }

    pub(crate) fn route(&self, host: &str) -> Result<Option<Route>> {
        let settings = self.settings.clone().validated()?;
        if !settings.applies(host) {
            return Ok(None);
        }
        let password = if !settings.username.is_empty() {
            self.credential.map(read_password).transpose()?
        } else {
            None
        };
        Route::new(settings, password)
    }

    pub(crate) fn clear(&self) {
        if let Some(credential) = self.credential {
            delete_password(credential);
        }
    }
}

impl Input {
    pub(crate) fn test_route(&self, previous: &Stored, host: &str) -> Result<Option<Route>> {
        let settings = self.settings.clone().validated()?;
        if !settings.applies(host) {
            return Ok(None);
        }
        let password = if settings.username.is_empty() {
            None
        } else if let Some(password) = self.password.as_ref() {
            (!password.is_empty()).then(|| Zeroizing::new(password.clone()))
        } else if settings.same_login(&previous.settings) {
            previous.credential.map(read_password).transpose()?
        } else {
            None
        };
        Route::new(settings, password)
    }

    pub(crate) fn save(self, previous: &Stored) -> Result<Save> {
        let settings = self.settings.validated()?;
        let mut created = None;
        let password = self.password.map(Zeroizing::new);
        let credential = if settings.mode == Mode::None || settings.username.is_empty() {
            None
        } else if let Some(password) = password {
            if password.is_empty() {
                None
            } else {
                validate_password(settings.mode, &password)?;
                let id = Uuid::new_v4();
                entry(id)?.set_password(&password).map_err(|_| {
                    "Could not save the proxy password in the system credential store.".to_owned()
                })?;
                created = Some(id);
                Some(id)
            }
        } else if settings.same_login(&previous.settings) {
            previous.credential
        } else {
            None
        };
        let replaced = previous.credential.filter(|key| Some(*key) != credential);
        Ok(Save {
            stored: Stored {
                settings,
                credential,
            },
            created,
            replaced,
        })
    }
}

pub(crate) struct Save {
    pub(crate) stored: Stored,
    created: Option<Uuid>,
    replaced: Option<Uuid>,
}

impl Save {
    pub(crate) fn finish(mut self) {
        self.created = None;
        if let Some(key) = self.replaced {
            delete_password(key);
        }
    }
}

impl Drop for Save {
    fn drop(&mut self) {
        if let Some(key) = self.created {
            delete_password(key);
        }
    }
}

fn entry(key: Uuid) -> Result<keyring::Entry> {
    keyring::Entry::new("Dirlume NetBox proxy", &key.to_string())
        .map_err(|_| "The proxy credential store is unavailable.".to_owned())
}

fn read_password(key: Uuid) -> Result<Zeroizing<String>> {
    entry(key)?.get_password().map(Zeroizing::new).map_err(|_| {
        "Could not read the proxy password from the system credential store.".to_owned()
    })
}

fn delete_password(key: Uuid) {
    if let Ok(entry) = entry(key) {
        let _ = entry.delete_credential();
    }
}

fn validate_password(mode: Mode, password: &str) -> Result<()> {
    if mode == Mode::Socks5 && password.len() > 255 {
        return Err("A SOCKS5 proxy password must fit in 255 bytes.".to_owned());
    }
    Ok(())
}

#[derive(Clone)]
pub(crate) struct Route {
    settings: Arc<Settings>,
    password: Option<Arc<Zeroizing<String>>>,
}

impl Route {
    fn new(settings: Settings, password: Option<Zeroizing<String>>) -> Result<Option<Self>> {
        if settings.mode == Mode::None {
            return Ok(None);
        }
        if let Some(password) = &password {
            validate_password(settings.mode, password)?;
        }
        Ok(Some(Self {
            settings: Arc::new(settings),
            password: password.map(Arc::new),
        }))
    }

    pub(crate) fn applies(&self, host: &str) -> bool {
        self.settings.applies(host)
    }
}

impl fmt::Debug for Route {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output
            .debug_struct("Route")
            .field("mode", &self.settings.mode)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Target {
    pub(crate) socket: SocketAddr,
    tunnel: Option<(Route, Host, u16)>,
}

impl Target {
    pub(crate) fn direct(socket: SocketAddr) -> Self {
        Self {
            socket,
            tunnel: None,
        }
    }

    pub(crate) fn with_port(&self, port: u16) -> Self {
        let mut target = self.clone();
        if let Some((_, _, target_port)) = &mut target.tunnel {
            *target_port = port;
        } else {
            target.socket.set_port(port);
        }
        target
    }

    pub(crate) fn ipv6(&self) -> bool {
        match &self.tunnel {
            Some((_, host, _)) => matches!(host, Host::Ip(IpAddr::V6(_))),
            None => self.socket.is_ipv6(),
        }
    }

    pub(crate) async fn connect(&self) -> io::Result<TcpStream> {
        let socket = TcpStream::connect(self.socket).await.map_err(|error| {
            if self.tunnel.is_some() {
                io::Error::new(
                    error.kind(),
                    format!("Could not reach the configured proxy. {error}"),
                )
            } else {
                error
            }
        })?;
        self.finish(socket).await
    }

    pub(crate) async fn finish(&self, mut socket: TcpStream) -> io::Result<TcpStream> {
        if let Some((route, host, port)) = &self.tunnel {
            match route.settings.mode {
                Mode::Socks5 => socks(&mut socket, route, host, *port).await?,
                Mode::HttpConnect => http(&mut socket, route, host, *port).await?,
                Mode::None => {}
            }
        }
        Ok(socket)
    }
}

pub(crate) async fn targets(
    proxy: Option<&Route>,
    family: AddressFamily,
    host: &str,
    port: u16,
) -> io::Result<Vec<Target>> {
    let Some(proxy) = proxy.filter(|proxy| proxy.applies(host)) else {
        return Ok(family
            .resolve(host, port)
            .await?
            .into_iter()
            .map(Target::direct)
            .collect());
    };
    let host = Host::parse(host)?;
    let addresses = family
        .resolve(&proxy.settings.host, proxy.settings.port)
        .await
        .map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("Could not resolve the proxy address. {error}"),
            )
        })?;
    let destinations = match host {
        Host::Domain(domain) if proxy.settings.resolve_locally => AddressFamily::Auto
            .resolve(&domain, port)
            .await
            .map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!("Could not resolve the destination on this computer. {error}"),
                )
            })?
            .into_iter()
            .map(|address| Host::Ip(address.ip()))
            .collect(),
        host => vec![host],
    };
    Ok(destinations
        .into_iter()
        .flat_map(|host| {
            addresses.iter().map(move |&socket| Target {
                socket,
                tunnel: Some((proxy.clone(), host.clone(), port)),
            })
        })
        .collect())
}

pub(crate) async fn connect(
    proxy: Option<&Route>,
    family: AddressFamily,
    host: &str,
    port: u16,
) -> io::Result<TcpStream> {
    let targets = targets(proxy, family, host, port).await?;
    let mut last = problem(
        io::ErrorKind::AddrNotAvailable,
        "No connection address is available.",
    );
    for target in targets {
        match target.connect().await {
            Ok(socket) => return Ok(socket),
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return Err(error),
            Err(error) => last = error,
        }
    }
    Err(last)
}

fn problem(kind: io::ErrorKind, message: &'static str) -> io::Error {
    io::Error::new(kind, message)
}

async fn socks(stream: &mut TcpStream, route: &Route, host: &Host, port: u16) -> io::Result<()> {
    let authentication = !route.settings.username.is_empty();
    if authentication && route.password.is_none() {
        return Err(problem(
            io::ErrorKind::PermissionDenied,
            "Enter the SOCKS5 proxy password.",
        ));
    }
    let method = if authentication { 2 } else { 0 };
    stream.write_all(&[5, 1, method]).await?;
    let mut choice = [0; 2];
    stream.read_exact(&mut choice).await?;
    if choice != [5, method] {
        return Err(problem(
            io::ErrorKind::PermissionDenied,
            "The SOCKS5 proxy did not accept the requested authentication method.",
        ));
    }
    if authentication {
        let username = route.settings.username.as_bytes();
        let password = route
            .password
            .as_ref()
            .map_or(&[][..], |password| password.as_bytes());
        let mut request = Zeroizing::new(Vec::new());
        request.extend_from_slice(&[1, username.len() as u8]);
        request.extend_from_slice(username);
        request.push(password.len() as u8);
        request.extend_from_slice(password);
        stream.write_all(&request).await?;
        stream.read_exact(&mut choice).await?;
        if choice != [1, 0] {
            return Err(problem(
                io::ErrorKind::PermissionDenied,
                "SOCKS5 proxy authentication failed.",
            ));
        }
    }
    let mut request = vec![5, 1, 0];
    match host {
        Host::Ip(IpAddr::V4(ip)) => {
            request.push(1);
            request.extend_from_slice(&ip.octets());
        }
        Host::Ip(IpAddr::V6(ip)) => {
            request.push(4);
            request.extend_from_slice(&ip.octets());
        }
        Host::Domain(domain) => {
            let length = u8::try_from(domain.len()).map_err(|_| {
                problem(
                    io::ErrorKind::InvalidInput,
                    "The destination name is too long for SOCKS5.",
                )
            })?;
            request.extend_from_slice(&[3, length]);
            request.extend_from_slice(domain.as_bytes());
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&request).await?;
    let mut header = [0; 4];
    stream.read_exact(&mut header).await?;
    if header[0] != 5 || header[2] != 0 {
        return Err(problem(
            io::ErrorKind::InvalidData,
            "The SOCKS5 proxy returned an invalid response.",
        ));
    }
    if header[1] != 0 {
        let detail = match header[1] {
            2 => "The SOCKS5 proxy denied access to the destination.",
            3 => "The SOCKS5 proxy could not reach the destination network.",
            4 => "The SOCKS5 proxy could not resolve or reach the destination host.",
            5 => "The destination refused the connection from the SOCKS5 proxy.",
            _ => "The SOCKS5 proxy could not connect to the destination.",
        };
        return Err(problem(io::ErrorKind::ConnectionRefused, detail));
    }
    let address_length = match header[3] {
        1 => 4,
        4 => 16,
        3 => usize::from(stream.read_u8().await?),
        _ => {
            return Err(problem(
                io::ErrorKind::InvalidData,
                "The SOCKS5 proxy returned an invalid address type.",
            ))
        }
    };
    let mut address = [0; 257];
    stream
        .read_exact(&mut address[..address_length + 2])
        .await?;
    Ok(())
}

async fn http(stream: &mut TcpStream, route: &Route, host: &Host, port: u16) -> io::Result<()> {
    let authority = host.authority(port);
    let mut request = Zeroizing::new(format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n"
    ));
    if !route.settings.username.is_empty() {
        let password = route
            .password
            .as_ref()
            .map_or("", |password| password.as_str());
        let credentials = Zeroizing::new(format!("{}:{password}", route.settings.username));
        let encoded = Zeroizing::new(STANDARD.encode(credentials.as_bytes()));
        request.push_str("Proxy-Authorization: Basic ");
        request.push_str(&encoded);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await?;
    let mut response = Vec::new();
    while !response.ends_with(b"\r\n\r\n") {
        if response.len() == 16 * 1024 {
            return Err(problem(
                io::ErrorKind::InvalidData,
                "The HTTP proxy response is too large.",
            ));
        }
        response.push(stream.read_u8().await?);
    }
    let status = std::str::from_utf8(
        response
            .split(|&byte| byte == b'\n')
            .next()
            .unwrap_or_default(),
    )
    .ok()
    .and_then(|line| {
        let mut fields = line.split_ascii_whitespace();
        fields
            .next()
            .filter(|value| matches!(*value, "HTTP/1.0" | "HTTP/1.1"))?;
        fields.next()?.parse::<u16>().ok()
    })
    .ok_or_else(|| {
        problem(
            io::ErrorKind::InvalidData,
            "The HTTP proxy returned an invalid response.",
        )
    })?;
    match status {
        200..=299 => Ok(()),
        407 => Err(problem(
            io::ErrorKind::PermissionDenied,
            "HTTP proxy authentication failed.",
        )),
        status => Err(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            format!("The HTTP proxy rejected the tunnel (HTTP {status})."),
        )),
    }
}
