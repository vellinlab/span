use super::{Output, Result, event, process_directory, ssh_destination};
use async_tungstenite::{
    client_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    env, io,
    path::{Path, PathBuf},
    process::Stdio,
    thread,
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{mpsc, oneshot},
    time::timeout,
};
use tokio_util::compat::TokioAsyncReadCompatExt;

const MAX_PACKET: usize = 64 * 1024 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const REMOTE_ROUTE: &str = r#"bash -lc '
if [ -S "${CODEX_HOME:-$HOME/.codex}/app-server-control/app-server-control.sock" ]; then
    printf "span-codex-shared\n"
    exec codex app-server proxy
fi
printf "span-codex-stdio\n"
exec codex app-server
'"#;

#[derive(Clone, Copy, PartialEq)]
enum Backend {
    Codex,
    Clue,
}

impl Backend {
    fn binary(self) -> &'static str {
        match (self, cfg!(windows)) {
            (Self::Codex, true) => "codex.exe",
            (Self::Codex, false) => "codex",
            (Self::Clue, true) => "clue.exe",
            (Self::Clue, false) => "clue",
        }
    }
}

enum Location {
    Fixture,
    Local(PathBuf),
    Ssh(String),
}

pub struct Agent {
    pub generation: u64,
    outgoing: mpsc::Sender<Value>,
    stop: Option<oneshot::Sender<()>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Agent {
    pub fn start(params: &Value, output: &Output, generation: u64) -> Result<Self> {
        let backend = match params["backend"].as_str() {
            Some("codex") => Backend::Codex,
            Some("clue") => Backend::Clue,
            _ => return Err("未知的 Agent 后端。".into()),
        };
        let location = if params["demo"] == true {
            Location::Fixture
        } else if let Some(target) = ssh_destination(params)? {
            Location::Ssh(target.to_owned())
        } else {
            Location::Local(process_directory(params)?)
        };
        let (outgoing, requests) = mpsc::channel(32);
        let (stop, stopped) = oneshot::channel();
        let output = output.clone();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let worker = thread::Builder::new()
            .name("span-agent".into())
            .spawn(move || {
                runtime.block_on(async {
                    tokio::select! {
                        _ = stopped => {}
                        result = serve(backend, location, requests, &output, generation) => {
                            let reason = result.err().map(|error| error.to_string());
                            let _ = event(&output, "agent-closed", generation, json!(reason));
                        }
                    }
                });
            })?;
        Ok(Self {
            generation,
            outgoing,
            stop: Some(stop),
            worker: Some(worker),
        })
    }

    pub fn send(&self, packet: &Value) -> Result<()> {
        self.outgoing
            .try_send(packet.clone())
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => "Agent 请求队列已满，请稍后重试。",
                mpsc::error::TrySendError::Closed(_) => "Agent 尚未连接。",
            })?;
        Ok(())
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct Process {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

fn spawn(command: &mut Command) -> io::Result<Process> {
    let mut child = hidden(command)
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    Ok(Process {
        input: child.stdin.take().expect("piped stdin"),
        output: BufReader::new(child.stdout.take().expect("piped stdout")),
        child,
    })
}

fn ssh(target: &str) -> Command {
    let mut command = Command::new("ssh");
    command.args([
        "-T",
        "-x",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "--",
        target,
    ]);
    command
}

fn codex_home() -> Option<PathBuf> {
    env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|home| PathBuf::from(home).join(".codex"))
        })
}

fn control_socket() -> Option<PathBuf> {
    let path = codex_home()?.join("app-server-control/app-server-control.sock");
    let metadata = path.metadata().ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        if !metadata.file_type().is_socket() {
            return None;
        }
    }
    // Windows AF_UNIX endpoints expose a filesystem entry through the Win32 APIs.
    if metadata.is_dir() {
        return None;
    }
    Some(path)
}

#[cfg(windows)]
fn windows_codex_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = codex_home() {
        for package in ["app-server-daemon", "standalone"] {
            let root = home.join("packages").join(package).join("current");
            paths.extend([root.join("bin/codex.exe"), root.join("codex.exe")]);
        }
    }
    if let Some(local) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        paths.push(local.join("Programs/OpenAI/Codex/bin/codex.exe"));
        let cache = local.join("OpenAI/Codex/bin");
        paths.push(cache.join("codex.exe"));
        let mut cached = std::fs::read_dir(cache)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
            .map(|entry| {
                (
                    entry.metadata().and_then(|info| info.modified()).ok(),
                    entry.path(),
                )
            })
            .collect::<Vec<_>>();
        cached.sort_unstable_by(|a, b| b.cmp(a));
        paths.extend(cached.into_iter().map(|(_, path)| path.join("codex.exe")));
    }
    paths.retain(|path| path.is_file());
    paths
}

