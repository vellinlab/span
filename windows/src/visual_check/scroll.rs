use super::{Event, Message};
use iced::window::raw_window_handle::RawWindowHandle;
use iced::{Subscription, Task, window};
use serde_json::{Value, json};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const WARMUP: usize = 8;
const SAMPLES: usize = 128;
const WM_MOUSEMOVE: u32 = 0x0200;
const WM_MOUSEWHEEL: u32 = 0x020a;
static WAIT_FOR_FRAME: AtomicBool = AtomicBool::new(false);

pub fn frames() -> Subscription<Message> {
    iced::event::listen_raw(|event, _, _| match event {
        iced::Event::Window(window::Event::RedrawRequested(started))
            if WAIT_FOR_FRAME.swap(false, Ordering::AcqRel) =>
        {
            Some(Message::Visual(Event::Frame(started)))
        }
        _ => None,
    })
}

#[derive(Clone, Copy, Debug)]
pub struct Target {
    hwnd: isize,
    screen_point: isize,
}

impl Target {
    pub fn locate(window: &dyn window::Window, x: i32, y: i32) -> Self {
        let handle = window.window_handle().expect("Win32 window handle");
        let RawWindowHandle::Win32(handle) = handle.as_raw() else {
            panic!("expected a Win32 window");
        };
        let hwnd = handle.hwnd.get();
        let mut screen = Point { x, y };
        // The handle is owned by the fixture window on this thread.
        assert_ne!(
            unsafe { ClientToScreen(hwnd as *mut c_void, &mut screen) },
            0
        );
        post(hwnd, WM_MOUSEMOVE, 0, packed_point(x, y));
        Self {
            hwnd,
            screen_point: packed_point(screen.x, screen.y),
        }
    }
}

pub struct Benchmark {
    target: Target,
    sent: Arc<Mutex<Option<Instant>>>,
    offset: f32,
    completed: usize,
    latencies: Vec<f64>,
    started: Option<(Instant, Resources)>,
}

impl Benchmark {
    pub fn new(target: Target, offset: f32) -> Self {
        Self {
            target,
            sent: Arc::default(),
            offset,
            completed: 0,
            latencies: Vec::with_capacity(SAMPLES),
            started: None,
        }
    }

    pub fn next_input(&self) -> Task<Message> {
        let sent = self.sent.clone();
        let target = self.target;
        let delta: i16 = if self.completed.is_multiple_of(2) {
            120
        } else {
            -120
        };
        let wait = if self.completed == 0 { 85 } else { 16 };
        Task::future(async move {
            tokio::time::sleep(Duration::from_millis(wait)).await;
            let mut mine = sent.lock().expect("wheel timestamp");
            *mine = Some(Instant::now());
            WAIT_FOR_FRAME.store(true, Ordering::Release);
            post(
                target.hwnd,
                WM_MOUSEWHEEL,
                usize::from(delta as u16) << 16,
                target.screen_point,
            );
        })
        .discard()
    }

