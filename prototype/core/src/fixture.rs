use super::{Output, Result, send};
use serde_json::{Value, json};
use std::{
    env,
    fmt::Write as _,
    fs,
    io::{self, BufRead, BufWriter, Write as _},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

const THREAD: &str = "workspace-review";
const TITLE: &str = "工作台架构评审";
const REVIEW_AGENT: &str = "键盘导航与窄窗口布局复核，核对 Windows 和 EL8 下的状态、结果与会话归属，并逐项检查审批、文件预览和历史恢复";
const REVIEW_MODEL: &str = "fixture-review-workbench-layout-keyboard-navigation-window-rendering-delegated-agent-long-model-identifier";
const READING_REVIEW: &str = r#"# 工作台会话验收

已确认会话可以继续。当前回合的文件、终端和执行记录均归属正确。

## 核对结果

- 保留当前阅读位置，更新时只补齐新增文字。
  - 审批出现后，仍可看到原先阅读的段落。
  - 路径 `prototype/ui/transcript.jsx` 能够选中复制。
- 使用 [验收记录](https://example.com/span) 核对回合。

| 核对项目 | 结果 |
| :--- | ---: |
| 会话历史 | 已通过 |
| 跨主机审批 | 已通过 |

### 复查命令

```sh
git diff --check -- prototype/ui/transcript.jsx prototype/core/src/fixture.rs
```

> 如需继续验证，用同一个窗口复查切换会话后的焦点。

回放和继续会话均已验证。"#;
const LONG_COMMAND: &str = concat!(
    "workspace inspect --profile desktop --path prototype/resources/workbench/verification/candidate \\\n",
    "\t--check output-and-history --keep-annotations \\\n",
    "    --include-summary"
);

fn approval_command(turn: &str, cwd: &Path, status: &str) -> Value {
    let command = format!(
        "git status --short\n{}",
        "# 这是一条用于核对滚动布局的说明。\n".repeat(34)
    );
    json!({"type":"commandExecution","id":format!("{turn}-approval-command"),"command":command,"cwd":cwd,"status":status})
}

fn approval_requests(output: &Output, turn: &str, cwd: &Path) -> io::Result<()> {
    let item = approval_command(turn, cwd, "inProgress");
    notice(
        output,
        "item/started",
        json!({"threadId":THREAD,"turnId":turn,"item":item}),
    )?;
    send(
        output,
        json!({"id":"fixture-approval","method":"item/commandExecution/requestApproval",
        "params":{"threadId":THREAD,"turnId":turn,"itemId":item["id"],"command":item["command"],"cwd":cwd,"reason":"检查长命令审批中的滚动和操作位置。"}}),
    )?;
    send(
        output,
        json!({"id":"fixture-answer","method":"item/tool/requestUserInput",
        "params":{"threadId":THREAD,"turnId":turn,"questions":[
            {"id":"platform","question":"验证平台","options":[{"label":"桌面","description":"原生窗口"}]},
            {"id":"result","question":"验证结果"}
        ]}}),
    )
}

fn patch_sample(turn: &str) -> Value {
    let mut large = String::from(
        "--- a/prototype/ui/workbench.css\n+++ b/prototype/ui/workbench.css\n@@ -1,5001 +1,5001 @@\n--- old source prefix\n+++ new source prefix\n",
    );
    for index in 1..=5000 {
        writeln!(
            large,
            "-    include(record_{index:04}, \"old workbench rule\");"
        )
        .unwrap();
        write!(
            large,
            "+    include(record_{index:04}, \"new workbench rule\");"
        )
        .unwrap();
        if index == 1 {
            write!(large, "\t// {}", "界面缩放后仍保留缩进。".repeat(8)).unwrap();
        }
        large.push('\n');
    }
    json!({"type":"fileChange","id":format!("{turn}-patch"),"status":"completed","changes":[
        {"path":"prototype/ui/workbench.css","kind":{"type":"update"},"diff":large},
        {"path":"prototype/REVIEW.md","kind":{"type":"update"},"diff":"@@ -8 +8 @@\n-    保留原文。\n+    保留原文和缩进。\n"},
        {"path":"prototype/sample/README.md","kind":{"type":"update"}}
    ]})
}

fn command_output(turn: &str, cwd: &Path) -> Value {
    let mut text = format!("    prepare\t{}\n", "index workspace ".repeat(12));
    for index in 1..20_000 {
        writeln!(
            text,
            "    检查 {index:05}\tworkspace/source/feature_{index:05}.rs"
        )
        .unwrap();
    }
    text.push_str("warning: 已核对全部命令输出。\n");
    json!({"type":"commandExecution","id":format!("{turn}-output"),"command":"workspace verify --all",
        "cwd":cwd,"status":"failed","exitCode":3,"aggregatedOutput":text})
}

fn catalog(cwd: &Path, title: &str, params: &Value, mode: &str, is_archived: bool) -> Value {
    let archived = params["archived"] == true;
    let mut entries = Vec::new();
    if archived == is_archived {
        entries.push(json!({"id":THREAD,"name":title,"cwd":cwd,"preview":TITLE,
            "gitInfo":{"branch":"prototype/web-workbench"}}));
    }
    if archived {
        entries.push(json!({"id":"catalog-archive","name":"归档会话示例","cwd":cwd}));
    } else if !mode.is_empty() {
        let last = if mode == "benchmark" { 1200 } else { 119 };
        let other = cwd.join("second-workspace");
        entries.extend((1..=last).map(|number| {
            json!({"id":format!("catalog-{number:04}"),
            "name":format!("目录会话 {number:04}"),"cwd":if number % 2 == 0 { cwd } else { &other }})
        }));
    }
    let query = params["searchTerm"].as_str().unwrap_or_default();
    if !query.is_empty() {
        entries.retain(|entry| {
            entry["name"]
                .as_str()
                .is_some_and(|name| name.contains(query))
        });
    }
    let limit = if mode == "benchmark" {
        entries.len()
    } else if !query.is_empty() {
        12
    } else {
        40
    };
    let start = params["cursor"]
        .as_str()
        .and_then(|cursor| cursor.parse::<usize>().ok())
        .unwrap_or(0)
        .min(entries.len());
    let end = (start + limit).min(entries.len());
    json!({"data":entries[start..end],"nextCursor":(end < entries.len()).then(|| end.to_string())})
}

fn history(grouped: bool) -> Vec<Value> {
    (1..=160)
        .map(|number| {
            let reply = match number % 8 {
                0 => format!(
                    "**第 {number:03} 项 · 工作区响应检查**\n\n\
                    | 项目 | 状态 |\n| --- | --- |\n| 会话回放 | 已验证 |\n| 终端输出 | 持续接收 |\n\n\
                    本次检查覆盖输入焦点、长行换行和滚动位置。"
                ),
                1 => format!(
                    "**第 {number:03} 项 · 终端与会话**\n\n\
                    ```sh\nprintf '%s\\n' 'terminal ready'\n```\n\n\
                    终端进程独立运行，会话仅跟随可见内容更新。"
                ),
                _ => format!(
                    "**第 {number:03} 项 · 工作区记录**\n\n\
                    已复核会话记录、文件选择与窗口缩放。进度由 Agent 事件驱动，\
                    中英文保持自然换行，连续滚动时会保留当前阅读位置。"
                ),
            };
            let mut items = if number == 1 || number == 160 {
                vec![
                    json!({"id":format!("question-{number}"),"type":"userMessage",
                        "content":[{"type":"text","text":"请检查长会话、终端和文件预览的表现。"}]}),
                    json!({"id":format!("result-{number}"),"type":"agentMessage","text":reply}),
                ]
            } else if number == 90 {
                vec![
                    json!({"id":"history-command-90","type":"commandExecution","command":"workspace verify --history",
                        "status":"completed","exitCode":0,"aggregatedOutput":"已核对第 90 项历史记录。\n保留命令卡片的展开状态。\n"}),
                    json!({"id":format!("result-{number}"),"type":"agentMessage","text":reply}),
                ]
            } else {
                vec![json!({"id":format!("result-{number}"),"type":"agentMessage","text":reply})]
            };
            if grouped && number > 140 {
                let activities = (0..144).map(|index| {
                    let id = format!("history-{number}-{index}");
                    if index % 24 >= 18 {
                        json!({"id":id,"type":"commandExecution","status":"completed","exitCode":0,
                            "command":format!("workspace verify --record {number}-{index:03}")})
                    } else {
                        json!({"id":id,"type":"agentMessage","text":"已复核工作区响应与会话记录。"})
                    }
                });
                items.splice(0..0, activities);
            }
            json!({"id":format!("review-{number}"),"status":"completed","items":items})
        })
        .collect()
}

fn notice(output: &Output, method: &str, params: Value) -> io::Result<()> {
    send(output, json!({"method":method,"params":params}))
}

fn wait_for_stream_gate(path: &Path, running: &AtomicBool) -> bool {
    for _ in 0..3_000 {
        if !running.load(Ordering::Acquire) {
            return false;
        }
        if path.is_file() {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    false
}

fn inline_review(
    output: &Output,
    running: &AtomicBool,
    thread_id: &str,
    turn: &str,
    focus: &str,
) -> io::Result<()> {
    let reasoning = format!("{turn}-summary");
    let internal = format!("{turn}-internal");
    for (method, item) in [
        (
            "item/completed",
            json!({"type":"userMessage","id":format!("{turn}-input"),
            "content":[{"type":"text","text":focus}]}),
        ),
        (
            "item/completed",
            json!({"type":"reasoning","id":reasoning,"summary":["核对改动和对应的会话状态。"]}),
        ),
        (
            "item/started",
            json!({"type":"agentMessage","id":internal,"text":"{\"findings\":[]}"}),
        ),
    ] {
        notice(
            output,
            method,
            json!({"threadId":thread_id,"turnId":turn,"item":item}),
        )?;
    }
    let ready = env::var_os("SPAN_PREVIEW_STREAM_GATE").is_none_or(|path| {
        wait_for_stream_gate(&PathBuf::from(path).join("finish-inline-review"), running)
    });
    let report = "发现一处会话恢复问题。\n\n- **[P2] 保留阅读位置** — `prototype/ui/transcript.jsx`\n  恢复会话时复用此前保存的阅读位置。";
    let status = if ready { "completed" } else { "interrupted" };
    notice(
        output,
        "item/completed",
        json!({"threadId":thread_id,"turnId":turn,"item":{
        "type":"exitedReviewMode","id":format!("{turn}-exit"),"review":report}}),
    )?;
    let item = json!({"type":"agentMessage","id":format!("{turn}-result"),"text":report});
    notice(
        output,
        "item/completed",
        json!({"threadId":thread_id,"turnId":turn,"item":item}),
    )?;
    running.store(false, Ordering::Release);
    notice(
        output,
        "turn/completed",
        json!({"threadId":thread_id,"turn":{
        "id":turn,"status":status,"items":[item]}}),
    )
}

fn stream_command_output(
    output: &Output,
    running: &AtomicBool,
    cwd: &Path,
    thread_id: &str,
    turn: &str,
    gate: &Path,
) -> io::Result<()> {
    let mut item = command_output(turn, cwd);
    let mut text = item["aggregatedOutput"].as_str().unwrap().to_owned();
    item["status"] = json!("inProgress");
    item["exitCode"] = Value::Null;
    notice(
        output,
        "item/started",
        json!({"threadId":thread_id,"turnId":turn,"item":item}),
    )?;
    if !wait_for_stream_gate(&gate.join("append"), running) {
        return Ok(());
    }
    for index in 1..=72 {
        if !running.load(Ordering::Acquire) {
            return Ok(());
        }
        let fragment = format!("    实时检查 {index:03}\tworkspace/source/stream_{index:03}.rs\n");
        text.push_str(&fragment);
        notice(
            output,
            "item/commandExecution/outputDelta",
            json!({"threadId":thread_id,"turnId":turn,"itemId":item["id"],"delta":fragment}),
        )?;
        thread::sleep(Duration::from_millis(40));
    }
    fs::write(gate.join("appended"), b"")?;
    if !wait_for_stream_gate(&gate.join("finish"), running) {
        return Ok(());
    }
    item["aggregatedOutput"] = json!(text);
    item["status"] = json!("completed");
    item["exitCode"] = json!(0);
    notice(
        output,
        "item/completed",
        json!({"threadId":thread_id,"turnId":turn,"item":item}),
    )?;
    running.store(false, Ordering::Release);
    notice(
        output,
        "turn/completed",
        json!({"threadId":thread_id,"turn":{"id":turn,"status":"completed","items":[]}}),
    )
}

fn stream_reasoning(
    output: &Output,
    running: &AtomicBool,
    thread_id: &str,
    turn: &str,
    gate: &Path,
) -> io::Result<()> {
    let id = format!("{turn}-streamed-summary");
    let following = gate.join("reasoning-following").is_file();
    let details = following || gate.join("reasoning-details").is_file();
    let mut initial = if details {
        let mut text =
            "### 复核顺序\n\n- 检查会话正文\n  - 保留两级缩进\n  - 核对工具结果\n\n".to_owned();
        let context = "记录核对过程、输入响应、工具结果与最终答复的顺序。".repeat(4);
        for index in 1..=144 {
            writeln!(
                text,
                "**复核记录 {index:03}**。核对修改的工作区、保留引用和步骤的归属。{context}\n"
            )
            .unwrap();
        }
        text
    } else {
        "核对历史记录和工具结果。".repeat(38_000) + "\r\n"
    };
    initial.push_str("开始复核长会话。");
    let section_delta = |section: usize, fragment: &str| {
        notice(
            output,
            "item/reasoning/summaryTextDelta",
            json!({"threadId":thread_id,"turnId":turn,"itemId":id,"summaryIndex":section,"delta":fragment}),
        )
    };
    if gate.join("reasoning-observers").is_file() {
        let paragraph = "对照工作区的修改、工具输出和复核记录。";
        for section in 1..=2 {
            let text = format!(
                "### 复核补充 {section}\n\n{}",
                (paragraph.repeat(12) + "\n\n").repeat(24)
            );
            section_delta(section, &text)?;
        }
    }
    let delta = |fragment: &str| section_delta(0, fragment);
    delta(&initial)?;
    if !wait_for_stream_gate(&gate.join("append"), running) {
        return Ok(());
    }
    for index in 1..=72 {
        if !running.load(Ordering::Acquire) {
            return Ok(());
        }
        delta(&format!(
            "\r\n- 正在比对工作区记录、工具输出和最近一次会话结果。步骤 {index:03}"
        ))?;
        thread::sleep(Duration::from_millis(40));
    }
    fs::write(gate.join("appended"), b"")?;
    if details {
        if !wait_for_stream_gate(&gate.join("follow-detail"), running) {
            return Ok(());
        }
        if following {
            delta("\r\n\r\n1. ")?;
            if !wait_for_stream_gate(&gate.join("follow-detail-content"), running) {
                return Ok(());
            }
            delta("收尾复核完成。步骤 073")?;
        } else {
            delta("\r\n- 收尾复核完成。步骤 073")?;
        }
    }
    if following {
        if !wait_for_stream_gate(&gate.join("reference-prefix"), running) {
            return Ok(());
        }
        notice(
            output,
            "item/started",
            json!({"threadId":thread_id,"turnId":turn,"item":{"type":"reasoning","id":id,
                "summary":[format!("[迟到引用]\n\n{initial}") ]}}),
        )?;
        delta(concat!(
            "\n\nتحقق من عرض ملخص الاستدلال أثناء تحديث المحادثة ثم افحص التطبيق على Windows و EL8. ",
            "راجع ترتيب عناصر الواجهة وتأكد من سهولة قراءة التحديث في النافذة الضيقة. ",
            "آخر خطوة: مراجعة النتائج."
        ))?;
        if !wait_for_stream_gate(&gate.join("reference-definition"), running) {
            return Ok(());
        }
        delta("\n\n[迟到引用]: https://example.com/span/reference\n\n引用检查完成。")?;
    }
    if !wait_for_stream_gate(&gate.join("finish"), running) {
        return Ok(());
    }
    notice(
        output,
        "item/completed",
        json!({"threadId":thread_id,"turnId":turn,"item":{"type":"reasoning","id":id,"summary":[]}}),
    )?;
    if following {
        notice(
            output,
            "item/completed",
            json!({"threadId":thread_id,"turnId":turn,"item":{
                "type":"agentMessage","id":format!("{turn}-reasoning-answer"),"phase":"final_answer",
                "text":"**推理核对已完成。**\n\n检查了实时摘要的更新、列表缩进和历史归档。"
            }}),
        )?;
    }
    running.store(false, Ordering::Release);
    notice(
        output,
        "turn/completed",
        json!({"threadId":thread_id,"turn":{"id":turn,"status":"completed","items":[]}}),
    )
}

fn long_reply(
    output: &Output,
    running: &AtomicBool,
    thread_id: &str,
    turn: &str,
    gate: &Path,
) -> io::Result<()> {
    let item = format!("{turn}-long-reply");
    let send_delta = |delta: &str| {
        notice(
            output,
            "item/agentMessage/delta",
            json!({"threadId":thread_id,"turnId":turn,"itemId":item,"delta":delta}),
        )
    };
    let mut answer =
        String::from("## 长回复的开头\n\n[复核链接](https://example.com/span)和正文可以选择。\n\n");
    for index in 1..=144 {
        writeln!(
            answer,
            "**第 {index:03} 项。** 检查缩进、滚动位置和长行换行。工作台会保留这段选区和原始的代码。\n"
        )
        .unwrap();
    }
    answer.push_str("### 预置正文末尾\n\n");
    let fast = gate.join("fast").is_file();
    let grouped = gate.join("grouped-history").is_file();
    if fast {
        answer.push_str("查看[后补引用][later]的链接。\n\n");
    }
    send_delta(&answer)?;
    let mut complete = false;
    if wait_for_stream_gate(&gate.join("append"), running) {
        let (count, interval) = if fast { (160, 20) } else { (40, 75) };
        for index in 1..=count {
            if !running.load(Ordering::Acquire) {
                return Ok(());
            }
            if grouped {
                notice(
                    output,
                    "item/completed",
                    json!({"threadId":thread_id,"turnId":turn,"item":{
                        "id":format!("{turn}-history-command-{index}"),"type":"commandExecution",
                        "status":"completed","exitCode":0,"command":format!("workspace verify --live {index:02}")
                    }}),
                )?;
                thread::sleep(Duration::from_millis(interval));
                continue;
            }
            let mut fragment = format!("追加记录 {index:03}。继续核对正在生成的结果。\n\n");
            if fast && index == 80 {
                fragment.push_str("[later]: https://example.com/span/reference\n\n");
            }
            answer.push_str(&fragment);
            send_delta(&fragment)?;
            thread::sleep(Duration::from_millis(interval));
        }
        fs::write(gate.join("appended"), b"")?;
        complete = wait_for_stream_gate(&gate.join("finish"), running);
    }
    answer.push_str("**长回复已全部生成。**");
    notice(
        output,
        "item/completed",
        json!({"threadId":thread_id,"turnId":turn,"item":{"type":"agentMessage","id":item,"phase":"final_answer","text":answer}}),
    )?;
    running.store(false, Ordering::Release);
    let status = if complete { "completed" } else { "interrupted" };
    notice(
        output,
        "turn/completed",
        json!({"threadId":thread_id,"turn":{"id":turn,"status":status,"items":[]}}),
    )
}

fn plan_notice(output: &Output, thread_id: &str, turn: &str, completed: usize) -> io::Result<()> {
    let plan: Vec<_> = [
        "核对工作目录和当前会话。",
        "检查终端恢复和跨主机审批。",
        "复核窄窗中的长草稿。",
    ]
    .into_iter()
    .enumerate()
    .map(|(index, step)| {
        let status = match index.cmp(&completed) {
            std::cmp::Ordering::Less => "completed",
            std::cmp::Ordering::Equal => "inProgress",
            std::cmp::Ordering::Greater => "pending",
        };
        json!({"step":step,"status":status})
    })
    .collect();
    notice(
        output,
        "turn/plan/updated",
        json!({"threadId":thread_id,"turnId":turn,"explanation":"检查两端的会话布局。","plan":plan}),
    )
}

pub fn run() -> Result<()> {
    let output = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let cwd = env::current_dir()?;
    let catalog_mode = env::var("SPAN_PREVIEW_CATALOG_FIXTURE").unwrap_or_default();
    let grouped = env::var_os("SPAN_PREVIEW_STREAM_GATE")
        .is_some_and(|path| PathBuf::from(path).join("grouped-history").is_file());
    let history = history(grouped);
    let child_turn = json!({"id":"child-turn","status":"completed","items":[
        {"type":"userMessage","id":"child-task","content":[{"type":"text","text":"复核工作台键盘导航。"}]},
        {"type":"reasoning","id":"child-reasoning","summary":["检查窄窗口与返回焦点。"]},
        {"type":"agentMessage","id":"child-result","phase":"final_answer","text":"子代理的会话记录。"}
    ]});
    let background = Arc::new(AtomicBool::new(false));
    let mut turn_count = 0;
    let mut new_thread_count = 0;
    let mut fork_count = 0;
    let mut goal = Value::Null;
    let mut title = TITLE.to_owned();
    let mut is_archived = false;
    let mut search_failed = false;
    let mut draft_send_failed = false;
    let mut active_plan: Option<String> = None;
    let mut review: Option<(String, bool)> = None;
    let mut reviewed = false;
    for line in io::stdin().lock().lines() {
        let packet: Value = serde_json::from_str(&line?)?;
        let id = &packet["id"];
        if id.is_null() {
            continue;
        }
        if id == "fixture-approval" {
            reviewed = packet["result"]["decision"] == "decline";
            if let Some((turn, _)) = &review {
                notice(
                    &output,
                    "item/completed",
                    json!({"threadId":THREAD,"turnId":turn,
                    "item":approval_command(turn, &cwd, if reviewed { "declined" } else { "completed" })}),
                )?;
            }
            continue;
        }
        if id == "fixture-answer" {
            if let Some((turn, _)) = review.take() {
                let answers = &packet["result"]["answers"];
                let text = if reviewed
                    && answers["platform"]["answers"][0] == "桌面"
                    && answers["result"]["answers"][0] == "布局正常"
                {
                    "审批回复：拒绝，已收到回答。"
                } else {
                    "审批验证失败。"
                };
                notice(
                    &output,
                    "item/completed",
                    json!({"threadId":THREAD,"turnId":turn,
                    "item":{"type":"agentMessage","id":format!("{turn}-verification"),"text":text}}),
                )?;
                background.store(false, Ordering::Release);
                notice(
                    &output,
                    "turn/completed",
                    json!({"threadId":THREAD,"turn":{"id":turn,"status":"completed","items":[]}}),
                )?;
            }
            continue;
        }
        let params = &packet["params"];
        let result = match packet["method"].as_str().unwrap_or_default() {
            "initialize" => json!({"userAgent":"Span preview fixture"}),
            "thread/list" if catalog_mode == "empty" => json!({"data":[],"nextCursor":null}),
            "thread/list" => {
                if catalog_mode == "paged"
                    && params["searchTerm"] == "目录会话 0119"
                    && !search_failed
                {
                    search_failed = true;
                    send(
                        &output,
                        json!({"id":id,"error":{"code":-32603,"message":"fixture search failed"}}),
                    )?;
                    continue;
                }
                catalog(&cwd, &title, params, &catalog_mode, is_archived)
            }
            "thread/start" => {
                new_thread_count += 1;
                json!({"thread":{"id":format!("fixture-new-{new_thread_count}"),"cwd":cwd},
                    "cwd":cwd,"model":"fixture","modelProvider":"fixture","approvalPolicy":"on-request"})
            }
            "thread/fork" => {
                fork_count += 1;
                if catalog_mode == "paged" && fork_count == 1 {
                    send(
                        &output,
                        json!({"id":id,"error":{"code":-32603,"message":"复制会话失败，请重试。"}}),
                    )?;
                    continue;
                }
                json!({"thread":{"id":format!("fixture-fork-{fork_count}"),"name":format!("会话副本 {fork_count}"),"cwd":cwd},
                    "cwd":cwd,"model":"fixture"})
            }
            "thread/resume" if params["threadId"] == "fixture-subagent" => json!({
                "thread":{"id":"fixture-subagent","name":REVIEW_AGENT,"cwd":cwd},
                "initialTurnsPage":{"data":[child_turn],"nextCursor":null},"cwd":cwd,"model":"fixture"
            }),
            "thread/resume" => {
                let turns = if params["excludeTurns"] == true {
                    &[][..]
                } else {
                    &history
                };
                let page = history.iter().rev().take(20).collect::<Vec<_>>();
                let thread = params["threadId"].as_str().unwrap_or(THREAD);
                let name = thread
                    .strip_prefix("catalog-")
                    .map(|suffix| {
                        if suffix == "archive" {
                            "归档会话示例".to_owned()
                        } else {
                            format!("目录会话 {suffix}")
                        }
                    })
                    .unwrap_or_else(|| title.clone());
                let directory = thread
                    .strip_prefix("catalog-")
                    .and_then(|suffix| suffix.parse::<usize>().ok())
                    .filter(|number| number % 2 == 1)
                    .map(|_| cwd.join("second-workspace"));
                let directory = directory.as_deref().unwrap_or(&cwd);
                json!({"thread":{"id":thread,"name":name,"cwd":directory,"turns":turns},
                    "initialTurnsPage":{"data":page,"nextCursor":(history.len()-20).to_string()},
                    "cwd":directory,"model":"fixture","modelProvider":"fixture","approvalPolicy":"on-request"})
            }
            "thread/turns/list" if params["threadId"] == "fixture-subagent" => {
                if params["cursor"] == "older-child" {
                    json!({"data":[{"id":"child-first","status":"completed","items":[
                        {"type":"agentMessage","id":"child-first-reply","phase":"final_answer","text":"已记录首轮检查。"}
                    ]}],"nextCursor":null})
                } else {
                    json!({"data":[child_turn],"nextCursor":"older-child"})
                }
            }
            "thread/turns/list" => {
                let end = params["cursor"]
                    .as_str()
                    .and_then(|s| s.parse::<usize>().ok())
                    .unwrap_or(history.len())
                    .min(history.len());
                let limit = params["limit"].as_u64().unwrap_or(20).min(160) as usize;
                let start = end.saturating_sub(limit);
                let page: Vec<_> = history[start..end].iter().rev().collect();
                json!({"data":page,"nextCursor":(start > 0).then(|| start.to_string())})
            }
            "review/start" => {
                let thread_id = params["threadId"].as_str().unwrap_or(THREAD).to_owned();
                let focus = match params["target"]["type"].as_str() {
                    Some("uncommittedChanges") => Some("current changes"),
                    Some("custom") => params["target"]["instructions"].as_str(),
                    _ => None,
                };
                let Some(focus) = focus.filter(|_| params["delivery"] == "inline") else {
                    send(
                        &output,
                        json!({"id":id,"error":{"message":"无效的审查范围。"}}),
                    )?;
                    continue;
                };
                if background.swap(true, Ordering::AcqRel) {
                    send(
                        &output,
                        json!({"id":id,"error":{"message":"已有任务在运行。"}}),
                    )?;
                    continue;
                }
                turn_count += 1;
                let turn = format!("live-review-{turn_count}");
                send(
                    &output,
                    json!({"id":id,"result":{"turn":{"id":turn,"status":"inProgress"},
                    "reviewThreadId":thread_id}}),
                )?;
                notice(
                    &output,
                    "item/completed",
                    json!({"threadId":thread_id,"turnId":turn,"item":{
                    "type":"enteredReviewMode","id":format!("{turn}-enter"),"review":focus}}),
                )?;
                notice(
                    &output,
                    "turn/started",
                    json!({"threadId":thread_id,"turn":{
                    "id":format!("{turn}-internal"),"rootTurnId":turn,"status":"inProgress","items":[]}}),
                )?;
                let output = output.clone();
                let running = background.clone();
                let focus = focus.to_owned();
                thread::spawn(move || {
                    let _ = inline_review(&output, &running, &thread_id, &turn, &focus);
                });
                continue;
            }
            "turn/start" => {
                let submitted = params["input"][0]["text"].as_str().unwrap_or_default();
                let retry_draft = submitted.lines().next() == Some("验证新会话草稿重试。");
                if retry_draft && !draft_send_failed {
                    draft_send_failed = true;
                    send(
                        &output,
                        json!({"id":id,"error":{"code":-32603,"message":"模拟发送失败，请重试。"}}),
                    )?;
                    continue;
                }
                if background.swap(true, Ordering::AcqRel) {
                    send(
                        &output,
                        json!({"id":id,"error":{"message":"已有任务在运行。"}}),
                    )?;
                    continue;
                }
                let thread_id = params["threadId"].as_str().unwrap_or(THREAD).to_owned();
                turn_count += 1;
                let turn = format!("live-{turn_count}");
                let started = json!({"id":turn,"status":"inProgress","items":[]});
                send(&output, json!({"id":id,"result":{"turn":started}}))?;
                notice(
                    &output,
                    "turn/started",
                    json!({"threadId":thread_id,"turn":started}),
                )?;
                let user_item = json!({"id":format!("{turn}-input"),"type":"userMessage",
                    "content":params["input"],"clientId":params["clientUserMessageId"]});
                notice(
                    &output,
                    "item/completed",
                    json!({"threadId":thread_id,"turnId":turn,"item":user_item}),
                )?;
                let fixture_reply = if retry_draft {
                    Some("草稿已成功重试。")
                } else if submitted == "整理检查结果，给出可复查的步骤。" {
                    Some(READING_REVIEW)
                } else {
                    None
                };
                if let Some(text) = fixture_reply {
                    notice(
                        &output,
                        "item/completed",
                        json!({"threadId":thread_id,"turnId":turn,"item":{"id":format!("{turn}-fixture-result"),
                            "type":"agentMessage","phase":"final_answer","text":text}}),
                    )?;
                    background.store(false, Ordering::Release);
                    notice(
                        &output,
                        "turn/completed",
                        json!({"threadId":thread_id,"turn":{"id":turn,"status":"completed","items":[]}}),
                    )?;
                    continue;
                }
                if params["input"][0]["text"] == "验证审批与表单。" {
                    notice(
                        &output,
                        "item/completed",
                        json!({"threadId":thread_id,"turnId":turn,"item":{"type":"reasoning",
                            "id":format!("{turn}-approval-summary"),"summary":["已核对待执行命令和工作目录。"]}}),
                    )?;
                    reviewed = false;
                    review = Some((turn, false));
                    continue;
                }
                if params["input"][0]["text"] == "验证任务计划。" {
                    plan_notice(&output, &thread_id, &turn, 1)?;
                    active_plan = Some(turn);
                    continue;
                }
                if params["input"][0]["text"] == "验证长回复末尾。"
                    && let Some(gate) = env::var_os("SPAN_PREVIEW_STREAM_GATE").map(PathBuf::from)
                {
                    let output = output.clone();
                    let background = background.clone();
                    thread::spawn(move || {
                        let _ = long_reply(&output, &background, &thread_id, &turn, &gate);
                    });
                    continue;
                }
                if params["input"][0]["text"] == "验证流式命令输出。"
                    && let Some(gate) = env::var_os("SPAN_PREVIEW_STREAM_GATE").map(PathBuf::from)
                {
                    let output = output.clone();
                    let background = background.clone();
                    let cwd = cwd.clone();
                    thread::spawn(move || {
                        let _ = stream_command_output(
                            &output,
                            &background,
                            &cwd,
                            &thread_id,
                            &turn,
                            &gate,
                        );
                    });
                    continue;
                }
                if params["input"][0]["text"] == "验证高频推理摘要。"
                    && let Some(gate) = env::var_os("SPAN_PREVIEW_STREAM_GATE").map(PathBuf::from)
                {
                    let output = output.clone();
                    let background = background.clone();
                    thread::spawn(move || {
                        let _ = stream_reasoning(&output, &background, &thread_id, &turn, &gate);
                    });
                    continue;
                }
                if params["input"][0]["text"] == "验证子代理导航。" {
                    for item in [
                        json!({"type":"subAgentActivity","id":format!("{turn}-review-agent"),"kind":"started",
                            "agentThreadId":"fixture-subagent","agentPath":format!("/review/{REVIEW_AGENT}"),"model":REVIEW_MODEL}),
                        json!({"type":"collabAgentToolCall","id":format!("{turn}-review-wait"),"tool":"wait","status":"completed",
                            "senderThreadId":thread_id,"receiverThreadIds":["fixture-subagent","fixture-compare"],
                            "agentsStates":{"fixture-subagent":{"status":"completed","message":"已核对键盘焦点。"},
                            "fixture-compare":{"status":"errored","message":"截图校验失败。\n需要重新采样。"}}}),
                        json!({"type":"agentMessage","id":format!("{turn}-review-result"),"phase":"final_answer","text":"代理导航验收完成。"}),
                    ] {
                        notice(
                            &output,
                            "item/completed",
                            json!({"threadId":thread_id,"turnId":turn,"item":item}),
                        )?;
                    }
                    background.store(false, Ordering::Release);
                    notice(
                        &output,
                        "turn/completed",
                        json!({"threadId":thread_id,"turn":{"id":turn,"status":"completed","items":[]}}),
                    )?;
                    continue;
                }
                if params["input"][0]["text"] == "验证连续工具活动。" {
                    notice(
                        &output,
                        "item/completed",
                        json!({"threadId":thread_id,"turnId":turn,"item":{"type":"agentMessage","id":format!("{turn}-activity-progress"),
                            "phase":"commentary","text":"# 正在核对工作区\n\n- 检查复核记录\n  - 逐项核对文件状态"}}),
                    )?;
                    for index in 1..=6 {
                        notice(
                            &output,
                            "item/completed",
                            json!({"threadId":thread_id,"turnId":turn,"item":{"type":"commandExecution","id":format!("{turn}-activity-{index}"),
                                "command":format!("git status --short -- review-{index}"),"status":"completed","exitCode":0,
                                "aggregatedOutput":format!("第 {index} 条命令的输出。")}}),
                        )?;
                    }
                    for index in 1..=2 {
                        notice(
                            &output,
                            "item/completed",
                            json!({"threadId":thread_id,"turnId":turn,"item":{"type":"dynamicToolCall","id":format!("{turn}-tool-{index}"),
                                "tool":format!("复核记录 {index}"),"namespace":"工作区",
                                "arguments":{"path":format!("review/checks/工作区检查-{index}.txt")},
                                "status":"completed","output":"记录可读。"}}),
                        )?;
                    }
                    notice(
                        &output,
                        "item/completed",
                        json!({"threadId":thread_id,"turnId":turn,"item":{"type":"commandExecution","id":format!("{turn}-failed"),
                            "command":"git diff --check -- review-missing","status":"failed","exitCode":1,"aggregatedOutput":"缺少待复核的记录。"}}),
                    )?;
                    notice(
                        &output,
                        "item/completed",
                        json!({"threadId":thread_id,"turnId":turn,"item":{"type":"fileChange","id":format!("{turn}-change"),
                            "status":"completed","changes":[{"path":"review/notes/review-notes.md","kind":{"type":"add"},
                            "diff":"@@ -0,0 +1 @@\n+已记录缺失文件。\n"}]}}),
                    )?;
                    notice(
                        &output,
                        "item/completed",
                        json!({"threadId":thread_id,"turnId":turn,"item":{"type":"agentMessage","id":format!("{turn}-activity-result"),
                            "phase":"final_answer","text":"## 连续工具活动验收完成。\n\n已记录缺少的复核文件。"}}),
                    )?;
                    background.store(false, Ordering::Release);
                    notice(
                        &output,
                        "turn/completed",
                        json!({"threadId":thread_id,"turn":{"id":turn,"status":"completed","items":[]}}),
                    )?;
                    continue;
                }
                if params["input"][0]["text"] == "验证长差异与文件切换。" {
                    notice(
                        &output,
                        "item/completed",
                        json!({"threadId":thread_id,"turnId":turn,"item":patch_sample(&turn)}),
                    )?;
                    notice(
                        &output,
                        "item/completed",
                        json!({"threadId":thread_id,"turnId":turn,"item":{"type":"agentMessage",
                            "id":format!("{turn}-patch-result"),"text":"已记录文件变更。\n\n```text\npatch preview ready\n```"}}),
                    )?;
                    background.store(false, Ordering::Release);
                    notice(
                        &output,
                        "turn/completed",
                        json!({"threadId":thread_id,"turn":{"id":turn,"status":"completed","items":[]}}),
                    )?;
                    continue;
                }
                if params["input"][0]["text"] == "验证完整命令输出。" {
                    notice(
                        &output,
                        "item/completed",
                        json!({"threadId":thread_id,"turnId":turn,"item":command_output(&turn, &cwd)}),
                    )?;
                    notice(
                        &output,
                        "item/completed",
                        json!({"threadId":thread_id,"turnId":turn,"item":{"type":"dynamicToolCall","id":format!("{turn}-tool"),
                            "tool":"核对异常项","status":"completed",
                            "output":format!("  发现一项配置异常。\n{}", "  保留后续检查记录。\n".repeat(18))}}),
                    )?;
                    let validation_dir = cwd
                        .join("validation environment")
                        .join("workbench-desktop")
                        .join("artifact review");
                    notice(
                        &output,
                        "item/completed",
                        json!({"threadId":thread_id,"turnId":turn,"item":{"id":format!("{turn}-long-command"),
                            "type":"commandExecution","command":LONG_COMMAND,"cwd":validation_dir,"status":"completed",
                            "exitCode":17,"aggregatedOutput":"检查未完成。\n"}}),
                    )?;
                    notice(
                        &output,
                        "item/completed",
                        json!({"threadId":thread_id,"turnId":turn,"item":{"type":"agentMessage","id":format!("{turn}-output-result"),
                            "text":"**检查已结束。** 命令退出码为 3，末尾记录了异常。"}}),
                    )?;
                    background.store(false, Ordering::Release);
                    notice(
                        &output,
                        "turn/completed",
                        json!({"threadId":thread_id,"turn":{"id":turn,"status":"completed","items":[]}}),
                    )?;
                    continue;
                }
                let output = output.clone();
                let background = background.clone();
                let verify_layout = params["input"][0]["text"] == "验证流式会话与底部终端。";
                thread::spawn(move || {
                    let mut answer = String::new();
                    let item = format!("{turn}-answer");
                    let summary = format!("{turn}-summary");
                    let sections = [
                        "正在核对窗口响应。

- 检查流式输出
  - 保留列表缩进",
                        "再确认工具结果和最终回复的前后顺序。",
                    ];
                    for (index, delta) in sections.into_iter().enumerate() {
                        let _ = notice(
                            &output,
                            "item/reasoning/summaryTextDelta",
                            json!({
                                "threadId":thread_id,"turnId":turn,"itemId":summary,"summaryIndex":index,"delta":delta,
                            }),
                        );
                    }
                    let _ = notice(
                        &output,
                        "item/completed",
                        json!({"threadId":thread_id,"turnId":turn,
                        "item":{"type":"reasoning","id":summary,"summary":sections}}),
                    );
                    let _ = notice(
                        &output,
                        "item/completed",
                        json!({"threadId":thread_id,"turnId":turn,
                        "item":{"type":"commandExecution","id":format!("{turn}-command"),"command":"git status --short",
                            "status":"completed","aggregatedOutput":" M prototype/ui/main.jsx","exitCode":0}}),
                    );
                    let _ = notice(
                        &output,
                        "item/completed",
                        json!({"threadId":thread_id,"turnId":turn,
                        "item":{"type":"collabAgentToolCall","id":format!("{turn}-delegate"),"tool":"spawnAgent",
                            "status":"completed","receiverThreadIds":["fixture-subagent"],
                            "agentsStates":{"fixture-subagent":{"status":"completed","message":"已检查界面。"}}}}),
                    );
                    let _ = notice(
                        &output,
                        "thread/tokenUsage/updated",
                        json!({"threadId":thread_id,"turnId":turn,
                        "tokenUsage":{"total":{"totalTokens":140,"inputTokens":100,"outputTokens":40},
                            "last":{"totalTokens":140},"modelContextWindow":512}}),
                    );
                    for (index, delta) in [
                        "**流式输出已接通。**\n\n",
                        "会话和终端可同时运行。节点发送增量，界面按帧合并。\n\n",
                        "| 检查 | 结果 |\n| --- | --- |\n| 会话历史 | 可加载 |\n",
                        "| 终端 | 可输入 |\n\n",
                        "```sh\nprintf '%s\\n' 'Span preview'\n```\n",
                    ]
                    .into_iter()
                    .cycle()
                    .take(if verify_layout { 240 } else { 150 })
                    .enumerate()
                    {
                        thread::sleep(Duration::from_millis(40));
                        if !background.load(Ordering::Acquire) {
                            break;
                        }
                        if let Some(delta) = match index {
                            16 => Some("检查窄窗口的对齐。"),
                            42 => Some("\n确认目标卡片和输入区之间的间距。"),
                            _ => None,
                        } {
                            let _ = notice(
                                &output,
                                "item/reasoning/summaryTextDelta",
                                json!({"threadId":thread_id,"turnId":turn,
                                    "itemId":format!("{turn}-layout"),"summaryIndex":0,"delta":delta}),
                            );
                        }
                        let piece = if index < 5 { delta } else { "·" };
                        answer.push_str(piece);
                        if notice(
                            &output,
                            "item/agentMessage/delta",
                            json!({"threadId":thread_id,"turnId":turn,"itemId":item,"delta":piece}),
                        )
                        .is_err()
                        {
                            return;
                        }
                    }
                    let done = background.swap(false, Ordering::AcqRel);
                    let _ = notice(
                        &output,
                        "item/completed",
                        json!({"threadId":thread_id,"turnId":turn,
                        "item":{"type":"agentMessage","id":item,"text":answer}}),
                    );
                    let _ = notice(
                        &output,
                        "turn/completed",
                        json!({"threadId":thread_id,
                        "turn":{"id":turn,"status": if done {"completed"} else {"interrupted"},"items":[]}}),
                    );
                });
                continue;
            }
            "turn/interrupt" => {
                if let Some(gate) = env::var_os("SPAN_PREVIEW_STREAM_GATE").map(PathBuf::from)
                    && gate.join("hold-stop").is_file()
                {
                    fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(gate.join("stop-requests"))?
                        .write_all(b"1")?;
                    if fs::remove_file(gate.join("fail-stop")).is_ok() {
                        send(
                            &output,
                            json!({"id":id,"error":{"code":-32603,"message":"模拟停止请求失败"}}),
                        )?;
                        continue;
                    }
                    if let Some(turn) = active_plan.take() {
                        let output = output.clone();
                        let background = background.clone();
                        let thread_id = params["threadId"].clone();
                        thread::spawn(move || {
                            if wait_for_stream_gate(&gate.join("release-stop"), &background) {
                                background.store(false, Ordering::Release);
                                let _ = notice(
                                    &output,
                                    "turn/completed",
                                    json!({"threadId":thread_id,"turn":{"id":turn,"status":"interrupted","items":[]}}),
                                );
                            }
                        });
                    }
                    send(&output, json!({"id":id,"result":{}}))?;
                    continue;
                }
                background.store(false, Ordering::Release);
                if let Some(turn) = active_plan.take() {
                    notice(
                        &output,
                        "turn/completed",
                        json!({"threadId":params["threadId"],"turn":{"id":turn,"status":"interrupted","items":[]}}),
                    )?;
                }
                json!({})
            }
            "turn/steer" => {
                let turn = &params["expectedTurnId"];
                let thread_id = params["threadId"].as_str().unwrap_or(THREAD);
                notice(
                    &output,
                    "item/completed",
                    json!({"threadId":thread_id,"turnId":turn,
                    "item":{"id":format!("steer-{}",params["clientUserMessageId"]),"type":"userMessage",
                        "content":params["input"],"clientId":params["clientUserMessageId"]}}),
                )?;
                if let Some(plan_turn) = active_plan
                    .as_deref()
                    .filter(|plan| Some(*plan) == turn.as_str())
                {
                    match params["input"][0]["text"].as_str() {
                        Some("推进计划。") => plan_notice(&output, thread_id, plan_turn, 2)?,
                        Some("完成计划。") => {
                            plan_notice(&output, thread_id, plan_turn, 3)?;
                            notice(
                                &output,
                                "item/completed",
                                json!({"threadId":thread_id,"turnId":turn,"item":{"id":format!("{plan_turn}-plan-result"),
                                    "type":"agentMessage","phase":"final_answer","text":"计划验收完成。"}}),
                            )?;
                            background.store(false, Ordering::Release);
                            active_plan = None;
                            notice(
                                &output,
                                "turn/completed",
                                json!({"threadId":thread_id,"turn":{"id":turn,"status":"completed","items":[]}}),
                            )?;
                        }
                        _ => {}
                    }
                }
                json!({"turnId":turn})
            }
            "thread/goal/get" => json!({"goal":goal}),
            "thread/goal/set" => {
                if let Some(objective) = params["objective"].as_str() {
                    if objective == "验收延迟目标保存。"
                        && let Some(gate) =
                            env::var_os("SPAN_PREVIEW_STREAM_GATE").map(PathBuf::from)
                    {
                        goal["tokensUsed"] = json!(320);
                        notice(
                            &output,
                            "thread/goal/updated",
                            json!({"threadId":THREAD,"goal":goal}),
                        )?;
                        if !wait_for_stream_gate(&gate.join("goal-save"), &AtomicBool::new(true)) {
                            send(
                                &output,
                                json!({"id":id,"error":{"code":-32603,"message":"目标保存验收超时。"}}),
                            )?;
                            continue;
                        }
                    }
                    if goal.is_null() {
                        goal = json!({"status":"active","tokensUsed":0,"tokenBudget":null});
                    }
                    goal["objective"] = json!(objective);
                }
                if !goal.is_null() {
                    if let Some(status) = params["status"].as_str() {
                        goal["status"] = json!(status);
                    }
                    if let Some(budget) = params.get("tokenBudget") {
                        goal["tokenBudget"] = budget.clone();
                    }
                }
                notice(
                    &output,
                    "thread/goal/updated",
                    json!({"threadId":THREAD,"goal":goal}),
                )?;
                json!({"goal":goal})
            }
            "thread/goal/clear" => {
                goal = Value::Null;
                notice(&output, "thread/goal/cleared", json!({"threadId":THREAD}))?;
                json!({"cleared":true})
            }
            "thread/name/set" => {
                if params["name"] == "本次重命名失败" {
                    send(
                        &output,
                        json!({"id":id,"error":{"code":-32603,"message":"重命名未保存。"}}),
                    )?;
                    continue;
                }
                title = params["name"].as_str().unwrap_or(TITLE).to_owned();
                notice(
                    &output,
                    "thread/name/updated",
                    json!({"threadId":THREAD,"threadName":title}),
                )?;
                json!({})
            }
            "thread/archive" | "thread/unarchive" if params["threadId"] == THREAD => {
                is_archived = packet["method"] == "thread/archive";
                json!({})
            }
            "model/list" => {
                json!({"data":[{"id":"fixture","model":"fixture","displayName":"Fixture",
                "isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"medium"}],
                "serviceTiers":[{"id":"priority","name":"Fast"}],"inputModalities":["text","image"]}]})
            }
            "account/rateLimits/read" => {
                if let Some((turn, prompted)) = review.as_mut() {
                    if !*prompted {
                        approval_requests(&output, turn, &cwd)?;
                        *prompted = true;
                    }
                }
                let mut rates = json!({"rateLimits":{"limitId":"codex","limitName":"Codex",
                    "primary":{"usedPercent":24,"windowDurationMins":300}},
                    "rateLimitsByLimitId":{"workbench-review":{"limitId":"workbench-review",
                        "limitName":"工作区批量处理与多轮长输出审阅的项目共享额度与连续交付窗口",
                        "secondary":{"usedPercent":92,"windowDurationMins":10080,"resetsAt":1795670400}}}});
                if let Some(gate) = env::var_os("SPAN_PREVIEW_STREAM_GATE").map(PathBuf::from) {
                    let live = gate.join("usage-live-update").is_file();
                    let context_only = gate.join("usage-context-only").is_file();
                    if live {
                        rates["rateLimits"]["primary"]["usedPercent"] = json!(67);
                        notice(&output, "account/rateLimits/updated", rates.clone())?;
                        rates["rateLimits"]["primary"]["usedPercent"] = json!(31);
                    }
                    if (live || context_only)
                        && !wait_for_stream_gate(&gate.join("usage-reply"), &AtomicBool::new(true))
                    {
                        send(
                            &output,
                            json!({"id":id,"error":{"code":-32603,"message":"用量验收超时。"}}),
                        )?;
                        continue;
                    }
                    if context_only {
                        notice(
                            &output,
                            "thread/tokenUsage/updated",
                            json!({"threadId":THREAD,"tokenUsage":{"modelContextWindow":512}}),
                        )?;
                        rates = json!({});
                    }
                }
                rates
            }
            "mcpServerStatus/list" => {
                if params["cursor"] == "mcp-next" {
                    if let Some(gate) = env::var_os("SPAN_PREVIEW_STREAM_GATE").map(PathBuf::from)
                        && fs::remove_file(gate.join("mcp-next-error")).is_ok()
                    {
                        send(
                            &output,
                            json!({"id":id,"error":{"code":-32603,"message":"模拟读取下一页失败"}}),
                        )?;
                        continue;
                    }
                    json!({"data":[{"name":"归档服务","authStatus":"unsupported","tools":{}}],"nextCursor":null})
                } else {
                    let tools = (1..=42)
                        .map(|index| (format!("document_tool_{index:02}"), json!({})))
                        .collect::<serde_json::Map<_, _>>();
                    json!({"data":[
                        {"name":"团队文档与历史记录检索服务","authStatus":"oAuth","runtimeStatus":"connected","tools":tools},
                        {"name":"缺陷跟踪服务","authStatus":"notLoggedIn","runtimeStatus":"authenticationRequired",
                            "tools":{},"toolsError":"登录已过期，请重新授权后读取工具。"}
                    ],"nextCursor":"mcp-next"})
                }
            }
            "skills/list" if params["cwds"] == json!([cwd]) => {
                let mut skills = vec![
                    json!({
                        "name":"workspace-review", "path":cwd.join(".agents/skills/workspace-review/SKILL.md"),
                        "description":"核对改动与测试证据。", "scope":"repo", "enabled":true,
                        "interface":{"displayName":"工作区复核", "shortDescription":"核对改动、测试证据和交付记录。"}
                    }),
                    json!({
                        "name":"offline-handbook", "path":cwd.join(".agents/skills/offline-handbook/SKILL.md"),
                        "description":"已停用的交接说明。", "scope":"user", "enabled":false
                    }),
                ];
                skills.extend((1..=32).map(|index| json!({
                    "name":format!("workspace-checklist-{index:02}"),
                    "path":cwd.join(format!(".agents/skills/checklist-{index:02}/SKILL.md")),
                    "description":format!("核对交接清单 {index:02} 的记录。"), "scope":"repo", "enabled":true
                })));
                json!({"data":[{"cwd":cwd,"skills":skills,"errors":[]}]})
            }
            "app/list" | "skills/list" => json!({"data":[],"nextCursor":null}),
            "command/exec" if params["cwd"] == json!(cwd) => {
                let command = params["command"].as_array().expect("command arguments");
                if command.ends_with(&[json!("HEAD"), json!("--")]) {
                    let patch = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-旧的工作区说明\n+新的工作区说明\n";
                    json!({"exitCode":0,"stdout":patch,"stderr":""})
                } else {
                    json!({"exitCode":0,"stdout":"docs/检查记录.md\0docs/空间 目录.md\0","stderr":""})
                }
            }
            "command/exec" => json!({"exitCode":1,"stdout":"","stderr":"Git 工作目录不匹配。"}),
            _ => json!({}),
        };
        send(&output, json!({"id":id,"result":result}))?;
    }
    Ok(())
}
