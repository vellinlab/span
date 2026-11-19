use async_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};
use futures_channel::mpsc;
use futures_util::{
    SinkExt, StreamExt, TryStreamExt, future,
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
};
use gtk::gio::{self, prelude::*};
use gtk::glib;
use serde_json::{Value, json};
use std::cell::Cell;
use std::ffi::OsStr;
use std::rc::Rc;
use std::time::{Duration, Instant};

const MAX_EVENT_BYTES: usize = 16 * 1024 * 1024;
const SERVER_COMMAND: &str = r#"
if [ -S "${CODEX_HOME:-$HOME/.codex}/app-server-control/app-server-control.sock" ]; then
    printf "span-codex-shared\n"
    exec codex app-server proxy
fi
printf "span-codex-stdio\n"
exec codex app-server
"#;

pub struct Rpc {
    process: gio::Subprocess,
    outgoing: mpsc::UnboundedSender<String>,
    next_id: Cell<u64>,
    receive: Box<dyn Fn(Result<Value, String>)>,
}

impl Rpc {
    pub fn start(
        socket: Option<&crate::ssh::Channel>,
        receive: impl Fn(Result<Value, String>) + 'static,
    ) -> Result<Rc<Self>, String> {
        let remote_command = format!("bash -lc '{SERVER_COMMAND}'");
        let mut argv: Vec<&OsStr> = Vec::new();
        #[cfg(unix)]
        {
            if let Some(socket) = socket {
                argv.extend(
                    [
                        crate::ssh::PROGRAM,
                        "-F",
                        "/dev/null",
                        "-T",
                        "-x",
                        "-o",
                        "BatchMode=yes",
                        "-o",
                        "ProxyCommand=/bin/false",
                        "-S",
                    ]
                    .map(OsStr::new),
                );
                argv.push(socket.as_os_str());
                argv.extend(["--", "localhost", &remote_command].map(OsStr::new));
            } else {
                argv.extend(["/bin/bash", "-c", SERVER_COMMAND].map(OsStr::new));
            }
        }
        #[cfg(windows)]
        let route_startup = socket.is_some();
        #[cfg(unix)]
        let route_startup = true;
        #[cfg(windows)]
        let codex = glib::find_program_in_path("codex.exe");
        #[cfg(windows)]
        if let Some(host) = socket {
            argv.push(OsStr::new(crate::ssh::PROGRAM));
            argv.extend(crate::ssh::BACKGROUND.iter().map(OsStr::new));
            argv.extend(["--", host, &remote_command].map(OsStr::new));
        } else {
            let path = codex
                .as_ref()
                .ok_or("请安装 Windows Codex CLI，并将 codex.exe 加入 PATH。")?;
            argv.extend([path.as_os_str(), OsStr::new("app-server")]);
        }

        let launcher = gio::SubprocessLauncher::new(
            gio::SubprocessFlags::STDIN_PIPE
                | gio::SubprocessFlags::STDOUT_PIPE
                | gio::SubprocessFlags::STDERR_SILENCE,
        );
        let process = launcher
            .spawn(&argv)
            .map_err(|e| format!("无法启动 Codex：{e}"))?;
        let stdin = process.stdin_pipe().expect("Codex stdin pipe");
        let stdout = process.stdout_pipe().expect("Codex stdout pipe");
        let stream = gio::SimpleIOStream::new(&stdout, &stdin);
        let (outgoing, requests) = mpsc::unbounded();
        let rpc = Rc::new(Self {
            process,
            outgoing,
            next_id: Cell::new(0),
            receive: Box::new(receive),
        });
        let weak = Rc::downgrade(&rpc);
        glib::MainContext::default().spawn_local(async move {
            let result = exchange(stream, requests, route_startup, |bytes| {
                if bytes.len() <= MAX_EVENT_BYTES {
                    if let (Some(rpc), Ok(message)) =
                        (weak.upgrade(), serde_json::from_slice(bytes))
                    {
                        (rpc.receive)(Ok(message));
                    }
                }
            })
            .await;
            if let Some(rpc) = weak.upgrade() {
                let message = result.err().unwrap_or_else(|| {
                    "Codex 已退出。请检查该主机上的 Codex CLI 和登录状态。".into()
                });
                (rpc.receive)(Err(message));
            }
        });
        Ok(rpc)
    }