#[cfg(windows)]
async fn appx_codex_paths() -> Vec<PathBuf> {
    let script = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-AppxPackage | Where-Object { $_.Name -in 'OpenAI.Codex','OpenAI.ChatGPT','OpenAI.ChatGPT-Desktop' } |
    Sort-Object Version -Descending | ForEach-Object {
        if ($_.InstallLocation) { $_.InstallLocation }
    }
"#;
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .kill_on_drop(true);
    let Ok(Ok(result)) = timeout(Duration::from_secs(4), hidden(&mut command).output()).await
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&result.stdout)
        .lines()
        .map(str::trim)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .flat_map(|root| {
            [
                "app/resources/codex.exe",
                "app/resources/bin/codex.exe",
                "resources/codex.exe",
            ]
            .map(|relative| root.join(relative))
        })
        .filter(|path| path.is_file())
        .collect()
}

struct LocalCodex {
    cwd: PathBuf,
    candidates: Vec<PathBuf>,
    socket: Option<PathBuf>,
}

impl LocalCodex {
    fn new(cwd: PathBuf) -> Self {
        let candidates = [
            env::var_os("SPAN_CODEX_PATH").filter(|value| !value.is_empty()),
            env::var_os("CODEX_CLI_PATH").filter(|value| !value.is_empty()),
        ]
        .into_iter()
        .flatten()
        .map(PathBuf::from)
        .chain([PathBuf::from(Backend::Codex.binary())])
        .collect();
        #[cfg(windows)]
        let candidates = [candidates, windows_codex_paths()].concat();
        Self {
            cwd,
            candidates,
            socket: control_socket(),
        }
    }

    fn spawn_at(&self, executable: &Path, socket: Option<&Path>) -> io::Result<Process> {
        let mut command = Command::new(executable);
        command.current_dir(&self.cwd).arg("app-server");
        if let Some(socket) = socket {
            command.arg("proxy").arg("--sock").arg(socket);
        }
        spawn(&mut command)
    }
}

async fn read_line(reader: &mut (impl AsyncBufRead + Unpin), line: &mut Vec<u8>) -> io::Result<()> {
    line.clear();
    let count = reader
        .take((MAX_PACKET + 1) as u64)
        .read_until(b'\n', line)
        .await?;
    match count {
        0 => Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Agent 已退出，请检查 CLI 和登录状态。",
        )),
        n if n > MAX_PACKET => Err(io::Error::other("Agent 数据包超出大小限制。")),
        _ => Ok(()),
    }
}

fn deliver(bytes: &[u8], output: &Output, generation: u64) -> io::Result<()> {
    if let Ok(value) = serde_json::from_slice(bytes) {
        event(output, "agent", generation, value)?;
    }
    Ok(())
}

fn spawn_local(
    local: &LocalCodex,
    candidates: &[PathBuf],
    errors: &mut Vec<String>,
) -> Option<Process> {
    candidates
        .iter()
        .find_map(|executable| match local.spawn_at(executable, None) {
            Ok(process) => Some(process),
            Err(error) => {
                errors.push(format!("{}: {error}", executable.display()));
                None
            }
        })
}

async fn remote_route(process: &mut Process) -> Result<bool> {
    timeout(Duration::from_secs(12), async {
        let mut line = Vec::new();
        loop {
            read_line(&mut process.output, &mut line).await?;
            let marker = std::str::from_utf8(&line).unwrap_or_default().trim_end();
            match marker {
                "span-codex-shared" => return Ok(true),
                "span-codex-stdio" => return Ok(false),
                _ => {}
            }
        }
    })
    .await
    .map_err(|_| "等待 SSH Codex 启动超时。")?
}

