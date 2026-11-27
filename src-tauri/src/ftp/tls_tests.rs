use std::{
    io::{BufRead, BufReader, Cursor},
    net::{SocketAddr, TcpListener, TcpStream as BlockingStream},
    thread,
};

use rcgen::{CertificateParams, KeyPair};
use rustls::{HandshakeKind, RootCertStore, ServerConfig, ServerConnection, StreamOwned};

use super::*;

fn credentials(name: &str, expired: bool) -> (Arc<ServerConfig>, RootCertStore) {
    let mut params = CertificateParams::new(vec![name.to_owned()]).unwrap();
    if expired {
        params.not_before = rcgen::date_time_ymd(2000, 1, 1);
        params.not_after = rcgen::date_time_ymd(2001, 1, 1);
    }
    let key = KeyPair::generate().unwrap();
    let certificate = params.self_signed(&key).unwrap();
    let mut roots = RootCertStore::empty();
    roots.add(certificate.der().clone()).unwrap();
    let config =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_protocol_versions(&[&rustls::version::TLS12])
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![certificate.der().clone()],
                key.serialize_der().try_into().unwrap(),
            )
            .unwrap();
    (Arc::new(config), roots)
}

fn secure(
    mut socket: BlockingStream,
    config: Arc<ServerConfig>,
) -> io::Result<StreamOwned<ServerConnection, BlockingStream>> {
    let timeout = Some(Duration::from_secs(4));
    socket.set_read_timeout(timeout)?;
    socket.set_write_timeout(timeout)?;
    let mut tls = ServerConnection::new(config).map_err(io::Error::other)?;
    while tls.is_handshaking() {
        tls.complete_io(&mut socket)?;
    }
    Ok(StreamOwned::new(tls, socket))
}

fn setup(
    listener: &TcpListener,
    config: Arc<ServerConfig>,
    encryption: Encryption,
) -> io::Result<StreamOwned<ServerConnection, BlockingStream>> {
    let (mut socket, _) = listener.accept()?;
    socket.set_read_timeout(Some(Duration::from_secs(4)))?;
    if encryption == Encryption::ExplicitTls {
        socket.write_all(b"220 Fixture ready\r\n")?;
        let mut command = String::new();
        BufReader::new(&mut socket).read_line(&mut command)?;
        assert_eq!(
            command, "AUTH TLS\r\n",
            "Only AUTH TLS may precede encryption"
        );
        socket.write_all(b"234 Start TLS\r\n")?;
    }
    let mut control = secure(socket, config)?;
    if encryption == Encryption::ImplicitTls {
        control.write_all(b"220 Fixture ready\r\n")?;
    }
    Ok(control)
}

