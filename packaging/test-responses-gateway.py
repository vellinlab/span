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
            output = next(
                (
                    item
                    for item in inputs
                    if item.get("call_id") == "span-patch"
                    and item.get("type") == "function_call_output"
                ),
                None,
            )
            if output is None:
                item = {
                    "type": "function_call",
                    "call_id": "span-patch",
                    "name": "exec_command",
                    "arguments": json.dumps({"cmd": f"apply_patch <<'EOF'\n{PATCH}\nEOF\n"}),
                }
            else:
                if "span-ci-result.txt" not in json.dumps(output):
                    raise ValueError("The patch result was not sent back to the model")
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
