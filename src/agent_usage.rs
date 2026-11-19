use gtk::prelude::*;
use gtk::{cairo, glib};
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::f64::consts::{FRAC_PI_2, TAU};
use std::rc::Rc;

pub struct Usage {
    pub widget: gtk::Box,
    pub context: Meter,
    pub plan: Meter,
    pub refresh: gtk::Button,
    tokens: gtk::Label,
    quota: gtk::Label,
    limits: RefCell<BTreeMap<String, Limit>>,
}

pub struct Meter {
    pub button: gtk::Button,
    _popover: gtk::Popover,
    drawing: gtk::DrawingArea,
    fraction: Rc<Cell<Option<f64>>>,
}

impl Meter {
    fn new(name: &str, plan: bool, content: &gtk::Box) -> Self {
        let button = gtk::Button::new();
        button.style_context().add_class("usage-meter");
        button.set_valign(gtk::Align::Center);
        button.set_focus_on_click(false);
        if let Some(accessible) = button.accessible() {
            accessible.set_name(name);
        }
        let drawing = gtk::DrawingArea::new();
        drawing.set_size_request(21, 21);
        drawing.set_halign(gtk::Align::Center);
        drawing.set_valign(gtk::Align::Center);
        let fraction: Rc<Cell<Option<f64>>> = Rc::new(Cell::new(None));
        let progress = fraction.clone();
        drawing.connect_draw(move |area, cr| {
            let color = area.style_context().color(area.state_flags());
            let x = f64::from(area.allocated_width()) / 2.0;
            let y = f64::from(area.allocated_height()) / 2.0;
            let radius = if plan { 8.5 } else { 7.0 };
            cr.set_line_width(1.7);
            cr.set_line_cap(cairo::LineCap::Round);
            cr.set_source_rgba(
                color.red(),
                color.green(),
                color.blue(),
                color.alpha() * 0.28,
            );
            cr.arc(x, y, radius, 0.0, TAU);
            let _ = cr.stroke();
            if let Some(value) = progress.get().filter(|value| *value > 0.0) {
                cr.set_source_rgba(color.red(), color.green(), color.blue(), color.alpha());
                cr.arc(x, y, radius, -FRAC_PI_2, TAU * value - FRAC_PI_2);
                let _ = cr.stroke();
            }
            if plan {
                cr.set_source_rgba(
                    color.red(),
                    color.green(),
                    color.blue(),
                    color.alpha() * 0.55,
                );
                cr.set_line_width(1.25);
                cr.move_to(x, y - 3.7);
                cr.line_to(x + 3.7, y);
                cr.line_to(x, y + 3.7);
                cr.line_to(x - 3.7, y);
                cr.close_path();
                let _ = cr.stroke();
            }
            glib::Propagation::Stop
        });
        button.add(&drawing);
        let popover = gtk::Popover::new(Some(&button));
        popover.style_context().add_class("agent-usage-popover");
        popover.set_position(gtk::PositionType::Top);
        popover.add(content);
        content.show_all();
        let popup = popover.downgrade();
        button.connect_clicked(move |_| {
            if let Some(popup) = popup.upgrade() {
                popup.popup();
            }
        });
        Self {
            button,
            _popover: popover,
            drawing,
            fraction,
        }
    }

    fn show_reading(&self, fraction: Option<f64>, hint: &str) {
        self.button.set_tooltip_text(Some(hint));
        if let Some(accessible) = self.button.accessible() {
            accessible.set_description(hint);
        }
        let fraction = fraction.map(|value| value.clamp(0.0, 1.0));
        if self.fraction.replace(fraction) != fraction {
            self.drawing.queue_draw();
        }
    }
}

#[derive(Default)]
struct Limit {
    name: Option<String>,
    plan: Option<String>,
    credits: Option<String>,
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

    fn remaining(&self) -> f64 {
        (100.0 - self.used).clamp(0.0, 100.0)
    }

    fn text(&self) -> String {
        let period = match self.minutes {
            Some(10080) => "每周限额".to_owned(),
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
        let mut description = format!("{period} · 剩余 {:.0}%", self.remaining());
        if let Some(reset) = reset {
            description.push_str(&format!(" · {reset} 重置"));
        }
        description
    }
}

impl Usage {
    pub fn new() -> Self {
        let context_content = panel();
        let heading = label("上下文窗口");
        heading.style_context().add_class("agent-title");
        context_content.add(&heading);
        let tokens = label("等待 Codex 返回上下文用量");
        context_content.add(&tokens);
        let context = Meter::new("上下文用量", false, &context_content);
        context.show_reading(None, "上下文窗口 · 等待用量");

        let plan_content = panel();
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let heading = label("套餐额度");
        heading.style_context().add_class("agent-title");
        header.pack_start(&heading, true, true, 0);
        let refresh = crate::icons::button(crate::icons::Icon::Refresh, "刷新额度", "刷新额度");
        header.pack_end(&refresh, false, false, 0);
        plan_content.add(&header);
        let quota = label("等待 Codex 返回套餐额度");
        plan_content.add(&quota);
        let plan = Meter::new("套餐额度", true, &plan_content);
        plan.show_reading(None, "套餐额度 · 等待读取");

        let widget = gtk::Box::new(gtk::Orientation::Horizontal, 1);
        widget.set_valign(gtk::Align::Center);
        widget.pack_start(&plan.button, false, false, 0);
        widget.pack_start(&context.button, false, false, 0);
        Self {
            widget,
            context,
            plan,
            refresh,
            tokens,
            quota,
            limits: RefCell::new(BTreeMap::new()),
        }
    }

