mod agent;
mod agent_activity;
mod agent_attachments;
mod agent_catalog;
mod agent_diff;
mod agent_options;
mod agent_question;
mod agent_render;
mod agent_rpc;
mod agent_selection;
mod agent_task;
mod agent_usage;
mod browser;
mod files;
mod host_dialog;
mod hosts;
mod icons;
mod mermaid;
mod preview;
mod quote;
mod reading_column;
mod session;
mod sftp;
mod source_preview;
mod vte;
mod workbench;

use gtk::prelude::*;
use gtk::{gdk, glib};

const APP_ID: &str = "io.github.zyw02.SshWorkbench";
const APP_NAME: &str = "Span";

fn main() -> glib::ExitCode {
    glib::set_application_name(APP_NAME);
    if std::env::var_os("SPAN_SSH_ASKPASS").as_deref() == Some(std::ffi::OsStr::new("1"))
        && let Some(prompt) = std::env::args_os().nth(1)
    {
        if gtk::init().is_err() {
            return glib::ExitCode::FAILURE;
        }
        load_theme();
        return host_dialog::askpass(&prompt.to_string_lossy());
    }
    let app = gtk::Application::builder().application_id(APP_ID).build();
    app.connect_startup(|_| load_theme());
    app.connect_activate(|app| {
        if let Some(window) = app.active_window() {
            window.present();
        } else {
            workbench::open(app);
        }
    });
    app.run()
}

fn load_theme() {
    let provider = gtk::CssProvider::new();
    if let Err(error) = provider.load_from_data(include_bytes!("workbench.css")) {
        eprintln!("Failed to load Workbench theme: {error}");
    }
    if let Some(screen) = gdk::Screen::default() {
        gtk::StyleContext::add_provider_for_screen(
            &screen,
            &provider,
            gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
        );
    }
}
