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


def until(check, interval=0.02, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(interval)
    raise RuntimeError("X11 benchmark setup timed out")


def divider_pixel(window, x, y):
    return window.get_image(x, y, 1, 1, X.ZPixmap, 0xffffffff).data[:3]


def sidebar_handle(window, origin):
    # GTK may emulate its input windows. Locate the actual divider by the
    # vertical accent line painted when the pointer is over its hit area.
    y = 300
    for x in range(212, 390, 2):
        before = divider_pixel(window, x, y)
        xtest.fake_input(screen, X.MotionNotify, x=origin.x + x, y=origin.y + y)
        screen.flush()
        time.sleep(0.024)
        color = divider_pixel(window, x, y)
        if (color != before and min(color) >= 110
                and color == divider_pixel(window, x, y + 152)):
            return x, y, color
    raise RuntimeError("moving over the sidebar divider did not paint its accent")


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
    same_directory = workload == "tabs-shared-directory"
    show_catalog = workload == "tabs-catalog"
    remap_prose = workload == "remap-prose"
    finish_prose = workload == "finish-prose"
    offscreen_prose = workload in ("offscreen-prose", "remap-prose", "finish-prose")
    warmup_events = 4
    switching_tabs = workload in ("tabs", "tabs-shared-directory", "tabs-catalog")
    live_scroll = workload == "live-scroll"
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
                   SPAN_BENCH_HISTORY=str(int(workload == "history" or switching_tabs
                                             or live_scroll or offscreen_prose)),
                   SPAN_BENCH_TABLE=str(int(workload == "table")),
                   SPAN_BENCH_TOOLS=str(int(workload == "tools")),
                   SPAN_BENCH_IMAGES=str(int(workload == "images")),
                   SPAN_BENCH_STREAM={"live-scroll": "scroll", "hidden-prose": "hidden-prose",
                                      "offscreen-prose": "hidden-prose",
                                      "remap-prose": "hidden-prose",
                                      "finish-prose": "hidden-prose"}.get(
                                          workload, str(int(workload == "stream"))),
                   SPAN_BENCH_TASK_IDLE=str(int(workload == "task-wait")),
                   SPAN_BENCH_TABS=str(int(switching_tabs)),
                   SPAN_BENCH_CATALOG=str(int(show_catalog)),
                   GTK_THEME="Adwaita:dark", NO_AT_BRIDGE="1", GDK_BACKEND="x11")
        if offscreen_prose:
            env["SPAN_BENCH_OFFSCREEN_PROSE"] = "1"
        if remap_prose:
            env["SPAN_BENCH_REMAP_PROSE"] = "1"
        if finish_prose:
            env["SPAN_BENCH_FINISH_PROSE"] = "1"
        if same_directory:
            # Keep App Server markers outside the folder open in every tab.
            workspace = home / "workspace"
            workspace.mkdir()
            for index in range(384):
                (workspace / f"project-file-{index:03d}.txt").touch()
            env.update(HOME=str(workspace), SPAN_BENCH_FIXTURE_HOME=directory)
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

                def wheel(button):
                    for event in (X.ButtonPress, X.ButtonRelease):
                        xtest.fake_input(screen, event, button)
                    screen.flush()

                setup_frame = pixels()
                before_cpu = cpu_seconds()
                start = time.monotonic()
                enter = screen.keysym_to_keycode(XK.string_to_keysym("Return"))
                for event in (X.KeyPress, X.KeyRelease):
                    xtest.fake_input(screen, event, enter)
                screen.flush()
                if workload == "task-wait":
                    until(lambda: (home / "agent-models").exists())
                    time.sleep(0.15)
                    xdo("type", "Wait for the test tool")
                    xdo("key", "Return")
                    until(lambda: (home / "bench-tool-started").exists())
                    time.sleep(0.45)
                    start = cpu_seconds()
                    time.sleep(4)
                    assert not (home / "bench-tool-finished").exists()
                    print(f"{name} CPU waiting for a tool: {(cpu_seconds() - start) * 1000:.1f} ms / 4 s",
                          flush=True)
                    until(lambda: (home / "bench-tool-finished").exists())
                    return
                if workload == "hidden-prose" or offscreen_prose:
                    until(lambda: (home / "agent-models").exists())
                    time.sleep(0.65 if offscreen_prose else 0.20)
                    xdo("type", "Stream a reply in the background")
                    xdo("key", "Return")
                    until((home / "bench-hidden-started").exists)
                    sent = pixels()
                    if offscreen_prose:
                        xdo("mousemove", "--window", wid, 715, 320)
                        for _ in range(12):
                            wheel(4)
                    else:
                        xdo("key", "ctrl+shift+a")
                    until(lambda: pixels() != sent)
                    time.sleep(0.2)
                    hidden_frame = pixels()
                    if remap_prose:
                        xdo("key", "ctrl+shift+t")
                        until(lambda: pixels() != hidden_frame)
                    start = cpu_seconds()
                    (home / "bench-hidden-unmapped").touch()
                    if workload == "offscreen-prose":
                        samples = []
                        schedule = time.monotonic()
                        for index in range(100):
                            before = pixels()
                            input_at = time.monotonic()
                            wheel(4 if index % 20 < 10 else 5)
                            while pixels() == before:
                                if time.monotonic() - input_at > 1:
                                    raise RuntimeError(f"{name} wheel event {index} did not repaint")
                                time.sleep(0.0005)
                            samples.append((time.monotonic() - input_at) * 1000)
                            time.sleep(max(0, schedule + (index + 1) * 0.035 - time.monotonic()))
                        elapsed = time.monotonic() - schedule
                        print(f"{name} scroll during streamed prose:"
                              f" median {statistics.median(samples):.1f} ms,"
                              f" p95 {sorted(samples)[94]:.1f} ms,"
                              f" app CPU {(cpu_seconds() - start) * 1000:.0f} ms / 100 events in {elapsed:.3f} s",
                              flush=True)
                        assert not (home / "bench-hidden-buffered").exists(), elapsed
                    until((home / "bench-hidden-buffered").exists, timeout=20)
                    cpu_ms = (cpu_seconds() - start) * 1000
                    footprint("after buffering inactive reply")
                    assert not (home / "bench-hidden-finished").exists()
                    if not offscreen_prose:
                        xdo("key", "ctrl+shift+a")
                        until(lambda: pixels() != hidden_frame)
                    elif remap_prose:
                        time.sleep(0.25)
                        ctrl = screen.keysym_to_keycode(XK.string_to_keysym("Control_L"))
                        previous_tab = screen.keysym_to_keycode(XK.string_to_keysym("Page_Up"))
                        before_remap = cpu_seconds()
                        input_at = time.monotonic()
                        xtest.fake_input(screen, X.KeyPress, ctrl)
                        xtest.fake_input(screen, X.KeyPress, previous_tab)
                        xtest.fake_input(screen, X.KeyRelease, previous_tab)
                        xtest.fake_input(screen, X.KeyRelease, ctrl)
                        screen.flush()
                        until(lambda: pixels() == hidden_frame, interval=0.001)
                        latency = (time.monotonic() - input_at) * 1000
                        time.sleep(max(0.0, input_at + 0.6 - time.monotonic()))
                        assert pixels() == hidden_frame, "the previous reading position changed"
                        print(f"{name} return to older history while reply is buffered:"
                              f" {latency:.1f} ms, app CPU {(cpu_seconds() - before_remap) * 1000:.0f} ms",
                              flush=True)
                    elif finish_prose:
                        time.sleep(0.15)
                        assert pixels() == hidden_frame, "the reply advanced the older viewport"
                        cpu_before = cpu_seconds()
                        (home / "bench-hidden-verified").touch()
                        until((home / "bench-completion-dispatched").exists, interval=0.001)
                        sequence_start = time.monotonic()
                        samples = []
                        for index in range(40):
                            before = pixels()
                            input_at = time.monotonic()
                            wheel(4 if index % 10 < 5 else 5)
                            until(lambda: pixels() != before, interval=0.001, timeout=2)
                            samples.append((time.monotonic() - input_at) * 1000)
                            time.sleep(max(0, sequence_start + (index + 1) * 0.023 - time.monotonic()))
                        cost = (cpu_seconds() - cpu_before) * 1000
                        print(f"{name} reply completion while scrolling older history:"
                              f" p95 {sorted(samples)[37]:.1f} ms, max {max(samples):.1f} ms,"
                              f" app CPU {cost:.0f} ms / 40 wheel events", flush=True)
                        until((home / "bench-hidden-finished").exists)
                    xdo("mousemove", "--window", wid, 715, 320)
                    # Allow follow-tail to restore the latest output. Then
                    # scroll down until the pixels stop changing so both
                    # specimens are compared at the same end position.
                    def reply_pixels():
                        return win.get_image(395, 420, 390, 180, X.ZPixmap, 0xffffffff).data

                    # The final link is the only underline this long. A small
                    # unchanged crop can also mean GTK has yet to lay out the
                    # buffered reply, so require that last line before exiting.
                    tail = tuple(bytes((255, 191, 160, a)) * 120 for a in (0, 255))

                    def final_fragment_visible():
                        image = win.get_image(285, 125, 775, 550, X.ZPixmap, 0xffffffff).data
                        return any(mark in image for mark in tail)

                    auto_followed = False
                    if not offscreen_prose:
                        # Candidate must show the last line without a wheel
                        # gesture. Older releases can require a manual scroll.
                        try:
                            until(final_fragment_visible, interval=0.01, timeout=5)
                            auto_followed = True
                        except RuntimeError:
                            if Path(binary).parent.name == "candidate":
                                raise
                        print(f"{name} automatically followed the buffered reply: {auto_followed}",
                              flush=True)
                    if not auto_followed:
                        time.sleep(0.22)
                        visible = reply_pixels()
                        for _ in range(28):
                            for _ in range(16):
                                xtest.fake_input(screen, X.ButtonPress, 5)
                                xtest.fake_input(screen, X.ButtonRelease, 5)
                            screen.flush()
                            time.sleep(0.28)
                            final = reply_pixels()
                            if final == visible and final_fragment_visible():
                                break
                            visible = final
                        else:
                            if shutil.which("import"):
                                Path("dist").mkdir(exist_ok=True)
                                subprocess.run(["import", "-window", str(wid), "dist/test-failure.png"],
                                               check=False)
                            raise RuntimeError("the buffered reply never reached its last viewport")
                    else:
                        visible = reply_pixels()
                    assert len(set(visible)) > 32
                    digest = hashlib.sha256(visible).hexdigest()
                    print(f"{name} final reply viewport: {digest}", flush=True)
                    phase = "reply below the viewport" if offscreen_prose else "inactive reply"
                    print(f"{name} {phase}: app CPU {cpu_ms:.0f} ms for 576 deltas", flush=True)
                    if not finish_prose:
                        (home / "bench-hidden-verified").touch()
                        until((home / "bench-hidden-finished").exists)
                    return digest
                if workload == "stream":
                    until(lambda: (home / "agent-models").exists())
                    time.sleep(0.2)
                    xdo("type", "Summarize the stream")

                    def conversation_pixels():
                        return win.get_image(330, 90, 430, 320, X.ZPixmap, 0xffffffff).data

                    initial_frame = conversation_pixels()
                    before_cpu = cpu_seconds()
                    for event in (X.KeyPress, X.KeyRelease):
                        xtest.fake_input(screen, event, enter)
                    screen.flush()
                    finished = home / "bench-stream-done"
                    until(finished.exists)
                    dispatched = float(finished.read_text())
                    frame, painted_at = initial_frame, dispatched
                    deadline = dispatched + 6
                    while time.monotonic() < deadline:
                        candidate = conversation_pixels()
                        now = time.monotonic()
                        if frame != candidate:
                            frame, painted_at = candidate, now
                        if frame != initial_frame and now - painted_at >= 0.45:
                            break
                        time.sleep(0.003)
                    else:
                        raise RuntimeError("reasoning stream did not settle")
                    cpu_ms = (cpu_seconds() - before_cpu) * 1000
                    print(f"{name} streamed reasoning: app CPU {cpu_ms:.0f} ms for 576 deltas, "
                          f"final paint within {(painted_at - dispatched) * 1000:.1f} ms after dispatch",
                          flush=True)
                    footprint("reasoning complete")
                    return
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

                    # GTK keeps the opening card in view while the images
                    # expand asynchronously. Verify the other end separately
                    # to avoid timing a fast draw that loaded only one image.
                    def image_painted(color):
                        red, green, blue = color
                        markers = (bytes((blue, green, red, 0)) * 8,
                                   bytes((blue, green, red, 255)) * 8)
                        data = win.get_image(565, 140, 135, 555, X.ZPixmap, 0xffffffff).data
                        return any(marker in data for marker in markers)

                    try:
                        until(lambda: image_painted(IMAGE_COLORS[0]), interval=0.002)
                    except RuntimeError:
                        print("Image response sent by fixture:",
                              (home / "bench-images-dispatched").exists(), flush=True)
                        if shutil.which("import"):
                            Path("dist").mkdir(exist_ok=True)
                            subprocess.run(["import", "-window", str(wid), "dist/test-failure.png"],
                                           check=False)
                        raise
                    first_visible = (time.monotonic() - start) * 1000
                    time.sleep(max(0, start + 1.25 - time.monotonic()))
                    cpu_ms = (cpu_seconds() - before_cpu) * 1000
                    print(f"{name} first thumbnail paint: {first_visible:.1f} ms,"
                          f" app CPU {cpu_ms:.0f} ms including settle", flush=True)
                    xdo("mousemove", "--window", wid, 715, 365)
                    for _ in range(80):
                        for event in (X.ButtonPress, X.ButtonRelease):
                            xtest.fake_input(screen, event, 5)
                    screen.flush()
                    until(lambda: image_painted(IMAGE_COLORS[-1]))
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
                if switching_tabs:
                    if show_catalog:
                        xdo("key", "ctrl+shift+h")
                        time.sleep(0.20)
                    xdo("mousemove", "--window", wid, 1040, 20)
                    def directory_pixels():
                        return win.get_image(60, 225, 170, 280, X.ZPixmap, 0xffffffff).data

                    directory_frame = directory_pixels() if same_directory else b""
                    if same_directory:
                        assert len(set(directory_frame)) > 32, "the shared file directory is empty"
                    def catalog_pixels():
                        return win.get_image(54, 200, 194, 290, X.ZPixmap, 0xffffffff).data

                    tab_frames = [pixels()]
                    catalog_frames = [catalog_pixels()] if show_catalog else []
                    for number in (2, 3):
                        (home / "agent-models").unlink()
                        xdo("key", "ctrl+shift+t")
                        time.sleep(0.2)
                        xdo("key", "ctrl+shift+a")
                        time.sleep(0.2)
                        xdo("key", "Return")
                        until(lambda: (home / f"bench-tab-{number}").exists()
                              and (home / "agent-models").exists())
                        time.sleep(0.65)
                        frame = pixels()
                        assert len(set(frame)) > 32 and frame not in tab_frames
                        tab_frames.append(frame)
                        if show_catalog:
                            sidebar_frame = catalog_pixels()
                            assert len(set(sidebar_frame)) > 32 and sidebar_frame not in catalog_frames
                            catalog_frames.append(sidebar_frame)
                    footprint("three loaded sessions")
                    samples = []
                    event_count = 120 if same_directory else 128
                    for index in range(warmup_events + event_count):
                        offset = index % 2
                        button = "Page_Up" if offset == 0 else "Page_Down"
                        key = screen.keysym_to_keycode(XK.string_to_keysym(button))
                        ctrl = screen.keysym_to_keycode(XK.string_to_keysym("Control_L"))
                        if index == warmup_events:
                            start_cpu = cpu_seconds()
                        start = time.monotonic()
                        xtest.fake_input(screen, X.KeyPress, ctrl)
                        xtest.fake_input(screen, X.KeyPress, key)
                        xtest.fake_input(screen, X.KeyRelease, key)
                        xtest.fake_input(screen, X.KeyRelease, ctrl)
                        screen.flush()
                        while (pixels() != tab_frames[1 + offset]
                               or (show_catalog and catalog_pixels() != catalog_frames[1 + offset])):
                            if time.monotonic() - start > 2:
                                raise RuntimeError(f"switch {index} did not repaint the expected session")
                            time.sleep(0.001)
                        if index >= warmup_events:
                            samples.append((time.monotonic() - start) * 1000)
                        time.sleep(0.05)
                    cpu_ms = (cpu_seconds() - start_cpu) * 1000
                    p95 = sorted(samples)[(95 * len(samples) + 99) // 100 - 1]
                    print(f"{name} session switch: median {statistics.median(samples):.1f} ms,"
                          f" p95 {p95:.1f} ms, app CPU {cpu_ms:.0f} ms / {len(samples)} events",
                          flush=True)
                    if same_directory:
                        assert directory_pixels() == directory_frame, "file listing changed across tabs"
                    footprint("after switching sessions")
                    return
                xdo("mousemove", "--window", wid, 715, 320)
                footprint("loaded")

                if live_scroll:
                    xdo("type", "Summarize the stream")
                    xdo("key", "Return")
                    until((home / "bench-stream-started").exists)
                    for _ in range(12):
                        xtest.fake_input(screen, X.ButtonPress, 4)
                        xtest.fake_input(screen, X.ButtonRelease, 4)
                    screen.sync()
                    time.sleep(0.2)
                    samples = []
                    begin = cpu_seconds()
                    schedule = time.monotonic()
                    for index in range(100):
                        # Inspect old messages while the next turn is arriving.
                        before = pixels()
                        start = time.monotonic()
                        button = 4 if index % 20 < 10 else 5
                        xtest.fake_input(screen, X.ButtonPress, button)
                        xtest.fake_input(screen, X.ButtonRelease, button)
                        screen.flush()
                        while pixels() == before:
                            if time.monotonic() - start > 1:
                                raise RuntimeError(f"scroll during reasoning did not update on event {index}")
                            time.sleep(0.0005)
                        samples.append((time.monotonic() - start) * 1000)
                        time.sleep(max(0, schedule + (index + 1) * 0.025 - time.monotonic()))
                    cpu_ms = (cpu_seconds() - begin) * 1000
                    assert not (home / "bench-stream-done").exists()
                    print(f"{name} scroll during reasoning: median {statistics.median(samples):.1f} ms,"
                          f" p95 {sorted(samples)[94]:.1f} ms,"
                          f" app CPU {cpu_ms:.0f} ms / 100 events", flush=True)
                    until((home / "bench-stream-done").exists)
                    return

                # Keep repeated wheel gestures away from both ends of the conversation.
                for button in [4] * 28 + [5] * 14:
                    for event in (X.ButtonPress, X.ButtonRelease):
                        xtest.fake_input(screen, event, button)
                    screen.flush()
                    time.sleep(0.012)
                time.sleep(0.2)

                for mode in ("scroll", "resize"):
                    samples = []
                    event_count = 128 if mode == "scroll" and workload == "history" else 32
                    for i in range(warmup_events + event_count):
                        if i == warmup_events:
                            start_cpu = cpu_seconds()
                        resize = mode == "resize"
                        before = pixels(resize)
                        start = time.monotonic()
                        if mode == "scroll":
                            button = 4 if i % 12 < 6 else 5
                            for event in (X.ButtonPress, X.ButtonRelease):
                                xtest.fake_input(screen, event, button)
                        else:
                            win.configure(width=1030 if i % 2 == 0 else 1100, height=800)
                        screen.flush()
                        while pixels(resize) == before:
                            if time.monotonic() - start > 2:
                                raise RuntimeError(f"{mode} did not visibly update on event {i}")
                            time.sleep(0.0005)
                        if i >= warmup_events:
                            samples.append(1000 * (time.monotonic() - start))
                        time.sleep(0.045)
                    cpu_ms = (cpu_seconds() - start_cpu) * 1000
                    p95 = sorted(samples)[(95 * len(samples) + 99) // 100 - 1]
                    print(f"{name} {mode}: median {statistics.median(samples):.1f} ms,"
                          f" p95 {p95:.1f} ms, app CPU {cpu_ms:.0f} ms / {len(samples)} events",
                          flush=True)
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
                if workload == "history":
                    origin = screen.screen().root.translate_coords(win, 0, 0)
                    handle_x, handle_y, accent = sidebar_handle(win, origin)
                    x, y = origin.x + handle_x, origin.y + handle_y
                    xtest.fake_input(screen, X.ButtonPress, 1)
                    screen.sync()
                    time.sleep(0.04)
                    begin = cpu_seconds()
                    start = time.monotonic()
                    for frame in range(160):
                        phase = frame % 80
                        offset = 3 * min(phase, 80 - phase)
                        xtest.fake_input(screen, X.MotionNotify, x=x + offset, y=y)
                        screen.flush()
                        time.sleep(max(0, start + (frame + 1) / 60 - time.monotonic()))
                        if frame == 40:
                            until(lambda: divider_pixel(win, handle_x + offset, handle_y) == accent,
                                  0.002)
                    xtest.fake_input(screen, X.MotionNotify, x=x, y=y)
                    xtest.fake_input(screen, X.ButtonRelease, 1)
                    screen.sync()
                    until(lambda: divider_pixel(win, handle_x, handle_y) == accent)
                    time.sleep(0.35)
                    cost = (cpu_seconds() - begin) * 1000
                    print(f"{name} sidebar divider drag: app CPU {cost:.0f} ms / 160 motions",
                          flush=True)
                    xdo("mousemove", "--window", wid, 715, 320)

                # Simulate high-resolution input arriving in bursts within one frame.
                # Move through the transcript, rather than pushing at an endpoint.
                def wheel_burst(stage):
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
                    print(f"{name} {stage}: app CPU {cost:.0f} ms / 480 events", flush=True)

                wheel_burst("wheel burst")
                if workload == "history":
                    # Repeat from the settled position while the blocks used by
                    # the previous gesture still have their text layouts.
                    wheel_burst("repeated wheel burst")

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
                xdo("mousemove", "--window", wid, 420, 171, "mousedown", 1)
                time.sleep(0.08)
                origin = screen.screen().root.translate_coords(win, 0, 0)
                selection_times = []
                begin = cpu_seconds()
                for step in range(32):
                    before = pixels()
                    started = time.monotonic()
                    xtest.fake_input(screen, X.MotionNotify,
                                     x=origin.x + 575, y=origin.y + (313 if step % 2 else 242))
                    screen.flush()
                    until(lambda: pixels() != before, interval=0.001)
                    selection_times.append((time.monotonic() - started) * 1000)
                    time.sleep(0.035)
                print(f"{name} selection drag: median {statistics.median(selection_times):.1f} ms,"
                      f" p95 {sorted(selection_times)[30]:.1f} ms,"
                      f" app CPU {(cpu_seconds() - begin) * 1000:.0f} ms / 32 events", flush=True)
                xdo("mouseup", 1, "key", "Escape")
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


workloads = ("hidden-prose", "remap-prose", "finish-prose", "offscreen-prose",
             "history", "table", "tools", "images", "stream", "live-scroll",
             "task-wait", "tabs", "tabs-shared-directory", "tabs-catalog")
if requested := os.environ.get("SPAN_BENCH_WORKLOADS"):
    selected = tuple(requested.split(","))
    assert set(selected) <= set(workloads), selected
    workloads = selected
reply_frames = {workload: set() for workload in ("offscreen-prose", "remap-prose", "finish-prose")
                if workload in workloads}
for package in sys.argv[1:]:
    for workload in workloads:
        final_frame = benchmark(package, workload)
        if workload in reply_frames:
            reply_frames[workload].add(final_frame)
for workload, frames in reply_frames.items():
    assert len(frames) == 1, f"{workload}: final live reply differed after returning to the bottom"
