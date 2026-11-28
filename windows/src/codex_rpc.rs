use crate::agent_backend::Backend;
use async_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};
use futures::channel::mpsc;
use futures::{SinkExt, StreamExt, future};
use iced::{Task, stream};
use serde_json::Value;
use std::{path::PathBuf, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::compat::TokioAsyncReadCompatExt;

const MAX_PACKET: usize = 64 * 1024 * 1024;
#[derive(Clone, Debug)]
pub enum Event {
    Packet(Value),
    Disconnected(String),
}

pub fn connect(
    host: Option<String>,
    cwd: Option<PathBuf>,
    backend: Backend,
) -> (mpsc::Sender<Value>, Task<Event>) {
    let (requests, receiver) = mpsc::channel(32);
    let events = stream::channel(32, move |mut output| async move {
        #[cfg(feature = "visual-check")]
        if crate::visual_check::enabled() {
            crate::visual_check::serve(receiver, &mut output).await;
            return;
        }
        let reason = serve(host, cwd, backend, receiver, &mut output)
            .await
            .err()
            .unwrap_or_else(|| format!("{} ended the connection.", backend.label()));
        let _ = output.send(Event::Disconnected(reason)).await;
    });
    (requests, Task::stream(events))
}

async fn serve(
    host: Option<String>,
    cwd: Option<PathBuf>,
    backend: Backend,
    mut requests: mpsc::Receiver<Value>,
    output: &mut mpsc::Sender<Event>,
) -> Result<(), String> {
    use std::process::Stdio;

    let mut command = if let Some(host) = &host {
        let mut ssh = Command::new(crate::ssh::PROGRAM);
        let remote = format!("bash -lc '{}'", backend.server_script());
        ssh.args(crate::ssh::BACKGROUND).args(["--", host, &remote]);
        ssh
    } else {
        let mut codex = Command::new(backend.executable());
        codex.arg("app-server");
        if let Some(cwd) = cwd {
            codex.current_dir(cwd);
        }
        codex
    };
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut process = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Could not start {}: {error}", backend.label()))?;
    let mut reader = BufReader::new(process.stdout.take().expect("stdout pipe"));
    let mut writer = process.stdin.take().expect("stdin pipe");

    let mut line = Vec::new();
    let shared = if host.is_some() {
        tokio::time::timeout(Duration::from_secs(16), async {
            loop {
                read_line(&mut reader, &mut line).await?;
                match std::str::from_utf8(&line).unwrap_or_default().trim_end() {
                    "span-codex-shared" => return Ok::<_, String>(true),
                    "span-codex-stdio" => return Ok(false),
                    _ => {}
                }
            }
        })
        .await
        .map_err(|_| "Remote Codex startup timed out.".to_owned())??
    } else {
        false
    };

    if shared {
        use async_tungstenite::tungstenite::Message as Frame;
        let transport = tokio::io::join(reader, writer).compat();
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_PACKET))
            .max_frame_size(Some(MAX_PACKET));
        let (socket, _) = tokio::time::timeout(
            Duration::from_secs(10),
            async_tungstenite::client_async_with_config("ws://localhost/", transport, Some(config)),
        )
        .await
        .map_err(|_| "The shared Codex connection timed out.".to_owned())?
        .map_err(|error| error.to_string())?;
        let (mut writer, mut reader) = socket.split();
        future::select(
            std::pin::pin!(async {
                while let Some(frame) = reader.next().await {
                    if let Frame::Text(text) = frame.map_err(|error| error.to_string())? {
                        deliver(text.as_bytes(), output).await?;
                    }
                }
                Err("The shared Codex connection closed.".to_owned())
            }),
            std::pin::pin!(async {
                while let Some(value) = requests.next().await {
                    writer
                        .send(Message::Text(value.to_string().into()))
                        .await
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            }),
        )
        .await
        .factor_first()
        .0
    } else {
        future::select(
            std::pin::pin!(async {
                loop {
                    read_line(&mut reader, &mut line).await?;
                    deliver(&line, output).await?;
                }
            }),
            std::pin::pin!(async {
                while let Some(value) = requests.next().await {
                    let mut data = value.to_string();
                    data.push('\n');
                    writer
                        .write_all(data.as_bytes())
                        .await
                        .map_err(|error| error.to_string())?;
                    writer.flush().await.map_err(|error| error.to_string())?;
                }
                Ok(())
            }),
        )
        .await
        .factor_first()
        .0
    }
}

async fn read_line(
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
    line: &mut Vec<u8>,
) -> Result<(), String> {
    line.clear();
    let count = reader
        .take((MAX_PACKET + 1) as u64)
        .read_until(b'\n', line)
        .await
        .map_err(|error| error.to_string())?;
    if count == 0 {
        return Err("Codex stopped responding. Verify that Codex CLI is installed and signed in on this host.".into());
    }
    if count > MAX_PACKET {
        return Err("The Codex response exceeded the size limit.".into());
    }
    Ok(())
}

async fn deliver(bytes: &[u8], output: &mut mpsc::Sender<Event>) -> Result<(), String> {
    let packet: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("Invalid Codex response: {error}"))?;
    output
        .send(Event::Packet(packet))
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    #[ignore = "requires the loopback SSH fixture"]
    fn windows_ssh_codex_exchanges_stdio_and_shared_websocket_packets() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                for (variable, route) in [
                    ("SPAN_TEST_SSH_HOST", "stdio"),
                    ("SPAN_TEST_SSH_SHARED_HOST", "shared"),
                ] {
                    let host = crate::ssh_check::host(variable);
                    let (mut requests, input) = mpsc::channel(4);
                    let (mut output, mut events) = mpsc::channel(4);
                    let rpc = serve(Some(host), None, Backend::Codex, input, &mut output);
                    let exchange = async move {
                        for (id, method, result) in [
                            (
                                1,
                                "initialize",
                                json!({"userAgent":"span-ssh-fixture", "route":route}),
                            ),
                            (2, "thread/list", json!({"data":[{"id":"loopback-thread"}]})),
                        ] {
                            requests
                                .send(json!({"id":id, "method":method, "params":{}}))
                                .await
                                .unwrap();
                            let Some(Event::Packet(packet)) = events.next().await else {
                                panic!("missing remote {route} Codex response to {method}");
                            };
                            assert_eq!(packet, json!({"id":id, "result":result}));
                        }
                    };
                    let exchange = future::try_join(rpc, async {
                        exchange.await;
                        Ok(())
                    });
                    tokio::time::timeout(Duration::from_secs(20), exchange)
                        .await
                        .expect("remote Codex exchange timed out")
                        .unwrap_or_else(|error| panic!("{route} Codex: {error}"));
                }
            });
    }
}
