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


def process_role(process, root_pid, chromium_roles):
    if process == root_pid:
        return "main"
    if process in chromium_roles:
        return chromium_roles[process]
    try:
        args = Path(f"/proc/{process}/cmdline").read_bytes().split(b"\0")
    except OSError:
        return "exited"
    for arg in args:
        if arg in (b"--type=renderer", b"--type=gpu-process", b"--type=utility", b"--type=zygote"):
            return arg.decode().split("=")[1]
    executable = os.path.basename(args[0])
    if executable == b"span-workbench-core":
        return "agent-fixture" if b"--fixture" in args else "workbench-service"
    if executable in (b"sh", b"bash", b"dash", b"sleep"):
        return "shell"
    return "other"


def stats(pid, chromium_roles=None):
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
    roles = {}
    chromium_roles = chromium_roles or {}
    for process in app:
        try:
            lines = Path(f"/proc/{process}/smaps_rollup").read_text().splitlines()
        except OSError:
            continue
        group = roles.setdefault(process_role(process, pid, chromium_roles), dict.fromkeys((*memory, "processes"), 0))
        group["processes"] += 1
        for line in lines:
            key, _, value = line.partition(":")
            if key in memory:
                kib = int(value.split()[0])
                memory[key] += kib
                group[key] += kib
    app_ticks = sum(ticks.get(process, 0) for process in app)
    memory.update(tree_cpu_ms=1000 * app_ticks / CLOCK_TICKS,
                  main_cpu_ms=1000 * ticks.get(pid, 0) / CLOCK_TICKS,
                  processes=len(app), by_role=roles)
    return memory


def terminal_memory(pid, browser, phase):
    snapshot = json.loads(subprocess.check_output([*browser, phase], text=True, timeout=28))
    roles = {process["id"]: process["type"] for process in snapshot["processes"]}
    if "renderer" not in roles.values():
        raise RuntimeError("Chromium did not report a renderer PID")
    measurement = stats(pid, roles)
    if "renderer" not in measurement["by_role"]:
        raise RuntimeError("Chromium renderer PID did not match the process tree")
    return roles, {key: measurement[key] for key in ("Pss", "Rss", "Private_Dirty", "by_role")} | {
        "js_heap_bytes": snapshot["heap"], "dom": snapshot["dom"],
    }


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
                chromium_roles = None
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
                    browser = ["/artifacts/node", "prototype/test/prepare-benchmark.mjs", port]
                    chromium_roles, before_terminal = terminal_memory(app.pid, browser, "--wait-for-history")
                    chromium_roles, quiet_terminal = terminal_memory(app.pid, browser, "--open-terminal")
                    subprocess.run([*browser, command], check=True, timeout=28)
                else:
                    xdo("key", "ctrl+shift+h")
                    widget("mouse", "工作台架构评审")
                    widget("state", "复制会话 ID", "showing")
                    widget("contains", "第 160 项")
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
                start_stats = stats(app.pid, chromium_roles)
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

                end = stats(app.pid, chromium_roles)
                record = {"app": name, "memory_kib": {key: end[key] for key in
                          ("Pss", "Rss", "Private_Dirty")}, "processes": end["processes"],
                          "by_role": end["by_role"],
                          "cpu_tree_ms": end["tree_cpu_ms"] - start_stats["tree_cpu_ms"],
                          "cpu_main_ms": end["main_cpu_ms"] - start_stats["main_cpu_ms"],
                          "scroll": sample(scroll), "scroll_no_pixel_change": timeouts,
                          "resize_geometry": sample(geometry), "resize_visible": sample(drag),
                          "resize_error": resize_error}
                if candidate:
                    _, active_terminal = terminal_memory(app.pid, browser, "--snapshot")
                    _, after_close = terminal_memory(app.pid, browser, "--close-terminal")
                    time.sleep(2)
                    _, after_settle = terminal_memory(app.pid, browser, "--snapshot")
                    _, after_diagnostic_gc = terminal_memory(app.pid, browser, "--collect-heap")
                    record["terminal_memory_kib"] = {
                        "before_open": before_terminal,
                        "open_idle": quiet_terminal,
                        "active": active_terminal,
                        "closed": after_close,
                        "settled_2s": after_settle,
                        "after_diagnostic_gc": after_diagnostic_gc,
                    }
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


