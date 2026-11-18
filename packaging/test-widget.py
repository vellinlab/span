#!/usr/bin/env python3
"""Exercise labeled GTK widgets through the X11 accessibility bus."""

import subprocess
import sys
import time

import pyatspi


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
    content = node.queryText().getText(0, -1)
    return bool(content and expected in content)


operation, name, *values = sys.argv[1:]
desktop = pyatspi.Registry.getDesktop(0)
seen = []
for _ in range(50):
    seen = []
    for node in descendants(desktop):
        if not visible(node):
            continue
        if node.name:
            seen.append(node.name)
        if operation == "contains" and contains(node, name):
            sys.exit(0)
        if node.name != name:
            continue
        if operation == "click" and "Action" in node.get_interfaces():
            if node.queryAction().doAction(0):
                sys.exit(0)
        if operation == "mouse" and "Component" in node.get_interfaces():
            bounds = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
            if bounds.width > 0 and bounds.height > 0:
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
    time.sleep(0.1)

sys.exit(f"Could not {operation} {name!r}; showing: {seen}")
