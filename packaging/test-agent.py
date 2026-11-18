#!/usr/bin/env python3
"""Deterministic App Server peer for the native GUI smoke test."""

import json
import os
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

```mermaid
flowchart LR
A[Inspect] --> B[Test] --> C[Publish]
```

![Preview image](test-output.png)
"""


def send(value):
    print(json.dumps(value), flush=True)


def entry(identifier, name, project, state="idle"):
    return {"id": identifier, "name": name, "cwd": str(home / project),
            "status": {"type": state}}


def stored_turn(identifier, text):
    return {"id": identifier, "status": "completed", "items": [
        {"id": identifier + "-message", "type": "agentMessage", "text": text},
        {"id": identifier + "-change", "type": "fileChange", "changes": [
            {"path": "checks.txt", "diff": diff}]}]}


assert sys.argv[1:] == ["app-server"]
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    params = request.get("params", {})
    request_id = request.get("id")
    if method == "initialize":
        assert params["clientInfo"]["name"] == "ssh-workbench"
        assert params["clientInfo"]["title"] == "Span"
        assert params["capabilities"]["experimentalApi"]
        send({"id": request_id, "result": {"userAgent": "fixture"}})
    elif method == "initialized":
        continue
    elif method == "thread/start":
        assert params["sandbox"] == "workspace-write"
        assert params["approvalPolicy"] == "on-request"
        send({"id": request_id, "result": {"thread": {"id": thread, "turns": []},
                                          "cwd": str(home), "model": "Codex"}})
        (home / "agent-ready").touch()
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
              "model": "Codex", "initialTurnsPage": {"data": [stored_turn("saved-turn", "Latest deployment notes")],
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
        assert params["threadId"] == thread
        (home / "agent-prompt").write_text(params["input"][0]["text"])
        send({"id": request_id, "result": {"turn": {"id": turn, "status": "inProgress"}}})
        send({"method": "item/agentMessage/delta", "params": {
            "threadId": thread, "turnId": turn, "itemId": item, "delta": "Deployment checklist"}})
        send({"method": "item/completed", "params": {"threadId": thread, "turnId": turn,
              "item": {"id": item, "type": "agentMessage", "text": reply}}})
        send({"method": "turn/diff/updated", "params": {"threadId": thread, "turnId": turn, "diff": diff}})
        (home / "agent-replied").touch()
        send({"id": "preview-question", "method": "item/tool/requestUserInput", "params": {
            "threadId": thread, "turnId": turn, "itemId": "question", "questions": [
                {"id": "environment", "header": "Deployment", "question": "Which deployment environment?",
                 "isOther": False, "isSecret": False, "options": None}]}})
    elif request_id == "preview-question":
        assert request["result"] == {"answers": {"environment": {"answers": ["Staging"]}}}
        (home / "agent-answered").touch()
        send({"method": "turn/completed", "params": {"threadId": thread,
              "turn": {"id": turn, "status": "completed", "error": None}}})
