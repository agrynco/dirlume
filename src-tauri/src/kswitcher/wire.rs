use std::{
    io::{self, Cursor, Read, Write},
    net::TcpStream,
    time::{Duration, Instant},
};

use ciborium::Value;
use ring::{
    aead::{self, Aad, LessSafeKey, Nonce, UnboundKey},
    hmac,
    rand::{SecureRandom, SystemRandom},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;

use crate::{desktop::Result, message};

const FRAME_LIMIT: usize = 256 * 1024;
const HANDSHAKE_LIMIT: usize = 1024;
const FRAME_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) fn valid_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) struct Channel {
    stream: TcpStream,
    request: Option<Cipher>,
    response: Option<Cipher>,
}

struct Cipher {
    key: LessSafeKey,
    sequence: u64,
}

impl Cipher {
    fn new(key: &[u8]) -> Result<Self> {
        let key = UnboundKey::new(&aead::AES_256_GCM, key)
            .map_err(|_| "Invalid KSwitcher session key.")?;
        Ok(Self {
            key: LessSafeKey::new(key),
            sequence: 0,
        })
    }

    fn next_nonce(&mut self) -> Result<Nonce> {
        let mut bytes = [0; 12];
        bytes[4..].copy_from_slice(&self.sequence.to_be_bytes());
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or("KSwitcher session exhausted.")?;
        Ok(Nonce::assume_unique_for_key(bytes))
    }
}

fn session_ciphers(
    client: &str,
    server: &str,
    challenge: &str,
    nonce: &str,
    secret: &str,
) -> Result<[Cipher; 2]> {
    // KSwitcher derives both keys from the ASCII hexadecimal pairing key.
    let context = format!("KSwitcher files v1|{client}|{server}|{challenge}|{nonce}");
    let secret = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    Ok([
        Cipher::new(hmac::sign(&secret, format!("{context}|request").as_bytes()).as_ref())?,
        Cipher::new(hmac::sign(&secret, format!("{context}|response").as_bytes()).as_ref())?,
    ])
}

impl Channel {
    pub(super) fn authenticate(
        stream: TcpStream,
        client: &str,
        server: &str,
        secret: &str,
    ) -> Result<Self> {
        if !valid_hex(client, 32)
            || !valid_hex(server, 32)
            || client == server
            || !valid_hex(secret, 64)
        {
            return Err("Invalid KSwitcher pairing.".into());
        }
        stream
            .set_write_timeout(Some(FRAME_TIMEOUT))
            .map_err(message)?;
        stream.set_nodelay(true).map_err(message)?;
        let mut random = [0; 16];
        SystemRandom::new()
            .fill(&mut random)
            .map_err(|_| "Cannot generate a KSwitcher handshake.")?;
        let nonce = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let mut channel = Self {
            stream,
            request: None,
            response: None,
        };
        channel
            .write(&json!({ "version": 1, "client": client, "server": server, "nonce": nonce }))?;
        #[derive(Deserialize)]
        struct Challenge {
            challenge: String,
        }
        let Challenge { challenge } = channel.read()?.deserialized().map_err(message)?;
        if !valid_hex(&challenge, 32) {
            return Err("Invalid KSwitcher challenge.".into());
        }
        let [request, response] = session_ciphers(client, server, &challenge, &nonce, secret)?;
        channel.request = Some(request);
        channel.response = Some(response);
        channel.call(&json!({ "action": "authenticate" }))?;
        Ok(channel)
    }

    fn write(&mut self, request: &impl Serialize) -> Result<()> {
        let mut bytes = Vec::new();
        ciborium::into_writer(request, &mut bytes).map_err(message)?;
        if let Some(cipher) = &mut self.request {
            let nonce = cipher.next_nonce()?;
            cipher
                .key
                .seal_in_place_append_tag(nonce, Aad::empty(), &mut bytes)
                .map_err(|_| "Cannot encrypt the KSwitcher request.")?;
        }
        let limit = if self.request.is_some() {
            FRAME_LIMIT
        } else {
            HANDSHAKE_LIMIT
        };
        if bytes.is_empty() || bytes.len() > limit {
            return Err("Invalid KSwitcher frame size.".into());
        }
        self.stream
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .map_err(message)?;
        self.stream.write_all(&bytes).map_err(message)
    }

    fn read(&mut self) -> Result<Value> {
        let deadline = Instant::now() + FRAME_TIMEOUT;
        let mut length = [0; 4];
        self.receive(&mut length, deadline)?;
        let length = u32::from_be_bytes(length) as usize;
        let valid = if self.response.is_some() {
            (17..=FRAME_LIMIT).contains(&length)
        } else {
            (1..=HANDSHAKE_LIMIT).contains(&length)
        };
        if !valid {
            return Err("Invalid KSwitcher frame size.".into());
        }
        let mut bytes = vec![0; length];
        self.receive(&mut bytes, deadline)?;
        let payload = if let Some(cipher) = &mut self.response {
            let nonce = cipher.next_nonce()?;
            cipher
                .key
                .open_in_place(nonce, Aad::empty(), &mut bytes)
                .map_err(|_| "KSwitcher could not authenticate the remote computer.")?
        } else {
            &mut bytes[..]
        };
        let mut reader = Cursor::new(payload);
        let reply =
            ciborium::de::from_reader_with_recursion_limit(&mut reader, 16).map_err(message)?;
        if reader.position() != reader.get_ref().len() as u64 {
            return Err("Invalid KSwitcher reply.".into());
        }
        Ok(reply)
    }

