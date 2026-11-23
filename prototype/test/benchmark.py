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

from Xlib import X, display, protocol
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
    return subprocess.check_output(
        ["/usr/libexec/platform-python", "packaging/test-widget.py", "--request",
         WIDGET_SOCKET, *args], text=True,
    ).strip()


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
    if not values:
        return None
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
        args = ["--demo", "--no-sandbox", "--disable-gpu", "--terminal-renderer=dom", "--remote-debugging-port=0",
                f"--user-data-dir={workspace / 'profile'}"] if candidate else []
        command = ('touch "$HOME/span-terminal-ready"; n=0; while :; do '
                   'printf \'span-bench-%04d\\n\' "$n"; n=$((n+1)); sleep .055; done')
        with open(workspace / "app.log", "w+") as log, subprocess.Popen(
            ["taskset", "-c", CPU, binary, *args], env=env, stdout=log, stderr=log,
        ) as app:
            try:
                title = "^Span" if candidate else "^Span$"
                wid = int(subprocess.check_output(
                    ["timeout", "20", "xdotool", "search", "--sync", "--onlyvisible",
                     "--pid", str(app.pid), "--name", title], text=True).splitlines()[0])
                win = screen.create_resource_object("window", wid)
                xdo("windowactivate", "--sync", wid, "windowmove", wid, 60, 50,
                    "windowsize", wid, 1180, 800)
                time.sleep(.6)
                if candidate:
                    port_file = workspace / "profile" / "DevToolsActivePort"
                    if not try_until(port_file.is_file, 12):
                        raise RuntimeError("Could not open the benchmark automation port")
                    port = port_file.read_text().splitlines()[0]
                    subprocess.run(["/artifacts/node", "prototype/test/prepare-benchmark.mjs",
                                    port, command], check=True, timeout=28)
                else:
                    xdo("key", "ctrl+shift+a")
                    widget("click", "打开会话")
                    widget("state", "复制会话 ID", "showing")
                    hx, hy, hw, hh = map(int, widget("bounds", "对话记录").split())
                    xdo("mousemove", hx + hw // 2, hy + hh // 2,
                        "click", "--repeat", 40, "--delay", 20, 5)
                    widget("click", "会话页终端面板")
                time.sleep(.9)

                def origin():
                    return root.translate_coords(win, 0, 0)

                def pixels():
                    pos = origin()
                    return root.get_image(pos.x + 365, pos.y + 105, 450, 220,
                                          X.ZPixmap, 0xffffffff).data

                if not candidate:
                    xdo("mousemove", "--window", wid, 650, 740, "click", 1, "type", command)
                    xdo("key", "Return")
                if not try_until((workspace / "span-terminal-ready").is_file, 5):
                    raise RuntimeError(f"{name}: the terminal stream did not start")
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
                # Request Openbox's normal interactive right-edge resize.
                # Subsequent positions are real pointer motions, not ConfigureWindow.
                pos = origin()
                width = win.get_geometry().width
                x, y = pos.x + width - 20, pos.y + 395
                pointer(x, y)
                root.send_event(protocol.event.ClientMessage(
                    window=win,
                    client_type=screen.intern_atom("_NET_WM_MOVERESIZE"),
                    data=(32, [x, y, 3, 1, 2]),
                ), event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
                screen.sync()
                time.sleep(.12)
                mouse(1, True)
                screen.sync()
                resize_error = None
                try:
                    for index in range(28):
                        old_width = win.get_geometry().width
                        before = pixels()
                        direction = -1 if index % 2 == 0 else 1
                        start = time.monotonic()
                        xtest.fake_input(screen, X.MotionNotify,
                                         x=x + (-82 if direction < 0 else 0), y=y)
                        screen.flush()
                        resized = try_until(lambda: (win.get_geometry().width - old_width) * direction > 50, 1)
                        if not resized:
                            resize_error = f"Interactive resize did not reach the target width ({old_width} → {win.get_geometry().width})."
                            break
                        now = time.monotonic()
                        painted = try_until(lambda: pixels() != before, .65)
                        if index >= 4:
                            geometry.append((now - start) * 1000)
                            if painted:
                                drag.append((time.monotonic() - start) * 1000)
                        time.sleep(.045)
                finally:
                    mouse(1, False)
                    screen.sync()

                end = stats(app.pid)
                record = {"app": name, "memory_kib": {key: end[key] for key in
                          ("Pss", "Rss", "Private_Dirty")}, "processes": end["processes"],
                          "cpu_tree_ms": end["tree_cpu_ms"] - start_stats["tree_cpu_ms"],
                          "cpu_main_ms": end["main_cpu_ms"] - start_stats["main_cpu_ms"],
                          "scroll": sample(scroll), "scroll_no_pixel_change": timeouts,
                          "resize_geometry": sample(geometry), "resize_visible": sample(drag),
                          "resize_error": resize_error}
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
if any(run["resize_error"] or not run["resize_visible"] or not run["scroll"] for run in report["runs"]):
    raise SystemExit("One or more interactive runs did not reach their expected resize or paint.")
