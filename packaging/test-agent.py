#!/usr/bin/env python3
"""Deterministic App Server peer for the native GUI smoke test."""

import json
import os
import socket
import stat
import sys
import threading
import time
from pathlib import Path

home = Path(os.environ.get("SPAN_BENCH_FIXTURE_HOME", os.environ["HOME"]))
control_socket = Path(os.environ.get("CODEX_HOME", home / ".codex")) / "app-server-control/app-server-control.sock"
thread = "preview-thread"
saved_thread = "stored-deployment"
turn = "preview-turn"
item = "preview-message"
interruptible_turn = "comparison-turn"
continued_turn = "comparison-continued"
diff = "diff --git a/checks.txt b/checks.txt\n--- a/checks.txt\n+++ b/checks.txt\n@@ -1 +1 @@\n-pending\n+passed\n"
reply = """## Deployment checklist

[Build documentation](https://example.invalid/span/docs?from=agent&view=build)

要确认当前构建结果，请阅读[GitHub 发布说明](https://example.invalid/span/notes?lang=zh&view=full)。

| Check | Result |
| --- | --- |
| Build | Passed |
| Integration | 12 passed |

```bash
target=staging
deploy --target "$target" --check-only
```

```mermaid
flowchart LR
A[Inspect] --> B[Test] --> C[Publish]
```

![Preview image](test-output.png)
"""
comparison = """| 框架 | 多 Agent | 会话恢复 | 主动打断 | 可观测性 | 使用场景 |
| --- | --- | --- | --- | --- | --- |
| AgentScope | 支持多角色对话、并发执行、消息路由和转交 | 会话状态可保存与加载，应用可自行定义恢复点和会话状态的保留时间 | 支持在模型生成或工具执行期间主动打断 | 可通过 OpenTelemetry 查看执行链路 | 适合需要人与多个角色协作、核对中间结果并及时调整方向的任务。部署前需要验证应用能否按预期保存关键步骤，以及断开连接后怎样恢复已有结果。比较时也要查看不同运行环境的实现，包括多语言内容、表格列宽和不同终端尺寸下的换行效果。 |
"""
interrupted = False
steer_attempted = False

def model(slug, name, default, efforts):
    return {"model": slug, "id": slug, "displayName": name, "inputModalities": ["text", "image"],
            "defaultReasoningEffort": default, "supportedReasoningEfforts": [
                {"reasoningEffort": effort} for effort in efforts]}


def send(value):
    print(json.dumps(value), flush=True)


def entry(identifier, name, project, state="idle"):
    return {"id": identifier, "name": name, "cwd": str(home / project),
            "status": {"type": state}}


def stored_turn(identifier, text):
    return {"id": identifier, "status": "completed", "items": [
        {"id": identifier + "-message", "type": "agentMessage", "text": text},
        {"id": identifier + "-reasoning", "type": "reasoning", "summary": ["Checked the saved deployment plan."],
         "content": ["fixture raw reasoning sentinel"]},
        {"id": identifier + "-command", "type": "commandExecution", "command": "printf archived",
         "status": "completed", "exitCode": 0, "aggregatedOutput": "Historical command output\n" * 200},
        {"id": identifier + "-change", "type": "fileChange", "changes": [
            {"path": "checks.txt", "diff": diff}]}]}


def run_proxy():
    with socket.socket(socket.AF_UNIX) as peer:
        peer.connect(str(control_socket))
        (home / "shared-proxy.pid").write_text(str(os.getpid()))

        def forward():
            while chunk := os.read(0, 65536):
                peer.sendall(chunk)
            peer.shutdown(socket.SHUT_WR)

        threading.Thread(target=forward, daemon=True).start()
        while chunk := peer.recv(65536):
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()


