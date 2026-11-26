use std::{
    fs,
    io::{BufRead, BufReader, Cursor, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    thread,
    time::Duration,
};

use serde_json::{json, Value};

use super::*;
use crate::remote_recycle::RecyclePreferences;
use crate::remote_transfer::{DownloadSession, UploadSession};

struct Fixture {
    child: Child,
    commands: ChildStdin,
    replies: BufReader<ChildStdout>,
}

impl Fixture {
    fn read(&mut self) -> Value {
        let mut line = String::new();
        self.replies.read_line(&mut line).expect("read SSH fixture");
        serde_json::from_str(&line).expect("read SSH fixture reply")
    }

    fn request(&mut self, request: Value) -> Value {
        writeln!(self.commands, "{request}").expect("write to SSH fixture");
        self.read()
    }

    fn wait_for_idle(&mut self) {
        for _ in 0..30 {
            if self.request(json!({}))["active"] == json!([0, 0, 0]) {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(self.request(json!({}))["active"], json!([0, 0, 0]));
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn route(input: Value, approved: &[HostVerification], pins: &[HostKey]) -> Result<RouteHandshake> {
    let input: ProfileInput = serde_json::from_value(input).expect("decode profile");
    let config = Config::default();
    let proxy = input.proxy_route(&config)?;
    let compatibility = input.compatibility(&config)?;
    let mut hosts = input.test_route(&config)?;
    open_route(
        hosts.iter_mut().map(RouteHost::Draft).collect(),
        |endpoint| stored_key(pins, endpoint),
        approved,
        RouteOptions {
            proxy,
            compatibility,
            ..RouteOptions::default()
        },
    )
}

fn recovery_versions(root: &std::path::Path, path: &str) -> Vec<String> {
    let mut files: Vec<_> = fs::read_dir(root.join("recycle"))
        .unwrap()
        .filter_map(|entry| fs::read_to_string(entry.unwrap().path().join(path)).ok())
        .collect();
    files.sort();
    files
}

fn verify_recycle_bin(session: Session, root: &std::path::Path) {
    fs::create_dir(root.join("recycle")).unwrap();
    let mut session = session.with_recycle(
        RecyclePreferences {
            folder: "/recycle".to_owned(),
            keep_deleted: true,
            keep_overwritten: true,
        },
        false,
    );
    for contents in ["first", "second"] {
        fs::write(root.join("deleted.txt"), contents).unwrap();
        session.recycle(&["deleted.txt".to_owned()]).unwrap();
        assert!(!root.join("deleted.txt").exists());
    }
    assert_eq!(recovery_versions(root, "deleted.txt"), ["first", "second"]);
    fs::create_dir(root.join("nested")).unwrap();
    fs::write(root.join("nested/report.txt"), "folder contents").unwrap();
    session.recycle(&["nested".to_owned()]).unwrap();
    assert!(!root.join("nested").exists());
    assert_eq!(
        recovery_versions(root, "nested/report.txt"),
        ["folder contents"]
    );
    assert!(session.recycle(&["recycle".to_owned()]).is_err());

    for name in [
        "overwrite.txt",
        "restore-on-failure.txt",
        "concurrent-arrival.txt",
        "canceled.txt",
    ] {
        let target = [name.to_owned()];
        fs::write(root.join(name), "previous version").unwrap();
        let stage = session
            .upload_to_stage(&target, &mut Cursor::new(b"new version"), |_| Ok(()))
            .unwrap();
        if name == "canceled.txt" {
            let stop = CancellationToken::new();
            stop.cancel();
            session.set_cancel(Some(stop));
        }
        let result = session.rename_stage(&stage, &target, true);
        session.set_cancel(None);
        session.remove_stage(&stage);
        let contents = fs::read_to_string(root.join(name)).unwrap();
        match name {
            "overwrite.txt" => {
                result.unwrap();
                assert_eq!(contents, "new version");
                assert_eq!(recovery_versions(root, name), ["previous version"]);
            }
            "restore-on-failure.txt" => {
                assert!(result.unwrap_err().contains("previous file was restored"));
                assert_eq!(contents, "previous version");
                assert!(recovery_versions(root, name).is_empty());
            }
            "concurrent-arrival.txt" => {
                assert!(result.unwrap_err().contains("/recycle/"));
                assert_eq!(contents, "concurrent arrival");
                assert_eq!(recovery_versions(root, name), ["previous version"]);
            }
            _ => {
                assert!(result.is_err());
                assert_eq!(contents, "previous version");
                assert!(recovery_versions(root, name).is_empty());
            }
        }
    }
    let mut session = session.with_recycle(
        RecyclePreferences {
            folder: "/missing-bin".to_owned(),
            keep_deleted: true,
            keep_overwritten: true,
        },
        false,
    );
    assert!(session.recycle(&["canceled.txt".to_owned()]).is_err());
    assert_eq!(
        fs::read_to_string(root.join("canceled.txt")).unwrap(),
        "previous version"
    );
}

#[test]
fn reads_a_saved_ssh_profile_without_jump_hosts() {
    let directory = tempfile::tempdir().expect("create profile test directory");
    let path = directory.path().join("ssh-profiles.json");
    let id = Uuid::new_v4();
    fs::write(
        &path,
        json!({
            "profiles": [{
                "id": id, "label": "Existing profile", "host": "example.test",
                "port": 22, "username": "fixture", "auth": { "kind": "password" },
                "credential": Uuid::new_v4(),
            }],
            "trustedHosts": [],
        })
        .to_string(),
    )
    .expect("write existing profile");
    let config = Config::load(&path).expect("read existing profile");
    let saved = config.profile(id).expect("find existing profile");
    assert_eq!(saved.route().count(), 1);
    assert_eq!(saved.destination.settings.endpoint.host, "example.test");
    let summary = serde_json::to_value(profiles::ProfileSummary::from(saved.clone())).unwrap();
    assert_eq!(summary["hasSecret"], true);
    assert_eq!(summary["jumpHosts"], json!([]));
    assert!(summary.get("credential").is_none());
}

#[test]
fn opens_a_two_hop_sftp_route() {
    let Some(python) = std::env::var_os("DIRLUME_SSH_FIXTURE_PYTHON") else {
        return;
    };
    let temp = tempfile::tempdir().expect("create SSH test directory");
    let root = temp.path().join("remote");
    fs::create_dir(&root).expect("create remote fixture directory");
    fs::write(root.join("server.txt"), "download from SSH").expect("seed remote file");
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/ssh-jump-fixture.py");
    let mut child = Command::new(python)
        .arg("-u")
        .arg(script)
        .arg(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("start SSH fixture");
    let commands = child.stdin.take().expect("fixture input");
    let replies = BufReader::new(child.stdout.take().expect("fixture output"));
    let mut fixture = Fixture {
        child,
        commands,
        replies,
    };
    let ready = fixture.read();
    let hosts = ready["hosts"].as_array().expect("three hosts");
    let mut input = hosts[2].clone();
    input["label"] = json!("Production");
    input["jumpHosts"] = json!([hosts[0], hosts[1]]);
    let proxy = proxy::fixture::Proxy::start(proxy::Mode::Socks5);
    input["proxy"] = proxy.draft();
    input["proxy"]["username"] = json!("");
    input["proxy"].as_object_mut().unwrap().remove("password");

    let mut approvals = Vec::new();
    for host in hosts {
        let challenge = route(input.clone(), &approvals, &[])
            .expect("request a host key")
            .err()
            .expect("each server needs independent approval");
        assert_eq!(challenge.endpoint.host, host["host"].as_str().unwrap());
        assert_eq!(
            u64::from(challenge.endpoint.port),
            host["port"].as_u64().unwrap()
        );
        assert!(challenge.fingerprint.starts_with("SHA256:"));
        approvals.push(challenge);
    }
    fixture.wait_for_idle();
    assert!(proxy
        .requests()
        .iter()
        .all(|(_, port)| u64::from(*port) == hosts[0]["port"].as_u64().unwrap()));
    assert!(!proxy.requests().is_empty());
    let (default_route, _) = route(input.clone(), &approvals, &[]).unwrap().ok().unwrap();
    assert!(open_sftp(default_route).is_ok());
    let mut unsupported = input.clone();
    unsupported["compatibility"] = json!({ "sftpCommand": "unsupported-sftp" });
    let (unsupported, _) = route(unsupported, &approvals, &[]).unwrap().ok().unwrap();
    assert_eq!(
        open_sftp(unsupported).err().as_deref(),
        Some("The SSH server rejected the custom SFTP command.")
    );
    input["compatibility"] = json!({ "sftpCommand": "fixture-sftp", "signedTimestamps": true });

    let (client, keys) = route(input.clone(), &approvals, &[])
        .expect("verify the entire route")
        .ok()
        .expect("accept all three explicit approvals");
    fs::write(root.join("rename-from.txt"), "source").unwrap();
    fs::write(root.join("rename-taken.txt"), "unrelated").unwrap();
    assert!(client
        .1
        .wait(standard_rename::run(
            &client,
            "/rename-from.txt",
            "/rename-taken.txt"
        ))
        .is_err());
    assert_eq!(
        fs::read(root.join("rename-taken.txt")).unwrap(),
        b"unrelated"
    );
    client
        .1
        .wait(standard_rename::run(
            &client,
            "/rename-from.txt",
            "/rename-to.txt",
        ))
        .unwrap();
    assert_eq!(fs::read(root.join("rename-to.txt")).unwrap(), b"source");
    fs::remove_file(root.join("rename-taken.txt")).unwrap();
    fs::remove_file(root.join("rename-to.txt")).unwrap();
    let mut session = open_sftp(client).expect("open SFTP over the route");
    let directory = session
        .initial_directory()
        .expect("initial remote directory");
    assert!(directory.is_empty());
    assert_eq!(
        session
            .listing(&directory)
            .expect("list SFTP directory")
            .entries
            .len(),
        1
    );
    let remote_file = vec!["client.txt".to_owned()];
    let mut source = Cursor::new(b"upload through the route");
    let stage = session
        .upload_to_stage(&remote_file, &mut source, |_| Ok(()))
        .expect("stage remote upload");
    session
        .rename_stage(&stage, &remote_file, false)
        .expect("publish remote upload");
    assert_eq!(
        fs::read(root.join("client.txt")).unwrap(),
        b"upload through the route"
    );
    crate::desktop::verify_ssh_moves(&mut session, temp.path(), &root);
    verify_recycle_bin(session, &root);

    let (client, _) = route(input.clone(), &[], &keys)
        .expect("reopen the pinned route")
        .ok()
        .expect("pinned keys should connect without approval");
    let shell = client
        .1
        .wait(async {
            let mut channel = client.channel_open_session().await.map_err(message)?;
            channel.exec(true, "fixture").await.map_err(message)?;
            while let Some(event) = channel.wait().await {
                if let ChannelMsg::Data { data } = event {
                    return Ok(String::from_utf8_lossy(&data).into_owned());
                }
            }
            Err("The test shell did not produce output.".to_owned())
        })
        .expect("execute a command on the destination");
    assert!(shell.contains("jump-shell-ready"));
    let mut session = open_sftp(client).expect("open another SFTP channel on the route");
    let destination = temp.path().join("local.txt");
    let mut output = fs::File::create(&destination).unwrap();
    session
        .download(&["server.txt".to_owned()], &mut output, |_| Ok(()))
        .expect("download over both hops");
    drop(output);
    assert_eq!(fs::read(&destination).unwrap(), b"download from SSH");
    fs::write(root.join("signed-date.txt"), "Legacy date").unwrap();
    let listing = session.listing(&[]).unwrap();
    let dated = listing
        .entries
        .iter()
        .find(|entry| entry.name == "signed-date.txt")
        .unwrap();
    assert_eq!(serde_json::to_value(dated).unwrap()["modified"], -1);
    drop(session);
    fixture.wait_for_idle();

    let mut denied = input.clone();
    denied["jumpHosts"] = json!([hosts[0]]);
    let error = route(denied, &[], &keys)
        .err()
        .expect("first bastion cannot forward directly to destination");
    assert!(
        error.contains("SSH destination (destination.invalid:")
            && error.contains("could not forward")
    );
    let mut swapped = input.clone();
    swapped["jumpHosts"] = json!([hosts[1], hosts[0]]);
    let error = route(swapped, &[], &keys)
        .err()
        .expect("second bastion is unreachable directly");
    assert!(error.contains("SSH jump host 1 (second-bastion.invalid:"));
    let (client, _) = route(input.clone(), &[], &keys)
        .expect("open the listing connection")
        .ok()
        .expect("the saved host keys are current");
    let mut saved = input.clone();
    saved["id"] = json!(Uuid::new_v4());
    for jump in saved["jumpHosts"].as_array_mut().unwrap() {
        jump["id"] = json!(Uuid::new_v4());
    }
    let connection = Connection {
        profile: serde_json::from_value(saved).expect("restore the saved profile"),
        host_keys: keys.clone(),
        listing: Mutex::new(open_sftp(client).expect("start the listing subsystem")),
        sudo: sudo::Access::default(),
    };
    let missing = connection
        .list(&["missing".to_owned()], None)
        .err()
        .expect("missing path");
    assert!(serde_json::to_value(SshListingError::from(missing))
        .unwrap()
        .is_string());
    assert!(connection.list(&[], None).is_ok());
    fixture.request(json!({ "rotate": 1 }));
    let error = route(input, &[], &keys)
        .err()
        .expect("changed host key must block the route");
    assert!(
        error.contains("SSH jump host 2 (second-bastion.invalid:")
            && error.contains("different host key")
    );
    fixture.child.kill().expect("stop the listening fixture");
    fixture
        .child
        .wait()
        .expect("wait for the SSH server to stop");
    let failure = connection
        .list(&[], None)
        .err()
        .expect("the saved route cannot reconnect");
    let failure = serde_json::to_value(SshListingError::from(failure)).unwrap();
    assert_eq!(failure["sshCause"], "connection_lost");
    assert!(failure["message"]
        .as_str()
        .unwrap()
        .contains("SSH jump host 1"));
}
