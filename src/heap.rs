pub const PRIVATE_ENVIRONMENT: [&str; 2] = ["G_SLICE", "SPAN_INTERNAL_G_SLICE"];

pub fn has_private_allocator() -> bool {
    cfg!(target_os = "linux")
        && std::env::var_os("SPAN_INTERNAL_G_SLICE").is_some_and(|value| value == "1")
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
pub fn release_after_session_close() {
    use gtk::{gio, glib};
    use std::cell::RefCell;
    use std::time::Duration;

    unsafe extern "C" {
        fn malloc_trim(pad: usize) -> std::ffi::c_int;
    }

    thread_local! {
        static PENDING: RefCell<Option<glib::SourceId>> = const { RefCell::new(None) };
    }

    PENDING.with(|pending| {
        if let Some(source) = pending.take() {
            source.remove();
        }
        // Several tab closures usually happen together. Sweep once off the UI
        // thread after GTK has dropped all of their widgets.
        pending.replace(Some(glib::timeout_add_local_once(
            Duration::from_millis(750),
            || {
                PENDING.with(|pending| pending.take());
                glib::MainContext::default().spawn_local(async {
                    let _ = gio::spawn_blocking(|| {
                        // glibc synchronizes access to its arenas with other threads.
                        unsafe { malloc_trim(0) };
                    })
                    .await;
                });
            },
        )));
    });
}
