"""Compare installed Linux builds on the same X11 display and pinned CPU."""
import ctypes
import hashlib
import os
from pathlib import Path
import shlex
import shutil
import statistics
import struct
import subprocess
import sys
import tempfile
import time
import zlib

from Xlib import X, XK, display
from Xlib.ext import xtest

screen = display.Display()
cpu = min(os.sched_getaffinity(0))
get_cpu_clock = ctypes.CDLL(None).clock_getcpuclockid
get_cpu_clock.argtypes = (ctypes.c_int, ctypes.POINTER(ctypes.c_int))
get_cpu_clock.restype = ctypes.c_int


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


IMAGE_COLORS = [(243, 175, 19), (59, 206, 133), (200, 119, 218)]


def write_image(path, color):
    # PNG generated without desktop libraries. The accent stripe gives each
    # fixture a distinct pixel signature at every fitted preview size.
    width, height = 2400, 1800
    red, green, blue = color
    stripe = bytes((red, green, blue)) * 1640
    row = b"\0" + stripe + bytes((61, 68, 82)) * (width - 1640)

    def chunk(name, data):
        crc = zlib.crc32(name + data)
        return struct.pack(">I", len(data)) + name + data + struct.pack(">I", crc)

    image = b"\x89PNG\r\n\x1a\n" + chunk(
        b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    path.write_bytes(image + chunk(b"IDAT", zlib.compress(row * height)) + chunk(b"IEND", b""))


def benchmark(binary, workload):
    name = Path(binary).parent.name + ("" if workload == "history" else f" {workload}")
    with tempfile.TemporaryDirectory() as directory:
        home = Path(directory)
        (home / "bin").mkdir()
        shutil.copy2("packaging/test-agent.py", home / "bin/codex")
        (home / "bin/codex").chmod(0o755)
        if workload == "images":
            (home / ".bench-images").mkdir()
            for i, color in enumerate(IMAGE_COLORS):
                write_image(home / ".bench-images" / f"preview-{i}.png", color)
        env = dict(os.environ, HOME=directory, XDG_CONFIG_HOME=directory, CODEX_HOME=directory,
                   PATH=str(home / "bin") + ":" + os.environ["PATH"],
                   SPAN_BENCH_HISTORY=str(int(workload == "history")),
                   SPAN_BENCH_TABLE=str(int(workload == "table")),
                   SPAN_BENCH_TOOLS=str(int(workload == "tools")),
                   SPAN_BENCH_IMAGES=str(int(workload == "images")),
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
                def pixels(resize=False):
                    # A tool-only part of the timeline may have left-aligned
                    # rows. Include its right edge and message bubbles for resize.
                    width, height = (635, 470) if resize and workload == "tools" else (540, 170)
                    return win.get_image(390, 150, width, height, X.ZPixmap, 0xffffffff).data

                process_clock = ctypes.c_int()
                error = get_cpu_clock(app.pid, ctypes.byref(process_clock))
                if error:
                    raise OSError(error, os.strerror(error))

                def cpu_seconds():
                    return time.clock_gettime_ns(process_clock.value) / 1e9

                def footprint(stage):
                    memory = Path(f"/proc/{app.pid}/smaps_rollup").read_text().splitlines()
                    pss = next(line.split()[1] for line in memory if line.startswith("Pss:"))
                    print(f"{name} {stage}: PSS {pss} KiB", flush=True)

                setup_frame = pixels()
                before_cpu = cpu_seconds()
                start = time.monotonic()
                enter = screen.keysym_to_keycode(XK.string_to_keysym("Return"))
                for event in (X.KeyPress, X.KeyRelease):
                    xtest.fake_input(screen, event, enter)
                screen.flush()
                if workload == "images":
                    until(lambda: (home / "agent-models").exists())
                    time.sleep(0.25)
                    footprint("before previews")
                    xdo("type", "Show the three image previews")
                    before_cpu = cpu_seconds()
                    start = time.monotonic()
                    for event in (X.KeyPress, X.KeyRelease):
                        xtest.fake_input(screen, event, enter)
                    screen.flush()

                    # Xvfb's 24-bit screen exposes BGRX32 pixel storage. The
                    # last thumbnail is at the bottom of the reply timeline.
                    red, green, blue = IMAGE_COLORS[-1]
                    markers = tuple(bytes((blue, green, red, unused)) * 8 for unused in (0, 255))

                    def last_image_painted():
                        data = win.get_image(265, 75, 785, 625, X.ZPixmap, 0xffffffff).data
                        return any(marker in data for marker in markers)

                    try:
                        until(last_image_painted)
                    except RuntimeError:
                        print("Image response sent by fixture:",
                              (home / "bench-images-dispatched").exists(), flush=True)
                        Path("dist").mkdir(exist_ok=True)
                        subprocess.run(["import", "-window", str(wid), "dist/test-failure.png"],
                                       check=False)
                        raise
                    first_visible = (time.monotonic() - start) * 1000
                    time.sleep(max(0, start + 1.25 - time.monotonic()))
                    cpu_ms = (cpu_seconds() - before_cpu) * 1000
                    print(f"{name} last thumbnail paint: {first_visible:.1f} ms,"
                          f" app CPU {cpu_ms:.0f} ms including settle", flush=True)
                    footprint("three previews loaded")
                    return
                # Backdate the measurement to the first observation of the
                # final frame. Loading chrome and intermediate height estimates
                # can also produce non-blank frames before the reply is usable.
                frame = setup_frame
                painted_at, painted_cpu = start, before_cpu
                deadline = start + 12
                while time.monotonic() < deadline:
                    candidate = pixels()
                    now = time.monotonic()
                    if frame != candidate:
                        frame = candidate
                        painted_at, painted_cpu = now, cpu_seconds()
                    elif (now - painted_at >= 0.35 and frame != setup_frame
                          and (home / "agent-models").exists() and len(set(frame)) > 32):
                        break
                    time.sleep(0.001)
                else:
                    raise RuntimeError("settled transcript paint timed out")
                print(f"{name} settled transcript paint: {(painted_at - start) * 1000:.1f} ms,"
                      f" app CPU {(painted_cpu - before_cpu) * 1000:.1f} ms", flush=True)
                time.sleep(max(0, painted_at + 1 - time.monotonic()))
                xdo("mousemove", "--window", wid, 715, 320)
                footprint("loaded")

                # Keep repeated wheel gestures away from both ends of the conversation.
                for button in [4] * 28 + [5] * 14:
                    for event in (X.ButtonPress, X.ButtonRelease):
                        xtest.fake_input(screen, event, button)
                    screen.flush()
                    time.sleep(0.012)
                time.sleep(0.2)

                for mode in ("scroll", "resize"):
                    samples = []
                    for i in range(36):
                        if i == 4:
                            start_cpu = cpu_seconds()
                        resize = mode == "resize"
                        before = hashlib.blake2b(pixels(resize), digest_size=8).digest()
                        start = time.monotonic()
                        if mode == "scroll":
                            button = 4 if i % 12 < 6 else 5
                            for event in (X.ButtonPress, X.ButtonRelease):
                                xtest.fake_input(screen, event, button)
                        else:
                            win.configure(width=1030 if i % 2 == 0 else 1100, height=800)
                        screen.flush()
                        while hashlib.blake2b(pixels(resize), digest_size=8).digest() == before:
                            if time.monotonic() - start > 2:
                                raise RuntimeError(f"{mode} did not visibly update on event {i}")
                            time.sleep(0.0005)
                        if i >= 4:
                            samples.append(1000 * (time.monotonic() - start))
                        time.sleep(0.045)
                    cpu_ms = (cpu_seconds() - start_cpu) * 1000
                    print(f"{name} {mode}: median {statistics.median(samples):.1f} ms,"
                          f" p95 {sorted(samples)[30]:.1f} ms, app CPU {cpu_ms:.0f} ms / 32 events", flush=True)
                def drag(surface):
                    # Continuous width changes cross text wrapping and PTY column boundaries.
                    # Include the final settle period in CPU accounting.
                    begin = cpu_seconds()
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
                    cost = (cpu_seconds() - begin) * 1000
                    print(f"{name} {surface} continuous resize: "
                          f"app CPU {cost:.0f} ms / 160 events", flush=True)

                drag("conversation")
                # Simulate high-resolution input arriving in bursts within one frame.
                # Move through the transcript, rather than pushing at an endpoint.
                begin = cpu_seconds()
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
                cost = (cpu_seconds() - begin) * 1000
                print(f"{name} wheel burst: app CPU {cost:.0f} ms / 480 events",
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
                footprint("after revisiting history")
                if workload != "history":
                    return
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
    for workload in ("history", "table", "tools", "images"):
        benchmark(package, workload)
