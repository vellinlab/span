use super::{Process, Result, spawn, ssh};
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{self, BufRead as _, BufWriter, Read as _, Seek as _, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

mod transcript;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::timeout,
};
use transcript::{BranchPage, Cursor};

const CATALOG_PAGE: usize = 40;
const CATALOG_PREFIX: u64 = 64 * 1024;
const TEAM_CONFIG_LIMIT: u64 = 128 * 1024;
const TEAM_TASKS_LIMIT: u64 = 512 * 1024;
const TEAM_SNAPSHOT_LIMIT: u64 = 8 * 1024 * 1024;
const TEAM_TRANSCRIPT_CHUNK: u64 = 128 * 1024;

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

fn team_file(path: &Path, limit: u64) -> Option<(Value, u64)> {
    let metadata = path.symlink_metadata().ok()?;
    if !metadata.is_file() || metadata.len() > limit {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    let length = bytes.len() as u64;
    if length > limit {
        return None;
    }
    Some((serde_json::from_slice(&bytes).ok()?, length))
}

#[derive(Clone, PartialEq)]
pub(super) struct SessionIdentity {
    pub(super) id: String,
    pub(super) file: Option<String>,
}

fn session_team(config: &Value, session: &SessionIdentity) -> bool {
    let Some(owner) = config["leadSessionId"].as_str() else {
        return false;
    };
    (owner == session.id || session.file.as_deref() == Some(owner))
        && config["name"].as_str().is_some()
}

fn local_teams(root: &Path, session: &SessionIdentity) -> io::Result<Vec<Value>> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut teams = Vec::new();
    let mut size = 0;
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path();
        if let Some((config, config_bytes)) =
            team_file(&path.join("config.json"), TEAM_CONFIG_LIMIT)
            && session_team(&config, session)
        {
            let (tasks, task_bytes) =
                team_file(&path.join("tasks.json"), TEAM_TASKS_LIMIT).unwrap_or_default();
            size += config_bytes + task_bytes + 32;
            if size > TEAM_SNAPSHOT_LIMIT {
                return Err(io::Error::other("Pi 团队记录超过响应大小限制。"));
            }
            teams.push(json!({ "config": config, "board": tasks }));
        }
    }
    Ok(teams)
}

