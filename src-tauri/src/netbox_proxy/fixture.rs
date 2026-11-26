use super::*;
use std::sync::Mutex;
use tokio::{net::TcpListener, task::JoinHandle};

const USER: &str = "fixture";
const PASSWORD: &str = "test-only";

pub(crate) struct Proxy {
    pub(crate) address: SocketAddr,
    mode: Mode,
    requests: Arc<Mutex<Vec<(String, u16)>>>,
    listener: JoinHandle<()>,
}

impl Proxy {
    pub(crate) fn start(mode: Mode) -> Self {
        tauri::async_runtime::block_on(Self::start_async(mode))
    }

    async fn start_async(mode: Mode) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let received = Arc::clone(&requests);
        let listener = tokio::spawn(async move {
            while let Ok((peer, _)) = listener.accept().await {
                let received = Arc::clone(&received);
                tokio::spawn(async move {
                    let _ = tunnel(peer, mode, received).await;
                });
            }
        });
        Self {
            address,
            mode,
            requests,
            listener,
        }
    }

    pub(crate) fn draft(&self) -> serde_json::Value {
        serde_json::json!({
            "mode": self.mode, "host": self.address.ip(), "port": self.address.port(),
            "username": USER, "password": PASSWORD
        })
    }

    pub(crate) fn route(&self) -> Route {
        let input: Input = serde_json::from_value(self.draft()).unwrap();
        input
            .test_route(&Stored::default(), "127.0.0.1")
            .unwrap()
            .unwrap()
    }

    pub(crate) fn requests(&self) -> Vec<(String, u16)> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.listener.abort();
    }
}

async fn tunnel(
    mut peer: TcpStream,
    mode: Mode,
    received: Arc<Mutex<Vec<(String, u16)>>>,
) -> io::Result<()> {
    let (host, port) = match mode {
        Mode::Socks5 => match socks_request(&mut peer).await? {
            Some(target) => target,
            None => return Ok(()),
        },
        Mode::HttpConnect => match http_request(&mut peer).await? {
            Some(target) => target,
            None => return Ok(()),
        },
        Mode::None => unreachable!(),
    };
    if !matches!(host.as_str(), "127.0.0.1" | "netbox.test") {
        return match mode {
            Mode::Socks5 => peer.write_all(&[5, 4, 0, 1, 0, 0, 0, 0, 0, 0]).await,
            Mode::HttpConnect => peer.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await,
            Mode::None => unreachable!(),
        };
    }
    received.lock().unwrap().push((host, port));
    let mut destination = TcpStream::connect(("127.0.0.1", port)).await?;
    match mode {
        Mode::Socks5 => peer.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).await?,
        Mode::HttpConnect => peer.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await?,
        Mode::None => unreachable!(),
    }
    tokio::io::copy_bidirectional(&mut peer, &mut destination).await?;
    Ok(())
}

async fn socks_request(peer: &mut TcpStream) -> io::Result<Option<(String, u16)>> {
    let mut negotiation = [0; 3];
    peer.read_exact(&mut negotiation).await?;
    assert_eq!(&negotiation[..2], &[5, 1]);
    assert!(matches!(negotiation[2], 0 | 2));
    peer.write_all(&[5, negotiation[2]]).await?;
    if negotiation[2] == 2 {
        assert_eq!(peer.read_u8().await?, 1);
        let user = read_field(peer).await?;
        let password = read_field(peer).await?;
        if user != USER.as_bytes() || password != PASSWORD.as_bytes() {
            peer.write_all(&[1, 1]).await?;
            return Ok(None);
        }
        peer.write_all(&[1, 0]).await?;
    }
    peer.read_exact(&mut negotiation).await?;
    assert_eq!(negotiation, [5, 1, 0]);
    let host = match peer.read_u8().await? {
        1 => std::net::Ipv4Addr::from(peer.read_u32().await?).to_string(),
        3 => String::from_utf8(read_field(peer).await?).unwrap(),
        kind => panic!("Unexpected address type {kind}"),
    };
    Ok(Some((host, peer.read_u16().await?)))
}

async fn read_field(peer: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut field = vec![0; peer.read_u8().await?.into()];
    peer.read_exact(&mut field).await?;
    Ok(field)
}

