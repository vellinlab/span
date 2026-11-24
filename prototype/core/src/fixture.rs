use super::{Output, Result, send};
use serde_json::{Value, json};
use std::{
    env,
    io::{self, BufRead, BufWriter},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

const THREAD: &str = "workspace-review";
const TITLE: &str = "工作台架构评审";

fn history() -> Vec<Value> {
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
            let items = if number == 1 || number == 160 {
                vec![
                    json!({"id":format!("question-{number}"),"type":"userMessage",
                        "content":[{"type":"text","text":"请检查长会话、终端和文件预览的表现。"}]}),
                    json!({"id":format!("result-{number}"),"type":"agentMessage","text":reply}),
                ]
            } else {
                vec![json!({"id":format!("result-{number}"),"type":"agentMessage","text":reply})]
            };
            json!({"id":format!("review-{number}"),"status":"completed","items":items})
        })
        .collect()
}

fn notice(output: &Output, method: &str, params: Value) -> io::Result<()> {
    send(output, json!({"method":method,"params":params}))
}

pub fn run() -> Result<()> {
    let output = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let cwd = env::current_dir()?;
    let history = history();
    let background = Arc::new(AtomicBool::new(false));
    let mut turn_count = 0;
    let mut goal = Value::Null;
    let mut title = TITLE.to_owned();
    for line in io::stdin().lock().lines() {
        let packet: Value = serde_json::from_str(&line?)?;
        let id = &packet["id"];
        if id.is_null() {
            continue;
        }
        let params = &packet["params"];
        let result = match packet["method"].as_str().unwrap_or_default() {
            "initialize" => json!({"userAgent":"Span preview fixture"}),
            "thread/list" => {
                json!({"data":[{"id":THREAD,"name":title,"cwd":cwd,"preview":TITLE,
                    "gitInfo":{"branch":"prototype/web-workbench"}}],"nextCursor":null})
            }
            "thread/start" | "thread/resume" => {
                let turns = if params["excludeTurns"] == true {
                    &[][..]
                } else {
                    &history
                };
                let page = history.iter().rev().take(20).collect::<Vec<_>>();
                json!({"thread":{"id":THREAD,"name":title,"cwd":cwd,"turns":turns},
                    "initialTurnsPage":{"data":page,"nextCursor":(history.len()-20).to_string()},
                    "cwd":cwd,"model":"fixture","modelProvider":"fixture","approvalPolicy":"on-request"})
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
            "turn/start" => {
                if background.swap(true, Ordering::AcqRel) {
                    send(
                        &output,
                        json!({"id":id,"error":{"message":"已有任务在运行。"}}),
                    )?;
                    continue;
                }
                turn_count += 1;
                let turn = format!("live-{turn_count}");
                let started = json!({"id":turn,"status":"inProgress","items":[]});
                send(&output, json!({"id":id,"result":{"turn":started}}))?;
                notice(
                    &output,
                    "turn/started",
                    json!({"threadId":THREAD,"turn":started}),
                )?;
                let user_item = json!({"id":format!("{turn}-input"),"type":"userMessage",
                    "content":params["input"],"clientId":params["clientUserMessageId"]});
                notice(
                    &output,
                    "item/completed",
                    json!({"threadId":THREAD,"turnId":turn,"item":user_item}),
                )?;
                let output = output.clone();
                let background = background.clone();
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
                                "threadId":THREAD,"turnId":turn,"itemId":summary,"summaryIndex":index,"delta":delta,
                            }),
                        );
                    }
                    let _ = notice(
                        &output,
                        "item/completed",
                        json!({"threadId":THREAD,"turnId":turn,
                        "item":{"type":"reasoning","id":summary,"summary":sections}}),
                    );
                    let _ = notice(
                        &output,
                        "item/completed",
                        json!({"threadId":THREAD,"turnId":turn,
                        "item":{"type":"commandExecution","id":format!("{turn}-command"),"command":"git status --short",
                            "status":"completed","aggregatedOutput":" M prototype/ui/main.jsx","exitCode":0}}),
                    );
                    let _ = notice(
                        &output,
                        "item/completed",
                        json!({"threadId":THREAD,"turnId":turn,
                        "item":{"type":"collabAgentToolCall","id":format!("{turn}-delegate"),"tool":"spawnAgent",
                            "status":"completed","receiverThreadIds":["fixture-subagent"],
                            "agentsStates":{"fixture-subagent":{"status":"completed","message":"已检查界面。"}}}}),
                    );
                    let _ = notice(
                        &output,
                        "thread/tokenUsage/updated",
                        json!({"threadId":THREAD,"turnId":turn,
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
                    .take(150)
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
                                json!({"threadId":THREAD,"turnId":turn,
                                    "itemId":format!("{turn}-layout"),"summaryIndex":0,"delta":delta}),
                            );
                        }
                        let piece = if index < 5 { delta } else { "·" };
                        answer.push_str(piece);
                        if notice(
                            &output,
                            "item/agentMessage/delta",
                            json!({"threadId":THREAD,"turnId":turn,"itemId":item,"delta":piece}),
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
                        json!({"threadId":THREAD,"turnId":turn,
                        "item":{"type":"agentMessage","id":item,"text":answer}}),
                    );
                    let _ = notice(
                        &output,
                        "turn/completed",
                        json!({"threadId":THREAD,
                        "turn":{"id":turn,"status": if done {"completed"} else {"interrupted"},"items":[]}}),
                    );
                });
                continue;
            }
            "turn/interrupt" => {
                background.store(false, Ordering::Release);
                json!({})
            }
            "turn/steer" => {
                let turn = &params["expectedTurnId"];
                notice(
                    &output,
                    "item/completed",
                    json!({"threadId":THREAD,"turnId":turn,
                    "item":{"id":format!("steer-{}",params["clientUserMessageId"]),"type":"userMessage",
                        "content":params["input"],"clientId":params["clientUserMessageId"]}}),
                )?;
                json!({"turnId":turn})
            }
            "thread/goal/get" => json!({"goal":goal}),
            "thread/goal/set" => {
                if let Some(objective) = params["objective"].as_str() {
                    goal = json!({"objective":objective,"tokenBudget":params["tokenBudget"],"tokensUsed":0});
                }
                if !goal.is_null() {
                    goal["status"] = params["status"].clone();
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
                title = params["name"].as_str().unwrap_or(TITLE).to_owned();
                notice(
                    &output,
                    "thread/name/updated",
                    json!({"threadId":THREAD,"threadName":title}),
                )?;
                json!({})
            }
            "model/list" => {
                json!({"data":[{"id":"fixture","model":"fixture","displayName":"Fixture",
                "isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"medium"}],
                "serviceTiers":[{"id":"priority","name":"Fast"}],"inputModalities":["text"]}]})
            }
            "account/rateLimits/read" => {
                json!({"rateLimits":{"limitId":"codex","limitName":"Codex",
                "primary":{"usedPercent":24,"windowDurationMins":300}}})
            }
            "app/list" | "skills/list" => json!({"data":[],"nextCursor":null}),
            _ => json!({}),
        };
        send(&output, json!({"id":id,"result":result}))?;
    }
    Ok(())
}
