use std::sync::OnceLock;

static PRIVATE_GL_DEFAULT: OnceLock<bool> = OnceLock::new();

#[cfg(target_os = "linux")]
pub fn configure_graphics() {
    let use_default = std::env::var_os("GDK_GL").is_none();
    if use_default {
        // Span uses Cairo. Avoid initializing GL merely to choose an X11 visual.
        // This runs before GTK or GIO initialization on the sole startup thread.
        unsafe { std::env::set_var("GDK_GL", "disable") };
    }
    let _ = PRIVATE_GL_DEFAULT.set(use_default);
}

pub fn private_variables() -> impl Iterator<Item = &'static str> + Clone {
    let private_allocator = cfg!(target_os = "linux")
        && std::env::var_os("SPAN_INTERNAL_G_SLICE").is_some_and(|value| value == "1");
    [
        private_allocator.then_some("G_SLICE"),
        private_allocator.then_some("SPAN_INTERNAL_G_SLICE"),
        (PRIVATE_GL_DEFAULT.get() == Some(&true)).then_some("GDK_GL"),
    ]
    .into_iter()
    .flatten()
}
