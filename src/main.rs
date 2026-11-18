mod agent;
mod agent_render;
mod agent_rpc;
mod browser;
mod files;
mod host_dialog;
mod hosts;
mod icons;
mod mermaid;
mod session;
mod sftp;
mod vte;
mod workbench;

use gtk::prelude::*;
use gtk::{gdk, glib};

fn main() -> glib::ExitCode {
    let app = gtk::Application::builder()
        .application_id("io.github.zyw02.SshWorkbench")
        .build();
    app.connect_startup(|_| {
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
    });
    app.connect_activate(|app| {
        if let Some(window) = app.active_window() {
            window.present();
        } else {
            workbench::open(app);
        }
    });
    app.run()
}
