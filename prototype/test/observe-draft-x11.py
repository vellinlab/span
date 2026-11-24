"""Observe the real desktop pixels of the Electron draft during a benchmark."""

import json
import os
from select import select
import sys
import time

from Xlib import X, display
from Xlib.ext import damage


def main():
    cpu = os.environ.get("SPAN_INPUT_OBSERVER_CPU")
    if cpu is not None:
        os.sched_setaffinity(0, {int(cpu)})
    x, y, width, height = map(int, sys.argv[1:])
    screen = display.Display()
    root = screen.screen().root
    screen.damage_query_version()
    root.damage_create(damage.DamageReportRawRectangles)
    screen.sync()

    def pixels():
        return root.get_image(x, y, width, height, X.ZPixmap, 0xffffffff).data

    def report(value):
        print(json.dumps(value), flush=True)

    def observe():
        previous = "MM"
        edits = []
        captures = 0
        assert pixels() == expected[previous], "Initial desktop draft differs from calibration"
        report(True)
        while True:
            while screen.pending_events():
                event = screen.next_event()
                if event.type != screen.extension_event.DamageNotify:
                    continue
                area = event.area
                if (area.x >= x + width or area.x + area.width <= x
                        or area.y >= y + height or area.y + area.height <= y):
                    continue
                rendered = pixels()
                captures += 1
                target = "MMW" if previous == "MM" else "MM"
                if rendered == expected[target]:
                    edits.append({"value": target, "shownAt": time.time_ns() / 1_000_000})
                    previous = target
            ready, _, _ = select([sys.stdin, screen], [], [])
            if sys.stdin in ready:
                assert sys.stdin.readline().strip() == "finish"
                return {"edits": edits, "captures": captures}

    expected = {}
    for request in sys.stdin:
        command = request.strip()
        if command == "observe":
            assert expected["MM"] != expected["MMW"], "X11 desktop pixels must reflect the draft"
            report(observe())
        elif command in ("MM", "MMW"):
            expected[command] = pixels()
            report(True)
        else:
            raise ValueError(f"Unknown draft observation command {command!r}")


if __name__ == "__main__":
    main()
