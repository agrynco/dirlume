use std::{
    io,
    pin::Pin,
    sync::atomic::{AtomicBool, Ordering},
    task::{Context, Poll},
};

use suppaftp::{
    tokio::{AsyncRustlsConnector, AsyncRustlsStream, AsyncTlsConnector, TokioTlsStream},
    FtpError, FtpResult,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpStream,
};

use super::{configure_socket, ConnectionPreferences};

#[derive(Debug)]
pub(super) struct Connector {
    tls: Option<AsyncRustlsConnector>,
    first: AtomicBool,
    raw_iac: bool,
    options: ConnectionPreferences,
}

impl Connector {
    pub(super) fn new(
        tls: Option<AsyncRustlsConnector>,
        raw_iac: bool,
        options: ConnectionPreferences,
    ) -> Self {
        Self {
            tls,
            first: AtomicBool::new(true),
            raw_iac,
            options,
        }
    }
}

#[async_trait::async_trait]
impl AsyncTlsConnector for Connector {
    type Stream = WireStream;

    async fn connect(&self, name: &str, socket: TcpStream) -> FtpResult<Self::Stream> {
        let control = self.first.swap(false, Ordering::Relaxed);
        configure_socket(&socket, self.options, !control).map_err(FtpError::ConnectionError)?;
        let transport = match &self.tls {
            Some(tls) => Transport::Tls(Box::new(tls.connect(name, socket).await?)),
            None => Transport::Plain(socket),
        };
        Ok(WireStream {
            transport,
            raw_iac: control && self.raw_iac,
        })
    }
}

trait WireIo: AsyncRead + AsyncWrite + Unpin {}
impl<T: AsyncRead + AsyncWrite + Unpin> WireIo for T {}

#[derive(Debug)]
enum Transport {
    Plain(TcpStream),
    Tls(Box<AsyncRustlsStream>),
}

#[derive(Debug)]
pub(super) struct WireStream {
    transport: Transport,
    raw_iac: bool,
}

impl WireStream {
    fn io(&mut self) -> Pin<&mut dyn WireIo> {
        match &mut self.transport {
            Transport::Plain(stream) => Pin::new(stream),
            Transport::Tls(stream) => Pin::new(stream.as_mut()),
        }
    }
}

impl AsyncRead for WireStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.io().poll_read(cx, bytes)
    }
}

impl AsyncWrite for WireStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.raw_iac {
            match bytes.iter().position(|&byte| byte == 0xff) {
                Some(0) if bytes.starts_with(&[0xff, 0xff]) => {
                    // SuppaFTP writes an encoded control command with write_all. Count both
                    // escaped bytes only when their single raw byte reached the transport.
                    return self
                        .io()
                        .poll_write(cx, &bytes[..1])
                        .map_ok(|count| count * 2);
                }
                Some(index) if index > 0 => return self.io().poll_write(cx, &bytes[..index]),
                _ => {}
            }
        }
        self.io().poll_write(cx, bytes)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.io().poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.io().poll_shutdown(cx)
    }
}

impl TokioTlsStream for WireStream {
    type InnerStream = Self;

    fn tcp_stream(self) -> FtpResult<TcpStream> {
        match self.transport {
            Transport::Plain(stream) => Ok(stream),
            Transport::Tls(stream) => (*stream).tcp_stream(),
        }
    }

    fn get_ref(&self) -> &TcpStream {
        match &self.transport {
            Transport::Plain(stream) => stream,
            Transport::Tls(stream) => stream.get_ref(),
        }
    }

    fn mut_ref(&mut self) -> &mut Self {
        self
    }
}
