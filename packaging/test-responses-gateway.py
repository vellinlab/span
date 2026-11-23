#!/usr/bin/env python3
"""Serve deterministic Responses API turns for a real App Server smoke test."""

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


MODEL = "span-ci-model"
PATCH = """*** Begin Patch
*** Add File: span-ci-result.txt
+Patched by the App Server.
*** End Patch"""
FIRST_PROMPT = "Create the fixture file."
SECOND_PROMPT = "Continue the existing fixture session."
FIRST_REPLY = "Fixture file created."
SECOND_REPLY = "Fixture session continued."


class Responses(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            if self.path != "/v1/responses":
                raise ValueError(f"Unexpected endpoint {self.path}")
            request = json.loads(
                self.rfile.read(int(self.headers["Content-Length"]))
            )
            if request.get("model") != MODEL:
                raise ValueError("Unexpected model in request")
            self.send_events(self.events(request))
        except (KeyError, StopIteration, ValueError) as error:
            self.send_error(400, str(error))

    def events(self, request):
        inputs = request["input"]
        latest_prompt = next(
            text["text"]
            for item in reversed(inputs)
            if item.get("role") == "user"
            for text in item["content"]
            if text.get("type") == "input_text"
        )
        if latest_prompt == SECOND_PROMPT:
            if not any(
                item.get("role") == "assistant"
                and any(text.get("text") == FIRST_REPLY for text in item["content"])
                for item in inputs
            ):
                raise ValueError("The resumed request lost its previous assistant message")
            item = self.message("second-message", SECOND_REPLY)
        elif latest_prompt == FIRST_PROMPT:
            outputs = {
                item["call_id"]: json.dumps(item)
                for item in inputs
                if item.get("type") == "function_call_output"
            }
            if "span-approval" not in outputs:
                item = self.command("span-approval", {
                    "cmd": "printf '%s\\n' approved > span-ci-approval.txt; cat span-ci-approval.txt",
                    "sandbox_permissions": "require_escalated",
                    "justification": "Write the approval marker in the test workspace.",
                })
            elif "approved" not in outputs["span-approval"]:
                raise ValueError("The approved command result was not sent back to the model")
            elif "span-patch" not in outputs:
                item = self.command("span-patch", {"cmd": f"apply_patch <<'EOF'\n{PATCH}\nEOF\n"})
            elif "span-ci-result.txt" not in outputs["span-patch"]:
                raise ValueError("The patch result was not sent back to the model")
            else:
                item = self.message("first-message", FIRST_REPLY)
        else:
            raise ValueError("Unexpected prompt in request")
        response_id = f"fixture-{self.server.responses + 1}"
        self.server.responses += 1
        usage = {"input_tokens": 20, "output_tokens": 5, "total_tokens": 25}
        return [
            {"type": "response.created", "response": {"id": response_id}},
            {"type": "response.output_item.done", "item": item},
            {"type": "response.completed", "response": {"id": response_id, "usage": usage}},
        ]

    @staticmethod
    def command(call_id, arguments):
        return {
            "type": "function_call",
            "call_id": call_id,
            "name": "exec_command",
            "arguments": json.dumps(arguments),
        }

    @staticmethod
    def message(message_id, text):
        return {
            "type": "message",
            "id": message_id,
            "role": "assistant",
            "content": [{"type": "output_text", "text": text}],
        }

    def send_events(self, events):
        payload = "".join(f"data: {json.dumps(event)}\n\n" for event in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


with HTTPServer(("127.0.0.1", 0), Responses) as server:
    server.responses = 0
    Path(sys.argv[1]).write_text(str(server.server_port))
    server.serve_forever()
