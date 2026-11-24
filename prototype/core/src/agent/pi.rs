use super::{Process, Result, spawn, ssh};
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{self, BufRead as _, BufWriter, Read as _},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

const CATALOG_PAGE: usize = 40;
const CATALOG_PREFIX: u64 = 64 * 1024;

pub(super) enum Catalog {
    Local,
    Ssh(String),
    Fixture,
}

pub(super) fn start_local(binary: &str, cwd: &Path) -> Result<Process> {
    let override_path = env::var_os("SPAN_PI_PATH").filter(|value| !value.is_empty());
    let mut candidates = vec![PathBuf::from(binary)];
    if cfg!(windows) {
        candidates.push(PathBuf::from("pi.cmd"));
    }
    if let Some(path) = override_path {
        candidates.insert(0, PathBuf::from(path));
    }
    let mut last_error = None;
    for path in candidates {
        match spawn(Command::new(path).args(["--mode", "rpc"]).current_dir(cwd)) {
            Ok(process) => return Ok(process),
            Err(error) => last_error = Some(error),
        }
    }
    Err(format!(
        "无法启动 Pi。请检查 Pi 安装，或将 SPAN_PI_PATH 指向可执行文件。\n{}",
        last_error.expect("CLI candidates are present")
    )
    .into())
}

#[derive(Debug)]
struct Record {
    name: String,
    path: String,
    prefix: Vec<u8>,
}

fn below_cursor(name: &str, cursor: &str) -> bool {
    cursor.is_empty() || name < cursor
}

fn local_records(directory: &Path, cursor: &str) -> io::Result<Vec<Record>> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut names = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if !entry.file_type().ok()?.is_file() {
                return None;
            }
            let name = entry.file_name().into_string().ok()?;
            (name.ends_with(".jsonl") && below_cursor(&name, cursor)).then_some(name)
        })
        .collect::<Vec<_>>();
    names.sort_unstable_by(|left, right| right.cmp(left));
    Ok(names
        .into_iter()
        .take(CATALOG_PAGE + 1)
        .filter_map(|name| {
            let path = directory.join(&name);
            let mut prefix = Vec::new();
            fs::File::open(&path)
                .ok()?
                .take(CATALOG_PREFIX)
                .read_to_end(&mut prefix)
                .ok()?;
            Some(Record {
                name,
                path: path.to_str()?.to_owned(),
                prefix,
            })
        })
        .collect())
}

fn shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

async fn remote_records(host: &str, directory: &str, cursor: &str) -> Result<Vec<Record>> {
    // The session root comes from Pi's own state. Filenames and payloads are NUL-delimited.
    const SCRIPT: &str = r#"
directory=$1
cursor=$2
export LC_ALL=C
if [[ ! -d "$directory" ]]; then exit 0; fi
count=0
while IFS= read -r -d '' name; do
  if [[ -n "$cursor" && ! "$name" < "$cursor" ]]; then continue; fi
  printf '%s\0' "$name"
  head -c "$3" -- "$directory/$name"
  printf '\0'
  count=$((count+1))
  if [[ $count -eq $4 ]]; then break; fi
done < <(find "$directory" -maxdepth 1 -type f -name '*.jsonl' -printf '%f\0' | sort -zr)
"#;
    let command = format!(
        "bash -c {} span-pi {} {} {} {}",
        shell_arg(SCRIPT),
        shell_arg(directory),
        shell_arg(cursor),
        CATALOG_PREFIX,
        CATALOG_PAGE + 1
    );
    let mut process = spawn(ssh(host).arg(command))?;
    let mut bytes = Vec::new();
    let limit = (CATALOG_PREFIX + 4096) * (CATALOG_PAGE + 1) as u64;
    let status = timeout(Duration::from_secs(14), async {
        (&mut process.output)
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() as u64 > limit {
            return Err(io::Error::other("Pi 会话目录超过响应大小限制。"));
        }
        process.child.wait().await
    })
    .await
    .map_err(|_| "读取 Pi 会话目录超时。")??;
    if !status.success() {
        return Err("无法读取远端 Pi 会话目录。".into());
    }
    let mut fields = bytes.split(|byte| *byte == 0);
    let mut records = Vec::new();
    while let (Some(name), Some(prefix)) = (fields.next(), fields.next()) {
        let name = std::str::from_utf8(name)?.to_owned();
        records.push(Record {
            path: format!("{directory}/{name}"),
            name,
            prefix: prefix.to_vec(),
        });
    }
    Ok(records)
}

