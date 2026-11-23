"""X11 comparison on the same pinned CPU, terminal stream and conversation fixture."""
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time

from Xlib import X, display
from Xlib.ext import xtest

screen = display.Display()
root = screen.screen().root
CPU = str(min(os.sched_getaffinity(0)))
CLOCK_TICKS = os.sysconf("SC_CLK_TCK")
PREVIEW = "/artifacts/linux/span-preview"
CORE = "/artifacts/linux/resources/app/bin/span-workbench-core"
WIDGET_SOCKET, OUTPUT = sys.argv[1:]
BASE = ("baseline", "/usr/bin/span")
NEXT = ("prototype", PREVIEW)


def xdo(*args):
    return subprocess.check_output(["xdotool", *map(str, args)], text=True).strip()


def widget(*args):
    subprocess.run(
        ["/usr/libexec/platform-python", "packaging/test-widget.py", "--request",
         WIDGET_SOCKET, *args], check=True,
    )


def stats(pid):
    children = {}
    ticks = {}
    for file in Path("/proc").glob("[0-9]*/stat"):
        try:
            fields = file.read_text().rsplit(")", 1)[1].split()
        except (OSError, IndexError):
            continue
        process = int(file.parent.name)
        children.setdefault(int(fields[1]), []).append(process)
        ticks[process] = int(fields[11]) + int(fields[12])
    app = [pid]
    for process in app:
        app.extend(children.get(process, []))
    memory = dict.fromkeys(("Pss", "Rss", "Private_Dirty"), 0)
    for process in app:
        try:
            lines = Path(f"/proc/{process}/smaps_rollup").read_text().splitlines()
        except OSError:
            continue
        for line in lines:
            key, _, value = line.partition(":")
            if key in memory:
                memory[key] += int(value.split()[0])
    app_ticks = sum(ticks.get(process, 0) for process in app)
    memory.update(tree_cpu_ms=1000 * app_ticks / CLOCK_TICKS,
                  main_cpu_ms=1000 * ticks.get(pid, 0) / CLOCK_TICKS, processes=len(app))
    return memory


def try_until(check, timeout=3):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        value = check()
        if value:
            return value
        time.sleep(.002)
    return None


def sample(values):
    return {"median_ms": round(statistics.median(values), 2),
            "p95_ms": round(sorted(values)[math.ceil(.95 * len(values)) - 1], 2),
            "samples": len(values), "max_ms": round(max(values), 2)}


def pointer(x, y):
    xtest.fake_input(screen, X.MotionNotify, x=x, y=y)
    screen.sync()


def mouse(button, pressed):
    xtest.fake_input(screen, X.ButtonPress if pressed else X.ButtonRelease, button)


