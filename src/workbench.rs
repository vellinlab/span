use crate::browser::Browser;
use crate::host_dialog;
use crate::hosts::{self, Host};
use crate::icons::{Icon, widget as icon};
use crate::session::{Launch, Session, State};
use gtk::prelude::*;
use gtk::{gio, glib, pango};
use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

struct Workbench {
    window: glib::WeakRef<gtk::ApplicationWindow>,
    tabs: gtk::Notebook,
    views: gtk::Stack,
    sidebar: gtk::Box,
    workspace: gtk::Paned,
    browser: Rc<Browser>,
    search: gtk::SearchEntry,
    host_list: gtk::Box,
    status: gtk::Label,
    restart: gtk::Button,
    sessions: RefCell<Vec<Rc<Session>>>,
    profile_path: PathBuf,
    hosts: RefCell<Vec<Host>>,
    load_error: Option<String>,
}

pub fn open(app: &gtk::Application) {
    let window = gtk::ApplicationWindow::builder()
        .application(app)
        .title("SSH Workbench")
        .default_width(1160)
        .default_height(720)
        .build();
    window.style_context().add_class("workbench");
    window.set_titlebar(Some(&titlebar(&window)));

    let root = column(0);
    let layout = row(0);
    let (sidebar, search, host_list) = host_sidebar();
    let tabs = gtk::Notebook::builder()
        .scrollable(true)
        .enable_popup(true)
        .group_name("workbench")
        .build();
    tabs.style_context().add_class("terminal-tabs");
    let plus = icon_button(Icon::Plus, "新建本地终端 (Ctrl+Shift+T)");
    plus.set_action_name(Some("win.local"));
    let files = icon_button(Icon::Folder, "文件目录 (Ctrl+Shift+F)");
    files.set_action_name(Some("win.files"));
    let tools = row(2);
    tools.add(&files);
    tools.add(&plus);
    tools.show_all();
    tabs.set_action_widget(&tools, gtk::PackType::End);

    let views = gtk::Stack::new();
    views.add_named(&tabs, "terminal");
    views.add_named(&empty_workspace(), "empty");
    layout.pack_start(&tool_rail(&sidebar), false, false, 0);
    layout.pack_start(&sidebar, false, false, 0);
    let browser = Browser::new();
    let workspace = gtk::Paned::new(gtk::Orientation::Horizontal);
    workspace.style_context().add_class("files-split");
    workspace.pack1(&views, true, true);
    workspace.pack2(&browser.panel, false, false);
    layout.pack_start(&workspace, true, true, 0);
    root.pack_start(&layout, true, true, 0);

    let footer = row(9);
    footer.style_context().add_class("statusbar");
    footer.pack_start(&icon(Icon::Terminal, 14), false, false, 0);
    let status = text_label("", "session-status");
    status.set_ellipsize(pango::EllipsizeMode::End);
    footer.pack_start(&status, true, true, 0);
    let restart = gtk::Button::with_label("重新启动");
    restart.style_context().add_class("quiet-button");
    restart.set_action_name(Some("win.restart"));
    restart.set_no_show_all(true);
    footer.pack_end(&restart, false, false, 0);
    root.pack_end(&footer, false, false, 0);
    window.add(&root);

    let profile_path = hosts::path();
    let (hosts, load_error) = match hosts::load(&profile_path) {
        Ok(hosts) => (hosts, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    let workbench = Rc::new(Workbench {
        window: window.downgrade(),
        tabs,
        views,
        sidebar,
        workspace,
        browser,
        search,
        host_list,
        status,
        restart,
        sessions: RefCell::new(Vec::new()),
        profile_path,
        hosts: RefCell::new(hosts),
        load_error,
    });

    for (name, accelerators, action) in [
        (
            "local",
            &["<Primary><Shift>t"][..],
            Workbench::open_local as fn(&Rc<Workbench>),
        ),
        (
            "quick",
            &["<Primary><Shift>o"][..],
            Workbench::quick_connect,
        ),
        ("add-host", &["<Primary><Shift>n"][..], Workbench::add_host),
        (
            "close",
            &["<Primary><Shift>w"][..],
            Workbench::close_current,
        ),
        (
            "sidebar",
            &["<Primary><Shift>b"][..],
            Workbench::toggle_sidebar,
        ),
        ("files", &["<Primary><Shift>f"][..], Workbench::toggle_files),
        ("copy", &[][..], Workbench::copy),
        ("paste", &[][..], Workbench::paste),
        (
            "previous",
            &["<Primary>Page_Up"][..],
            Workbench::previous_tab,
        ),
        ("next", &["<Primary>Page_Down"][..], Workbench::next_tab),
        ("restart", &[][..], Workbench::restart),
    ] {
        let command = gio::SimpleAction::new(name, None);
        let weak = Rc::downgrade(&workbench);
        command.connect_activate(move |_, _| {
            if let Some(workbench) = weak.upgrade() {
                action(&workbench);
            }
        });
        window.add_action(&command);
        app.set_accels_for_action(&format!("win.{name}"), accelerators);
    }

    let weak = Rc::downgrade(&workbench);
    workbench.search.connect_search_changed(move |_| {
        if let Some(workbench) = weak.upgrade() {
            workbench.rebuild_hosts();
        }
    });
    let weak = Rc::downgrade(&workbench);
    workbench.tabs.connect_switch_page(move |_, page, _| {
        if let Some(workbench) = weak.upgrade() {
            let active = workbench.session_for(page);
            workbench.update_status(active.as_deref());
            workbench.browser.select(active.as_ref());
            if let Some(active) = active {
                active.terminal.grab_focus();
            }
        }
    });
    let shutdown = workbench.clone();
    window.connect_destroy(move |_| {
        for session in shutdown.sessions.borrow().iter() {
            session.cancel();
        }
    });

    workbench.rebuild_hosts();
    window.show_all();
    workbench.open_local();
}

impl Workbench {
    fn open_local(self: &Rc<Self>) {
        self.open_session(Launch::Local);
    }

    fn open_session(self: &Rc<Self>, launch: Launch) {
        let session = Session::new(launch);
        let tab = row(7);
        tab.style_context().add_class("tab-label");
        let label = text_label(session.launch.label(), "tab-title");
        label.set_ellipsize(pango::EllipsizeMode::End);
        let title_width = label
            .create_pango_layout(Some(session.launch.label()))
            .pixel_size()
            .0;
        label.set_width_request(title_width.clamp(64, 160));
        tab.set_tooltip_text(Some(&session.launch.description()));
        tab.pack_start(&icon(session.launch.icon(), 14), false, false, 0);
        tab.pack_start(&label, true, true, 0);
        tab.pack_start(&session.indicator, false, false, 0);
        let close = icon_button(Icon::Close, "关闭标签");
        close.style_context().add_class("tab-close");
        tab.pack_end(&close, false, false, 0);
        tab.show_all();
        session.page.show_all();

        let weak = Rc::downgrade(self);
        let active = Rc::downgrade(&session);
        close.connect_clicked(move |_| {
            if let (Some(workbench), Some(session)) = (weak.upgrade(), active.upgrade()) {
                workbench.close_session(&session);
            }
        });
        let weak = Rc::downgrade(self);
        let active = Rc::downgrade(&session);
        session.terminal.connect_child_exited(move |_, status| {
            if let (Some(workbench), Some(session)) = (weak.upgrade(), active.upgrade()) {
                session.child_exited(status);
                workbench.refresh_status();
            }
        });

        self.sessions.borrow_mut().push(session.clone());
        let position = self.tabs.append_page(&session.page, Some(&tab));
        self.tabs
            .set_menu_label_text(&session.page, session.launch.label());
        self.tabs.set_tab_reorderable(&session.page, true);
        self.views.set_visible_child_name("terminal");
        self.tabs.set_current_page(Some(position));
        self.start(&session);
        session.terminal.grab_focus();
    }

    fn start(self: &Rc<Self>, session: &Rc<Session>) {
        let weak = Rc::downgrade(self);
        session.start(move || {
            if let Some(workbench) = weak.upgrade() {
                workbench.refresh_status();
            }
        });
        self.refresh_status();
    }

    fn close_session(&self, session: &Rc<Session>) {
        session.cancel();
        self.sessions
            .borrow_mut()
            .retain(|active| !Rc::ptr_eq(active, session));
        if let Some(position) = self.tabs.page_num(&session.page) {
            self.tabs.remove_page(Some(position));
        }
        if self.sessions.borrow().is_empty() {
            self.views.set_visible_child_name("empty");
            self.browser.select(None);
        }
        self.refresh_status();
    }

    fn close_current(self: &Rc<Self>) {
        if let Some(session) = self.current_session() {
            self.close_session(&session);
        }
    }

    fn session_for(&self, page: &gtk::Widget) -> Option<Rc<Session>> {
        self.sessions
            .borrow()
            .iter()
            .find(|session| session.page.upcast_ref::<gtk::Widget>() == page)
            .cloned()
    }

    fn current_session(&self) -> Option<Rc<Session>> {
        self.tabs
            .current_page()
            .and_then(|index| self.tabs.nth_page(Some(index)))
            .and_then(|page| self.session_for(&page))
    }

    fn refresh_status(&self) {
        self.update_status(self.current_session().as_deref());
    }

    fn update_status(&self, session: Option<&Session>) {
        let mut label = "无会话".to_owned();
        let mut can_restart = false;
        if let Some(session) = session {
            label = session.launch.description();
            match session.state.get() {
                State::Starting => label.push_str("  ·  启动中"),
                State::Running => {}
                State::Exited(0) => label.push_str("  ·  已退出"),
                State::Exited(_) => label.push_str("  ·  已退出（异常状态）"),
                State::Failed => label.push_str("  ·  启动失败"),
            }
            can_restart = session.state.get().can_restart();
            self.restart.set_label(match session.launch {
                Launch::Local => "重新启动",
                Launch::Ssh(_) => "重新连接",
            });
        }
        self.status.set_text(&label);
        self.restart.set_visible(can_restart);
    }

    fn restart(self: &Rc<Self>) {
        if let Some(session) = self
            .current_session()
            .filter(|s| s.state.get().can_restart())
        {
            self.start(&session);
            session.terminal.grab_focus();
        }
    }

    fn previous_tab(self: &Rc<Self>) {
        self.tabs.prev_page();
    }

    fn next_tab(self: &Rc<Self>) {
        self.tabs.next_page();
    }

    fn toggle_sidebar(self: &Rc<Self>) {
        self.sidebar.set_visible(!self.sidebar.is_visible());
    }

    fn toggle_files(self: &Rc<Self>) {
        if self.browser.panel.is_visible() {
            self.browser.panel.hide();
            self.browser.reset();
        } else {
            self.browser.panel.show();
            self.workspace
                .set_position((self.workspace.allocated_width() - 414).max(0));
            self.browser.select(self.current_session().as_ref());
        }
    }

    fn copy(self: &Rc<Self>) {
        if let Some(session) = self.current_session() {
            session.terminal.copy_text();
        }
    }

    fn paste(self: &Rc<Self>) {
        if let Some(session) = self.current_session() {
            session.terminal.paste_text();
        }
    }

    fn quick_connect(self: &Rc<Self>) {
        let parent = self.window.upgrade().expect("Workbench window");
        if let Some(host) = host_dialog::edit(&parent, "快速连接", "连接", None, |_| Ok(())) {
            self.open_session(Launch::Ssh(host));
        }
    }

    fn add_host(self: &Rc<Self>) {
        self.edit_host(None);
    }

    fn edit_host(self: &Rc<Self>, index: Option<usize>) {
        if let Some(error) = &self.load_error {
            self.report_error("主机列表无法编辑", error);
            return;
        }
        let mut next = self.hosts.borrow().clone();
        let previous = index.map(|i| next[i].clone());
        let parent = self.window.upgrade().expect("Workbench window");
        let title = if index.is_some() {
            "编辑主机"
        } else {
            "添加主机"
        };
        if host_dialog::edit(&parent, title, "保存", previous.as_ref(), |host| {
            let mut updated = next.clone();
            match index {
                Some(i) => updated[i] = host.clone(),
                None => updated.push(host.clone()),
            }
            hosts::save(&self.profile_path, &updated).map_err(|error| format!("保存失败：{error}"))
        })
        .map(|host| match index {
            Some(i) => next[i] = host,
            None => next.push(host),
        })
        .is_some()
        {
            self.hosts.replace(next);
            self.search.set_text("");
            self.rebuild_hosts();
        }
    }

    fn delete_host(self: &Rc<Self>, index: usize) {
        let mut next = self.hosts.borrow().clone();
        let parent = self.window.upgrade().expect("Workbench window");
        if host_dialog::confirm_delete(&parent, &next[index]) {
            next.remove(index);
            if let Err(error) = hosts::save(&self.profile_path, &next) {
                self.report_error("删除主机失败", &error);
                return;
            }
            self.hosts.replace(next);
            self.rebuild_hosts();
        }
    }

    fn report_error(&self, heading: &str, error: &str) {
        let parent = self.window.upgrade().expect("Workbench window");
        let dialog = gtk::MessageDialog::builder()
            .transient_for(&parent)
            .modal(true)
            .destroy_with_parent(true)
            .buttons(gtk::ButtonsType::Close)
            .message_type(gtk::MessageType::Error)
            .text(heading)
            .secondary_text(error)
            .build();
        dialog.style_context().add_class("workbench-dialog");
        dialog.run();
        dialog.close();
    }

    fn rebuild_hosts(self: &Rc<Self>) {
        for child in self.host_list.children() {
            self.host_list.remove(&child);
        }
        if let Some(error) = &self.load_error {
            let label = text_label("无法读取主机配置", "form-error");
            label.set_tooltip_text(Some(error));
            self.host_list.add(&label);
        } else {
            let query = self.search.text().trim().to_lowercase();
            let hosts = self.hosts.borrow();
            for (index, host) in hosts.iter().enumerate() {
                if host.name.to_lowercase().contains(&query)
                    || host.target.to_lowercase().contains(&query)
                {
                    self.host_list.add(&self.host_row(index, host));
                }
            }
            if self.host_list.children().is_empty() {
                let message = if hosts.is_empty() {
                    "暂无主机"
                } else {
                    "没有匹配的主机"
                };
                self.host_list.add(&text_label(message, "host-empty"));
            }
        }
        self.host_list.show_all();
    }

    fn host_row(self: &Rc<Self>, index: usize, host: &Host) -> gtk::Box {
        let item = row(2);
        item.style_context().add_class("host-row");
        let action = gtk::Button::new();
        action.style_context().add_class("host-connect");
        action.set_tooltip_text(Some(&format!("连接 {}", host.target)));
        let contents = row(10);
        let badge = row(0);
        badge.style_context().add_class("host-icon");
        badge.add(&icon(Icon::Server, 16));
        let labels = column(2);
        let name = text_label(&host.name, "host-name");
        let target = text_label(&host.target, "host-target");
        name.set_ellipsize(pango::EllipsizeMode::End);
        labels.pack_start(&name, false, false, 0);
        if host.name != host.target {
            target.set_ellipsize(pango::EllipsizeMode::End);
            labels.pack_start(&target, false, false, 0);
        }
        labels.set_valign(gtk::Align::Center);
        contents.pack_start(&badge, false, false, 0);
        contents.pack_start(&labels, true, true, 0);
        if host.trusted_x11 {
            let x11 = text_label("X11", "host-tag");
            x11.set_tooltip_text(Some("信任 X11 转发"));
            contents.pack_end(&x11, false, false, 0);
        }
        action.add(&contents);
        let weak = Rc::downgrade(self);
        let host = host.clone();
        action.connect_clicked(move |_| {
            if let Some(workbench) = weak.upgrade() {
                workbench.open_session(Launch::Ssh(host.clone()));
            }
        });
        item.pack_start(&action, true, true, 0);

        let menu = gtk::Menu::new();
        let edit = gtk::MenuItem::with_label("编辑主机");
        let delete = gtk::MenuItem::with_label("删除主机");
        menu.append(&edit);
        menu.append(&delete);
        menu.show_all();
        let weak = Rc::downgrade(self);
        edit.connect_activate(move |_| {
            if let Some(workbench) = weak.upgrade() {
                workbench.edit_host(Some(index));
            }
        });
        let weak = Rc::downgrade(self);
        delete.connect_activate(move |_| {
            if let Some(workbench) = weak.upgrade() {
                workbench.delete_host(index);
            }
        });
        let more = gtk::MenuButton::builder().tooltip_text("主机操作").build();
        more.style_context().add_class("quiet-button");
        if let Some(arrow) = more.child() {
            more.remove(&arrow);
        }
        more.add(&icon(Icon::More, 16));
        more.set_popup(Some(&menu));
        item.pack_end(&more, false, false, 0);
        item
    }
}

fn titlebar(window: &gtk::ApplicationWindow) -> gtk::HeaderBar {
    let header = gtk::HeaderBar::builder()
        .title("SSH Workbench")
        .show_close_button(true)
        .has_subtitle(false)
        .build();
    header.style_context().add_class("workbench-header");

    let brand = row(8);
    let mark = text_label(">_", "app-mark");
    mark.set_xalign(0.5);
    brand.pack_start(&mark, false, false, 0);
    brand.pack_start(&text_label("SSH Workbench", "app-title"), false, false, 0);
    header.pack_start(&brand);

    // Set an empty center widget so the window manager title remains available without repeating it.
    header.set_custom_title(Some(&row(0)));
    let menus = gtk::MenuBar::new();
    for (name, items) in [
        (
            "会话",
            &[
                ("新建本地终端", "local"),
                ("快速连接…", "quick"),
                ("关闭标签", "close"),
            ][..],
        ),
        ("主机", &[("添加主机…", "add-host")][..]),
        ("编辑", &[("复制", "copy"), ("粘贴", "paste")][..]),
        (
            "视图",
            &[
                ("显示／隐藏主机栏", "sidebar"),
                ("文件目录", "files"),
                ("上一个标签", "previous"),
                ("下一个标签", "next"),
            ][..],
        ),
    ] {
        let root = gtk::MenuItem::with_label(name);
        let submenu = gtk::Menu::new();
        for &(label, action) in items {
            let item = gtk::MenuItem::with_label(label);
            let window = window.downgrade();
            item.connect_activate(move |_| {
                if let Some(command) = window
                    .upgrade()
                    .and_then(|window| window.lookup_action(action))
                {
                    command.activate(None);
                }
            });
            submenu.append(&item);
        }
        root.set_submenu(Some(&submenu));
        menus.append(&root);
    }
    header.pack_start(&menus);
    header
}

fn tool_rail(sidebar: &gtk::Box) -> gtk::Box {
    let rail = column(4);
    rail.style_context().add_class("tool-rail");
    let hosts = gtk::ToggleButton::builder()
        .tooltip_text("显示／隐藏主机栏 (Ctrl+Shift+B)")
        .build();
    hosts.style_context().add_class("quiet-button");
    hosts.add(&icon(Icon::Server, 17));
    sidebar
        .bind_property("visible", &hosts, "active")
        .bidirectional()
        .sync_create()
        .build();
    rail.pack_start(&hosts, false, false, 0);
    for (symbol, tooltip, action) in [
        (Icon::Terminal, "新建本地终端 (Ctrl+Shift+T)", "win.local"),
        (Icon::Connect, "快速连接 (Ctrl+Shift+O)", "win.quick"),
    ] {
        let button = icon_button(symbol, tooltip);
        button.set_action_name(Some(action));
        rail.pack_start(&button, false, false, 0);
    }
    rail
}

fn host_sidebar() -> (gtk::Box, gtk::SearchEntry, gtk::Box) {
    let sidebar = column(0);
    sidebar.set_width_request(232);
    sidebar.style_context().add_class("host-sidebar");

    let heading = row(8);
    heading.style_context().add_class("sidebar-heading");
    heading.pack_start(&text_label("SSH 主机", "section-title"), true, true, 0);
    let add = icon_button(Icon::Plus, "添加主机 (Ctrl+Shift+N)");
    add.set_action_name(Some("win.add-host"));
    heading.pack_end(&add, false, false, 0);
    sidebar.pack_start(&heading, false, false, 0);

    let search = gtk::SearchEntry::builder()
        .placeholder_text("搜索主机")
        .width_chars(10)
        .build();
    search.style_context().add_class("host-search");
    sidebar.pack_start(&search, false, false, 0);

    let list = column(4);
    list.style_context().add_class("host-list");
    let scroll = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .vscrollbar_policy(gtk::PolicyType::Automatic)
        .overlay_scrolling(true)
        .build();
    scroll.add(&list);
    sidebar.pack_start(&scroll, true, true, 0);

    (sidebar, search, list)
}

fn empty_workspace() -> gtk::Box {
    let stage = column(12);
    stage.set_halign(gtk::Align::Center);
    stage.set_valign(gtk::Align::Center);
    let terminal = icon(Icon::Terminal, 38);
    terminal.style_context().add_class("empty-icon");
    stage.pack_start(&terminal, false, false, 0);
    let title = text_label("打开终端", "empty-title");
    title.set_xalign(0.5);
    stage.pack_start(&title, false, false, 0);
    let buttons = row(8);
    let local = gtk::Button::with_label("新建本地终端");
    local.set_action_name(Some("win.local"));
    local.style_context().add_class("primary");
    let quick = gtk::Button::with_label("快速连接");
    quick.set_action_name(Some("win.quick"));
    buttons.pack_start(&local, false, false, 0);
    buttons.pack_start(&quick, false, false, 0);
    stage.pack_start(&buttons, false, false, 0);
    stage
}

fn row(spacing: i32) -> gtk::Box {
    gtk::Box::new(gtk::Orientation::Horizontal, spacing)
}

fn column(spacing: i32) -> gtk::Box {
    gtk::Box::new(gtk::Orientation::Vertical, spacing)
}

fn text_label(text: &str, class: &str) -> gtk::Label {
    let label = gtk::Label::builder().label(text).xalign(0.0).build();
    if !class.is_empty() {
        label.style_context().add_class(class);
    }
    label
}

fn icon_button(symbol: Icon, tooltip: &str) -> gtk::Button {
    let button = gtk::Button::builder().tooltip_text(tooltip).build();
    button.style_context().add_class("quiet-button");
    button.add(&icon(symbol, 16));
    button
}
