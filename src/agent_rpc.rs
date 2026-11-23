use crate::agent_backend::Backend;
use crate::plugin_catalog::Incoming;
use async_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};
use futures_channel::mpsc;
use futures_util::{
    StreamExt, TryStreamExt, future,
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
};
use gtk::gio::{self, prelude::*};
use gtk::glib;
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::ffi::OsStr;
use std::rc::Rc;
use std::time::{Duration, Instant};

const MAX_EVENT_BYTES: usize = 64 * 1024 * 1024;
#[cfg(windows)]
#[path = "windows_pipe.rs"]
mod windows_pipe;

pub struct Rpc {
    process: gio::Subprocess,
    outgoing: mpsc::UnboundedSender<String>,
    next_id: Cell<u64>,
    plugin_lists: RefCell<Vec<u64>>,
    receive: Box<dyn Fn(Result<Incoming, String>)>,
}

impl Rpc {
    pub fn start(
        socket: Option<&crate::ssh::Channel>,
        backend: Backend,
        receive: impl Fn(Result<Incoming, String>) + 'static,
    ) -> Result<Rc<Self>, String> {
        let script = backend.server_script();
        let remote_command = format!("bash -lc '{script}'");
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
                argv.extend(["/bin/bash", "-c", script.as_str()].map(OsStr::new));
            }
        }
        #[cfg(windows)]
        let route_startup = socket.is_some();
        #[cfg(unix)]
        let route_startup = true;
        #[cfg(windows)]
        let executable = glib::find_program_in_path(backend.executable());
        #[cfg(windows)]
        if let Some(host) = socket {
            argv.push(OsStr::new(crate::ssh::PROGRAM));
            argv.extend(crate::ssh::BACKGROUND.iter().map(OsStr::new));
            argv.extend(["--", host, &remote_command].map(OsStr::new));
        } else {
            let path = executable.as_ref().ok_or_else(|| {
                format!(
                    "请安装 {}，并将 {} 加入 PATH。",
                    backend.label(),
                    backend.executable()
                )
            })?;
            argv.extend([path.as_os_str(), OsStr::new("app-server")]);
        }

        let launcher = gio::SubprocessLauncher::new(
            gio::SubprocessFlags::STDIN_PIPE
                | gio::SubprocessFlags::STDOUT_PIPE
                | gio::SubprocessFlags::STDERR_SILENCE,
        );
        for variable in crate::process_environment::private_variables() {
            launcher.unsetenv(variable);
        }
        let process = launcher
            .spawn(&argv)
            .map_err(|e| format!("无法启动 {}：{e}", backend.label()))?;
        let stdin = process.stdin_pipe().expect("Codex stdin pipe");
        let stdout = process.stdout_pipe().expect("Codex stdout pipe");
        #[cfg(unix)]
        let stream = gio::SimpleIOStream::new(&stdout, &stdin)
            .into_async_read_write()
            .map_err(|_| "无法打开 Codex 的输入输出流。")?;
        #[cfg(windows)]
        let stream = windows_pipe::Pipe::new(stdout, stdin);
        let (outgoing, requests) = mpsc::unbounded();
        let rpc = Rc::new(Self {
            process,
            outgoing,
            next_id: Cell::new(0),
            plugin_lists: RefCell::new(Vec::new()),
            receive: Box::new(receive),
        });
        let weak = Rc::downgrade(&rpc);
        glib::MainContext::default().spawn_local(async move {
            let result = exchange(stream, requests, route_startup, async |packet: Message| {
                let lists = weak
                    .upgrade()
                    .map(|rpc| rpc.plugin_lists.borrow().clone())
                    .unwrap_or_default();
                let bytes = packet.into_data();
                let decoded = if bytes.len() >= 256 * 1024 {
                    gio::spawn_blocking(move || crate::plugin_catalog::decode(&bytes, &lists))
                        .await
                        .ok()
                } else {
                    Some(crate::plugin_catalog::decode(&bytes, &lists))
                };
                if let (Some(rpc), Some(Ok(message))) = (weak.upgrade(), decoded) {
                    let id = match &message {
                        Incoming::Plugins { id, .. } => Some(*id),
                        Incoming::Json(v)
                            if v.get("result").is_some() || v.get("error").is_some() =>
                        {
                            v["id"].as_u64()
                        }
                        _ => None,
                    };
                    if let Some(id) = id {
                        rpc.plugin_lists
                            .borrow_mut()
                            .retain(|pending| *pending != id);
                    }
                    (rpc.receive)(Ok(message));
                }
            })
            .await;
            if let Some(rpc) = weak.upgrade() {
                let message = result.err().unwrap_or_else(|| {
                    format!(
                        "{} 已退出。请检查此主机上的程序、PATH 和登录状态。",
                        backend.label()
                    )
                });
                (rpc.receive)(Err(message));
            }
        });
        Ok(rpc)
    }

    pub fn request(&self, method: &str, params: Value) -> u64 {
        let id = self.next_id.get() + 1;
        self.next_id.set(id);
        if method == "plugin/list" {
            self.plugin_lists.borrow_mut().push(id);
        }
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
    stream: impl AsyncRead + AsyncWrite + Unpin,
    mut requests: mpsc::UnboundedReceiver<String>,
    route_startup: bool,
    mut receive: impl AsyncFnMut(Message),
) -> Result<(), String> {
    let mut stream = BufReader::new(stream);
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
                if message.is_text() {
                    receive(message).await;
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
                if (&mut reader)
                    .take((MAX_EVENT_BYTES + 1) as u64)
                    .read_until(b'\n', &mut line)
                    .await?
                    == 0
                {
                    return Err::<(), _>(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
                }
                if line.len() > MAX_EVENT_BYTES {
                    return Err(std::io::Error::other("Codex 事件超过大小上限。"));
                }
                receive(Message::Binary(std::mem::take(&mut line).into())).await;
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