pub(super) fn valid_team_member(id: &str) -> bool {
    id.len() == 8 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

struct TranscriptChunk {
    file: String,
    block: TranscriptBlock,
}

#[derive(Clone)]
struct TranscriptBlock {
    start: u64,
    bytes: Vec<u8>,
}

pub(super) struct TeamTranscript {
    owner: SessionIdentity,
    member: String,
    file: String,
    cursor: Cursor,
    buffered: Option<TranscriptBlock>,
}

fn local_team_chunk(
    parent: &Path,
    member: &str,
    file: Option<&str>,
    end: Option<u64>,
) -> io::Result<Option<TranscriptChunk>> {
    if !parent.is_absolute() {
        return Ok(None);
    }
    let mut directory = parent.with_extension("");
    for component in [None, Some(member), Some("run-0")] {
        if let Some(component) = component {
            directory.push(component);
        }
        match directory.symlink_metadata() {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return Ok(None),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        }
    }
    let name = match file {
        Some(file) => file.to_owned(),
        None => {
            let latest = fs::read_dir(&directory)?
                .filter_map(|entry| {
                    let entry = entry.ok()?;
                    let name = entry.file_name().into_string().ok()?;
                    if !name.ends_with(".jsonl") || !entry.file_type().ok()?.is_file() {
                        return None;
                    }
                    Some((entry.metadata().ok()?.modified().ok()?, name))
                })
                .max();
            let Some((_, name)) = latest else {
                return Ok(None);
            };
            name
        }
    };
    let path = directory.join(&name);
    if !path.symlink_metadata()?.is_file() {
        return Ok(None);
    }
    let mut file = fs::File::open(path)?;
    let length = file.metadata()?.len();
    let end = end.unwrap_or(length);
    if end > length {
        return Err(io::Error::other("Pi 子代理的记录已变更，请重新打开。"));
    }
    let start = end.saturating_sub(TEAM_TRANSCRIPT_CHUNK);
    let mut bytes = vec![0; (end - start) as usize];
    file.seek(SeekFrom::Start(start))?;
    file.read_exact(&mut bytes)?;
    Ok(Some(TranscriptChunk {
        file: name,
        block: TranscriptBlock { start, bytes },
    }))
}

fn start_remote_team_reader(host: &str) -> Result<Process> {
    // Requests and results use NUL-delimited fields. A roster ends with an empty config field.
    // The local reader checks ownership again after decoding the remote data.
    const SCRIPT: &str = r#"
shopt -s nullglob dotglob
export LC_ALL=C
config_limit=$(($1 + 1))
tasks_limit=$(($2 + 1))
owner_field='"leadSessionId"[[:space:]]*:[[:space:]]*'
while IFS= read -r -d '' operation; do
  if [[ $operation == transcript ]]; then
    IFS= read -r -d '' parent || exit 2
    IFS= read -r -d '' member || exit 2
    IFS= read -r -d '' name || exit 2
    IFS= read -r -d '' end || exit 2
    [[ $parent == /*.jsonl && $member =~ ^[[:xdigit:]]{8}$ ]] || exit 2
    [[ -z $name || ( $name == *.jsonl && $name != */* ) ]] || exit 2
    [[ -z $end || $end =~ ^[0-9]{1,18}$ ]] || exit 2
    base=${parent%.jsonl}
    directory="$base/$member/run-0"
    if [[ -d "$directory" && ! -L "$directory" && ! -L "$base/$member" && ! -L "$base" ]]; then
      if [[ -z $name ]]; then
        latest=''
        for file in "$directory/"*.jsonl; do
          [[ -f "$file" && ! -L "$file" ]] || continue
          if [[ -z "$latest" || "$file" -nt "$latest" || ( ! "$latest" -nt "$file" && "$file" > "$latest" ) ]]; then latest=$file; fi
        done
        name=${latest##*/}
      fi
      file="$directory/$name"
      if [[ -n $name && -f "$file" && ! -L "$file" ]]; then
        if [[ -z $end ]]; then end=$(stat -c %s -- "$file") || exit 2; fi
        start=$((end > $3 ? end - $3 : 0))
        printf '%s\0%s\0' "$name" "$end"
        dd if="$file" iflag=skip_bytes,count_bytes skip="$start" count="$((end - start))" status=none || exit 2
      fi
    fi
    printf '\0'
    continue
  fi
  [[ $operation == roster ]] || exit 2
  IFS= read -r -d '' owner_id && IFS= read -r -d '' owner_file || exit 2
  for directory in "$HOME/.pi/teams/"*; do
    config="$directory/config.json"
    tasks="$directory/tasks.json"
    [[ -d "$directory" && ! -L "$directory" && -f "$config" && ! -L "$config" ]] || continue
    IFS= read -r -d '' -n "$config_limit" config_json < "$config"
    [[ ${#config_json} -lt $config_limit ]] || continue
    [[ $config_json =~ $owner_field"$owner_id" || ( -n "$owner_file" && $config_json =~ $owner_field"$owner_file" ) ]] || continue
    task_json=''
    if [[ -f "$tasks" && ! -L "$tasks" ]]; then
      IFS= read -r -d '' -n "$tasks_limit" task_json < "$tasks"
      if [[ ${#task_json} -ge $tasks_limit ]]; then task_json=''; fi
    fi
    printf '%s\0%s\0' "$config_json" "$task_json"
  done
  printf '\0'
done
"#;
    let command = format!(
        "exec bash -c {} span-pi-teams {} {} {}",
        shell_arg(SCRIPT),
        TEAM_CONFIG_LIMIT,
        TEAM_TASKS_LIMIT,
        TEAM_TRANSCRIPT_CHUNK,
    );
    Ok(spawn(ssh(host).arg(command))?)
}

async fn read_team_field(
    output: &mut (impl tokio::io::AsyncBufRead + Unpin),
    remaining: &mut u64,
    field: &mut Vec<u8>,
) -> io::Result<()> {
    field.clear();
    let count = output.take(*remaining).read_until(0, field).await?;
    *remaining -= count as u64;
    if field.pop() != Some(0) {
        return Err(io::Error::other(if *remaining == 0 {
            "Pi 团队记录超过响应大小限制。"
        } else {
            "远端 Pi 团队连接已关闭。"
        }));
    }
    Ok(())
}

async fn remote_teams(process: &mut Process, session: &SessionIdentity) -> Result<Vec<Value>> {
    let mut owners = b"roster\0".to_vec();
    serde_json::to_writer(&mut owners, &session.id)?;
    owners.push(0);
    if let Some(file) = &session.file {
        serde_json::to_writer(&mut owners, file)?;
    }
    owners.push(0);
    let teams = timeout(Duration::from_secs(10), async {
        process.input.write_all(&owners).await?;
        process.input.flush().await?;
        let mut teams = Vec::new();
        let mut remaining = TEAM_SNAPSHOT_LIMIT;
        let mut config = Vec::new();
        let mut tasks = Vec::new();
        loop {
            read_team_field(&mut process.output, &mut remaining, &mut config).await?;
            if config.is_empty() {
                return Ok::<_, io::Error>(teams);
            }
            read_team_field(&mut process.output, &mut remaining, &mut tasks).await?;
            if let Ok(config) = serde_json::from_slice::<Value>(&config)
                && session_team(&config, session)
            {
                let tasks = serde_json::from_slice::<Value>(&tasks).ok();
                teams.push(json!({ "config": config, "board": tasks }));
            }
        }
    })
    .await
    .map_err(|_| "读取远端 Pi 团队超时。")??;
    Ok(teams)
}

pub(super) async fn team_snapshot(
    source: &Catalog,
    remote: &mut Option<Process>,
    session: &SessionIdentity,
) -> Result<Value> {
    let teams = match source {
        Catalog::Local => {
            let home = env::home_dir().ok_or("无法定位 Pi 团队目录。")?;
            let session = session.clone();
            tokio::task::spawn_blocking(move || {
                local_teams(&home.join(".pi").join("teams"), &session)
            })
            .await??
        }
        Catalog::Ssh(host) => {
            if remote.is_none() {
                *remote = Some(start_remote_team_reader(host)?);
            }
            let result =
                remote_teams(remote.as_mut().expect("opened remote team reader"), session).await;
            if result.is_err() {
                *remote = None;
            }
            result?
        }
        Catalog::Fixture => Vec::new(),
    };
    Ok(json!(teams))
}

pub(super) async fn team_transcript(
    source: &Catalog,
    remote: &mut Option<Process>,
    stored: &mut Option<TeamTranscript>,
    session: &SessionIdentity,
    member: &str,
    offset: Option<u64>,
) -> Result<Value> {
    let previous = match offset {
        None => None,
        Some(offset) => Some(
            stored
                .as_ref()
                .filter(|view| {
                    &view.owner == session && view.member == member && view.cursor.end == offset
                })
                .ok_or("Pi 子代理的历史页已失效，请重新打开。")?,
        ),
    };
    let Some(parent) = session
        .file
        .as_ref()
        .filter(|file| file.ends_with(".jsonl") && !file.contains('\0'))
    else {
        return Ok(json!({"entries":[],"cursor":null}));
    };
    let mut file = previous.map(|view| view.file.clone());
    let mut end = offset;
    let mut page = BranchPage::new(previous.map(|view| view.cursor.parent.clone()));
    let result = timeout(Duration::from_secs(22), async {
        if let Some(block) = previous.and_then(|view| view.buffered.as_ref()) {
            if page.read(block.start, &block.bytes)? {
                return Ok::<_, Box<dyn std::error::Error>>(Some(block.clone()));
            }
            end = Some(block.start);
        }
        while let Some(chunk) =
            team_transcript_chunk(source, remote, parent, member, file.as_deref(), end).await?
        {
            file = Some(chunk.file);
            if page.read(chunk.block.start, &chunk.block.bytes)? {
                return Ok(Some(chunk.block));
            }
            end = Some(chunk.block.start);
        }
        if file.is_some() {
            return Err("Pi 子代理的记录已变更，请重新打开。".into());
        }
        Ok(None)
    })
    .await;
    if result.is_err() {
        *remote = None;
    }
    let block = result.map_err(|_| "读取 Pi 子代理这一页的记录超时。")??;
    let (entries, next) = page.finish();
    *stored = next.and_then(|cursor| {
        // Keep the already-read prefix below the cursor for the next page.
        let buffered = block.and_then(|mut block| {
            block
                .bytes
                .truncate(cursor.end.saturating_sub(block.start) as usize);
            (!block.bytes.is_empty()).then_some(block)
        });
        file.map(|file| TeamTranscript {
            owner: session.clone(),
            member: member.to_owned(),
            file,
            cursor,
            buffered,
        })
    });
    let cursor = stored.as_ref().map(|view| view.cursor.end.to_string());
    Ok(json!({"entries":entries,"cursor":cursor}))
}

async fn team_transcript_chunk(
    source: &Catalog,
    remote: &mut Option<Process>,
    parent: &str,
    member: &str,
    file: Option<&str>,
    end: Option<u64>,
) -> Result<Option<TranscriptChunk>> {
    let chunk = match source {
        Catalog::Local => {
            let parent = PathBuf::from(parent);
            let member = member.to_owned();
            let file = file.map(str::to_owned);
            tokio::task::spawn_blocking(move || {
                local_team_chunk(&parent, &member, file.as_deref(), end)
            })
            .await??
        }
        Catalog::Ssh(host) => {
            if remote.is_none() {
                *remote = Some(start_remote_team_reader(host)?);
            }
            let process = remote.as_mut().expect("opened remote team reader");
            let result = timeout(Duration::from_secs(10), async {
                let name = file.unwrap_or_default();
                let offset = end.map(|end| end.to_string()).unwrap_or_default();
                let request = format!("transcript\0{parent}\0{member}\0{name}\0{offset}\0");
                process.input.write_all(request.as_bytes()).await?;
                process.input.flush().await?;
                let mut remaining = TEAM_TRANSCRIPT_CHUNK + 4096;
                let mut field = Vec::new();
                read_team_field(&mut process.output, &mut remaining, &mut field).await?;
                if field.is_empty() {
                    return Ok::<_, io::Error>(None);
                }
                let file = String::from_utf8(field.clone()).map_err(io::Error::other)?;
                if !name.is_empty() && file != name {
                    return Err(io::Error::other("远端 Pi 子代理的记录已变更，请重新打开。"));
                }
                read_team_field(&mut process.output, &mut remaining, &mut field).await?;
                let received_end = std::str::from_utf8(&field)
                    .ok()
                    .and_then(|value| value.parse::<u64>().ok())
                    .filter(|received| end.is_none_or(|end| *received == end))
                    .ok_or_else(|| io::Error::other("远端 Pi 子代理记录的位置无效。"))?;
                let start = received_end.saturating_sub(TEAM_TRANSCRIPT_CHUNK);
                read_team_field(&mut process.output, &mut remaining, &mut field).await?;
                if field.len() as u64 != received_end - start {
                    return Err(io::Error::other("远端 Pi 子代理的记录已变更，请重新打开。"));
                }
                Ok(Some(TranscriptChunk {
                    file,
                    block: TranscriptBlock {
                        start,
                        bytes: field,
                    },
                }))
            })
            .await;
            if !matches!(&result, Ok(Ok(_))) {
                *remote = None;
            }
            result.map_err(|_| "读取远端 Pi 子代理记录超时。")??
        }
        Catalog::Fixture => None,
    };
    Ok(chunk)
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