pub(super) fn connection(port: u16, encryption: Encryption) -> Connection {
    let mut profile = ProfileInput {
        id: None,
        label: "Local FTPS fixture".to_owned(),
        host: "127.0.0.1".to_owned(),
        port,
        username: "fixture".to_owned(),
        password: None,
        code_page: None,
        encryption: Some(encryption),
        ftp_options: None,
        directories: None,
        environment: None,
        connection_options: None,
        proxy: None,
    }
    .profile()
    .unwrap();
    profile.connection_options =
        serde_json::from_str(r#"{"timeout":{"mode":"custom","seconds":4}}"#).unwrap();
    Connection {
        profile,
        password: "fixture-password".to_owned(),
        proxy: None,
    }
}

fn close_data(mut data: StreamOwned<ServerConnection, BlockingStream>) -> io::Result<()> {
    data.conn.send_close_notify();
    data.flush()?;
    data.sock.shutdown(std::net::Shutdown::Both)
}

fn exercise_server(
    listener: TcpListener,
    config: Arc<ServerConfig>,
    encryption: Encryption,
) -> io::Result<Vec<u8>> {
    let mut control = BufReader::new(setup(&listener, Arc::clone(&config), encryption)?);
    let mut passive = None;
    let mut active = None;
    let mut protected = false;
    let mut uploaded = Vec::new();
    let mut transfers = 0;
    let mut line = String::new();
    while control.read_line(&mut line)? != 0 {
        let command = line
            .trim_end()
            .split_once(' ')
            .map_or(line.trim_end(), |(command, _)| command);
        let response = match command {
            "USER" => "331 Send password\r\n",
            "PASS" => "230 Logged in\r\n",
            "OPTS" | "PBSZ" | "TYPE" => "200 OK\r\n",
            "PROT" => {
                assert_eq!(line.trim_end(), "PROT P");
                protected = true;
                "200 Private data\r\n"
            }
            "CWD" => "250 Directory changed\r\n",
            "PASV" => {
                let data = TcpListener::bind(("127.0.0.1", 0))?;
                let port = data.local_addr()?.port();
                passive = Some(data);
                // Dirlume keeps the authenticated control peer for passive data connections.
                write!(
                    control.get_mut(),
                    "227 Passive (127,0,0,2,{},{})\r\n",
                    port / 256,
                    port % 256
                )?;
                line.clear();
                continue;
            }
            "PORT" => {
                let values: Vec<u8> = line
                    .trim_end()
                    .split_once(' ')
                    .unwrap()
                    .1
                    .split(',')
                    .map(|number| number.parse().unwrap())
                    .collect();
                active = Some(SocketAddr::from((
                    [values[0], values[1], values[2], values[3]],
                    u16::from_be_bytes([values[4], values[5]]),
                )));
                "200 Active address accepted\r\n"
            }
            "EPRT" => {
                let fields: Vec<_> = line
                    .trim_end()
                    .split_once(' ')
                    .unwrap()
                    .1
                    .split('|')
                    .collect();
                active = Some(SocketAddr::new(
                    fields[2].parse().unwrap(),
                    fields[3].parse().unwrap(),
                ));
                "200 Active address accepted\r\n"
            }
            "MLSD" | "RETR" | "STOR" => {
                assert!(protected, "Files and listings require PROT P");
                control.get_mut().write_all(b"150 Opening data\r\n")?;
                let socket = if let Some(address) = active.take() {
                    assert!(address.ip().is_loopback());
                    BlockingStream::connect(address)?
                } else {
                    passive.take().expect("PASV requested").accept()?.0
                };
                let mut data = secure(socket, Arc::clone(&config))?;
                assert_eq!(
                    data.conn.handshake_kind(),
                    Some(HandshakeKind::Resumed),
                    "The fixture requires TLS session reuse"
                );
                match command {
                    "MLSD" => {
                        data.write_all(b"type=file;size=5;modify=20261126080000; demo.txt\r\n")?
                    }
                    "RETR" => data.write_all(b"hello")?,
                    "STOR" => {
                        data.read_to_end(&mut uploaded)?;
                    }
                    _ => unreachable!(),
                }
                let _ = close_data(data);
                transfers += 1;
                "226 Transfer finished\r\n"
            }
            "RNFR" => "350 Ready for destination\r\n",
            "RNTO" => "250 Renamed\r\n",
            "QUIT" => {
                control.get_mut().write_all(b"221 Goodbye\r\n")?;
                break;
            }
            _ => panic!("Unexpected FTP command: {line}"),
        };
        control.get_mut().write_all(response.as_bytes())?;
        line.clear();
    }
    assert_eq!(transfers, 3);
    Ok(uploaded)
}

#[test]
fn explicit_and_implicit_ftps_protect_transfers_and_reuse_the_control_session() {
    for (encryption, active_mode, proxy_mode) in [
        (Encryption::ExplicitTls, false, None),
        (Encryption::ExplicitTls, true, None),
        (Encryption::ImplicitTls, false, None),
        (Encryption::ImplicitTls, true, None),
        (Encryption::ExplicitTls, false, Some(proxy::Mode::Socks5)),
        (
            Encryption::ImplicitTls,
            false,
            Some(proxy::Mode::HttpConnect),
        ),
    ] {
        let (server, roots) = credentials("127.0.0.1", false);
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut connection = connection(listener.local_addr().unwrap().port(), encryption);
        connection.profile.ftp_options.active_mode = active_mode;
        let proxy = proxy_mode.map(proxy::fixture::Proxy::start);
        connection.proxy = proxy.as_ref().map(proxy::fixture::Proxy::route);
        let server = thread::spawn(move || exercise_server(listener, server, encryption));
        let mut session = connection
            .open_session(None, Some(client_tls_config(roots).unwrap()))
            .unwrap();
        assert_eq!(session.list(&[]).unwrap().files[0].name(), "demo.txt");
        let mut downloaded = Vec::new();
        let target = ["demo.txt".to_owned()];
        session
            .download(&target, &mut downloaded, |_| Ok(()))
            .unwrap();
        assert_eq!(downloaded, b"hello");
        let stage = session
            .upload_to_stage(&target, &mut Cursor::new(b"encrypted upload"), |_| Ok(()))
            .unwrap();
        session.rename_stage(&stage, &target).unwrap();
        session.limits.call(session.stream.quit()).unwrap();
        assert_eq!(server.join().unwrap().unwrap(), b"encrypted upload");
        if let Some(proxy) = proxy {
            let requests = proxy.requests();
            assert_eq!(requests[0], ("127.0.0.1".into(), connection.profile.port));
            assert_eq!(
                requests.len(),
                4,
                "FTPS control and three passive data connections"
            );
            assert!(requests[1..]
                .iter()
                .all(|(_, port)| *port != connection.profile.port));
        }
    }
}

#[test]
fn ftps_rejects_untrusted_expired_and_wrong_name_certificates() {
    for (name, expired, trust, expected) in [
        ("127.0.0.1", false, false, "unknownissuer"),
        ("127.0.0.1", true, true, "expired"),
        ("wrong.example.test", false, true, "notvalidforname"),
    ] {
        let (config, roots) = credentials(name, expired);
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let connection = connection(
            listener.local_addr().unwrap().port(),
            Encryption::ExplicitTls,
        );
        let server =
            thread::spawn(move || setup(&listener, config, Encryption::ExplicitTls).is_err());
        let roots = if trust { roots } else { RootCertStore::empty() };
        let error = connection
            .open_session(None, Some(client_tls_config(roots).unwrap()))
            .err()
            .expect("TLS verification should fail");
        assert!(
            error.to_lowercase().replace(' ', "").contains(expected),
            "{error}"
        );
        assert!(server.join().unwrap());
    }
}

#[test]
fn refusing_auth_tls_does_not_send_plaintext_credentials() {
    let (_, roots) = credentials("127.0.0.1", false);
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let connection = connection(
        listener.local_addr().unwrap().port(),
        Encryption::ExplicitTls,
    );
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        socket.write_all(b"220 Fixture ready\r\n").unwrap();
        let mut socket = BufReader::new(socket);
        let mut command = String::new();
        socket.read_line(&mut command).unwrap();
        assert_eq!(command, "AUTH TLS\r\n");
        socket
            .get_mut()
            .write_all(b"534 TLS is unavailable\r\n")
            .unwrap();
        command.clear();
        assert_eq!(socket.read_line(&mut command).unwrap(), 0);
    });
    let error = connection
        .open_session(None, Some(client_tls_config(roots).unwrap()))
        .err()
        .unwrap();
    assert!(
        error.contains("Could not negotiate explicit TLS"),
        "{error}"
    );
    server.join().unwrap();
}

#[test]
fn canceling_an_implicit_handshake_closes_the_socket_with_no_deadline() {
    let (_, roots) = credentials("127.0.0.1", false);
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let mut connection = connection(
        listener.local_addr().unwrap().port(),
        Encryption::ImplicitTls,
    );
    connection.profile.connection_options =
        serde_json::from_str(r#"{"timeout":{"mode":"disabled"}}"#).unwrap();
    let stop = CancellationToken::new();
    let stopper = stop.clone();
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        let mut first_byte = [0];
        socket.read_exact(&mut first_byte).unwrap();
        assert_eq!(
            first_byte,
            [22],
            "The implicit connection begins with a TLS record"
        );
        stopper.cancel();
        socket.read_to_end(&mut Vec::new()).unwrap();
    });
    let error = connection
        .open_session(Some(stop), Some(client_tls_config(roots).unwrap()))
        .err()
        .unwrap();
    assert!(error.contains("operation was canceled"), "{error}");
    server.join().unwrap();
}