async def serve_shared():
    import asyncio
    import websockets

    async def forward_requests(websocket, process):
        async for request in websocket:
            process.stdin.write(request.encode() + b"\n")
            await process.stdin.drain()

    async def forward_events(websocket, process):
        async for line in process.stdout:
            await websocket.send(line.decode().rstrip("\n"))

    async def connection(websocket):
        process = await asyncio.create_subprocess_exec(
            sys.executable, __file__, "shared-stdio",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, limit=64 * 1024 * 1024,
        )
        requests = asyncio.create_task(forward_requests(websocket, process))
        events = asyncio.create_task(forward_events(websocket, process))
        _, pending = await asyncio.wait([requests, events], return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        process.stdin.close()
        await process.wait()
        await asyncio.gather(requests, events, return_exceptions=True)

    control_socket.parent.mkdir(parents=True, exist_ok=True)
    async with websockets.unix_serve(connection, str(control_socket)):
        await asyncio.Future()


args = sys.argv[1:]
if args == ["app-server", "proxy"]:
    run_proxy()
    sys.exit()
if args == ["serve-shared"]:
    import asyncio
    asyncio.run(serve_shared())
    sys.exit()
shared = args == ["shared-stdio"]
assert shared or (args == ["app-server"] and not control_socket.exists())
plugin_installed = False
connector_enabled = True
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    params = request.get("params", {})
    request_id = request.get("id")
    if method == "initialize":
        assert params["clientInfo"]["name"] == "span"
        assert params["clientInfo"]["title"] == "Span"
        assert params["capabilities"]["experimentalApi"]
        send({"id": request_id, "result": {"userAgent": "span/0.169.1 (fixture)"}})
    elif method == "initialized":
        continue
    elif method == "plugin/list":
        assert "marketplaceKinds" not in params
        name = "Remote Fixture Plugin" if shared else "Local Fixture Plugin"
        item = {"id": "fixture@fixture-catalog", "name": "fixture",
                "source": {"type": "remote"}, "interface": {"displayName": name},
                "installed": plugin_installed, "enabled": plugin_installed,
                "mustShowInstallationInterstitial": shared,
                "installPolicy": "AVAILABLE", "authPolicy": "ON_USE"}
        others = [dict(item, id=f"sample-{n}@fixture", name=f"sample-{n}", interface={"displayName": f"Directory sample {n}"}) for n in range(60)]
        if not (home / "large-directory-sent").exists():
            item["interface"]["screenshotUrls"] = ["data:image/png;base64," + "A" * 40_652_012]
            (home / "large-directory-sent").touch()
        send({"id": request_id, "result": {"featuredPluginIds": [item["id"]], "marketplaces": [
            {"name": "fixture-catalog", "path": None, "plugins": [item] + others}]}})
    elif method == "plugin/read":
        assert shared and params == {"pluginName": "fixture", "remoteMarketplaceName": "fixture-catalog"}
        send({"id": request_id, "result": {"plugin": {"description": "Remote plugin details",
              "skills": [{"name": "Fixture skill"}]}}})
    elif method == "plugin/install":
        assert params == {"pluginName": "fixture", "remoteMarketplaceName": "fixture-catalog"}
        plugin_installed = True
        (home / "plugin-installed").touch()
        send({"id": request_id, "result": {"authPolicy": "ON_USE", "appsNeedingAuth": []}})
    elif method == "plugin/uninstall":
        assert plugin_installed and params == {"pluginId": "fixture@fixture-catalog"}
        plugin_installed = False
        (home / "plugin-uninstalled").touch()
        send({"id": request_id, "result": {}})
    elif method == "app/list":
        assert params["limit"] == 50
        if params["cursor"] is None:
            data = [{"id": "fixture_app", "name": "ChatGPT Space", "description": "Search and edit your pages and spaces.",
                     "isAccessible": True, "isEnabled": connector_enabled}]
            data.extend([
                {"id": "github", "name": "GitHub", "description": "Inspect repositories and pull requests.", "isAccessible": True},
                {"id": "google_drive", "name": "Google Drive", "description": "Search documents, sheets and slides.", "isAccessible": True},
                {"id": "notion", "name": "Notion", "description": "Find pages and update databases.\n\nMCP server instructions: fixture internal text", "isAccessible": True},
                {"id": "pets", "name": "Pets", "description": "Create animated companions.", "isAccessible": False},
            ])
            next_cursor = "fixture-page-2"
        else:
            assert params["cursor"] == "fixture-page-2"
            data = [{"id": "fixture_new", "name": "Another Connector", "isAccessible": False,
                     "installUrl": "https://example.invalid/connect"}]
            next_cursor = None
        send({"id": request_id, "result": {"data": data, "nextCursor": next_cursor}})
    elif method == "config/batchWrite":
        assert params == {"edits": [{"keyPath": "apps.fixture_app.enabled", "value": False,
                                     "mergeStrategy": "upsert"}], "reloadUserConfig": True}
        connector_enabled = False
        send({"id": request_id, "result": {}})
    elif method in ("thread/goal/get", "thread/goal/set", "thread/goal/clear"):
        thread_id = params["threadId"]
        assert thread_id in (thread, saved_thread, "fork-slash-fixture", "new-slash-fixture")
        goal_file = home / ("goal-" + thread_id + ".json")
        goal = json.loads(goal_file.read_text()) if goal_file.exists() else None
        if method == "thread/goal/set":
            assert params["origin"] == "user"
            if params.get("objective") == "Goal rejected by fixture":
                send({"id": request_id, "error": {"code": -32602, "message": "Fixture goal rejected"}})
                continue
            goal = {"objective": params.get("objective") or goal["objective"], "status": params["status"]}
            goal_file.write_text(json.dumps(goal))
        if method == "thread/goal/clear":
            assert params["origin"] == "user" and goal
            goal_file.unlink()
            send({"id": request_id, "result": {"cleared": True}})
        else:
            send({"id": request_id, "result": {"goal": goal}})
    elif method == "thread/start":
        assert params["sandbox"] == "workspace-write"
        assert params["approvalPolicy"] == "on-request"
        started_thread = "new-slash-fixture" if shared else thread
        turns = []
        if os.environ.get("SPAN_BENCH_HISTORY") == "1":
            label = "会话性能测量"
            if os.environ.get("SPAN_BENCH_TABS") == "1":
                for number in range(1, 4):
                    try:
                        (home / f"bench-tab-{number}").touch(exist_ok=False)
                    except FileExistsError:
                        continue
                    label = f"会话 {number} 性能测量"
                    started_thread = f"benchmark-thread-{number}"
                    break
                else:
                    raise AssertionError("The multitab benchmark opened an unexpected session")
            for n in range(4):
                paragraphs = [f"{n+1}.{i+1} {label} · 项目进展。 "
                              f"Workspace status for task {i}. [参考资料](https://example.invalid/{i}) "
                              + "保留中英文换行与选择。 " * 4 for i in range(80)]
                turns.append({"id": f"turn-{n}", "status": "completed", "items": [
                    {"id": f"reply-{n}", "type": "agentMessage", "text": "\n\n".join(paragraphs)}]})
        if os.environ.get("SPAN_BENCH_TABLE") == "1":
            header = ("| 任务 | Workspace | 进展 | 参考资料 | 说明 |\n"
                      "| --- | --- | --- | --- | --- |")
            rows = [f"| 任务 {i} | Workspace {i} | 已验证第 {i} 项 | "
                    f"[资料 {i}](https://example.invalid/{i}) | 中英文混排并随窗口换行。 |"
                    for i in range(1, 97)]
            turns = [{"id": "table-turn", "status": "completed", "items": [
                {"id": "table-reply", "type": "agentMessage", "text": "\n".join([header] + rows)}]}]
        if os.environ.get("SPAN_BENCH_TOOLS") == "1":
            for n in range(16):
                items = [{"id": f"request-{n}", "type": "userMessage", "content": [
                    {"type": "text", "text": f"任务 {n} · Check the workspace and report the results."}]}]
                for tool in range(6):
                    items.append({"id": f"exec-{n}-{tool}", "type": "commandExecution",
                                  "command": f"check-task {n} {tool}", "status": "completed",
                                  "exitCode": 0, "aggregatedOutput": "Task diagnostics and results\n" * 320})
                    items.append({"id": f"change-{n}-{tool}", "type": "fileChange", "changes": [
                        {"path": f"checks-{n}-{tool}.txt", "diff": diff}]})
                items.append({"id": f"tool-reply-{n}", "type": "agentMessage",
                              "text": f"## 工具执行记录 · Task {n}\n\n" +
                                      "已完成检查。 Review the command output and diff above. " * 9})
                turns.append({"id": f"tool-turn-{n}", "status": "completed", "items": items})
        send({"id": request_id, "result": {"thread": {"id": started_thread, "turns": turns},
                                          "cwd": str(home), "model": "gpt-base-fixture",
                                          "sandbox": {"type": "workspaceWrite", "networkAccess": False},
                                          "approvalPolicy": "on-request",
                                          "modelProvider": "fixture", "reasoningEffort": "low"}})
        (home / "agent-ready").touch()
    elif method == "model/list":
        assert params["modelProvider"] == "fixture" and params["limit"] == 50
        if params.get("cursor") is None:
            data = [model("gpt-base-fixture", "GPT Base", "low", ["low"])]
            next_cursor = "fixture-vision"
        else:
            assert params["cursor"] == "fixture-vision"
            data = [model("gpt-vision-fixture", "GPT Vision", "medium", ["medium", "high"])]
            data[0]["serviceTiers"] = [{"id": "priority", "name": "Fast", "description": "Fast"}]
            next_cursor = None
            (home / "agent-models").touch()
        send({"id": request_id, "result": {"data": data, "nextCursor": next_cursor}})
    elif method == "account/rateLimits/read":
        send({"id": request_id, "result": {"rateLimits": {"limitId": "codex",
            "planType": "pro", "credits": {"hasCredits": False, "unlimited": False, "balance": "0"},
            "primary": {"usedPercent": 17, "windowDurationMins": 300},
            "secondary": {"usedPercent": 31, "windowDurationMins": 10080}}}})
    elif method == "thread/list":
        assert params["limit"] == 30 and params["sortKey"] == "updated_at"
        if os.environ.get("SPAN_BENCH_CATALOG_PAGES") == "1" and not params["searchTerm"]:
            page = int(params.get("cursor") or 0)
            assert 0 <= page <= 8
            first = page * 29
            indices = list(range(first, first + 29))
            if page:
                indices.insert(0, first - 1)
            results = [entry(f"catalog-{n}", f"Catalog entry #{n:03d}",
                             f"Projects/Section {n % (3 if n >= 87 else 2) + 1}") for n in indices]
            (home / f"catalog-page-{page}").touch()
            send({"id": request_id, "result": {
                "data": results, "nextCursor": str(page + 1) if page < 8 else None}})
            continue
        with (home / "agent-catalog-requests").open("a") as requests:
            print(os.getpid(), file=requests)
        results = [entry(saved_thread, "Deployment rollout", "Projects/Operations"),
                   entry(thread, "Release checklist", "Projects/Operations"),
                   entry("archive-notes", "Build notes", "Projects/Platform")]
        if os.environ.get("SPAN_BENCH_CATALOG") == "1":
            results = [entry(f"benchmark-entry-{index}", f"{os.getpid()} · 事项 {index + 1}",
                             f"Projects/Group {index // 10 + 1}") for index in range(30)]
        search = params["searchTerm"] or ""
        results = [entry for entry in results if search.lower() in entry["name"].lower()]
        send({"id": request_id, "result": {"data": results, "nextCursor": None}})
        (home / ("agent-searched" if search else "agent-catalog")).touch()
    elif method == "thread/resume":
        assert params["threadId"] == saved_thread and params["excludeTurns"]
        assert all(field not in params for field in ("sandbox", "approvalPolicy", "approvalsReviewer"))
        assert params["initialTurnsPage"] == {"limit": 4, "sortDirection": "desc", "itemsView": "full"}
        send({"id": request_id, "result": {"thread": entry(saved_thread, "Deployment rollout", "Projects/Operations"),
              "model": "gpt-base-fixture", "modelProvider": "fixture", "reasoningEffort": "low",
              "sandbox": {"type": "readOnly", "networkAccess": False}, "approvalPolicy": "never",
              "initialTurnsPage": {"data": [stored_turn("saved-turn", "Latest deployment notes")],
                                   "nextCursor": "older-cursor"}}})
        with (home / "agent-resumed").open("a") as resumes:
            print(saved_thread, file=resumes)
        if shared:
            external_turn = {"id": "external-turn", "status": "inProgress"}
            send({"method": "turn/started", "params": {"threadId": saved_thread, "turn": external_turn}})
            event = {"threadId": saved_thread, "turnId": external_turn["id"]}
            send({"method": "item/completed", "params": {**event, "item": {
                "id": "external-input", "type": "userMessage", "clientId": None,
                "content": [{"type": "text", "text": "Check the rollout from my other device."}]}}})
            send({"method": "item/completed", "params": {**event, "item": {
                "id": "external-reply", "type": "agentMessage", "text": "The shared rollout is healthy."}}})
            send({"method": "turn/completed", "params": {"threadId": saved_thread,
                  "turn": {**external_turn, "status": "completed"}}})
    elif method == "thread/unsubscribe":
        assert params["threadId"] in (thread, saved_thread, "fork-slash-fixture", "new-slash-fixture")
        send({"id": request_id, "result": {"status": "unsubscribed"}})
    elif method == "thread/name/set":
        assert shared
        assert (params["threadId"], params["name"]) in (
            ("fork-slash-fixture", "Reviewed fork"), ("new-slash-fixture", "Fresh checklist"))
        (home / "slash-rename").write_text(params["name"])
        send({"id": request_id, "result": {}})
    elif method == "thread/fork":
        assert shared and params == {"threadId": saved_thread, "excludeTurns": True}
        send({"id": request_id, "result": {
            "thread": {"id": "fork-slash-fixture", "turns": [stored_turn("forked-turn", "Forked chat history")]},
            "cwd": str(home), "model": "gpt-base-fixture", "modelProvider": "fixture"}})
    elif method in ("review/start", "thread/compact/start"):
        assert shared and params["threadId"] == saved_thread
        review = method == "review/start"
        if review:
            assert params["target"] == {"type": "baseBranch", "branch": "main"}
        special = "slash-review" if review else "slash-compact"
        run = {"id": special, "status": "inProgress"}
        send({"id": request_id, "result": {"turn": run, "reviewThreadId": saved_thread} if review else {}})
        send({"method": "turn/started", "params": {"threadId": saved_thread, "turn": run}})
        item = ({"id": special, "type": "exitedReviewMode", "review": "Native review completed."}
                if review else {"id": special, "type": "contextCompaction"})
        send({"method": "item/completed", "params": {
            "threadId": saved_thread, "turnId": special, "item": item}})
        send({"method": "turn/completed", "params": {"threadId": saved_thread,
              "turn": {"id": special, "status": "completed"}}})
        (home / special).touch()
    elif method == "mcpServerStatus/list":
        assert shared and params["threadId"] == saved_thread and params["limit"] == 50
        send({"id": request_id, "result": {"data": [{"name": "Fixture MCP", "authStatus": "unsupported",
              "tools": {"fixture_search": {}}}], "nextCursor": None}})
    elif method == "command/exec":
        assert shared and params["cwd"] == str(home / "Projects/Operations") and params["timeoutMs"] == 10000
        if params["command"][2] == "diff":
            assert params["command"] == ["git", "--no-pager", "diff", "--no-color",
                                         "--no-ext-diff", "--no-textconv", "HEAD", "--"]
            output = diff
        else:
            assert params["command"] == ["git", "ls-files", "--others", "--exclude-standard"]
            output = "new-slash-file.txt\n"
        send({"id": request_id, "result": {"exitCode": 0, "stdout": output, "stderr": ""}})
    elif method == "thread/turns/list":
        assert params["threadId"] == saved_thread and params["cursor"] == "older-cursor"
        assert params["limit"] == 12 and params["sortDirection"] == "desc"
        send({"id": request_id, "result": {"data": [stored_turn("older-turn", "Earlier deployment notes")],
                                          "nextCursor": None}})
        (home / "agent-older-page").touch()
    elif method == "turn/interrupt":
        assert params == {"threadId": thread, "turnId": interruptible_turn}
        send({"id": request_id, "result": {}})
        send({"method": "turn/completed", "params": {"threadId": thread,
              "turn": {"id": interruptible_turn, "status": "interrupted", "error": None}}})
        interrupted = True
    elif method == "turn/steer":
        assert set(params) == {"threadId", "expectedTurnId", "input", "clientUserMessageId"}
        assert params["threadId"] == thread and params["expectedTurnId"] == interruptible_turn
        assert params["input"] == [{"type": "text", "text": "Focus on X11", "text_elements": []}]
        if not steer_attempted:
            steer_attempted = True
            send({"id": request_id, "error": {"code": -32602, "message": "Fixture steer rejected"}})
            continue
        send({"method": "item/completed", "params": {
            "threadId": thread, "turnId": interruptible_turn, "item": {
                "id": "steer-input", "type": "userMessage", "clientId": params["clientUserMessageId"],
                "content": [{"type": "text", "text": "fixture duplicate steer sentinel"}]}}})
        send({"id": request_id, "result": {"turnId": interruptible_turn}})
        send({"method": "item/reasoning/summaryTextDelta", "params": {
            "threadId": thread, "turnId": interruptible_turn, "itemId": "comparison-reasoning",
            "summaryIndex": 0, "delta": " Reasoning continues below the follow-up."}})
        send({"method": "item/completed", "params": {"threadId": thread, "turnId": interruptible_turn,
              "item": {"id": "comparison-reasoning", "type": "reasoning",
                       "summary": ["Reasoning before the follow-up. Thinking after the progress update. "
                                   "Reasoning continues below the follow-up."]}}})
        (home / "agent-steered").touch()
    elif method == "turn/start":
        assert params["summary"] == "auto"
        assert params["clientUserMessageId"]
        message = params["input"][0]["text"]
        if os.environ.get("SPAN_BENCH_TASK_IDLE") == "1":
            assert message == "Wait for the test tool" and params["threadId"] == thread
            identifier = "waiting-benchmark"
            event = {"threadId": thread, "turnId": identifier}
            send({"id": request_id, "result": {"turn": {"id": identifier, "status": "inProgress"}}})
            command = {"id": "test-tool", "type": "commandExecution", "command": "check build results"}
            send({"method": "item/started", "params": {**event, "item": {
                **command, "status": "inProgress"}}})
            (home / "bench-tool-started").touch()
            time.sleep(5)
            send({"method": "item/completed", "params": {**event, "item": {
                **command, "status": "completed", "exitCode": 0, "aggregatedOutput": "Build ready"}}})
            send({"method": "turn/completed", "params": {
                **event, "turn": {"id": identifier, "status": "completed"}}})
            (home / "bench-tool-finished").touch()
            continue
        stream = os.environ.get("SPAN_BENCH_STREAM")
        if stream == "hidden-prose":
            assert message == "Stream a reply in the background"
            identifier = "hidden-prose-benchmark"
            event = {"threadId": thread, "turnId": identifier}
            send({"id": request_id, "result": {"turn": {"id": identifier, "status": "inProgress"}}})
            (home / "bench-hidden-started").touch()

            def wait_for_bench(name):
                for _ in range(750):
                    if (home / name).exists():
                        return
                    time.sleep(0.02)
                raise TimeoutError(name)

            wait_for_bench("bench-hidden-unmapped")
            offscreen = os.environ.get("SPAN_BENCH_OFFSCREEN_PROSE") == "1"
            interval = 0.170 if offscreen and os.environ.get("SPAN_BENCH_REMAP_PROSE") != "1" else 0.045
            paragraphs = []
            for index in range(576):
                delta = f"Long reply fragment {index + 1}. **Build output** and `preview` rows. "
                if index % 6 == 5:
                    delta += "\n\n"
                if index == 575:
                    delta += "[The final fragment of the streamed reply](https://example.invalid/end)\n"
                paragraphs.append(delta)
                send({"method": "item/agentMessage/delta", "params": {
                    **event, "itemId": "hidden-prose", "delta": delta}})
                if index % 6 == 5:
                    time.sleep(interval)
            (home / "bench-hidden-buffered").touch()
            wait_for_bench("bench-hidden-verified")
            send({"method": "item/completed", "params": {**event, "item": {
                "id": "hidden-prose", "type": "agentMessage", "text": "".join(paragraphs)}}})
            send({"method": "turn/completed", "params": {
                **event, "turn": {"id": identifier, "status": "completed"}}})
            (home / "bench-hidden-finished").touch()
            continue
        if stream in ("1", "scroll"):
            assert message == "Summarize the stream" and params["threadId"] == thread
            identifier = "reasoning-benchmark"
            event = {"threadId": thread, "turnId": identifier}
            send({"id": request_id, "result": {"turn": {"id": identifier, "status": "inProgress"}}})
            if stream == "scroll":
                (home / "bench-stream-started").touch()
            for index in range(576):
                send({"method": "item/reasoning/summaryTextDelta", "params": {
                    **event, "itemId": "reasoning", "summaryIndex": index // 72,
                    "delta": "Review **build output** and `preview` rows. "}})
                if index % 6 == 5:
                    time.sleep(0.045 if stream == "scroll" else 0.008)
            marker = home / "bench-stream-pending"
            marker.write_text(str(time.monotonic()))
            marker.replace(home / "bench-stream-done")
            send({"method": "item/completed", "params": {**event, "item": {
                "id": "stream-reply", "type": "agentMessage", "text": "Reasoning stream finished."}}})
            send({"method": "turn/completed", "params": {
                **event, "turn": {"id": identifier, "status": "completed"}}})
            continue
        if os.environ.get("SPAN_BENCH_IMAGES") == "1":
            assert message == "Show the three image previews" and params["threadId"] == thread
            image_turn = "image-benchmark-turn"
            event = {"threadId": thread, "turnId": image_turn}
            send({"id": request_id, "result": {"turn": {"id": image_turn, "status": "inProgress"}}})
            # A dot directory permits inline Markdown images without opening
            # the independent generated-artifact panel.
            text = "\n\n".join(f"![Image {i}](.bench-images/preview-{i}.png)" for i in range(3))
            send({"method": "item/completed", "params": {**event, "item": {
                "id": "image-benchmark", "type": "agentMessage", "text": text}}})
            send({"method": "turn/completed", "params": {
                **event, "turn": {"id": image_turn, "status": "completed"}}})
            (home / "bench-images-dispatched").touch()
            continue
        if message in ("Plan this update", "Back to normal"):
            assert shared and params["threadId"] == saved_thread
            mode = "plan" if message == "Plan this update" else "default"
            assert params["collaborationMode"] == {"mode": mode, "settings": {
                "model": "gpt-base-fixture", "reasoning_effort": "low", "developer_instructions": None}}
            response = "Plan mode result." if mode == "plan" else "Default mode result."
            plan_turn = f"{mode}-turn"
            send({"id": request_id, "result": {"turn": {"id": plan_turn, "status": "inProgress"}}})
            send({"method": "item/completed", "params": {"threadId": saved_thread, "turnId": plan_turn,
                  "item": {"id": plan_turn, "type": "agentMessage", "text": response}}})
            send({"method": "turn/completed", "params": {"threadId": saved_thread,
                  "turn": {"id": plan_turn, "status": "completed"}}})
            continue
        quoted_prompt = "> span_preview_marker\n\nDraft before quotes"
        continued_prompt = "请继续上一轮未完成的任务。"
        expected_speed = "priority" if message in ("Show the deployment check\n你", quoted_prompt, continued_prompt) else "default"
        assert params["serviceTierForTurn"] == expected_speed
        assert "serviceTier" not in params
        if message in ("Show the deployment check\n你", continued_prompt):
            assert params["sandboxPolicy"] == {"type": "readOnly", "networkAccess": False}
            assert params["approvalPolicy"] == "never"
        elif message == "Check the comparison layout":
            assert params["sandboxPolicy"] == {"type": "dangerFullAccess"}
            assert params["approvalPolicy"] == "never"
        elif params["threadId"] == saved_thread:
            assert params["sandboxPolicy"] == {"type": "workspaceWrite", "writableRoots": [],
                                                "networkAccess": False, "excludeTmpdirEnvVar": False,
                                                "excludeSlashTmp": False}
            assert params["approvalPolicy"] == "on-request"
        else:
            assert "sandboxPolicy" not in params and "approvalPolicy" not in params
        if message == quoted_prompt:
            send({"id": request_id, "result": {"turn": {"id": "quoted-turn", "status": "inProgress"}}})
            send({"method": "turn/completed", "params": {"threadId": thread,
                  "turn": {"id": "quoted-turn", "status": "completed", "error": None}}})
            (home / "agent-quoted").touch()
            continue
        (home / "agent-request").write_text(json.dumps(params, ensure_ascii=False) + "\n")
        if params["threadId"] == saved_thread:
            assert message.startswith("Read the remote attachment")
            uploaded = Path(json.loads(message.splitlines()[-1].removeprefix("- ")))
            assert uploaded.parent.parent == Path("/tmp") and uploaded.parent.name.startswith("span-")
            assert uploaded.read_text() == "Workspace notes\n"
            assert stat.S_IMODE(uploaded.stat().st_mode) == 0o600
            assert stat.S_IMODE(uploaded.parent.stat().st_mode) == 0o700
            pasted = params["input"][1]
            assert pasted["type"] == "localImage"
            image = Path(pasted["path"])
            assert image.parent == uploaded.parent and image.name == "02-剪贴板图片.png"
            assert image.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
            image.unlink()
            uploaded.unlink()
            uploaded.parent.rmdir()
            send({"id": request_id, "result": {"turn": {"id": "uploaded-turn", "status": "completed"}}})
            send({"method": "turn/completed", "params": {"threadId": saved_thread,
                  "turn": {"id": "uploaded-turn", "status": "completed", "error": None}}})
            (home / "agent-uploaded").touch()
            continue
        assert params["threadId"] == thread
        assert params["model"] == "gpt-vision-fixture"
        assert params["effort"] == ("medium" if message == continued_prompt else "high")
        if message == "Check the comparison layout":
            assert len(params["input"]) == 1
            send({"id": request_id, "result": {"turn": {"id": interruptible_turn, "status": "inProgress"}}})
            send({"method": "item/reasoning/summaryTextDelta", "params": {
                "threadId": thread, "turnId": interruptible_turn, "itemId": "comparison-reasoning",
                "summaryIndex": 0, "delta": "Reasoning before the follow-up."}})
            send({"method": "item/completed", "params": {"threadId": thread, "turnId": interruptible_turn,
                  "item": {"id": "comparison-progress", "type": "agentMessage",
                           "text": "I found the comparison data."}}})
            send({"method": "item/reasoning/summaryTextDelta", "params": {
                "threadId": thread, "turnId": interruptible_turn, "itemId": "comparison-reasoning",
                "summaryIndex": 0, "delta": " Thinking after the progress update."}})
            send({"method": "item/completed", "params": {"threadId": thread, "turnId": interruptible_turn,
                  "item": {"id": "comparison-check", "type": "commandExecution",
                           "command": "printf comparison", "status": "completed", "exitCode": 0}}})
            send({"method": "item/agentMessage/delta", "params": {
                "threadId": thread, "turnId": interruptible_turn, "itemId": "comparison-draft",
                "delta": "**Preparing the comparison table.**"}})
            continue
        if message == continued_prompt:
            assert interrupted and len(params["input"]) == 1
            send({"id": request_id, "result": {"turn": {"id": continued_turn, "status": "inProgress"}}})
            send({"method": "item/completed", "params": {"threadId": thread, "turnId": continued_turn,
                  "item": {"id": "comparison-final", "type": "agentMessage", "text": comparison}}})
            send({"method": "turn/completed", "params": {"threadId": thread,
                  "turn": {"id": continued_turn, "status": "completed", "error": None}}})
            continue
        assert params["input"][1] == {"type": "localImage", "path": str(home / "test-output.png")}
        pasted = params["input"][2]
        assert pasted["type"] == "localImage"
        image = Path(pasted["path"])
        assert image.name == "剪贴板图片.png"
        assert image.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
        assert stat.S_IMODE(image.stat().st_mode) == 0o600
        (home / "agent-prompt").write_text(params["input"][0]["text"])
        send({"id": request_id, "result": {"turn": {"id": turn, "status": "inProgress"}}})
        event = {"threadId": thread, "turnId": turn}
        send({"method": "item/completed", "params": {**event, "item": {
            "id": "same-client-input", "type": "userMessage", "clientId": params["clientUserMessageId"],
            "content": [{"type": "text", "text": "fixture duplicate prompt sentinel"}]}}})
        send({"method": "item/reasoning/summaryTextDelta", "params": {
            **event, "itemId": "reasoning", "summaryIndex": 0, "delta": "**Checking the build "}})
        send({"method": "item/reasoning/summaryTextDelta", "params": {
            **event, "itemId": "reasoning", "summaryIndex": 0, "delta": "before publishing.**"}})
        send({"method": "item/reasoning/textDelta", "params": {
            **event, "itemId": "reasoning", "contentIndex": 0, "delta": "fixture raw reasoning sentinel"}})
        command = {"id": "read-checks", "type": "commandExecution", "command": "cat checks.txt",
                   "commandActions": [{"type": "read", "name": "checks.txt", "path": "checks.txt"}]}
        send({"method": "item/started", "params": {**event, "item": {**command, "status": "inProgress"}}})
        send({"method": "item/completed", "params": {**event, "item": {
            **command, "status": "completed", "exitCode": 0, "aggregatedOutput": "integration test passed"}}})
        send({"method": "item/completed", "params": {**event, "item": {
            "id": "web", "type": "webSearch", "query": "deployment checklist documentation",
            "action": {"type": "findInPage", "pattern": "deployment checklist documentation",
                       "url": "https://docs.example.com/activity/checklist?from=span&view=doc"}}}})
        send({"method": "item/fileChange/patchUpdated", "params": {
            **event, "itemId": "checks-edit", "changes": [{"path": "checks.txt", "diff": diff}]}})
        send({"method": "item/agentMessage/delta", "params": {
            "threadId": thread, "turnId": turn, "itemId": item, "delta": "Deployment checklist"}})
        send({"method": "item/completed", "params": {"threadId": thread, "turnId": turn,
              "item": {"id": item, "type": "agentMessage", "text": reply}}})
        send({"method": "thread/tokenUsage/updated", "params": {"threadId": thread, "turnId": turn,
              "tokenUsage": {"total": {"totalTokens": 12800},
                             "last": {"totalTokens": 667, "inputTokens": 540, "outputTokens": 127},
                             "modelContextWindow": 5000}}})
        send({"method": "turn/diff/updated", "params": {"threadId": thread, "turnId": turn, "diff": diff}})
        (home / "agent-replied").touch()
        send({"id": "preview-question", "method": "item/tool/requestUserInput", "params": {
            "threadId": thread, "turnId": turn, "itemId": "question", "questions": [
                {"id": "environment", "header": "Deployment", "question": "Which deployment environment?",
                 "isOther": False, "isSecret": False, "options": None}]}})
    elif request_id == "preview-question":
        assert request["result"] == {"answers": {"environment": {"answers": ["Staging"]}}}
        (home / "generated-preview.html").write_text("""<!doctype html><html><head>
            <style>body { background: #123; }</style></head><body>
            <h1>Generated workspace page</h1><p>Deployment preview &amp; status</p>
            <p>中文预览 <a href="https://example.invalid/span/preview?a=1&amp;b=2">预览里的链接</a></p>
            <script>window.spanPreview = 'fixture script sentinel';</script></body></html>""")
        send({"method": "item/completed", "params": {"threadId": thread, "turnId": turn,
              "item": {"id": "environment-reply", "type": "agentMessage",
                       "text": "Environment confirmed. See [the generated page](./generated-preview.html)."}}})
        send({"method": "item/completed", "params": {"threadId": thread, "turnId": turn,
              "item": {"id": "reasoning", "type": "reasoning", "summary": ["Checked the build before publishing."],
                       "content": ["fixture raw reasoning sentinel"]}}})
        (home / "agent-answered").touch()
        send({"method": "turn/completed", "params": {"threadId": thread,
              "turn": {"id": turn, "status": "completed", "error": None}}})
