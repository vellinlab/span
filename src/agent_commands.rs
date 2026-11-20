use crate::icons::{self, Icon};
use gtk::prelude::*;
use gtk::{gdk, pango};
use std::cell::RefCell;

const COMMANDS: &[(&str, &str)] = &[
    ("/model", "选择模型"),
    ("/reasoning", "选择思考强度"),
    ("/plan", "切换规划模式，可附带任务"),
    ("/review", "审查未提交改动，可指定分支或提交"),
    ("/diff", "查看当前工作区的 Git 改动"),
    ("/compact", "压缩当前会话的上下文"),
    ("/status", "查看会话状态与上下文用量"),
    ("/usage", "查看套餐额度"),
    ("/new", "在当前目录开始新会话"),
    ("/resume", "打开会话列表或恢复指定 ID"),
    ("/fork", "复制当前会话到新会话"),
    ("/rename", "重命名当前会话"),
    ("/copy", "复制最近一轮完整回复"),
    ("/pwd", "显示当前会话的工作目录"),
    ("/mcp", "查看当前会话的 MCP 服务器"),
    ("/goal", "查看或设置会话目标"),
    ("/goal edit", "编辑会话目标"),
    ("/goal pause", "暂停会话目标"),
    ("/goal resume", "继续会话目标"),
    ("/goal clear", "清除会话目标"),
    ("/permissions", "选择会话权限"),
    ("/fast", "切换 Fast 模式"),
    ("/plugins", "管理当前主机的插件"),
    ("/apps", "管理当前主机的连接器"),
];

pub fn known(command: &str) -> bool {
    COMMANDS.iter().any(|(name, _)| *name == command)
        || matches!(command, "/cwd" | "/agents" | "/clear")
}

pub struct Commands {
    popup: gtk::Popover,
    pub list: gtk::ListBox,
    matches: RefCell<Vec<(&'static str, &'static str)>>,
}

impl Commands {
    pub fn new(input: &gtk::TextView) -> Self {
        let popup = gtk::Popover::new(Some(input));
        popup.set_modal(false);
        popup.set_position(gtk::PositionType::Top);
        popup.set_no_show_all(true);
        popup.style_context().add_class("agent-picker-menu");
        if let Some(accessible) = popup.accessible() {
            accessible.set_name("Codex 命令");
        }
        let list = gtk::ListBox::new();
        list.set_activate_on_single_click(true);
        list.set_can_focus(false);
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .propagate_natural_height(true)
            .max_content_height(306)
            .width_request(288)
            .build();
        scroll.add(&list);
        scroll.show_all();
        popup.add(&scroll);
        Self {
            popup,
            list,
            matches: RefCell::new(Vec::new()),
        }
    }

    pub fn update(&self, input: &gtk::TextView, prefix: &str) {
        let matches = suggestions(prefix);
        if matches.is_empty() || !input.has_focus() || !input.is_editable() || !input.is_mapped() {
            self.hide();
            return;
        }
        if *self.matches.borrow() != matches {
            for child in self.list.children() {
                self.list.remove(&child);
            }
            for (command, description) in &matches {
                let row = gtk::ListBoxRow::new();
                row.set_can_focus(false);
                row.style_context().add_class("agent-command-option");
                let content = gtk::Box::new(gtk::Orientation::Horizontal, 9);
                content.add(&icons::widget(Icon::Terminal, 15));
                let label = gtk::Label::new(Some(command));
                label.set_xalign(0.0);
                content.add(&label);
                let label = gtk::Label::new(Some(description));
                label.set_xalign(0.0);
                label.set_ellipsize(pango::EllipsizeMode::End);
                label.style_context().add_class("preview-detail");
                content.pack_start(&label, true, true, 0);
                row.add(&content);
                self.list.add(&row);
                row.show_all();
            }
            self.matches.replace(matches);
            self.list.select_row(self.list.row_at_index(0).as_ref());
        }
        self.popup.set_pointing_to(&gdk::Rectangle::new(0, 0, 1, 1));
        self.popup.show();
    }

    pub fn hide(&self) {
        self.popup.hide();
    }

    pub fn row_command(&self, row: &gtk::ListBoxRow) -> Option<&'static str> {
        self.matches
            .borrow()
            .get(row.index() as usize)
            .map(|item| item.0)
    }

    pub fn selected(&self) -> Option<&'static str> {
        self.popup
            .is_visible()
            .then(|| self.list.selected_row())
            .flatten()
            .and_then(|row| self.row_command(&row))
    }

    pub fn key(&self, event: &gdk::EventKey) -> bool {
        use gdk::keys::constants::{Down, Escape, Up};
        if !self.popup.is_visible()
            || !(event.state() & gtk::accelerator_get_default_mod_mask()).is_empty()
        {
            return false;
        }
        let step = match event.keyval() {
            Escape => {
                self.hide();
                return true;
            }
            Down => 1,
            Up => -1,
            _ => return false,
        };
        let count = self.matches.borrow().len() as i32;
        let index = self.list.selected_row().map_or(0, |row| row.index());
        if count != 0 {
            if let Some(row) = self.list.row_at_index((index + step).rem_euclid(count)) {
                self.list.select_row(Some(&row));
                if let Some(adjustment) = self.list.adjustment() {
                    let allocation = row.allocation();
                    adjustment.clamp_page(
                        f64::from(allocation.y()),
                        f64::from(allocation.y() + allocation.height()),
                    );
                }
            }
        }
        true
    }
}

fn suggestions(prefix: &str) -> Vec<(&'static str, &'static str)> {
    if !prefix.starts_with('/') || prefix.contains(['\n', '\r']) {
        return Vec::new();
    }
    COMMANDS
        .iter()
        .copied()
        .filter(|(command, _)| command.starts_with(prefix))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_command_prefixes_open_the_palette() {
        assert_eq!(suggestions("/mo")[0].0, "/model");
        assert_eq!(suggestions("/goal re")[0].0, "/goal resume");
        for text in [
            "Check /model",
            "/mnt/data",
            "/goal Do some work",
            "/model\n",
        ] {
            assert!(suggestions(text).is_empty());
        }
    }
}
