use gtk::glib::{self, ffi as gffi, translate::*};
use gtk::prelude::*;
use std::ffi::{c_char, c_int, c_long, c_uint, c_void};
use std::ptr::{NonNull, null_mut};

#[repr(C)]
pub struct VteTerminal {
    _private: [u8; 0],
}

type SpawnCallback =
    unsafe extern "C" fn(*mut VteTerminal, gffi::GPid, *mut gffi::GError, *mut c_void);

#[link(name = "vte-2.91")]
unsafe extern "C" {
    fn vte_terminal_get_type() -> gffi::GType;
    fn vte_terminal_new() -> *mut gtk::ffi::GtkWidget;
    fn vte_terminal_set_scrollback_lines(terminal: *mut VteTerminal, lines: c_long);
    fn vte_terminal_set_input_enabled(terminal: *mut VteTerminal, enabled: gffi::gboolean);
    fn vte_terminal_reset(
        terminal: *mut VteTerminal,
        clear_tabstops: gffi::gboolean,
        clear_history: gffi::gboolean,
    );
    fn vte_terminal_feed(terminal: *mut VteTerminal, data: *const c_char, len: isize);
    fn vte_terminal_copy_clipboard_format(terminal: *mut VteTerminal, format: c_uint);
    fn vte_terminal_paste_clipboard(terminal: *mut VteTerminal);
    fn vte_terminal_spawn_async(
        terminal: *mut VteTerminal,
        pty_flags: c_uint,
        cwd: *const c_char,
        argv: *mut *mut c_char,
        envv: *mut *mut c_char,
        spawn_flags: c_uint,
        child_setup: gffi::GSpawnChildSetupFunc,
        child_setup_data: *mut c_void,
        child_setup_data_destroy: gffi::GDestroyNotify,
        timeout: c_int,
        cancellable: *mut gtk::gio::ffi::GCancellable,
        callback: Option<SpawnCallback>,
        callback_data: *mut c_void,
    );
}

glib::wrapper! {
    pub struct Terminal(Object<VteTerminal>)
        @extends gtk::Widget, @implements gtk::Scrollable;

    match fn {
        type_ => || vte_terminal_get_type(),
    }
}

impl Terminal {
    pub fn new() -> Self {
        assert!(gtk::is_initialized_main_thread());
        // VTE constructs a GtkWidget with a floating GObject reference.
        unsafe { from_glib_none(vte_terminal_new().cast()) }
    }

    pub fn set_scrollback_lines(&self, lines: c_long) {
        unsafe { vte_terminal_set_scrollback_lines(self.to_glib_none().0, lines) }
    }

    pub fn set_input_enabled(&self, enabled: bool) {
        unsafe { vte_terminal_set_input_enabled(self.to_glib_none().0, enabled.into_glib()) }
    }

    pub fn reset(&self, clear_tabstops: bool, clear_history: bool) {
        unsafe {
            vte_terminal_reset(
                self.to_glib_none().0,
                clear_tabstops.into_glib(),
                clear_history.into_glib(),
            )
        }
    }

    pub fn feed(&self, data: &[u8]) {
        unsafe {
            vte_terminal_feed(
                self.to_glib_none().0,
                data.as_ptr().cast(),
                data.len() as isize,
            )
        }
    }

    pub fn copy_text(&self) {
        const VTE_FORMAT_TEXT: c_uint = 1;
        unsafe { vte_terminal_copy_clipboard_format(self.to_glib_none().0, VTE_FORMAT_TEXT) }
    }

    pub fn paste_text(&self) {
        unsafe { vte_terminal_paste_clipboard(self.to_glib_none().0) }
    }

    pub fn connect_child_exited(&self, on_exit: impl Fn(&Self, i32) + 'static) {
        self.connect_local("child-exited", false, move |values| {
            let terminal = values[0].get::<Self>().expect("VTE terminal");
            let status = values[1].get::<i32>().expect("VTE child exit status");
            on_exit(&terminal, status);
            None
        });
    }

    pub fn spawn<F>(&self, cwd: Option<&str>, argv: &[&str], on_spawn: F)
    where
        F: FnOnce(Result<(), glib::Error>) + 'static,
    {
        assert!(!argv.is_empty());
        unsafe extern "C" fn finished<F>(
            _terminal: *mut VteTerminal,
            _pid: gffi::GPid,
            error: *mut gffi::GError,
            data: *mut c_void,
        ) where
            F: FnOnce(Result<(), glib::Error>) + 'static,
        {
            // VTE calls this once, including if the terminal was destroyed.
            let on_spawn = unsafe { Box::from_raw(data.cast::<F>()) };
            let result = match NonNull::new(error) {
                Some(error) => Err(unsafe { from_glib_none(error.as_ptr()) }),
                None => Ok(()),
            };
            on_spawn(result);
        }

        // VTE copies cwd and argv during this call; a null envv inherits the environment.
        unsafe {
            vte_terminal_spawn_async(
                self.to_glib_none().0,
                0,
                cwd.to_glib_none().0,
                argv.to_glib_none().0,
                null_mut(),
                0,
                None,
                null_mut(),
                None,
                10_000,
                null_mut(),
                Some(finished::<F>),
                Box::into_raw(Box::new(on_spawn)).cast(),
            )
        }
    }
}
