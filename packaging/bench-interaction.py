"""Compare installed Linux builds on the same X11 display and pinned CPU."""
import hashlib
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

from Xlib import X, display
from Xlib.ext import xtest

screen = display.Display()
cpu = min(os.sched_getaffinity(0))


def xdo(*args):
    return subprocess.check_output(["xdotool", *map(str, args)], text=True).strip()


def until(check):
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.02)
    raise RuntimeError("X11 benchmark setup timed out")


def benchmark(binary):
    with tempfile.TemporaryDirectory() as directory:
        home = Path(directory)
        (home / "bin").mkdir()
        shutil.copy2("packaging/test-agent.py", home / "bin/codex")
        env = dict(os.environ, HOME=directory, XDG_CONFIG_HOME=directory, CODEX_HOME=directory,
                   PATH=str(home / "bin") + ":" + os.environ["PATH"], SPAN_BENCH_HISTORY="1",
                   GTK_THEME="Adwaita:dark", NO_AT_BRIDGE="1", GDK_BACKEND="x11")
        with subprocess.Popen(["taskset", "-c", str(cpu), binary], env=env) as app:
            try:
                def window_id():
                    found = subprocess.run(["xdotool", "search", "--onlyvisible", "--pid", str(app.pid),
                                            "--name", "^Span$"], capture_output=True, text=True)
                    return found.stdout.strip().splitlines()[:1]

                wid = int(until(window_id)[0])
                win = screen.create_resource_object("window", wid)
                xdo("windowsize", wid, 1100, 800, "windowfocus", wid)
                time.sleep(0.4)
                xdo("key", "ctrl+shift+a")
                time.sleep(0.4)
                xdo("key", "Return")
                until(lambda: (home / "agent-ready").exists())
                time.sleep(1)
                xdo("mousemove", "--window", wid, 715, 320)

                def pixels():
                    data = win.get_image(390, 150, 540, 170, X.ZPixmap, 0xffffffff).data
                    return hashlib.blake2b(data, digest_size=8).digest()

                def ticks():
                    fields = Path(f"/proc/{app.pid}/stat").read_text().split()
                    return int(fields[13]) + int(fields[14])

                for mode in ("scroll", "resize"):
                    samples = []
                    for i in range(36):
                        if i == 4:
                            start_cpu = ticks()
                        before = pixels()
                        start = time.monotonic()
                        if mode == "scroll":
                            button = 4 if i % 12 < 6 else 5
                            for event in (X.ButtonPress, X.ButtonRelease):
                                xtest.fake_input(screen, event, button)
                        else:
                            win.configure(width=1030 if i % 2 == 0 else 1100, height=800)
                        screen.flush()
                        while pixels() == before:
                            if time.monotonic() - start > 2:
                                raise RuntimeError(f"{mode} did not visibly update on event {i}")
                            time.sleep(0.002)
                        if i >= 4:
                            samples.append(1000 * (time.monotonic() - start))
                        time.sleep(0.045)
                    cpu_ms = (ticks() - start_cpu) * 1000 / os.sysconf("SC_CLK_TCK")
                    print(f"{Path(binary).parent.name} {mode}: median {statistics.median(samples):.1f} ms,"
                          f" p95 {sorted(samples)[30]:.1f} ms, app CPU {cpu_ms:.0f} ms / 32 events", flush=True)
            finally:
                app.terminate()
                app.wait(timeout=5)


for package in sys.argv[1:]:
    benchmark(package)
