use std::{
    io::{BufRead, BufReader},
    net::{TcpListener, TcpStream as BlockingStream},
    thread,
};

use super::{tls_tests::connection, *};

fn send(peer: &mut BufReader<BlockingStream>, response: &[u8]) {
    peer.get_mut().write_all(response).unwrap();
}

fn read(peer: &mut BufReader<BlockingStream>) -> Vec<u8> {
    let mut line = Vec::new();
    peer.read_until(b'\n', &mut line).unwrap();
    line
}

fn start(listener: TcpListener, user: &[u8], password: &[u8]) -> BufReader<BlockingStream> {
    let (socket, _) = listener.accept().unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut peer = BufReader::new(socket);
    send(&mut peer, b"220 Fixture\r\n");
    assert_eq!(read(&mut peer), user);
    send(&mut peer, b"331 Password\r\n");
    assert_eq!(read(&mut peer), password);
    send(&mut peer, b"230 Logged in\r\n");
    assert!(read(&mut peer).starts_with(b"OPTS UTF8 "));
    send(&mut peer, b"200 OK\r\n");
    peer
}

fn binary(peer: &mut BufReader<BlockingStream>) {
    assert_eq!(read(peer), b"TYPE I\r\n");
    send(peer, b"200 OK\r\n");
}

#[test]
fn independent_legacy_iac_preferences_and_empty_password() {
    for (raw_commands, raw_pwd) in [(false, false), (true, false), (false, true), (true, true)] {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut connection = connection(listener.local_addr().unwrap().port(), Encryption::Plain);
        connection.profile.code_page = Some(1252);
        connection.profile.ftp_options = FtpOptions {
            empty_password: true,
            raw_iac_commands: raw_commands,
            raw_iac_pwd: raw_pwd,
            post_login_commands: vec!["NOOP".to_owned(), "SITE TEST".to_owned()],
            ..Default::default()
        };
        let fixture = thread::spawn(move || {
            let mut peer = start(listener, b"USER fixture\r\n", b"PASS \r\n");
            for command in [b"NOOP\r\n".as_slice(), b"SITE TEST\r\n"] {
                assert_eq!(read(&mut peer), command);
                send(&mut peer, b"200 OK\r\n");
            }
            binary(&mut peer);
            assert_eq!(read(&mut peer), b"PWD\r\n");
            send(&mut peer, b"257 \"/a\xff\xff\"\r\n");
            assert_eq!(
                read(&mut peer),
                if raw_commands {
                    b"CWD /\xff\xff\r\n".as_slice()
                } else {
                    b"CWD /\xff\xff\xff\xff\r\n".as_slice()
                }
            );
            send(&mut peer, b"250 OK\r\n");
            assert_eq!(read(&mut peer), b"PWD\r\n");
            send(&mut peer, b"257 malformed path\r\n");
        });
        let mut session = connection.open().unwrap();
        assert_eq!(session.pwd().unwrap(), if raw_pwd { "/aÿÿ" } else { "/aÿ" });
        session.limits.call(session.stream.cwd("/ÿÿ")).unwrap();
        assert!(session.pwd().is_err());
        fixture.join().unwrap();
    }
}

#[test]
fn post_login_failure_hides_arguments_and_server_text() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let mut connection = connection(listener.local_addr().unwrap().port(), Encryption::Plain);
    connection.profile.username.clear();
    connection.profile.ftp_options.post_login_commands =
        vec!["SITE fixture-secret".to_owned(), "NOOP".to_owned()];
    let fixture = thread::spawn(move || {
        let mut peer = start(
            listener,
            b"USER anonymous\r\n",
            b"PASS fixture-password\r\n",
        );
        assert_eq!(read(&mut peer), b"SITE fixture-secret\r\n");
        send(&mut peer, b"500 rejected fixture-secret\r\n");
        assert!(read(&mut peer).is_empty());
    });
    let error = connection.open().err().unwrap();
    assert_eq!(
        error,
        "FTP post-login command 1 failed (server status 500)."
    );
    fixture.join().unwrap();
}

