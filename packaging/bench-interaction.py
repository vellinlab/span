"""Compare installed Linux builds on the same X11 display and pinned CPU."""
import hashlib
import os
from pathlib import Path
import shlex
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
        (home / "bin/codex").chmod(0o755)
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

                # Keep repeated wheel gestures away from both ends of the conversation.
                for button in [4] * 28 + [5] * 14:
                    for event in (X.ButtonPress, X.ButtonRelease):
                        xtest.fake_input(screen, event, button)
                    screen.flush()
                    time.sleep(0.012)
                time.sleep(0.2)

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
                def drag(surface):
                    # Continuous width changes cross text wrapping and PTY column boundaries.
                    # Include the final settle period in CPU accounting.
                    begin = ticks()
                    start = time.monotonic()
                    for frame in range(160):
                        phase = frame % 80
                        width = 1050 + 3 * min(phase, 80 - phase)
                        win.configure(width=width, height=800)
                        screen.flush()
                        time.sleep(max(0, start + (frame + 1) / 60 - time.monotonic()))
                    screen.sync()
                    time.sleep(0.35)
                    assert win.get_geometry().width == width
                    cost = (ticks() - begin) * 1000 / os.sysconf("SC_CLK_TCK")
                    print(f"{Path(binary).parent.name} {surface} continuous resize: "
                          f"app CPU {cost:.0f} ms / 160 events", flush=True)

                drag("conversation")
                # Simulate high-resolution input arriving in bursts within one frame.
                # Move through the transcript, rather than pushing at an endpoint.
                begin = ticks()
                start = time.monotonic()
                for frame in range(120):
                    button = 4 if frame % 24 < 12 else 5
                    for _ in range(4):
                        for event in (X.ButtonPress, X.ButtonRelease):
                            xtest.fake_input(screen, event, button)
                    screen.flush()
                    time.sleep(max(0, start + (frame + 1) / 60 - time.monotonic()))
                screen.sync()
                time.sleep(0.25)
                cost = (ticks() - begin) * 1000 / os.sysconf("SC_CLK_TCK")
                print(f"{Path(binary).parent.name} wheel burst: app CPU {cost:.0f} ms / 480 events",
                      flush=True)

                # Drive well beyond each end and verify that a distant page is
                # painted again after being evicted and brought back on screen.
                def endpoint(button):
                    for _ in range(640):
                        for event in (X.ButtonPress, X.ButtonRelease):
                            xtest.fake_input(screen, event, button)
                    screen.sync()
                    time.sleep(0.6)
                    data = win.get_image(390, 150, 540, 170, X.ZPixmap, 0xffffffff).data
                    assert len(set(data)) > 32, "blank transcript after scrolling"
                    return hashlib.blake2b(data, digest_size=8).digest()

                top = endpoint(4)
                bottom = endpoint(5)
                assert top != bottom and endpoint(4) == top, "history did not survive scrolling"
                xdo("key", "ctrl+shift+a")
                time.sleep(0.25)
                xdo("type", """seq 1 3000 | awk '{printf "%06d %0160d\\n", $1, $1}'; touch """
                    + shlex.quote(str(home / "bench-terminal-ready")))
                xdo("key", "Return")
                until(lambda: (home / "bench-terminal-ready").exists())
                time.sleep(0.4)
                drag("terminal")
            finally:
                app.terminate()
                app.wait(timeout=5)


for package in sys.argv[1:]:
    benchmark(package)
