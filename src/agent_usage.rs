use gtk::glib;
use gtk::prelude::*;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::BTreeMap;

pub struct Usage {
    pub button: gtk::Button,
    pub refresh: gtk::Button,
    pub popover: gtk::Popover,
    tokens: gtk::Label,
    quota: gtk::Label,
    limits: RefCell<BTreeMap<String, Limit>>,
}

#[derive(Default)]
struct Limit {
    name: Option<String>,
    primary: Option<Window>,
    secondary: Option<Window>,
}

struct Window {
    used: f64,
    minutes: Option<u64>,
    reset: Option<i64>,
}

impl Window {
    fn parse(value: &Value) -> Option<Self> {
        let used = value["usedPercent"].as_f64()?;
        Some(Self {
            used,
            minutes: value["windowDurationMins"].as_u64(),
            reset: value["resetsAt"].as_i64(),
        })
    }

    fn text(&self) -> String {
        let period = match self.minutes {
            Some(minutes) if minutes >= 1440 && minutes % 1440 == 0 => {
                format!("{} 天", minutes / 1440)
            }
            Some(minutes) if minutes >= 60 && minutes % 60 == 0 => format!("{} 小时", minutes / 60),
            Some(minutes) => format!("{minutes} 分钟"),
            None => "当前周期".to_owned(),
        };
        let reset = self
            .reset
            .and_then(|time| glib::DateTime::from_unix_local(time).ok())
            .and_then(|time| time.format("%m-%d %H:%M").ok());
        let mut description = format!("{period} · 已用 {:.0}%", self.used);
        if let Some(reset) = reset {
            description.push_str(&format!(" · {reset} 重置"));
        }
        description
    }
}

impl Usage {
    pub fn new() -> Self {
        let button = gtk::Button::with_label("用量");
        button.style_context().add_class("agent-picker");
        button.set_valign(gtk::Align::Center);
        button.set_tooltip_text(Some("查看上下文、会话 token 和账号额度"));
        let popover = gtk::Popover::new(Some(&button));
        popover.style_context().add_class("agent-usage-popover");
        popover.set_position(gtk::PositionType::Top);
        let content = gtk::Box::new(gtk::Orientation::Vertical, 8);
        content.style_context().add_class("agent-usage");
        content.set_width_request(270);
        let heading = label("会话用量");
        heading.style_context().add_class("agent-title");
        content.add(&heading);
        let tokens = label("等待 Codex 返回 token 用量");
        content.add(&tokens);
        content.add(&gtk::Separator::new(gtk::Orientation::Horizontal));
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let heading = label("账号额度");
        heading.style_context().add_class("agent-title");
        header.pack_start(&heading, true, true, 0);
        let refresh = gtk::Button::with_label("刷新额度");
        refresh.style_context().add_class("quiet-button");
        header.pack_end(&refresh, false, false, 0);
        content.add(&header);
        let quota = label("点击刷新读取账号额度");
        content.add(&quota);
        popover.add(&content);
        content.show_all();
        Self {
            button,
            popover,
            refresh,
            tokens,
            quota,
            limits: RefCell::new(BTreeMap::new()),
        }
    }

    pub fn clear_tokens(&self) {
        self.tokens.set_text("等待 Codex 返回 token 用量");
        self.button.set_label("用量");
    }

    pub fn disconnect(&self) {
        self.clear_tokens();
        self.limits.borrow_mut().clear();
        self.refresh.set_sensitive(true);
        self.quota.set_text("连接后可读取账号额度");
    }

    pub fn tokens(&self, data: &Value) {
        let last = &data["last"];
        let total = &data["total"];
        let mut text = Vec::new();
        if let Some(tokens) = total["totalTokens"].as_u64() {
            text.push(format!("会话累计 · {} tokens", number(tokens)));
        }
        if let (Some(input), Some(output)) =
            (last["inputTokens"].as_u64(), last["outputTokens"].as_u64())
        {
            text.push(format!(
                "最近请求 · 输入 {} / 输出 {}",
                number(input),
                number(output)
            ));
        }
        if let (Some(tokens), Some(window)) = (
            last["totalTokens"].as_u64(),
            data["modelContextWindow"].as_u64().filter(|size| *size > 0),
        ) {
            let percent = tokens as f64 * 100.0 / window as f64;
            self.button.set_label(&format!("用量 · {percent:.0}%"));
            text.push(format!(
                "上下文 · {} / {} tokens",
                number(tokens),
                number(window)
            ));
        } else {
            self.button.set_label("用量");
        }
        if !text.is_empty() {
            self.tokens.set_text(&text.join("\n"));
        }
    }

    pub fn loading(&self) {
        self.refresh.set_sensitive(false);
        if self.limits.borrow().is_empty() {
            self.quota.set_text("正在读取账号额度…");
        }
    }

    pub fn unavailable(&self, error: &str) {
        self.refresh.set_sensitive(true);
        self.quota.set_tooltip_text(Some(&error.replace('\0', "�")));
        if self.limits.borrow().is_empty() {
            self.quota.set_text("当前账号未提供额度信息");
        }
    }

    pub fn quota(&self, data: &Value, full: bool) {
        let mut limits = self.limits.borrow_mut();
        if full {
            limits.clear();
        }
        update_limit(&mut limits, "codex", &data["rateLimits"]);
        if let Some(buckets) = data["rateLimitsByLimitId"].as_object() {
            for (id, value) in buckets {
                update_limit(&mut limits, id, value);
            }
        }
        let mut display = Vec::new();
        for (id, limit) in limits.iter().take(4) {
            if limits.len() > 1 {
                display.push(limit.name.as_deref().unwrap_or(id).replace('\0', "�"));
            }
            display.extend(
                [&limit.primary, &limit.secondary]
                    .into_iter()
                    .flatten()
                    .map(Window::text),
            );
        }
        self.quota.set_tooltip_text(None);
        self.quota.set_text(
            if display.is_empty() {
                "当前账号未提供额度信息".into()
            } else {
                display.join("\n")
            }
            .as_str(),
        );
        if full {
            self.refresh.set_sensitive(true);
        }
    }
}

fn label(value: &str) -> gtk::Label {
    let label = gtk::Label::new(Some(value));
    label.set_xalign(0.0);
    label.set_line_wrap(true);
    label
}

fn update_limit(limits: &mut BTreeMap<String, Limit>, id: &str, value: &Value) {
    let id = value["limitId"].as_str().unwrap_or(id);
    let primary = Window::parse(&value["primary"]);
    let secondary = Window::parse(&value["secondary"]);
    if primary.is_none() && secondary.is_none() {
        return;
    }
    let limit = limits.entry(id.to_owned()).or_default();
    if let Some(name) = value["limitName"].as_str() {
        limit.name = Some(name.to_owned());
    }
    if primary.is_some() {
        limit.primary = primary;
    }
    if secondary.is_some() {
        limit.secondary = secondary;
    }
}

fn number(value: u64) -> String {
    let digits = value.to_string();
    let mut result = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            result.push(',');
        }
        result.push(digit);
    }
    result
}