fn passive(peer: &mut BufReader<BlockingStream>) -> TcpListener {
    assert_eq!(read(peer), b"PASV\r\n");
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    send(
        peer,
        format!("227 Passive (127,0,0,1,{},{})\r\n", port / 256, port % 256).as_bytes(),
    );
    listener
}

#[test]
fn selects_mlsd_fallback_and_list_policies() {
    for policy in [MlsdPolicy::Auto, MlsdPolicy::On, MlsdPolicy::Off] {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut connection = connection(listener.local_addr().unwrap().port(), Encryption::Plain);
        connection.profile.ftp_options.mlsd = policy;
        let fixture = thread::spawn(move || {
            let mut peer = start(listener, b"USER fixture\r\n", b"PASS fixture-password\r\n");
            binary(&mut peer);
            assert_eq!(read(&mut peer), b"CWD /\r\n");
            send(&mut peer, b"250 OK\r\n");
            if policy != MlsdPolicy::Off {
                let data = passive(&mut peer);
                assert_eq!(read(&mut peer), b"MLSD\r\n");
                send(&mut peer, b"502 MLSD unsupported\r\n");
                drop(data);
            }
            if policy == MlsdPolicy::On {
                assert!(read(&mut peer).is_empty());
            } else {
                let data = passive(&mut peer);
                assert_eq!(read(&mut peer), b"LIST\r\n");
                send(&mut peer, b"150 Opening listing\r\n");
                let (mut data, _) = data.accept().unwrap();
                data.write_all(b"-rw-r--r-- 1 user group 5 Nov 26 08:00 demo.txt\r\n")
                    .unwrap();
                drop(data);
                send(&mut peer, b"226 Listed\r\n");
            }
        });
        let mut session = connection.open().unwrap();
        let listing = session.list(&[]);
        if policy == MlsdPolicy::On {
            assert!(listing.err().unwrap().contains("502"));
        } else {
            assert_eq!(listing.unwrap().files[0].name(), "demo.txt");
        }
        drop(session);
        fixture.join().unwrap();
    }
}

#[test]
fn active_mode_reports_listener_timeout_and_obeys_cancellation() {
    for cancel in [false, true] {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut connection = connection(listener.local_addr().unwrap().port(), Encryption::Plain);
        connection.profile.ftp_options.active_mode = true;
        connection.profile.connection_options = serde_json::from_str(if cancel {
            r#"{"timeout":{"mode":"disabled"}}"#
        } else {
            r#"{"timeout":{"mode":"custom","seconds":1}}"#
        })
        .unwrap();
        let stop = CancellationToken::new();
        let trigger = stop.clone();
        let fixture = thread::spawn(move || {
            let mut peer = start(listener, b"USER fixture\r\n", b"PASS fixture-password\r\n");
            binary(&mut peer);
            assert_eq!(read(&mut peer), b"CWD /\r\n");
            send(&mut peer, b"250 OK\r\n");
            let command = read(&mut peer);
            assert!(command.starts_with(b"PORT ") || command.starts_with(b"EPRT "));
            send(&mut peer, b"200 OK\r\n");
            assert_eq!(read(&mut peer), b"MLSD\r\n");
            send(&mut peer, b"150 Waiting for data\r\n");
            if cancel {
                trigger.cancel();
            }
            match peer.read_until(b'\n', &mut Vec::new()) {
                Ok(0) => {}
                Err(error) if error.kind() == io::ErrorKind::ConnectionReset => {}
                result => panic!("The canceled connection stayed open: {result:?}"),
            }
        });
        let mut session = connection.open_with_cancel(Some(stop)).unwrap();
        let result = session.list(&[]).err().unwrap();
        assert!(
            result.contains(if cancel {
                "canceled"
            } else {
                "active FTP data connection timed out"
            }),
            "{result}"
        );
        drop(session);
        fixture.join().unwrap();
    }
}