def benchmark(name, binary):
    candidate = name == "prototype"
    with tempfile.TemporaryDirectory(prefix="span-desktop-") as tmp:
        workspace = Path(tmp)
        wrapper = workspace / "codex"
        wrapper.write_text(f'#!/bin/bash\nexec "{CORE}" --fixture\n')
        wrapper.chmod(0o755)
        env = dict(os.environ, HOME=tmp, CODEX_HOME=tmp, XDG_CONFIG_HOME=tmp,
                   GTK_THEME="Adwaita:dark", GDK_BACKEND="x11",
                   SPAN_PREVIEW_PROFILE=str(workspace / "profile"),
                   PATH=f"{tmp}:{os.environ['PATH']}")
        args = ["--demo", "--no-sandbox", "--disable-gpu"] if candidate else []
        with open(workspace / "app.log", "w+") as log, subprocess.Popen(
            ["taskset", "-c", CPU, binary, *args], env=env, stdout=log, stderr=log,
        ) as app:
            try:
                title = "^Span · 工作台预览$" if candidate else "^Span$"
                wid = int(subprocess.check_output(
                    ["timeout", "20", "xdotool", "search", "--sync", "--onlyvisible",
                     "--pid", str(app.pid), "--name", title], text=True).splitlines()[0])
                win = screen.create_resource_object("window", wid)
                xdo("windowactivate", "--sync", wid, "windowmove", wid, 60, 50,
                    "windowsize", wid, 1100, 800)
                time.sleep(.6)
                if candidate:
                    xdo("mousemove", "--window", wid, 1070, 26, "click", 1)
                else:
                    xdo("key", "ctrl+shift+a")
                    widget("click", "打开会话")
                    widget("contains", "第 160 项")
                    widget("click", "会话页终端面板")
                time.sleep(.9)

                def origin():
                    return root.translate_coords(win, 0, 0)

                def pixels():
                    pos = origin()
                    return root.get_image(pos.x + 365, pos.y + 105, 450, 220,
                                          X.ZPixmap, 0xffffffff).data

                xdo("mousemove", "--window", wid, 650, 740, "click", 1, "type",
                    "n=0; while :; do printf 'span-bench-%04d\\n' \"$n\"; n=$((n+1)); sleep .055; done")
                xdo("key", "Return")
                time.sleep(.35)
                start_stats = stats(app.pid)
                xdo("mousemove", "--window", wid, 650, 240)
                scroll = []
                timeouts = 0
                for index in range(36):
                    before = pixels()
                    start = time.monotonic()
                    button = 4 if index % 12 < 6 else 5
                    mouse(button, True)
                    mouse(button, False)
                    screen.flush()
                    changed = try_until(lambda: pixels() != before, .55)
                    if not changed:
                        timeouts += 1
                    if index >= 4 and changed:
                        scroll.append((time.monotonic() - start) * 1000)
                    time.sleep(.045)

                drag = []
                geometry = []
                # Openbox's client Alt+right mouse binding holds a real resize
                # grab. Two motions resize the same corner in each measurement.
                pos = origin()
                width = win.get_geometry().width
                x, y = pos.x + width - 2, pos.y + 395
                pointer(x, y)
                alt = 64
                xtest.fake_input(screen, X.KeyPress, alt)
                mouse(3, True)
                screen.sync()
                time.sleep(.08)
                try:
                    for index in range(28):
                        old_width = win.get_geometry().width
                        before = pixels()
                        direction = -1 if index % 2 == 0 else 1
                        start = time.monotonic()
                        xtest.fake_input(screen, X.MotionNotify,
                                         x=x + (-82 if direction < 0 else 0), y=y)
                        screen.flush()
                        resized = try_until(lambda: (win.get_geometry().width - old_width) * direction > 50)
                        if not resized:
                            raise RuntimeError(f"{name}: window manager did not resize the client")
                        now = time.monotonic()
                        painted = try_until(lambda: pixels() != before, .65)
                        if index >= 4:
                            geometry.append((now - start) * 1000)
                            if painted:
                                drag.append((time.monotonic() - start) * 1000)
                        time.sleep(.045)
                finally:
                    mouse(3, False)
                    xtest.fake_input(screen, X.KeyRelease, alt)
                    screen.sync()

                end = stats(app.pid)
                record = {"app": name, "memory_kib": {key: end[key] for key in
                          ("Pss", "Rss", "Private_Dirty")}, "processes": end["processes"],
                          "cpu_tree_ms": end["tree_cpu_ms"] - start_stats["tree_cpu_ms"],
                          "cpu_main_ms": end["main_cpu_ms"] - start_stats["main_cpu_ms"],
                          "scroll": sample(scroll), "scroll_no_pixel_change": timeouts,
                          "resize_geometry": sample(geometry), "resize_visible": sample(drag)}
                print(json.dumps(record), flush=True)
                return record
            except Exception:
                log.seek(0)
                print(log.read()[-5000:], file=sys.stderr)
                raise
            finally:
                app.terminate()
                try:
                    app.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    app.kill()


report = {"runner": "AlmaLinux 8 / Xvfb 1440×960 / Openbox / one constrained CPU / software rendering",
          "baseline": "Span 0.1.0 EL8 x86_64", "runs": []}
for target in (BASE, NEXT, NEXT, BASE):
    report["runs"].append(benchmark(*target))
    Path(OUTPUT).write_text(json.dumps(report, indent=2) + "\n")