def catalog_benchmark(name, binary):
    with tempfile.TemporaryDirectory(prefix="span-catalog-") as tmp:
        profile = Path(tmp) / "profile"
        env = dict(os.environ, HOME=tmp, SPAN_PREVIEW_PROFILE=str(profile),
                   SPAN_PREVIEW_CATALOG_FIXTURE="benchmark")
        args = ["--demo", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0",
                f"--user-data-dir={profile}"]
        with subprocess.Popen(["taskset", "-c", CPU, binary, *args], env=env, stdout=sys.stderr) as app:
            try:
                wid = int(subprocess.check_output(
                    ["timeout", "20", "xdotool", "search", "--sync", "--onlyvisible",
                     "--pid", str(app.pid), "--name", "^Span"], text=True).splitlines()[0])
                xdo("windowactivate", "--sync", wid, "windowmove", wid, 60, 50,
                    "windowsize", wid, 1180, 800)
                port_file = profile / "DevToolsActivePort"
                if not try_until(port_file.is_file, 12):
                    raise RuntimeError("Could not open the catalog benchmark automation port")
                port = port_file.read_text().splitlines()[0]
                browser = ["/artifacts/node", "prototype/test/prepare-benchmark.mjs", port]
                top = json.loads(subprocess.check_output([*browser, "--catalog-top"], text=True, timeout=32))
                roles = {process["id"]: process["type"] for process in top["processes"]}
                win = screen.create_resource_object("window", wid)
                origin = root.translate_coords(win, 0, 0)
                pointer(origin.x + 105, origin.y + 380)
                time.sleep(.35)

                def pixels():
                    return root.get_image(origin.x + 68, origin.y + 255, 115, 360, X.ZPixmap, 0xffffffff).data

                start_stats = stats(app.pid, roles)
                latencies = []
                for index in range(24):
                    before = pixels()
                    start = time.monotonic()
                    button = 5 if index % 12 < 6 else 4
                    mouse(button, True)
                    mouse(button, False)
                    screen.flush()
                    if try_until(lambda: pixels() != before, .45):
                        latencies.append((time.monotonic() - start) * 1000)
                    time.sleep(.13)
                end_stats = stats(app.pid, roles)
                bottom = json.loads(subprocess.check_output([*browser, "--catalog-bottom"], text=True, timeout=32))
                record = {"app": name, "mounted_top": top["mounted"], "mounted_bottom": bottom["mounted"],
                          "dom_nodes_top": top["dom"]["nodes"], "wheel_to_pixel_change": sample(latencies),
                          "wheel_no_pixel_change": 24 - len(latencies),
                          "cpu_tree_ms": end_stats["tree_cpu_ms"] - start_stats["tree_cpu_ms"],
                          "cpu_main_ms": end_stats["main_cpu_ms"] - start_stats["main_cpu_ms"],
                          "memory_kib": {key: start_stats[key] for key in ("Pss", "Rss", "Private_Dirty")},
                          "renderer_kib": start_stats["by_role"]["renderer"]}
                print(json.dumps(record), flush=True)
                return record
            finally:
                app.terminate()
                try:
                    app.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    app.kill()


report = {"runner": "AlmaLinux 8 / Xvfb 1440×960 / Openbox / one constrained CPU / software rendering",
          "runs": []}
if WIDGET_SOCKET == "--catalog":
    base = ("baseline", "/artifacts/catalog-baseline/span-preview")
    report["baseline_renderer"] = Path("/artifacts/catalog-baseline-commit.txt").read_text().strip()
    report["sessions"] = 1201
    for target in (base, NEXT, NEXT, base):
        report["runs"].append(catalog_benchmark(*target))
        Path(OUTPUT).write_text(json.dumps(report, indent=2) + "\n")
    for run in report["runs"]:
        counts = (run["mounted_top"], run["mounted_bottom"])
        expected = counts == (1201, 1201) if run["app"] == "baseline" else all(0 < n < 40 for n in counts)
        if not expected or not run["wheel_to_pixel_change"]:
            raise SystemExit("Catalog comparison did not reach the expected endpoints or paint.")
else:
    report["baseline"] = "Span 0.1.0 EL8 x86_64"
    for target in (BASE, NEXT, NEXT, BASE):
        report["runs"].append(benchmark(*target))
        Path(OUTPUT).write_text(json.dumps(report, indent=2) + "\n")
    if any(run["resize_error"] or not run["resize_visible"] or not run["scroll"] for run in report["runs"]):
        raise SystemExit("One or more interactive runs did not reach their expected resize or paint.")
