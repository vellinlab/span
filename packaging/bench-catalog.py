"""Compare session catalog pagination with real button presses on one X11 runner."""

import ctypes
import hashlib
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

from gi.repository import GLib
import pyatspi
from Xlib import X, display


screen = display.Display()
context = GLib.MainContext.default()


def wait(check, stage):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        while context.pending():
            context.iteration(False)
        if result := check():
            return result
        time.sleep(0.004)
    raise RuntimeError(f"catalog did not reach the expected state: {stage}")


def descendants(node):
    yield node
    for child in node:
        yield from descendants(child)


def xdo(*args):
    return subprocess.check_output(["xdotool", *map(str, args)], text=True).strip()


def benchmark(binary):
    with tempfile.TemporaryDirectory() as directory:
        home = Path(directory)
        (home / "bin").mkdir()
        shutil.copy2("packaging/test-agent.py", home / "bin/codex")
        (home / "bin/codex").chmod(0o755)
        env = dict(os.environ, HOME=directory, XDG_CONFIG_HOME=directory, CODEX_HOME=directory,
                   PATH=f"{home / 'bin'}:{os.environ['PATH']}", GDK_BACKEND="x11",
                   GTK_THEME="Adwaita:dark", SPAN_BENCH_CATALOG_PAGES="1")
        env.pop("NO_AT_BRIDGE", None)
        cpu = min(os.sched_getaffinity(0))
        with subprocess.Popen(["taskset", "-c", str(cpu), binary], env=env) as app:
            try:
                return exercise(home, app.pid, Path(binary).parent.name)
            finally:
                app.terminate()
                app.wait(timeout=5)


def exercise(home, pid, name):
    def window_id():
        result = subprocess.run(["xdotool", "search", "--onlyvisible", "--pid", str(pid),
                                 "--name", "^Span$"], capture_output=True, text=True)
        return result.stdout.strip()

    window = int(wait(window_id, "main X11 window"))
    xdo("windowsize", window, 1100, 800, "windowfocus", window)
    xdo("key", "ctrl+shift+h")
    wait((home / "catalog-page-0").exists, "first request")
    desktop = pyatspi.Registry.getDesktop(0)

    def catalog():
        for app in desktop:
            for node in descendants(app):
                if (node.name == "加载更多"
                        and node.getState().contains(pyatspi.STATE_SHOWING)
                        and node.getState().contains(pyatspi.STATE_SENSITIVE)):
                    return app, node
        return None

    app, more = wait(catalog, "visible and enabled pagination button")
    bounds = more.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
    xdo("mousemove", bounds.x + bounds.width // 2, bounds.y + bounds.height // 2)
    assert bounds.width > 0 and bounds.height > 0

    def sensitive():
        return more.getState().contains(pyatspi.STATE_SENSITIVE)

    cpu_clock = ctypes.c_int()
    get_clock = ctypes.CDLL(None).clock_getcpuclockid
    get_clock.argtypes = (ctypes.c_int, ctypes.POINTER(ctypes.c_int))
    if error := get_clock(pid, ctypes.byref(cpu_clock)):
        raise OSError(error, os.strerror(error))

    def cpu_ms():
        return time.clock_gettime_ns(cpu_clock.value) / 1e6

    latencies, costs = [], []
    for page in range(1, 9):
        assert sensitive()
        start, cpu_before = time.monotonic(), cpu_ms()
        xdo("click", "--delay", 0, 1)
        marker = home / f"catalog-page-{page}"
        wait(lambda: marker.exists() and (sensitive() == (page < 8)), f"completed page {page}")
        latencies.append((time.monotonic() - start) * 1000)
        time.sleep(0.06)
        costs.append(cpu_ms() - cpu_before)

    # The fixture overlaps page boundaries and introduces a project on page
    # four. The assembled rows stay unique and retain their display order.
    indices = range(9 * 29)
    expected = [f"Catalog entry #{number:03d}" for group in range(3)
                for number in indices if number % (3 if number >= 87 else 2) == group]
    actual = [node.name for node in descendants(app)
              if node.getRole() == pyatspi.ROLE_LABEL
              and (node.name or "").startswith("Catalog entry #")]
    assert actual == expected, (len(actual), len(expected), actual[:20])
    print(f"{name}: {len(actual)} unique rows, "
          f"page median {statistics.median(latencies):.1f} ms,"
          f" app CPU {sum(costs):.0f} ms / 8 pages,"
          f" final four pages {sum(costs[-4:]):.0f} ms", flush=True)
    win = screen.create_resource_object("window", window)
    pixels = win.get_image(48, 168, 184, 455, X.ZPixmap, 0xffffffff).data
    return hashlib.sha256(pixels).hexdigest()


if __name__ == "__main__":
    captures = {benchmark(binary) for binary in sys.argv[1:]}
    assert len(captures) == 1, f"loaded sidebar pixels differ across modes: {captures}"