    fn receive(&mut self, mut bytes: &mut [u8], deadline: Instant) -> Result<()> {
        while !bytes.is_empty() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("The KSwitcher response timed out.".into());
            }
            self.stream
                .set_read_timeout(Some(remaining))
                .map_err(message)?;
            match self.stream.read(bytes) {
                Ok(0) => return Err("The KSwitcher connection closed.".into()),
                Ok(count) => bytes = &mut bytes[count..],
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(message(error)),
            }
        }
        Ok(())
    }

    pub(super) fn call(&mut self, request: &impl Serialize) -> Result<Value> {
        self.write(request)?;
        let reply = self.read()?;
        #[derive(Deserialize)]
        struct Status {
            error: u32,
        }
        let status: Status = reply.deserialized().map_err(message)?;
        if status.error != 0 {
            return Err(message(std::io::Error::from_raw_os_error(
                status.error as i32,
            )));
        }
        Ok(reply)
    }

    pub(super) fn request<T: DeserializeOwned>(&mut self, request: &impl Serialize) -> Result<T> {
        self.call(request)?.deserialized().map_err(message)
    }
}

#[cfg(test)]
mod tests {
    use std::{net::TcpListener, thread};

    use super::*;

    const CLIENT: &str = "01010101010101010101010101010101";
    const SERVER: &str = "02020202020202020202020202020202";
    const CHALLENGE: &str = "03030303030303030303030303030303";
    const SECRET: &str = "abababababababababababababababababababababababababababababababab";

    #[test]
    fn matches_k_switcher_v1_authentication_frames() {
        let [request, response] = session_ciphers(
            CLIENT,
            SERVER,
            CHALLENGE,
            "04040404040404040404040404040404",
            SECRET,
        )
        .unwrap();
        // Generated independently with Node's HMAC-SHA256 and AES-256-GCM.
        for (mut cipher, packet, expected) in [
            (
                request,
                json!({ "action": "authenticate" }),
                "b4378bf1a76137e03f7bd1a354b12e69ab7ca25304ff9e036fe795930c07d881164593a164",
            ),
            (
                response,
                json!({ "error": 0 }),
                "7ec78478071da4dcb8756e1153d903e7520549f0483a115e",
            ),
        ] {
            let mut bytes = Vec::new();
            ciborium::into_writer(&packet, &mut bytes).unwrap();
            let nonce = cipher.next_nonce().unwrap();
            cipher
                .key
                .seal_in_place_append_tag(nonce, Aad::empty(), &mut bytes)
                .unwrap();
            assert_eq!(
                bytes
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>(),
                expected
            );
        }
    }

    #[test]
    fn exchanges_encrypted_requests_and_rejects_a_replayed_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut channel = Channel {
                stream,
                request: None,
                response: None,
            };
            let hello: serde_json::Value = channel.read().unwrap().deserialized().unwrap();
            assert_eq!(hello["version"], 1);
            assert_eq!(hello["client"], CLIENT);
            assert_eq!(hello["server"], SERVER);
            channel.write(&json!({ "challenge": CHALLENGE })).unwrap();
            let [request, response] = session_ciphers(
                CLIENT,
                SERVER,
                CHALLENGE,
                hello["nonce"].as_str().unwrap(),
                SECRET,
            )
            .unwrap();
            channel.request = Some(response);
            channel.response = Some(request);
            let auth: serde_json::Value = channel.read().unwrap().deserialized().unwrap();
            assert_eq!(auth["action"], "authenticate");
            channel.write(&json!({ "error": 0 })).unwrap();
            let drives: serde_json::Value = channel.read().unwrap().deserialized().unwrap();
            assert_eq!(drives["action"], "drives");
            channel
                .write(&json!({ "error": 0, "drives": [{ "path": "C:\\" }] }))
                .unwrap();
            let _ = channel.read().unwrap();
            channel.request.as_mut().unwrap().sequence = 1;
            channel
                .write(&json!({ "error": 0, "drives": [{ "path": "C:\\" }] }))
                .unwrap();
        });
        let mut channel =
            Channel::authenticate(TcpStream::connect(address).unwrap(), CLIENT, SERVER, SECRET)
                .unwrap();
        let response: serde_json::Value = channel.request(&json!({ "action": "drives" })).unwrap();
        assert_eq!(response["drives"][0]["path"], "C:\\");
        assert!(channel
            .call(&json!({ "action": "drives" }))
            .unwrap_err()
            .contains("authenticate"));
        server.join().unwrap();
    }
}
