use std::{borrow::Cow, num::NonZeroUsize, ops::Deref, path::Path, sync::Mutex};

use bytes::Bytes;
use openssh_sftp_client_lowlevel::{connect, Queue, ReadEnd, WriteEnd};
use tokio::io::{AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};

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
    let mut session = RenameSession::open(channel).await?;
    let result = session.rename(from, to).await;
    let _ = session.channel_mut().writer.shutdown().await;
    result
}

type Stream = russh::ChannelStream<russh::client::Msg>;

pub(super) struct RenameSession {
    channel: Option<RenameChannel>,
    pub usable: bool,
}

struct RenameChannel {
    writer: WriteHalf<Stream>,
    requests: WriteEnd<Vec<u8>, PendingPackets>,
    replies: ReadEnd<ReadHalf<Stream>, Vec<u8>, PendingPackets>,
}

impl Drop for RenameSession {
    fn drop(&mut self) {
        if let Some(channel) = self.channel.take() {
            // russh closes the channel by spawning a Tokio task when its stream drops.
            tauri::async_runtime::spawn(async move { drop(channel) });
        }
    }
}

impl RenameSession {
    pub(super) async fn open(channel: russh::Channel<russh::client::Msg>) -> Result<Self> {
        let (reader, mut writer) = tokio::io::split(channel.into_stream());
        let requests = connect::<Vec<u8>, _, _>(PendingPackets::default(), ()).map_err(message)?;
        let mut replies = ReadEnd::new(
            reader,
            NonZeroUsize::new(4096).unwrap(),
            requests.deref().clone(),
        );
        requests.queue().flush(&mut writer).await?;
        replies.receive_server_hello().await.map_err(message)?;
        Ok(Self {
            channel: Some(RenameChannel {
                writer,
                requests,
                replies,
            }),
            usable: true,
        })
    }

    fn channel_mut(&mut self) -> &mut RenameChannel {
        self.channel.as_mut().expect("open SSH rename channel")
    }

    pub(super) async fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        self.usable = false;
        let channel = self.channel_mut();
        let id = channel.requests.create_response_id();
        // SFTP v3 rename preserves an existing name. The POSIX extension can overwrite it.
        let reply = channel
            .requests
            .send_rename_request(
                id,
                Cow::Borrowed(Path::new(from)),
                Cow::Borrowed(Path::new(to)),
            )
            .map_err(message)?;
        channel.requests.queue().flush(&mut channel.writer).await?;
        channel
            .replies
            .read_in_one_packet()
            .await
            .map_err(message)?;
        self.usable = true;
        reply
            .wait()
            .await
            .map(|_| ())
            .map_err(|error| super::SftpFailure::from(error).into())
    }
}
