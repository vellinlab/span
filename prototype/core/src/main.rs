mod agent;
mod fixture;

use agent::Agent;

use base64::{Engine, engine::general_purpose::STANDARD};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{self, BufRead, BufWriter, Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
type Output = Arc<Mutex<BufWriter<io::Stdout>>>;

fn send(output: &Output, packet: Value) -> io::Result<()> {
    let mut output = output.lock().expect("stdout lock");
    serde_json::to_writer(&mut *output, &packet)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn event(output: &Output, kind: &str, generation: u64, payload: Value) -> io::Result<()> {
    send(
        output,
        json!({"event":kind,"generation":generation,"data":payload}),
    )
}

struct Terminal {
    generation: u64,
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    input: Box<dyn Write + Send>,
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn ssh_destination(params: &Value) -> Result<Option<&str>> {
    let Some(target) = params
        .get("ssh")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return Ok(None);
    };
    if target.starts_with('-')
        || target.len() > 512
        || !target
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"@.:_-%[]".contains(&b))
    {
        return Err("请使用 SSH 配置别名或 user@host。".into());
    }
    Ok(Some(target))
}

fn dimensions(params: &Value) -> PtySize {
    PtySize {
        cols: params["cols"].as_u64().unwrap_or(80).clamp(2, 500) as u16,
        rows: params["rows"].as_u64().unwrap_or(24).clamp(2, 250) as u16,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn terminal_start(params: &Value, output: &Output, generation: u64) -> Result<Terminal> {
    let pair = native_pty_system().openpty(dimensions(params))?;
    let mut command;
    if let Some(target) = ssh_destination(params)? {
        command = CommandBuilder::new("ssh");
        command.args(["-tt", "--", target]);
    } else {
        let shell = if cfg!(windows) {
            env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into())
        } else {
            env::var_os("SHELL").unwrap_or_else(|| "/bin/bash".into())
        };
        command = CommandBuilder::new(shell);
        command.cwd(process_directory(params)?);
    }
    command.env("TERM", "xterm-256color");
    let mut reader = pair.master.try_clone_reader()?;
    let input = pair.master.take_writer()?;
    let child = pair.slave.spawn_command(command)?;
    drop(pair.slave);
    let output = output.clone();
    thread::spawn(move || {
        let mut buffer = [0; 16384];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let data = STANDARD.encode(&buffer[..count]);
            if event(&output, "terminal", generation, json!(data)).is_err() {
                return;
            }
        }
        let _ = event(&output, "terminal-closed", generation, Value::Null);
    });
    Ok(Terminal {
        generation,
        child,
        master: pair.master,
        input,
    })
}

fn workspace(params: &Value) -> Result<PathBuf> {
    let cwd = params["cwd"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("尚未选择工作区。")?;
    let cwd = fs::canonicalize(cwd)?;
    if !cwd.is_dir() {
        return Err("工作区必须是目录。".into());
    }
    Ok(cwd)
}

fn process_directory(params: &Value) -> Result<PathBuf> {
    let _ = workspace(params)?;
    // Windows canonical paths carry a verbatim prefix that cmd.exe treats as UNC.
    Ok(PathBuf::from(
        params["cwd"].as_str().expect("validated workspace"),
    ))
}

fn entry_path(params: &Value) -> Result<PathBuf> {
    let root = workspace(params)?;
    let path = root
        .join(params["path"].as_str().unwrap_or_default())
        .canonicalize()?;
    if !path.starts_with(root) {
        return Err("路径超出工作区。".into());
    }
    Ok(path)
}

fn files(params: &Value) -> Result<Value> {
    let path = entry_path(params)?;
    let mut entries = fs::read_dir(path)?
        .filter_map(std::result::Result::ok)
        .take(2000)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let kind = entry.file_type().ok()?;
            (kind.is_dir() || kind.is_file()).then_some((!kind.is_dir(), name))
        })
        .collect::<Vec<_>>();
    entries.sort_unstable();
    Ok(json!(
        entries
            .into_iter()
            .map(|(file, name)| json!({"name":name,"directory":!file}))
            .collect::<Vec<_>>()
    ))
}

fn preview(params: &Value) -> Result<Value> {
    const MAX: u64 = 256 * 1024;
    let path = entry_path(params)?;
    if !fs::metadata(&path)?.is_file() {
        return Err("请选择一个普通文件。".into());
    }
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX {
        return Err("预览支持不超过 256 KiB 的文件。".into());
    }
    if let Some(image) = match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    } {
        return Ok(json!({"kind":"image","mime":image,"data":STANDARD.encode(bytes)}));
    }
    let text = String::from_utf8(bytes).map_err(|_| "暂不支持这种文件格式。")?;
    if text.contains('\0') {
        return Err("暂不支持这种文件格式。".into());
    }
    let kind = if matches!(ext.as_str(), "md" | "markdown") {
        "markdown"
    } else {
        "text"
    };
    Ok(json!({"kind":kind,"data":text}))
}

#[derive(Default)]
struct Service {
    agent: Option<Agent>,
    terminal: Option<Terminal>,
}

impl Service {
    fn request(&mut self, output: &Output, message: &Value) -> Result<Value> {
        let params = &message["params"];
        let generation = params["generation"].as_u64().unwrap_or(0);
        match message["method"].as_str().unwrap_or_default() {
            "agent.start" => {
                self.agent.take();
                self.agent = Some(Agent::start(params, output, generation)?);
            }
            "agent.close" => {
                if self
                    .agent
                    .as_ref()
                    .is_some_and(|agent| agent.generation == generation)
                {
                    self.agent.take();
                }
            }
            "agent.send" => {
                let agent = self
                    .agent
                    .as_ref()
                    .filter(|agent| agent.generation == generation)
                    .ok_or("Agent 尚未连接。")?;
                agent.send(&params["packet"])?;
            }
            "terminal.start" => {
                self.terminal.take();
                self.terminal = Some(terminal_start(params, output, generation)?);
            }
            "terminal.close" => {
                if self
                    .terminal
                    .as_ref()
                    .is_some_and(|terminal| terminal.generation == generation)
                {
                    self.terminal.take();
                }
            }
            "terminal.write" => {
                let terminal = self
                    .terminal
                    .as_mut()
                    .filter(|terminal| terminal.generation == generation)
                    .ok_or("终端尚未连接。")?;
                let input = params["data"].as_str().ok_or("无效的终端输入。")?;
                terminal.input.write_all(input.as_bytes())?;
                terminal.input.flush()?;
            }
            "terminal.resize" => {
                let terminal = self
                    .terminal
                    .as_ref()
                    .filter(|terminal| terminal.generation == generation)
                    .ok_or("终端尚未连接。")?;
                terminal.master.resize(dimensions(params))?;
            }
            "files.list" => return files(params),
            "files.preview" => return preview(params),
            _ => return Err("未知的工作台请求。".into()),
        }
        Ok(Value::Null)
    }
}

fn main() -> Result<()> {
    if env::args().nth(1).as_deref() == Some("--fixture") {
        return fixture::run();
    }
    let output = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let mut service = Service::default();
    for line in io::stdin().lock().lines() {
        let message: Value = serde_json::from_str(&line?)?;
        let response = match service.request(&output, &message) {
            Ok(value) => json!({"id":message["id"],"result":value}),
            Err(error) => json!({"id":message["id"],"error":error.to_string()}),
        };
        send(&output, response)?;
    }
    Ok(())
}
