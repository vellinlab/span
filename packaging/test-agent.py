#!/usr/bin/env python3
"""Deterministic App Server peer for the native GUI smoke test."""

import json
import os
import stat
import sys
from pathlib import Path

home = Path(os.environ["HOME"])
thread = "preview-thread"
saved_thread = "stored-deployment"
turn = "preview-turn"
item = "preview-message"
diff = "diff --git a/checks.txt b/checks.txt\n--- a/checks.txt\n+++ b/checks.txt\n@@ -1 +1 @@\n-pending\n+passed\n"
reply = """## Deployment checklist

The app renders structured output using native GTK widgets.

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
        {"id": identifier + "-change", "type": "fileChange", "changes": [
            {"path": "checks.txt", "diff": diff}]}]}


assert sys.argv[1:] == ["app-server"]
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    params = request.get("params", {})
    request_id = request.get("id")
    if method == "initialize":
        assert params["clientInfo"]["name"] == "span"
        assert params["clientInfo"]["title"] == "Span"
        assert params["capabilities"]["experimentalApi"]
        send({"id": request_id, "result": {"userAgent": "fixture"}})
    elif method == "initialized":
        continue
    elif method == "thread/start":
        assert params["sandbox"] == "workspace-write"
        assert params["approvalPolicy"] == "on-request"
        send({"id": request_id, "result": {"thread": {"id": thread, "turns": []},
                                          "cwd": str(home), "model": "gpt-base-fixture",
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
            next_cursor = None
            (home / "agent-models").touch()
        send({"id": request_id, "result": {"data": data, "nextCursor": next_cursor}})
    elif method == "account/rateLimits/read":
        send({"id": request_id, "result": {"rateLimits": {"limitId": "codex",
            "primary": {"usedPercent": 17, "windowDurationMins": 300},
            "secondary": {"usedPercent": 31, "windowDurationMins": 10080}}}})
    elif method == "thread/list":
        assert params["limit"] == 30 and params["sortKey"] == "updated_at"
        results = [entry(saved_thread, "Deployment rollout", "Projects/Operations"),
                   entry(thread, "Release checklist", "Projects/Operations"),
                   entry("archive-notes", "Build notes", "Projects/Platform")]
        search = params["searchTerm"] or ""
        results = [entry for entry in results if search.lower() in entry["name"].lower()]
        send({"id": request_id, "result": {"data": results, "nextCursor": None}})
        (home / ("agent-searched" if search else "agent-catalog")).touch()
    elif method == "thread/resume":
        assert params["threadId"] == saved_thread and params["excludeTurns"]
        assert params["initialTurnsPage"] == {"limit": 12, "sortDirection": "desc", "itemsView": "full"}
        send({"id": request_id, "result": {"thread": entry(saved_thread, "Deployment rollout", "Projects/Operations"),
              "model": "gpt-base-fixture", "modelProvider": "fixture", "reasoningEffort": "low",
              "initialTurnsPage": {"data": [stored_turn("saved-turn", "Latest deployment notes")],
                                   "nextCursor": "older-cursor"}}})
        with (home / "agent-resumed").open("a") as resumes:
            print(saved_thread, file=resumes)
    elif method == "thread/unsubscribe":
        assert params["threadId"] == thread
        send({"id": request_id, "result": {"status": "unsubscribed"}})
    elif method == "thread/turns/list":
        assert params["threadId"] == saved_thread and params["cursor"] == "older-cursor"
        assert params["limit"] == 12 and params["sortDirection"] == "desc"
        send({"id": request_id, "result": {"data": [stored_turn("older-turn", "Earlier deployment notes")],
                                          "nextCursor": None}})
        (home / "agent-older-page").touch()
    elif method == "turn/start":
        assert params["summary"] == "auto"
        (home / "agent-request").write_text(json.dumps(params, ensure_ascii=False) + "\n")
        if params["threadId"] == saved_thread:
            message = params["input"][0]["text"]
            assert message.startswith("Read the remote attachment")
            uploaded = Path(json.loads(message.splitlines()[-1].removeprefix("- ")))
            assert uploaded.parent.parent == Path("/tmp") and uploaded.parent.name.startswith("span-")
            assert uploaded.read_text() == "Workspace notes\n"
            assert stat.S_IMODE(uploaded.stat().st_mode) == 0o600
            assert stat.S_IMODE(uploaded.parent.stat().st_mode) == 0o700
            uploaded.unlink()
            uploaded.parent.rmdir()
            send({"id": request_id, "result": {"turn": {"id": "uploaded-turn", "status": "completed"}}})
            send({"method": "turn/completed", "params": {"threadId": saved_thread,
                  "turn": {"id": "uploaded-turn", "status": "completed", "error": None}}})
            (home / "agent-uploaded").touch()
            continue
        assert params["threadId"] == thread
        assert params["model"] == "gpt-vision-fixture" and params["effort"] == "high"
        assert params["input"][1] == {"type": "localImage", "path": str(home / "test-output.png")}
        (home / "agent-prompt").write_text(params["input"][0]["text"])
        send({"id": request_id, "result": {"turn": {"id": turn, "status": "inProgress"}}})
        event = {"threadId": thread, "turnId": turn}
        send({"method": "item/reasoning/summaryTextDelta", "params": {
            **event, "itemId": "reasoning", "summaryIndex": 0, "delta": "Checking the build "}})
        send({"method": "item/reasoning/summaryTextDelta", "params": {
            **event, "itemId": "reasoning", "summaryIndex": 0, "delta": "before publishing."}})
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
        send({"method": "item/completed", "params": {"threadId": thread, "turnId": turn,
              "item": {"id": "reasoning", "type": "reasoning", "summary": ["Checked the build before publishing."],
                       "content": ["fixture raw reasoning sentinel"]}}})
        (home / "agent-answered").touch()
        send({"method": "turn/completed", "params": {"threadId": thread,
              "turn": {"id": turn, "status": "completed", "error": None}}})
