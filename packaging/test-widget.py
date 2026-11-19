#!/usr/bin/env python3
"""Exercise labeled GTK widgets through the X11 accessibility bus."""

import os
import subprocess
import sys
import time

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
    content = node.queryText().getText(0, -1)
    return bool(content and expected in content)


operation, name, *values = sys.argv[1:]
desktop = pyatspi.Registry.getDesktop(0)
dialog = os.environ.get("SPAN_TEST_DIALOG")
seen = []
for _ in range(50):
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
            if operation == "mouse-text" and contains(node, name):
                text = node.queryText()
                index = text.getText(0, -1).index(name) + len(name) // 2
                x, y, width, height = text.getCharacterExtents(index, pyatspi.DESKTOP_COORDS)
                if width > 0 and height > 0 and x >= 0 and y >= 0:
                    subprocess.run(["xdotool", "mousemove", str(x + width // 2),
                                    str(y + height // 2), "click", "1"], check=True)
                    sys.exit(0)
            if node.name != name:
                continue
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
