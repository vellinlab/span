#!/usr/bin/env python3
"""Deterministic App Server peer for the native GUI smoke test."""

import json
import os
import sys
from pathlib import Path

home = Path(os.environ["HOME"])
thread = "preview-thread"
turn = "preview-turn"
item = "preview-message"
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


assert sys.argv[1:] == ["app-server"]
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    params = request.get("params", {})
    request_id = request.get("id")
    if method == "initialize":
        assert params["clientInfo"]["name"] == "ssh-workbench"
        send({"id": request_id, "result": {"userAgent": "fixture"}})
    elif method == "initialized":
        continue
    elif method == "thread/start":
        assert params["sandbox"] == "workspace-write"
        assert params["approvalPolicy"] == "on-request"
        send({"id": request_id, "result": {"thread": {"id": thread, "turns": []},
                                          "cwd": str(home), "model": "Codex"}})
        (home / "agent-ready").touch()
    elif method == "turn/start":
        assert params["threadId"] == thread
        (home / "agent-prompt").write_text(params["input"][0]["text"])
        send({"id": request_id, "result": {"turn": {"id": turn, "status": "inProgress"}}})
        send({"method": "item/agentMessage/delta", "params": {
            "threadId": thread, "turnId": turn, "itemId": item, "delta": "Deployment checklist"}})
        send({"method": "item/completed", "params": {"threadId": thread, "turnId": turn,
              "item": {"id": item, "type": "agentMessage", "text": reply}}})
        send({"method": "turn/completed", "params": {"threadId": thread,
              "turn": {"id": turn, "status": "completed", "error": None}}})
        (home / "agent-replied").touch()
