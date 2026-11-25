use super::{Output, Result, event, process_directory, ssh_destination};
use async_tungstenite::{
    client_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    cell::{OnceCell, RefCell},
    env, io,
    path::{Path, PathBuf},
    process::Stdio,
    thread,
    time::Duration,
};
mod pi;
pub(super) use pi::fixture as pi_fixture;
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
const REMOTE_ACP: &str = r#"
name="$1"
if command -v "$name" >/dev/null 2>&1; then
    cli="$name"
elif [ -x "$HOME/.$name/bin/$name" ]; then
    cli="$HOME/.$name/bin/$name"
elif [ -x "$HOME/.local/bin/$name" ]; then
    cli="$HOME/.local/bin/$name"
else
    printf "span-acp-missing\n"
    exit 127
fi
printf "span-acp-cwd %s\n" "$PWD"
if [ -n "$2" ]; then
    IFS= read -r password || exit 1
    if [ "$name" = opencode ]; then
        export OPENCODE_SERVER_PASSWORD="$password" OPENCODE_SERVER_USERNAME=span
    else
        export KILO_SERVER_PASSWORD="$password" KILO_SERVER_USERNAME=span
    fi
    exec "$cli" acp --hostname 127.0.0.1 --port "$2"
fi
if [ -n "$3" ]; then
    exec "$cli" "$3"
fi
exec "$cli"
"#;

struct AcpHttpConnection {
    local_port: u16,
    remote_port: u16,
    password: String,
}

impl AcpHttpConnection {
    fn from_request(params: &Value) -> Option<Self> {
        let local_port = u16::try_from(params["localPort"].as_u64()?).ok()?;
        let remote_port = u16::try_from(params["remotePort"].as_u64()?).ok()?;
        let password = params["password"].as_str()?;
        if local_port == 0
            || remote_port == 0
            || password.len() != 64
            || !password.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return None;
        }
        Some(Self {
            local_port,
            remote_port,
            password: password.to_owned(),
        })
    }
}

#[derive(Clone, Copy, PartialEq)]
struct AcpBackend {
    name: &'static str,
    label: &'static str,
    windows_executable: &'static str,
    path_override: &'static str,
    subcommand: Option<&'static str>,
}

const OPENCODE: AcpBackend = AcpBackend {
    name: "opencode",
    label: "OpenCode",
    windows_executable: "opencode.exe",
    path_override: "SPAN_OPENCODE_PATH",
    subcommand: Some("acp"),
};
const KILO: AcpBackend = AcpBackend {
    name: "kilo",
    label: "Kilo",
    windows_executable: "kilo.exe",
    path_override: "SPAN_KILO_PATH",
    subcommand: Some("acp"),
};
const CLAUDE: AcpBackend = AcpBackend {
    name: "claude-agent-acp",
    label: "Claude Code",
    windows_executable: "claude-agent-acp.exe",
    path_override: "SPAN_CLAUDE_ACP_PATH",
    subcommand: None,
};

#[derive(Clone, Copy, PartialEq)]
enum Backend {
    Codex,
    Clue,
    Pi,
    Acp(AcpBackend),
}

