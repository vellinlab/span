use futures_util::io::{AsyncRead, AsyncWrite};
use gio::prelude::*;
use gtk::{gio, glib};
use std::io::{self, Cursor, Read};
use std::pin::Pin;
use std::task::{Context, Poll, ready};

type Transfer = Result<(Vec<u8>, usize), (Vec<u8>, glib::Error)>;
type Pending<T> = Pin<Box<dyn Future<Output = T>>>;

/// Win32 subprocess streams have asynchronous operations but no PollableStream interface.
pub(super) struct Pipe {
    input: gio::InputStream,
    output: gio::OutputStream,
    pending_read: Option<Pending<Transfer>>,
    pending_write: Option<Pending<Transfer>>,
    pending_close: Option<Pending<Result<(), glib::Error>>>,
    buffered: Cursor<Vec<u8>>,
}

impl Pipe {
    pub(super) fn new(input: gio::InputStream, output: gio::OutputStream) -> Self {
        Self {
            input,
            output,
            pending_read: None,
            pending_write: None,
            pending_close: None,
            buffered: Cursor::default(),
        }
    }
}

impl AsyncRead for Pipe {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        output: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        let available = self.buffered.read(output)?;
        if available > 0 || output.is_empty() {
            return Poll::Ready(Ok(available));
        }
        if self.pending_read.is_none() {
            self.pending_read = Some(self.input.read_future(
                vec![0; output.len().min(16 * 1024)],
                glib::Priority::DEFAULT,
            ));
        }
        let result = ready!(self.pending_read.as_mut().unwrap().as_mut().poll(cx));
        self.pending_read.take();
        let (mut data, count) = result.map_err(|(_, error)| io::Error::other(error.to_string()))?;
        data.truncate(count);
        self.buffered = Cursor::new(data);
        Poll::Ready(self.buffered.read(output))
    }
}

impl AsyncWrite for Pipe {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        input: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.pending_write.is_none() {
            if input.is_empty() {
                return Poll::Ready(Ok(0));
            }
            let chunk = &input[..input.len().min(16 * 1024)];
            self.pending_write = Some(
                self.output
                    .write_future(chunk.to_vec(), glib::Priority::DEFAULT),
            );
        }
        let result = ready!(self.pending_write.as_mut().unwrap().as_mut().poll(cx));
        self.pending_write.take();
        Poll::Ready(
            result
                .map(|(_, count)| count)
                .map_err(|(_, error)| io::Error::other(error.to_string())),
        )
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.pending_close.is_none() {
            self.pending_close = Some(self.output.close_future(glib::Priority::DEFAULT));
        }
        let result = ready!(self.pending_close.as_mut().unwrap().as_mut().poll(cx));
        self.pending_close.take();
        Poll::Ready(result.map_err(|error| io::Error::other(error.to_string())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn win32_subprocess_round_trips_stdio() {
        let flags = gio::SubprocessFlags::STDIN_PIPE | gio::SubprocessFlags::STDOUT_PIPE;
        let process = gio::Subprocess::newv(
            &[
                "powershell.exe",
                "-NoProfile",
                "-Command",
                "[Console]::WriteLine([Console]::ReadLine())",
            ]
            .map(std::ffi::OsStr::new),
            flags,
        )
        .expect("native child process");
        let mut pipe = Pipe::new(
            process.stdout_pipe().unwrap(),
            process.stdin_pipe().unwrap(),
        );
        let result = glib::MainContext::new().block_on(async {
            super::super::with_timeout(8, async {
                pipe.write_all(b"span-stdio\n").await?;
                let mut echoed = [0; 10];
                pipe.read_exact(&mut echoed).await?;
                io::Result::Ok(echoed)
            })
            .await
        });
        process.force_exit();
        assert_eq!(
            result.expect("pipe timeout").expect("pipe read and write"),
            *b"span-stdio"
        );
    }
}
