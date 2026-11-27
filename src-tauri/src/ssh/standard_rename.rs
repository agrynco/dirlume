use std::{borrow::Cow, num::NonZeroUsize, ops::Deref, path::Path, sync::Mutex};

use bytes::Bytes;
use openssh_sftp_client_lowlevel::{connect, Queue, ReadEnd};
use tokio::io::{AsyncWrite, AsyncWriteExt};

use super::{message, sftp_channel, AuthenticatedRoute, Result};

#[derive(Default)]
struct PendingPackets(Mutex<Vec<Bytes>>);

impl Queue for PendingPackets {
    fn push(&self, packet: Bytes) {
        self.0
            .lock()
            .expect("single SFTP request writer")
            .push(packet);
    }

    fn extend(&self, header: Bytes, body: &[&[Bytes]]) {
        let mut packets = self.0.lock().expect("single SFTP request writer");
        packets.push(header);
        for group in body {
            packets.extend_from_slice(group);
        }
    }
}

impl PendingPackets {
    async fn flush(&self, writer: &mut (impl AsyncWrite + Unpin)) -> Result<()> {
        let packets = std::mem::take(&mut *self.0.lock().map_err(message)?);
        for packet in packets {
            writer.write_all(&packet).await.map_err(message)?;
        }
        writer.flush().await.map_err(message)
    }
}

pub(super) async fn run(client: &AuthenticatedRoute, from: &str, to: &str) -> Result<()> {
    let channel = sftp_channel(client).await?;
    run_on_channel(channel, from, to).await
}

pub(super) async fn run_on_channel(
    channel: russh::Channel<russh::client::Msg>,
    from: &str,
    to: &str,
) -> Result<()> {
    let (reader, mut writer) = tokio::io::split(channel.into_stream());
    let mut requests = connect::<Vec<u8>, _, _>(PendingPackets::default(), ()).map_err(message)?;
    let mut replies = ReadEnd::new(
        reader,
        NonZeroUsize::new(4096).unwrap(),
        requests.deref().clone(),
    );
    requests.queue().flush(&mut writer).await?;
    replies.receive_server_hello().await.map_err(message)?;
    let id = requests.create_response_id();
    // Deliberately use SFTP v3 rename. The advertised POSIX extension overwrites an
    // existing name, including an item created while the upload was being published.
    let reply = requests
        .send_rename_request(
            id,
            Cow::Borrowed(Path::new(from)),
            Cow::Borrowed(Path::new(to)),
        )
        .map_err(message)?;
    requests.queue().flush(&mut writer).await?;
    replies.read_in_one_packet().await.map_err(message)?;
    reply
        .wait()
        .await
        .map_err(|error| String::from(super::SftpFailure::from(error)))?;
    let _ = writer.shutdown().await;
    Ok(())
}