fn session_record(record: Record) -> Option<Value> {
    let mut lines = record.prefix.split(|byte| *byte == b'\n');
    let header: Value = serde_json::from_slice(lines.next()?).ok()?;
    if header["type"] != "session" {
        return None;
    }
    let id = header["id"].as_str()?;
    let mut title = None;
    let mut preview = None;
    for line in lines {
        if let Ok(entry) = serde_json::from_slice::<Value>(line) {
            match entry["type"].as_str() {
                Some("session_info") => title = entry["name"].as_str().map(str::to_owned),
                Some("message") if preview.is_none() && entry["message"]["role"] == "user" => {
                    let content = &entry["message"]["content"];
                    preview = content
                        .as_str()
                        .or_else(|| {
                            content
                                .as_array()?
                                .iter()
                                .find_map(|block| block["text"].as_str())
                        })
                        .map(|text| text.trim().chars().take(180).collect::<String>());
                }
                _ => {}
            }
        }
    }
    Some(
        json!({"id":id,"path":record.path,"title":title,"preview":preview,"cwd":header["cwd"],"created":header["timestamp"]}),
    )
}

pub(super) async fn catalog(
    source: &Catalog,
    session_file: Option<&String>,
    request: &Value,
) -> Result<Value> {
    let cursor = request["cursor"].as_str().unwrap_or_default();
    let mut records = match (source, session_file) {
        (Catalog::Local, Some(file)) => {
            let dir = Path::new(file)
                .parent()
                .ok_or("Pi 未提供会话目录。")?
                .to_owned();
            let cursor = cursor.to_owned();
            tokio::task::spawn_blocking(move || local_records(&dir, &cursor)).await??
        }
        (Catalog::Ssh(host), Some(file)) => {
            let (dir, _) = file.rsplit_once('/').ok_or("远端 Pi 未提供会话目录。")?;
            remote_records(host, dir, cursor).await?
        }
        _ => Vec::new(),
    };
    let more = records.len() > CATALOG_PAGE;
    records.truncate(CATALOG_PAGE);
    let next = more
        .then(|| records.last().map(|record| record.name.clone()))
        .flatten();
    Ok(
        json!({"items":records.into_iter().filter_map(session_record).collect::<Vec<_>>(),"cursor":next}),
    )
}

pub(crate) fn fixture() -> Result<()> {
    let output = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let model = json!({"id":"fixture","provider":"span","name":"Pi Fixture","reasoning":true});
    let mut session = 1;
    let mut title = None;
    for line in io::stdin().lock().lines() {
        let packet: Value = serde_json::from_str(&line?)?;
        let kind = packet["type"].as_str().unwrap_or_default();
        let data = match kind {
            "get_state" => json!({"sessionId":format!("pi-fixture-{session}"),"sessionName":title,
                "model":model,"thinkingLevel":"medium"}),
            "get_commands" => json!({"commands":[]}),
            "get_available_models" => json!({"models":[model]}),
            "get_available_thinking_levels" => json!({"levels":["off","low","medium","high"]}),
            "get_session_stats" => json!({"tokens":{"input":120,"output":20,"total":140},
                "contextUsage":{"tokens":140,"contextWindow":16_000}}),
            "new_session" => {
                session += 1;
                title = None;
                json!({"cancelled":false})
            }
            "set_session_name" => {
                title = packet["name"].as_str().map(str::to_owned);
                super::super::send(&output, json!({"type":"session_info_changed","name":title}))?;
                Value::Null
            }
            "prompt" => {
                let events = [
                    json!({"type":"agent_start"}),
                    json!({"type":"message_end","message":{"role":"user","content":packet["message"]}}),
                    json!({"type":"message_update","assistantMessageEvent":{
                        "type":"text_delta","contentIndex":0,"delta":"Pi 的统一时间线已接通。"}}),
                    json!({"type":"message_end","message":{"role":"assistant","stopReason":"stop",
                        "content":[{"type":"text","text":"Pi 的统一时间线已接通。"}]}}),
                    json!({"type":"agent_settled","aborted":false}),
                ];
                for message in events {
                    super::super::send(&output, message)?;
                }
                json!({"disposition":"started"})
            }
            _ => Value::Null,
        };
        super::super::send(
            &output,
            json!({"type":"response","id":packet["id"],
            "command":kind,"success":true,"data":data}),
        )?;
    }
    Ok(())
}