async fn serve(
    backend: Backend,
    location: Location,
    requests: mpsc::Receiver<Value>,
    output: &Output,
    generation: u64,
) -> Result<()> {
    match (backend, location) {
        (_, Location::Fixture) => {
            let process = spawn(Command::new(env::current_exe()?).arg("--fixture"))?;
            stdio(process, requests, output, generation, "fixture").await?;
        }
        (Backend::Codex, Location::Ssh(target)) => {
            let mut routed = spawn(ssh(&target).arg(REMOTE_ROUTE))?;
            let process = match remote_route(&mut routed).await {
                Ok(false) => routed,
                Ok(true) => match websocket(routed).await {
                    Ok(socket) => return shared_rpc(socket, requests, output, generation).await,
                    Err(_) => spawn(ssh(&target).arg("bash -lc 'exec codex app-server'"))?,
                },
                Err(_) => {
                    // SSH hosts whose login shell cannot run Bash can still use JSONL.
                    drop(routed);
                    spawn(ssh(&target).args(["codex", "app-server"]))?
                }
            };
            stdio(process, requests, output, generation, "stdio").await?;
        }
        (Backend::Codex, Location::Local(cwd)) => {
            let local = LocalCodex::new(cwd);
            #[cfg(windows)]
            let package_paths = if local.socket.is_some() {
                appx_codex_paths().await
            } else {
                Vec::new()
            };

            if let Some(socket) = &local.socket {
                #[cfg(windows)]
                let candidates = local.candidates.iter().chain(&package_paths);
                #[cfg(not(windows))]
                let candidates = local.candidates.iter();
                let connection = timeout(HANDSHAKE_TIMEOUT, async {
                    for executable in candidates {
                        if let Ok(process) = local.spawn_at(executable, Some(socket))
                            && let Ok(connection) = websocket(process).await
                        {
                            return Some(connection);
                        }
                    }
                    None
                })
                .await;
                if let Ok(Some(socket)) = connection {
                    return shared_rpc(socket, requests, output, generation).await;
                }
            }

            let mut errors = Vec::new();
            let started = spawn_local(&local, &local.candidates, &mut errors);
            #[cfg(windows)]
            let started = match started {
                Some(process) => Some(process),
                None => {
                    let paths = if local.socket.is_some() {
                        package_paths
                    } else {
                        appx_codex_paths().await
                    };
                    spawn_local(&local, &paths, &mut errors)
                }
            };
            let process = started.ok_or_else(|| {
                format!(
                    "无法启动 Codex。请检查 CLI 安装，或将 SPAN_CODEX_PATH 指向可执行文件。\n{}",
                    errors.join("\n"),
                )
            })?;
            stdio(process, requests, output, generation, "stdio").await?;
        }
        (Backend::Clue, location) => {
            let mut command = match location {
                Location::Ssh(target) => {
                    let mut command = ssh(&target);
                    command.arg("clue");
                    command
                }
                Location::Local(cwd) => {
                    let mut command = Command::new(backend.binary());
                    command.current_dir(cwd);
                    command
                }
                Location::Fixture => unreachable!(),
            };
            let process = spawn(command.arg("app-server"))
                .map_err(|error| format!("无法启动 Clue App Server：{error}"))?;
            stdio(process, requests, output, generation, "stdio").await?;
        }
    }
    Ok(())
}

async fn stdio(
    mut process: Process,
    mut requests: mpsc::Receiver<Value>,
    output: &Output,
    generation: u64,
    route: &str,
) -> io::Result<()> {
    event(output, "agent-route", generation, json!(route))?;
    let read = async {
        let mut line = Vec::new();
        loop {
            read_line(&mut process.output, &mut line).await?;
            deliver(&line, output, generation)?;
        }
    };
    let write = async {
        while let Some(packet) = requests.recv().await {
            let mut data = serde_json::to_vec(&packet)?;
            data.push(b'\n');
            process.input.write_all(&data).await?;
            process.input.flush().await?;
        }
        Ok(())
    };
    tokio::select! { result = read => result, result = write => result }
}

type ProxyStream = tokio_util::compat::Compat<tokio::io::Join<BufReader<ChildStdout>, ChildStdin>>;
type ProxySocket = (Child, async_tungstenite::WebSocketStream<ProxyStream>);

async fn websocket(process: Process) -> Result<ProxySocket> {
    let stream = tokio::io::join(process.output, process.input).compat();
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_PACKET))
        .max_frame_size(Some(MAX_PACKET));
    let (socket, _) = timeout(
        HANDSHAKE_TIMEOUT,
        client_async_with_config("ws://localhost/", stream, Some(config)),
    )
    .await??;
    Ok((process.child, socket))
}

async fn shared_rpc(
    (_child, socket): ProxySocket,
    mut requests: mpsc::Receiver<Value>,
    output: &Output,
    generation: u64,
) -> Result<()> {
    event(output, "agent-route", generation, json!("shared"))?;
    let (mut writer, mut reader) = socket.split();
    let read = async {
        while let Some(frame) = reader.next().await {
            if let Message::Text(text) = frame? {
                deliver(text.as_bytes(), output, generation)?;
            }
        }
        Err("共享 Codex 连接已关闭。".into())
    };
    let write = async {
        while let Some(packet) = requests.recv().await {
            writer
                .send(Message::Text(packet.to_string().into()))
                .await?;
        }
        Ok(())
    };
    tokio::select! { result = read => result, result = write => result }
}