    pub fn clear_tokens(&self) {
        self.tokens.set_text("等待 Codex 返回上下文用量");
        self.context.show_reading(None, "上下文窗口 · 等待用量");
    }

    pub fn disconnect(&self) {
        self.clear_tokens();
        self.limits.borrow_mut().clear();
        self.refresh.set_sensitive(true);
        self.quota.set_tooltip_text(None);
        self.quota.set_text("连接后可读取套餐额度");
        self.plan.show_reading(None, "套餐额度 · 尚未连接");
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
            let fraction = (tokens as f64 / window as f64).clamp(0.0, 1.0);
            let used = format!(
                "已用 {:.0}% · 剩余 {:.0}%",
                fraction * 100.0,
                (1.0 - fraction) * 100.0
            );
            let count = format!("{} / {} tokens", number(tokens), number(window));
            self.context
                .show_reading(Some(fraction), &format!("上下文窗口\n{used}\n{count}"));
            text.splice(0..0, [used, count]);
        } else {
            self.context.show_reading(None, "上下文窗口 · 容量暂不可用");
            text.insert(0, "当前模型未提供窗口容量".into());
        }
        self.tokens.set_text(&text.join("\n"));
    }

    pub fn loading(&self) {
        self.refresh.set_sensitive(false);
        if self.limits.borrow().is_empty() {
            self.quota.set_text("正在读取套餐额度…");
            self.plan.show_reading(None, "套餐额度 · 正在读取");
        }
    }

    pub fn unavailable(&self, error: &str) {
        self.refresh.set_sensitive(true);
        self.quota.set_tooltip_text(Some(&error.replace('\0', "�")));
        if self.limits.borrow().is_empty() {
            self.quota.set_text("当前账号未提供额度信息");
            self.plan.show_reading(None, "当前账号未提供额度信息");
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
        let main = limits
            .get("codex")
            .or_else(|| limits.values().next().filter(|_| limits.len() == 1));
        if let Some(name) = main.and_then(|limit| limit.plan.as_ref()) {
            display.push(format!("{name} 套餐"));
        }
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
            if let Some(credits) = &limit.credits {
                display.push(credits.clone());
            }
        }
        let remaining = main.and_then(|limit| {
            [&limit.primary, &limit.secondary]
                .into_iter()
                .flatten()
                .map(Window::remaining)
                .reduce(f64::min)
        });
        self.quota.set_tooltip_text(None);
        let details = if display.is_empty() {
            "当前账号未提供额度信息".into()
        } else {
            display.join("\n")
        };
        self.quota.set_text(&details);
        self.plan.show_reading(
            remaining.map(|percent| percent / 100.0),
            &format!("套餐额度\n{details}"),
        );
        if full {
            self.refresh.set_sensitive(true);
        }
    }
}

fn panel() -> gtk::Box {
    let content = gtk::Box::new(gtk::Orientation::Vertical, 8);
    content.style_context().add_class("agent-usage");
    content.set_width_request(236);
    content
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
    let plan = value["planType"].as_str().and_then(|value| match value {
        "free" => Some("Free"),
        "go" => Some("Go"),
        "plus" => Some("Plus"),
        "pro" => Some("Pro"),
        "prolite" => Some("Pro Lite"),
        "promax" => Some("Pro Max"),
        "team" => Some("Team"),
        "business" => Some("Business"),
        "enterprise" => Some("Enterprise"),
        "edu" => Some("Edu"),
        _ => None,
    });
    let credits = &value["credits"];
    let balance = if credits["unlimited"].as_bool() == Some(true) {
        Some("点数 · 不限额".into())
    } else {
        credits["balance"]
            .as_str()
            .map(|amount| format!("点数余额 · {}", amount.replace('\0', "�")))
    };
    if primary.is_none() && secondary.is_none() && plan.is_none() && balance.is_none() {
        return;
    }
    let limit = limits.entry(id.to_owned()).or_default();
    if let Some(name) = value["limitName"].as_str() {
        limit.name = Some(name.to_owned());
    }
    if let Some(plan) = plan {
        limit.plan = Some(plan.into());
    }
    if balance.is_some() {
        limit.credits = balance;
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
