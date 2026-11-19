#!/usr/bin/env python3
"""Deterministic App Server peer for the native GUI smoke test."""

import json
import os
import socket
import stat
import sys
import threading
from pathlib import Path

home = Path(os.environ["HOME"])
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

要确认当前构建结果，请阅读[发布说明](https://example.invalid/span/notes?lang=zh&view=full)。

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
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
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
    elif method == "thread/start":
        assert params["sandbox"] == "workspace-write"
        assert params["approvalPolicy"] == "on-request"
        send({"id": request_id, "result": {"thread": {"id": thread, "turns": []},
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
            "primary": {"usedPercent": 17, "windowDurationMins": 300},
            "secondary": {"usedPercent": 31, "windowDurationMins": 10080}}}})
    elif method == "thread/list":
        assert params["limit"] == 30 and params["sortKey"] == "updated_at"
        with (home / "agent-catalog-requests").open("a") as requests:
            print(os.getpid(), file=requests)
        results = [entry(saved_thread, "Deployment rollout", "Projects/Operations"),
                   entry(thread, "Release checklist", "Projects/Operations"),
                   entry("archive-notes", "Build notes", "Projects/Platform")]
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
        assert params["threadId"] == thread
        send({"id": request_id, "result": {"status": "unsubscribed"}})
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
            "id": "web", "type": "webSearch", "query": "deployment checklist documentation"}}})
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