    pub fn frame(&mut self, frame_started: Instant, offset: f32) -> Task<Message> {
        let mut sent = self.sent.lock().expect("wheel timestamp");
        let movement = offset - self.offset;
        let Some(posted) = *sent else {
            return Task::none();
        };
        if frame_started < posted || movement.abs() < 1.0 {
            WAIT_FOR_FRAME.store(true, Ordering::Release);
            return Task::none();
        }
        let now = Instant::now();
        let expected = if self.completed.is_multiple_of(2) {
            60.0
        } else {
            -60.0
        };
        assert!(
            (movement - expected).abs() < 1.0,
            "wheel moved {movement}, expected {expected}"
        );
        *sent = None;
        drop(sent);

        self.offset = offset;
        self.completed += 1;
        if self.completed == WARMUP {
            self.started = Some((now, Resources::read()));
        } else if self.completed > WARMUP {
            self.latencies
                .push(now.duration_since(posted).as_secs_f64() * 1000.0);
        }
        if self.latencies.len() < SAMPLES {
            return self.next_input();
        }

        let (start, baseline) = self.started.take().expect("scroll baseline");
        let end = Resources::read();
        let wall_ms = now.duration_since(start).as_secs_f64() * 1000.0;
        self.latencies.sort_by(f64::total_cmp);
        let cpu_ms = (end.ticks - baseline.ticks) as f64 / 10_000.0;
        let results = json!({
            "samples": SAMPLES,
            "warmup": WARMUP,
            "wheel_to_frame_p50_ms": self.percentile(50),
            "wheel_to_frame_p95_ms": self.percentile(95),
            "wheel_to_frame_max_ms": self.latencies.last(),
            "cpu_ms": cpu_ms,
            "wall_ms": wall_ms,
            "working_set_start_bytes": baseline.working_set,
            "working_set_end_bytes": end.working_set,
            "working_set_peak_bytes": end.peak_working_set,
            "private_start_bytes": baseline.private_usage,
            "private_end_bytes": end.private_usage,
        });
        Task::done(Message::Visual(Event::ScrollResults(results)))
    }

    fn percentile(&self, percentile: usize) -> f64 {
        self.latencies[(self.latencies.len() * percentile).div_ceil(100) - 1]
    }
}

pub fn save(path: &std::path::Path, results: &Value) {
    std::fs::write(
        path.join("scroll.json"),
        serde_json::to_vec_pretty(results).expect("encode scroll metrics"),
    )
    .expect("write scroll metrics");
}

fn packed_point(x: i32, y: i32) -> isize {
    (u32::from(x as u16) | (u32::from(y as u16) << 16)) as isize
}

fn post(hwnd: isize, message: u32, wparam: usize, lparam: isize) {
    // Only the fixture's live Span window is targeted.
    assert_ne!(
        unsafe { PostMessageW(hwnd as *mut c_void, message, wparam, lparam) },
        0
    );
}

struct Resources {
    ticks: u64,
    working_set: usize,
    peak_working_set: usize,
    private_usage: usize,
}

impl Resources {
    fn read() -> Self {
        let mut creation = FileTime::default();
        let mut exit = FileTime::default();
        let mut kernel = FileTime::default();
        let mut user = FileTime::default();
        let cb = size_of::<MemoryCounters>() as u32;
        let mut memory = MemoryCounters {
            cb,
            ..MemoryCounters::default()
        };
        // The current-process pseudo-handle does not require closing.
        unsafe {
            let process = GetCurrentProcess();
            assert_ne!(
                GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user),
                0
            );
            assert_ne!(K32GetProcessMemoryInfo(process, &mut memory, cb), 0);
        }
        Self {
            ticks: kernel.ticks() + user.ticks(),
            working_set: memory.working_set,
            peak_working_set: memory.peak_working_set,
            private_usage: memory.private_usage,
        }
    }
}

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

#[derive(Default)]
#[repr(C)]
struct FileTime {
    low: u32,
    high: u32,
}

impl FileTime {
    fn ticks(&self) -> u64 {
        u64::from(self.low) | (u64::from(self.high) << 32)
    }
}

#[derive(Default)]
#[repr(C)]
struct MemoryCounters {
    cb: u32,
    page_faults: u32,
    peak_working_set: usize,
    working_set: usize,
    peak_paged: usize,
    paged: usize,
    peak_non_paged: usize,
    non_paged: usize,
    pagefile: usize,
    peak_pagefile: usize,
    private_usage: usize,
}

#[link(name = "user32")]
unsafe extern "system" {
    fn ClientToScreen(hwnd: *mut c_void, point: *mut Point) -> i32;
    fn PostMessageW(hwnd: *mut c_void, message: u32, wparam: usize, lparam: isize) -> i32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> *mut c_void;
    fn GetProcessTimes(
        process: *mut c_void,
        creation: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
    fn K32GetProcessMemoryInfo(process: *mut c_void, memory: *mut MemoryCounters, len: u32) -> i32;
}
