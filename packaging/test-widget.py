#!/usr/bin/env python3
"""Exercise labeled GTK widgets through the X11 accessibility bus."""

import contextlib
import io
import json
import os
import socket
import subprocess
import sys
import time

def request(path, arguments):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(30)
        client.connect(path)
        with client.makefile("rwb") as channel:
            line = json.dumps([os.getenv("SPAN_TEST_DIALOG"), arguments]).encode()
            channel.write(line + b"\n")
            channel.flush()
            status, output, error = json.loads(channel.readline())
    sys.stdout.write(output)
    sys.stderr.write(error)
    return status


if len(sys.argv) > 3 and sys.argv[1] == "--request":
    sys.exit(request(sys.argv[2], sys.argv[3:]))


import pyatspi
from gi.repository import GLib


def descendants(node):
    yield node
    for child in node:
        yield from descendants(child)


def visible(node):
    states = node.getState()
    return states.contains(pyatspi.STATE_VISIBLE) and states.contains(pyatspi.STATE_SHOWING)


def contains(node, expected):
    if "Text" not in node.get_interfaces():
        return False
    try:
        content = node.queryText().getText(0, -1)
    except NotImplementedError:
        # A disappearing widget can still advertise Text in the AT-SPI cache.
        return False
    return bool(content and expected in content)


def exercise(arguments, dialog):
    operation, name, *values = arguments
    desktop = pyatspi.Registry.getDesktop(0)
    seen = []
    context = GLib.MainContext.default()
    for _ in range(50):
        while context.pending():
            context.iteration(False)
        seen = []
        try:
            roots = (desktop,)
            if dialog:
                roots = tuple(node for app in desktop for node in app if node.name == dialog)
            for node in (node for root in roots for node in descendants(root)):
                if not visible(node):
                    continue
                if node.name:
                    seen.append(node.name)
                if operation in ("contains", "not-contains") and contains(node, name):
                    sys.exit(0 if operation == "contains" else f"Unexpected text {name!r}")
                if operation in ("mouse-text", "drag-text") and contains(node, name):
                    text = node.queryText()
                    index = text.getText(0, -1).index(name)
                    if operation == "mouse-text":
                        index += len(name) // 2
                    x, y, width, height = text.getCharacterExtents(index, pyatspi.DESKTOP_COORDS)
                    if width > 0 and height > 0 and x >= 0 and y >= 0:
                        if operation == "drag-text":
                            end_x, end_y, end_w, end_h = text.getCharacterExtents(
                                index + len(name) - 1, pyatspi.DESKTOP_COORDS)
                            if min(end_x, end_y) < 0 or min(end_w, end_h) <= 0:
                                continue
                            command = ["mousemove", str(x + 1), str(y + height // 2), "mousedown", "1",
                                       "sleep", "0.1", "mousemove", str(end_x + end_w - 1),
                                       str(end_y + end_h // 2), "sleep", "0.1", "mouseup", "1"]
                        else:
                            command = ["mousemove", str(x + width // 2), str(y + height // 2), "click", "1"]
                        subprocess.run(["xdotool", *command], check=True)
                        sys.exit(0)
                if node.name != name:
                    continue
                if operation == "description" and (node.description or "").startswith(values[0]):
                    sys.exit(0)
                if operation in ("state", "not-state"):
                    state = getattr(pyatspi, "STATE_" + values[0].upper())
                    if node.getState().contains(state) == (operation == "state"):
                        sys.exit(0)
                if operation == "scroll-value":
                    for child in node:
                        if (child.getRole() == pyatspi.ROLE_SCROLL_BAR
                                and child.getState().contains(pyatspi.STATE_VERTICAL)):
                            print(int(child.queryValue().currentValue))
                            sys.exit(0)
                if operation == "click" and "Action" in node.get_interfaces():
                    if node.queryAction().doAction(0):
                        sys.exit(0)
                if operation in ("bounds", "mouse") and "Component" in node.get_interfaces():
                    bounds = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
                    if bounds.width > 0 and bounds.height > 0:
                        if operation == "bounds":
                            print(bounds.x, bounds.y, bounds.width, bounds.height)
                            sys.exit(0)
                        subprocess.run(["xdotool", "mousemove", str(bounds.x + min(14, bounds.width // 2)),
                                        str(bounds.y + min(12, bounds.height // 2)), "click", "1"], check=True)
                        sys.exit(0)
                if operation == "expanded-contains" and node.getState().contains(pyatspi.STATE_EXPANDED):
                    if any(contains(child, values[0]) for child in descendants(node)):
                        sys.exit(0)
                if operation == "fill-card":
                    for field in descendants(node.parent):
                        if visible(field) and "EditableText" in field.get_interfaces():
                            field.queryEditableText().setTextContents(values[0])
                            sys.exit(0)
            if operation == "count":
                print(seen.count(name))
                sys.exit(0)
        except GLib.Error as error:
            # A dialog or a streaming update can remove a widget while AT-SPI walks it.
            if "does not exist" not in error.message:
                raise
            time.sleep(0.1)
            continue
        if operation == "not-contains":
            sys.exit(0)
        time.sleep(0.1)

    sys.exit(f"Could not {operation} {name!r}; showing: {seen}")


def serve(path):
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(path)
        server.listen(1)
        while True:
            client, _ = server.accept()
            with client, client.makefile("rwb") as channel:
                line = channel.readline()
                if not line:
                    continue
                dialog, arguments = json.loads(line)
                output = io.StringIO()
                status, error = 0, ""
                with contextlib.redirect_stdout(output):
                    try:
                        exercise(arguments, dialog)
                    except SystemExit as result:
                        if isinstance(result.code, str):
                            status, error = 1, result.code + "\n"
                        else:
                            status = result.code or 0
                reply = json.dumps([status, output.getvalue(), error]).encode()
                channel.write(reply + b"\n")


if len(sys.argv) == 3 and sys.argv[1] == "--serve":
    serve(sys.argv[2])
else:
    exercise(sys.argv[1:], os.getenv("SPAN_TEST_DIALOG"))