impl Backend {
    fn binary(self) -> &'static str {
        match (self, cfg!(windows)) {
            (Self::Codex, true) => "codex.exe",
            (Self::Codex, false) => "codex",
            (Self::Clue, true) => "clue.exe",
            (Self::Clue, false) => "clue",
            (Self::Pi, true) => "pi.exe",
            (Self::Pi, false) => "pi",
            (Self::Acp(acp), true) => acp.windows_executable,
            (Self::Acp(acp), false) => acp.name,
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
            Some("pi") => Backend::Pi,
            Some("opencode") => Backend::Acp(OPENCODE),
            Some("kilo") => Backend::Acp(KILO),
            Some("claude") => Backend::Acp(CLAUDE),
            _ => return Err("未知的 Agent 后端。".into()),
        };
        let location = if params["demo"] == true {
            Location::Fixture
        } else if let Some(target) = ssh_destination(params)? {
            Location::Ssh(target.to_owned())
        } else {
            Location::Local(process_directory(params)?)
        };
        let acp_http = matches!(backend, Backend::Acp(OPENCODE | KILO))
            .then(|| AcpHttpConnection::from_request(&params["acpHttp"]))
            .flatten();
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
                        result = serve(backend, location, acp_http, requests, &output, generation) => {
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
    ssh_with_forward(target, None)
}

fn ssh_with_forward(target: &str, connection: Option<&AcpHttpConnection>) -> Command {
    let mut command = Command::new("ssh");
    command.args(["-T", "-x", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]);
    if let Some(connection) = connection {
        command
            .args(["-o", "ExitOnForwardFailure=yes", "-L"])
            .arg(format!(
                "127.0.0.1:{}:127.0.0.1:{}",
                connection.local_port, connection.remote_port
            ));
    }
    command.args(["--", target]);
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        if !path.metadata().ok()?.file_type().is_socket() {
            return None;
        }
    }
    #[cfg(windows)]
    {
        // Inspect the AF_UNIX reparse entry without following it as a file.
        if path.symlink_metadata().ok()?.is_dir() {
            return None;
        }
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

async fn connect_local_proxy(
    local: &LocalCodex,
    socket: &Path,
    candidates: &[PathBuf],
    budget: Duration,
) -> std::result::Result<Option<ProxySocket>, tokio::time::error::Elapsed> {
    timeout(budget, async {
        for executable in candidates {
            if let Ok(process) = local.spawn_at(executable, Some(socket))
                && let Ok(connection) = websocket(process).await
            {
                return Some(connection);
            }
        }
        None
    })
    .await
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
    acp_http: Option<AcpHttpConnection>,
    requests: mpsc::Receiver<Value>,
    output: &Output,
    generation: u64,
) -> Result<()> {
    match (backend, location) {
        (Backend::Pi, location) => {
            let (process, catalog) = match location {
                Location::Ssh(target) => (
                    spawn(ssh(&target).args(["pi", "--mode", "rpc"]))?,
                    pi::Catalog::Ssh(target),
                ),
                Location::Local(cwd) => {
                    (pi::start_local(backend.binary(), &cwd)?, pi::Catalog::Local)
                }
                Location::Fixture => (
                    spawn(Command::new(env::current_exe()?).arg("--pi-fixture"))?,
                    pi::Catalog::Fixture,
                ),
            };
            let route = if matches!(catalog, pi::Catalog::Fixture) {
                "fixture"
            } else {
                "stdio"
            };
            stdio_process(process, requests, output, generation, route, Some(catalog)).await?;
        }
        (Backend::Acp(acp), Location::Ssh(target)) => {
            let port = acp_http
                .as_ref()
                .map(|connection| connection.remote_port.to_string())
                .unwrap_or_default();
            let mut process = spawn(ssh_with_forward(&target, acp_http.as_ref()).arg(format!(
                "sh -c '{REMOTE_ACP}' span-acp {} '{port}' '{}'",
                acp.name,
                acp.subcommand.unwrap_or_default()
            )))?;
            if let Some(connection) = &acp_http {
                process
                    .input
                    .write_all(connection.password.as_bytes())
                    .await?;
                process.input.write_all(b"\n").await?;
                process.input.flush().await?;
            }
            let directory = timeout(Duration::from_secs(12), async {
                let mut line = Vec::new();
                loop {
                    read_line(&mut process.output, &mut line).await?;
                    let line = std::str::from_utf8(&line)
                        .unwrap_or_default()
                        .trim_end_matches(['\r', '\n']);
                    if line == "span-acp-missing" {
                        return Err(io::Error::new(
                            io::ErrorKind::NotFound,
                            format!(
                                "远端找不到 {}。请安装 CLI 或将它加入 SSH 会话的 PATH。",
                                acp.label
                            ),
                        ));
                    }
                    if let Some(directory) = line.strip_prefix("span-acp-cwd ")
                        && directory.starts_with('/')
                    {
                        return Ok(directory.to_owned());
                    }
                }
            })
            .await
            .map_err(|_| format!("等待 SSH {} 工作目录超时。", acp.label))??;
            event(
                output,
                "agent",
                generation,
                json!({"method":"span/backendWorkspace", "params":{"cwd":directory}}),
            )?;
            stdio(process, requests, output, generation, "stdio").await?;
        }
        (Backend::Acp(acp), Location::Local(cwd)) => {
            let program = env::var_os(acp.path_override).filter(|value| !value.is_empty());
            let is_default = program.is_none();
            let launch = |program| {
                let mut command = Command::new(program);
                command.args(acp.subcommand).current_dir(&cwd);
                if let Some(connection) = &acp_http {
                    let (user, password) = if acp == OPENCODE {
                        ("OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD")
                    } else {
                        ("KILO_SERVER_USERNAME", "KILO_SERVER_PASSWORD")
                    };
                    command
                        .args(["--hostname", "127.0.0.1", "--port"])
                        .arg(connection.local_port.to_string())
                        .env(user, "span")
                        .env(password, &connection.password);
                }
                spawn(&mut command)
            };
            let process = launch(program.unwrap_or_else(|| backend.binary().into()))
                .or_else(|error| {
                    if cfg!(windows)
                        && is_default
                        && acp == CLAUDE
                        && error.kind() == io::ErrorKind::NotFound
                    {
                        return launch("claude-agent-acp.cmd".into());
                    }
                    Err(error)
                })
                .map_err(|error| {
                    format!(
                        "无法启动 {}。请检查 CLI 安装，或将 {} 指向可执行文件。\n{error}",
                        acp.label, acp.path_override
                    )
                })?;
            stdio(process, requests, output, generation, "stdio").await?;
        }
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
            let mut package_paths = None;

            if let Some(socket) = &local.socket {
                #[cfg(windows)]
                let started_at = tokio::time::Instant::now();
                let connection =
                    connect_local_proxy(&local, socket, &local.candidates, HANDSHAKE_TIMEOUT).await;
                if let Ok(Some(proxy)) = connection {
                    return shared_rpc(proxy, requests, output, generation).await;
                }
                #[cfg(windows)]
                if matches!(connection, Ok(None)) {
                    let remaining = HANDSHAKE_TIMEOUT.saturating_sub(started_at.elapsed());
                    let paths = appx_codex_paths().await;
                    if !remaining.is_zero()
                        && let Ok(Some(proxy)) =
                            connect_local_proxy(&local, socket, &paths, remaining).await
                    {
                        return shared_rpc(proxy, requests, output, generation).await;
                    }
                    package_paths = Some(paths);
                }
            }

            let mut errors = Vec::new();
            let started = spawn_local(&local, &local.candidates, &mut errors);
            #[cfg(windows)]
            let started = match started {
                Some(process) => Some(process),
                None => {
                    let paths = match package_paths {
                        Some(paths) => paths,
                        None => appx_codex_paths().await,
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
    process: Process,
    requests: mpsc::Receiver<Value>,
    output: &Output,
    generation: u64,
    route: &str,
) -> io::Result<()> {
    stdio_process(process, requests, output, generation, route, None).await
}

enum PiTeamRequest {
    Read {
        id: Value,
        session: String,
        member: Option<String>,
    },
    Release(String),
}

async fn stdio_process(
    mut process: Process,
    mut requests: mpsc::Receiver<Value>,
    output: &Output,
    generation: u64,
    route: &str,
    pi_catalog: Option<pi::Catalog>,
) -> io::Result<()> {
    event(output, "agent-route", generation, json!(route))?;
    let pi_session_file = OnceCell::new();
    let pi_session = RefCell::new(None::<pi::SessionIdentity>);
    let (team_requests, mut team_queue) = mpsc::channel::<PiTeamRequest>(2);
    let teams = async {
        let Some(catalog) = &pi_catalog else {
            return std::future::pending().await;
        };
        let mut remote: Option<pi::RemoteTeamReader> = None;
        loop {
            let request = if remote.is_some() {
                match timeout(Duration::from_secs(12), team_queue.recv()).await {
                    Ok(request) => request,
                    Err(_) => {
                        remote = None;
                        continue;
                    }
                }
            } else {
                team_queue.recv().await
            };
            let (id, session, member) = match request {
                Some(PiTeamRequest::Read {
                    id,
                    session,
                    member,
                }) => (id, session, member),
                Some(PiTeamRequest::Release(session)) => {
                    if remote
                        .as_ref()
                        .is_some_and(|reader| reader.session == session)
                    {
                        remote = None;
                    }
                    continue;
                }
                None => return Ok(()),
            };
            let identity = pi_session
                .borrow()
                .as_ref()
                .filter(|active| active.id == session)
                .cloned();
            let result = match identity {
                Some(identity) => {
                    let result = if let Some(member) = member {
                        pi::team_transcript(catalog, &mut remote, &identity, &member).await
                    } else {
                        pi::team_snapshot(catalog, &mut remote, &identity).await
                    };
                    if pi_session.borrow().as_ref() == Some(&identity) {
                        result
                    } else {
                        Err("Pi 会话已切换。".into())
                    }
                }
                None => Err("Pi 会话已切换。".into()),
            };
            event(output, "agent", generation, pi_response(&id, result))?;
        }
    };
    let read = async {
        let mut line = Vec::new();
        loop {
            read_line(&mut process.output, &mut line).await?;
            if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                if pi_catalog.is_some()
                    && value["type"] == "response"
                    && value["command"] == "get_state"
                {
                    let file = value["data"]["sessionFile"]
                        .as_str()
                        .filter(|file| !file.is_empty());
                    if let Some(file) = file {
                        let _ = pi_session_file.set(file.to_owned());
                    }
                    pi_session.replace(value["data"]["sessionId"].as_str().map(|id| {
                        pi::SessionIdentity {
                            id: id.to_owned(),
                            file: file.map(str::to_owned),
                        }
                    }));
                } else if pi_catalog.is_some()
                    && value["type"] == "response"
                    && matches!(
                        value["command"].as_str(),
                        Some("switch_session" | "new_session")
                    )
                    && value["success"] == true
                    && value["data"]["cancelled"] != true
                {
                    pi_session.replace(None);
                }
                event(output, "agent", generation, value)?;
            }
        }
    };
    let write = async {
        while let Some(packet) = requests.recv().await {
            let kind = packet["type"].as_str().unwrap_or_default();
            if let Some(catalog) = &pi_catalog
                && kind == "span_list_sessions"
            {
                let result = pi::catalog(catalog, pi_session_file.get(), &packet).await;
                event(
                    output,
                    "agent",
                    generation,
                    pi_response(&packet["id"], result),
                )?;
                continue;
            }
            if pi_catalog.is_some() && kind == "span_pi_release_team_view" {
                if let Some(session) = packet["sessionId"]
                    .as_str()
                    .filter(|session| session.len() <= 128)
                {
                    let _ = team_requests.try_send(PiTeamRequest::Release(session.to_owned()));
                }
                continue;
            }
            if pi_catalog.is_some() && matches!(kind, "span_pi_teams" | "span_pi_team_transcript") {
                let id = &packet["id"];
                let member = if kind == "span_pi_team_transcript" {
                    let Some(member) = packet["memberId"]
                        .as_str()
                        .filter(|member| pi::valid_team_member(member))
                    else {
                        event(
                            output,
                            "agent",
                            generation,
                            pi_response(id, Err("当前会话没有这个 Pi 子代理。".into())),
                        )?;
                        continue;
                    };
                    Some(member.to_owned())
                } else {
                    None
                };
                let result = match packet["sessionId"].as_str() {
                    Some(session)
                        if !session.is_empty()
                            && session.len() <= 128
                            && session
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                            && pi_session
                                .borrow()
                                .as_ref()
                                .is_some_and(|active| active.id == session) =>
                    {
                        if team_requests
                            .try_send(PiTeamRequest::Read {
                                id: id.clone(),
                                session: session.to_owned(),
                                member,
                            })
                            .is_ok()
                        {
                            continue;
                        }
                        Err("正在读取 Pi 团队。".into())
                    }
                    _ => Err("Pi 会话已切换。".into()),
                };
                event(output, "agent", generation, pi_response(id, result))?;
                continue;
            }
            let mut data = serde_json::to_vec(&packet)?;
            data.push(b'\n');
            process.input.write_all(&data).await?;
            process.input.flush().await?;
        }
        Ok(())
    };
    tokio::select! { result = read => result, result = write => result, result = teams => result }
}

fn pi_response(id: &Value, result: Result<Value>) -> Value {
    match result {
        Ok(data) => json!({"id":id,"type":"response","success":true,"data":data}),
        Err(error) => json!({"id":id,"type":"response","success":false,"error":error.to_string()}),
    }
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