async fn http_request(peer: &mut TcpStream) -> io::Result<Option<(String, u16)>> {
    let mut request = Vec::new();
    while !request.ends_with(b"\r\n\r\n") {
        request.push(peer.read_u8().await?);
        assert!(request.len() < 2048);
    }
    let request = String::from_utf8(request).unwrap();
    let credentials = STANDARD.encode(format!("{USER}:{PASSWORD}"));
    if !request
        .lines()
        .any(|line| line == format!("Proxy-Authorization: Basic {credentials}"))
    {
        peer.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
            .await?;
        return Ok(None);
    }
    let authority = request
        .lines()
        .next()
        .unwrap()
        .strip_prefix("CONNECT ")
        .unwrap()
        .strip_suffix(" HTTP/1.1")
        .unwrap();
    let (host, port) = authority.rsplit_once(':').unwrap();
    Ok(Some((host.to_owned(), port.parse().unwrap())))
}

#[tokio::test]
async fn authenticates_without_resolving_the_remote_name_or_losing_the_greeting() {
    for mode in [Mode::Socks5, Mode::HttpConnect] {
        let proxy = Proxy::start_async(mode).await;
        let server = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = server.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = server.accept().await.unwrap();
            socket.write_all(b"hello").await.unwrap();
        });
        let route = proxy.route();
        let mut stream = connect(Some(&route), AddressFamily::Auto, "netbox.test", port)
            .await
            .unwrap();
        let mut greeting = [0; 5];
        stream.read_exact(&mut greeting).await.unwrap();
        assert_eq!(&greeting, b"hello");
        assert_eq!(proxy.requests(), [("netbox.test".into(), port)]);
        let mut draft = proxy.draft();
        draft["password"] = serde_json::json!("wrong");
        let input: Input = serde_json::from_value(draft).unwrap();
        let wrong = input
            .test_route(&Stored::default(), "netbox.test")
            .unwrap()
            .unwrap();
        let error = connect(Some(&wrong), AddressFamily::Auto, "netbox.test", port)
            .await
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(proxy.requests().len(), 1);
    }
}

#[tokio::test]
async fn resolves_locally_when_requested_and_bypasses_only_explicit_loopback() {
    let proxy = Proxy::start_async(Mode::Socks5).await;
    let mut draft = proxy.draft();
    draft["resolveLocally"] = serde_json::json!(true);
    let input: Input = serde_json::from_value(draft.clone()).unwrap();
    let route = input
        .test_route(&Stored::default(), "localhost")
        .unwrap()
        .unwrap();
    let targets = targets(Some(&route), AddressFamily::Auto, "localhost", 21)
        .await
        .unwrap();
    assert!(targets
        .iter()
        .all(|target| matches!(&target.tunnel, Some((_, Host::Ip(_), 21)))));
    draft["skipLoopback"] = serde_json::json!(true);
    let input: Input = serde_json::from_value(draft).unwrap();
    assert!(input
        .test_route(&Stored::default(), "localhost")
        .unwrap()
        .is_none());
    assert!(input
        .test_route(&Stored::default(), "::1")
        .unwrap()
        .is_none());
    assert!(input
        .test_route(&Stored::default(), "netbox.test")
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn cancellation_closes_a_proxy_that_is_stalling_during_negotiation() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let input: Input = serde_json::from_value(serde_json::json!({
        "mode": "socks5", "host": address.ip(), "port": address.port()
    }))
    .unwrap();
    let route = input
        .test_route(&Stored::default(), "netbox.test")
        .unwrap()
        .unwrap();
    let cancellation = tokio_util::sync::CancellationToken::new();
    let stop = cancellation.clone();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut greeting = [0; 3];
        socket.read_exact(&mut greeting).await.unwrap();
        stop.cancel();
        assert_eq!(socket.read(&mut greeting).await.unwrap(), 0);
    });
    let pending = connect(Some(&route), AddressFamily::Auto, "netbox.test", 21);
    assert!(matches!(
        crate::netbox_connection::wait(None, Some(&cancellation), pending).await,
        Err(crate::netbox_connection::WaitError::Canceled)
    ));
    server.await.unwrap();
}