    pub fn request(&self, method: &str, params: Value) -> u64 {
        let id = self.next_id.get() + 1;
        self.next_id.set(id);
        self.enqueue(json!({"id": id, "method": method, "params": params}));
        id
    }

    pub fn notify(&self, method: &str) {
        self.enqueue(json!({"method": method}));
    }

    pub fn reply(&self, id: Value, result: Value) {
        self.enqueue(json!({"id": id, "result": result}));
    }

    pub fn unsupported(&self, id: Value) {
        self.enqueue(json!({"id": id, "error": {"code": -32601, "message": "This client does not implement this request"}}));
    }

    fn enqueue(&self, value: Value) {
        let _ = self.outgoing.unbounded_send(value.to_string());
    }
}

async fn exchange(
    stream: gio::SimpleIOStream,
    mut requests: mpsc::UnboundedReceiver<String>,
    route_startup: bool,
    receive: impl Fn(&[u8]),
) -> Result<(), String> {
    let mut stream = BufReader::new(
        stream
            .into_async_read_write()
            .map_err(|_| "无法打开 Codex 的输入输出流。")?,
    );
    let mut line = Vec::new();
    let shared = if route_startup {
        let route = async {
            loop {
                line.clear();
                let length = stream
                    .read_until(b'\n', &mut line)
                    .await
                    .map_err(|error| format!("无法读取 Codex 启动状态：{error}"))?;
                match line.as_slice() {
                    b"span-codex-shared\n" => return Ok::<_, String>(true),
                    b"span-codex-stdio\n" => return Ok(false),
                    _ if length == 0 => return Err("无法启动 Codex。请检查该主机的连接。".into()),
                    _ => {}
                }
            }
        };
        with_timeout(15, route)
            .await
            .ok_or("等待 Codex 启动超时。")??
    } else {
        false
    };

    if shared {
        // The CLI proxy forwards raw bytes. The daemon speaks WebSocket over its socket.
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_EVENT_BYTES))
            .max_frame_size(Some(MAX_EVENT_BYTES));
        let (websocket, _) = with_timeout(
            10,
            async_tungstenite::client_async_with_config("ws://localhost/", stream, Some(config)),
        )
        .await
        .ok_or("连接共享 Codex 后台超时。")?
        .map_err(|error| format!("无法连接共享 Codex 后台：{error}"))?;
        let (mut writer, mut reader) = websocket.split();
        let read = async {
            let mut slice = Instant::now();
            while let Some(message) = reader.try_next().await? {
                if let Message::Text(message) = message {
                    receive(message.as_bytes());
                    yield_for_ui(&mut slice).await;
                }
            }
            Err::<(), _>(async_tungstenite::tungstenite::Error::ConnectionClosed)
        };
        let write = async {
            while let Some(request) = requests.next().await {
                writer.send(Message::Text(request.into())).await?;
            }
            Ok(())
        };
        future::try_join(read, write).await.map_err(
            |error: async_tungstenite::tungstenite::Error| format!("共享 Codex 连接中断：{error}"),
        )?;
    } else {
        let (reader, mut writer) = stream.split();
        let mut reader = BufReader::new(reader);
        let read = async {
            let mut slice = Instant::now();
            loop {
                line.clear();
                if reader.read_until(b'\n', &mut line).await? == 0 {
                    return Err::<(), _>(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
                }
                if line.len() > MAX_EVENT_BYTES {
                    return Err(std::io::Error::other("Codex 事件超过大小上限。"));
                }
                receive(&line);
                yield_for_ui(&mut slice).await;
            }
        };
        let write = async {
            while let Some(mut request) = requests.next().await {
                request.push('\n');
                writer.write_all(request.as_bytes()).await?;
            }
            Ok(())
        };
        future::try_join(read, write)
            .await
            .map_err(|error| format!("Codex 连接中断：{error}"))?;
    }
    Ok(())
}

async fn yield_for_ui(slice: &mut Instant) {
    if slice.elapsed() >= Duration::from_millis(6) {
        glib::timeout_future(Duration::from_millis(1)).await;
        *slice = Instant::now();
    }
}

async fn with_timeout<T>(seconds: u32, work: impl Future<Output = T>) -> Option<T> {
    match future::select(std::pin::pin!(work), glib::timeout_future_seconds(seconds)).await {
        future::Either::Left((result, _)) => Some(result),
        future::Either::Right(_) => None,
    }
}

impl Drop for Rpc {
    fn drop(&mut self) {
        self.process.force_exit();
    }
}
