use crate::icons::{self, Icon};
use gtk::pango;
use gtk::prelude::*;
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;

pub struct Options {
    permission: Picker,
    applied_permission: Cell<Option<PermissionMode>>,
    model: Picker,
    effort: Picker,
    fast: gtk::ToggleButton,
    turn_speed_supported: Cell<bool>,
    current: RefCell<(String, Option<String>)>,
    catalog: RefCell<Vec<Model>>,
    cursors: RefCell<HashSet<String>>,
}

struct Choice {
    id: String,
    name: String,
    is_default: bool,
}

struct Picker {
    button: gtk::MenuButton,
    label: gtk::Label,
    list: gtk::ListBox,
    prefix: &'static str,
    choices: RefCell<Vec<Choice>>,
    selected: Cell<usize>,
}

impl Picker {
    fn new(
        name: &str,
        prefix: &'static str,
        chars: i32,
        menu_width: i32,
        icon: Option<Icon>,
    ) -> Self {
        let button = gtk::MenuButton::new();
        button.set_valign(gtk::Align::Center);
        button.set_tooltip_text(Some(name));
        MenuButtonExt::set_direction(&button, gtk::ArrowType::Up);
        button.style_context().add_class("agent-picker");
        if let Some(accessible) = button.accessible() {
            accessible.set_name(name);
        }
        if let Some(child) = button.child() {
            button.remove(&child);
        }
        let label = gtk::Label::new(None);
        label.set_valign(gtk::Align::Center);
        if chars > 0 {
            label.set_ellipsize(pango::EllipsizeMode::End);
            label.set_max_width_chars(chars);
        }
        let trigger = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        if let Some(icon) = icon {
            trigger.pack_start(&icons::widget(icon, 16), false, false, 0);
        }
        trigger.pack_start(&label, false, false, 0);
        trigger.pack_start(&icons::widget(Icon::ChevronDown, 12), false, false, 0);
        button.add(&trigger);

        let list = gtk::ListBox::new();
        list.set_selection_mode(gtk::SelectionMode::Single);
        list.set_activate_on_single_click(true);
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .propagate_natural_height(true)
            .width_request(menu_width)
            .max_content_height(248)
            .build();
        scroll.add(&list);
        scroll.show_all();
        let popover = gtk::Popover::new(Some(&button));
        popover.style_context().add_class("agent-picker-menu");
        popover.add(&scroll);
        let focus_list = list.clone();
        popover.connect_map(move |_| {
            if let Some(row) = focus_list.selected_row() {
                row.grab_focus();
            }
        });
        button.set_popover(Some(&popover));

        Self {
            button,
            label,
            list,
            prefix,
            choices: RefCell::new(Vec::new()),
            selected: Cell::new(0),
        }
    }

    fn replace(&self, choices: Vec<Choice>, selected: &str) {
        for child in self.list.children() {
            self.list.remove(&child);
        }
        for choice in &choices {
            let row = gtk::Box::new(gtk::Orientation::Horizontal, 10);
            let label = gtk::Label::new(Some(&choice.name));
            label.set_xalign(0.0);
            label.set_ellipsize(pango::EllipsizeMode::End);
            row.pack_start(&label, true, true, 0);
            if choice.is_default {
                let default = gtk::Label::new(Some("默认"));
                default.style_context().add_class("picker-default");
                row.pack_end(&default, false, false, 0);
            }
            self.list.add(&row);
        }
        self.list.show_all();
        let index = choices.iter().position(|item| item.id == selected);
        self.choices.replace(choices);
        self.select(index.unwrap_or(0));
    }

    fn select(&self, index: usize) {
        if let Some(choice) = self.choices.borrow().get(index) {
            self.selected.set(index);
            self.label
                .set_text(&format!("{}{}", self.prefix, choice.name));
            self.list
                .select_row(self.list.row_at_index(index as i32).as_ref());
        }
    }

    fn dismiss(&self) {
        if let Some(popover) = self.button.popover() {
            popover.popdown();
        }
    }

    fn activate(&self, row: &gtk::ListBoxRow) -> bool {
        let index = row.index() as usize;
        let changed = self.selected.get() != index;
        self.select(index);
        self.dismiss();
        changed
    }

    fn active_id(&self) -> Option<String> {
        self.choices
            .borrow()
            .get(self.selected.get())
            .map(|item| item.id.clone())
    }
}

#[derive(Clone, Copy, PartialEq)]
enum PermissionMode {
    Workspace,
    ReadOnly,
    Full,
}

impl PermissionMode {
    const ALL: [Self; 3] = [Self::Workspace, Self::ReadOnly, Self::Full];

    fn id(self) -> &'static str {
        match self {
            Self::Workspace => "workspaceWrite",
            Self::ReadOnly => "readOnly",
            Self::Full => "dangerFullAccess",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Workspace => "工作区权限",
            Self::ReadOnly => "只读",
            Self::Full => "完全访问",
        }
    }

    fn description(self) -> &'static str {
        match self {
            Self::Workspace => "可修改工作区文件，超出范围时由 Codex 请求审批。",
            Self::ReadOnly => "可读取文件，禁止写入或联网，且不允许通过审批提升权限。",
            Self::Full => "可按当前用户的权限访问文件和网络，命令无需逐次审批。",
        }
    }

    fn approval_policy(self) -> &'static str {
        if self == Self::Workspace {
            "on-request"
        } else {
            "never"
        }
    }

    fn apply(self, params: &mut Value) {
        params["sandboxPolicy"] = match self {
            Self::Workspace => json!({
                "type": self.id(),
                "writableRoots": [],
                "networkAccess": false,
                "excludeTmpdirEnvVar": false,
                "excludeSlashTmp": false,
            }),
            Self::ReadOnly => json!({"type": self.id(), "networkAccess": false}),
            Self::Full => json!({"type": self.id()}),
        };
        params["approvalPolicy"] = json!(self.approval_policy());
        params["approvalsReviewer"] = json!("user");
    }
}

struct Model {
    id: String,
    name: String,
    efforts: Vec<String>,
    default_effort: Option<String>,
    images: bool,
    fast: bool,
}

impl Model {
    fn parse(value: &Value) -> Option<Self> {
        let id = value["model"].as_str().or_else(|| value["id"].as_str())?;
        if id.is_empty() || id.contains('\0') || value["hidden"] == true {
            return None;
        }
        let efforts = value["supportedReasoningEfforts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|effort| {
                let id = effort["reasoningEffort"].as_str()?.to_owned();
                (!id.is_empty() && !id.contains('\0')).then_some(id)
            })
            .collect();
        Some(Self {
            id: id.to_owned(),
            name: value["displayName"]
                .as_str()
                .unwrap_or(id)
                .replace('\0', "�"),
            efforts,
            default_effort: value["defaultReasoningEffort"].as_str().map(str::to_owned),
            images: value["inputModalities"]
                .as_array()
                .is_none_or(|items| items.is_empty() || items.iter().any(|item| item == "image")),
            fast: value["serviceTiers"]
                .as_array()
                .filter(|tiers| !tiers.is_empty())
                .map(|tiers| tiers.iter().any(|tier| tier["id"] == "priority"))
                .unwrap_or_else(|| {
                    value["additionalSpeedTiers"]
                        .as_array()
                        .is_some_and(|tiers| tiers.iter().any(|tier| tier == "fast"))
                }),
        })
    }
}

pub struct Selection {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub images: bool,
    speed: Option<&'static str>,
    permission: Option<PermissionMode>,
}

impl Selection {
    pub fn apply(&self, params: &mut Value) {
        if let Some(model) = &self.model {
            params["model"] = json!(model);
        }
        if let Some(effort) = &self.effort {
            params["effort"] = json!(effort);
        }
        if let Some(speed) = self.speed {
            params["serviceTierForTurn"] = json!(speed);
        }
        if let Some(mode) = self.permission {
            mode.apply(params);
        }
    }
}

impl Options {
    pub fn new(actions: &gtk::Box) -> Rc<Self> {
        let permission = Picker::new("会话权限", "", 0, 172, Some(Icon::Shield));
        let model = Picker::new("选择模型", "", 19, 182, None);
        let effort = Picker::new("思考强度", "思考 · ", 14, 126, None);
        let fast = gtk::ToggleButton::new();
        fast.set_valign(gtk::Align::Center);
        fast.style_context().add_class("agent-picker");
        fast.style_context().add_class("agent-fast");
        fast.set_focus_on_click(false);
        fast.add(&icons::widget(Icon::Bolt, 16));
        if let Some(accessible) = fast.accessible() {
            accessible.set_name("Fast 模式");
        }
        actions.pack_start(&permission.button, false, false, 0);
        actions.pack_start(&model.button, false, false, 0);
        actions.pack_start(&effort.button, false, false, 0);
        actions.pack_start(&fast, false, false, 0);
        let options = Rc::new(Self {
            permission,
            applied_permission: Cell::new(None),
            model,
            effort,
            fast,
            turn_speed_supported: Cell::new(false),
            current: RefCell::new((String::new(), None)),
            catalog: RefCell::new(Vec::new()),
            cursors: RefCell::new(HashSet::new()),
        });
        let weak = Rc::downgrade(&options);
        options
            .permission
            .list
            .connect_row_activated(move |_, row| {
                if let Some(options) = weak.upgrade() {
                    options.select_permission(row);
                }
            });
        let weak = Rc::downgrade(&options);
        options.model.list.connect_row_activated(move |_, row| {
            if let Some(options) = weak.upgrade()
                && options.model.activate(row)
            {
                options.model_changed();
            }
        });
        let weak = Rc::downgrade(&options);
        options.effort.list.connect_row_activated(move |_, row| {
            if let Some(options) = weak.upgrade() {
                options.effort.activate(row);
            }
        });
        options.open(&Value::Null);
        options
    }

    pub fn model_tooltip(&self, text: &str) {
        self.model.button.set_tooltip_text(Some(text));
    }

    pub fn server_ready(&self, result: &Value) {
        // Codex reports the server version in the first user-agent token.
        // 0.151 introduced per-turn speeds, which leave shared session defaults intact.
        let supported = result["userAgent"]
            .as_str()
            .and_then(|agent| agent.split_ascii_whitespace().next())
            .and_then(|product| product.rsplit_once('/'))
            .is_some_and(|(_, version)| {
                let mut parts = version.split('.');
                let major = parts.next().and_then(|part| part.parse::<u32>().ok());
                let minor = parts.next().and_then(|part| part.parse::<u32>().ok());
                major
                    .zip(minor)
                    .is_some_and(|(major, minor)| major > 0 || minor >= 151)
            });
        self.turn_speed_supported.set(supported);
    }

    pub fn open(&self, result: &Value) {
        self.fast.set_active(false);
        let mode = PermissionMode::ALL.into_iter().find(|mode| {
            result["sandbox"]["type"] == mode.id()
                && result["approvalPolicy"] == mode.approval_policy()
                && (*mode == PermissionMode::Full || result["sandbox"]["networkAccess"] != true)
        });
        self.render_permissions(mode);
        let model = result["model"]
            .as_str()
            .unwrap_or_default()
            .replace('\0', "�");
        let effort = result["reasoningEffort"]
            .as_str()
            .filter(|id| !id.contains('\0'))
            .map(str::to_owned);
        self.current.replace((model, effort));
        self.catalog.borrow_mut().clear();
        self.cursors.borrow_mut().clear();
        self.render_models();
    }

    pub fn add_page(&self, result: &Value) -> Option<String> {
        let mut catalog = self.catalog.borrow_mut();
        for model in result["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Model::parse)
        {
            if catalog.len() == 200 {
                break;
            }
            if !catalog.iter().any(|entry| entry.id == model.id) {
                catalog.push(model);
            }
        }
        let next = result["nextCursor"]
            .as_str()
            .filter(|cursor| !cursor.is_empty())
            .filter(|_| catalog.len() < 200 && self.cursors.borrow().len() < 10)
            .map(str::to_owned);
        drop(catalog);
        if let Some(next) = next.filter(|cursor| self.cursors.borrow_mut().insert(cursor.clone())) {
            return Some(next);
        }
        self.render_models();
        None
    }

    pub fn render_models(&self) {
        let current = self.current.borrow().0.clone();
        let selected = self.model.active_id().filter(|id| !id.is_empty());
        let catalog = self.catalog.borrow();
        let mut choices = Vec::new();
        if current.is_empty() || !catalog.iter().any(|item| item.id == current) {
            let name = if current.is_empty() {
                "当前模型".into()
            } else {
                current.clone()
            };
            choices.push(Choice {
                id: current.clone(),
                name,
                is_default: false,
            });
        }
        choices.extend(catalog.iter().map(|model| Choice {
            id: model.id.clone(),
            name: model.name.clone(),
            is_default: false,
        }));
        drop(catalog);
        let selected = selected.as_deref().unwrap_or(&current);
        let selected = if choices.iter().any(|item| item.id == selected) {
            selected
        } else {
            &current
        };
        self.model.replace(choices, selected);
        self.model_changed();
    }

    fn model_changed(&self) {
        let choice = self.model.active_id();
        let current = self.current.borrow();
        let catalog = self.catalog.borrow();
        let model = catalog
            .iter()
            .find(|model| choice.as_deref() == Some(&model.id));
        let efforts = model
            .map(|model| model.efforts.as_slice())
            .unwrap_or_default();
        let same = choice.as_deref() == Some(current.0.as_str());
        let previous = same.then_some(current.1.as_deref()).flatten();
        let default = model
            .and_then(|model| model.default_effort.as_deref())
            .filter(|id| efforts.iter().any(|effort| effort == *id));
        let select = if same {
            previous.filter(|id| efforts.iter().any(|effort| effort == *id))
        } else {
            default
        };
        let mut choices = Vec::new();
        if select.is_none() {
            choices.push(Choice {
                id: String::new(),
                name: previous.map_or("默认", effort_name).to_owned(),
                is_default: false,
            });
        }
        choices.extend(efforts.iter().map(|id| Choice {
            id: id.clone(),
            name: effort_name(id).to_owned(),
            is_default: Some(id.as_str()) == default,
        }));
        self.effort.replace(choices, select.unwrap_or(""));
        self.effort
            .button
            .set_sensitive(self.model.button.is_sensitive() && !efforts.is_empty());
        self.update_fast(
            self.model.button.is_sensitive(),
            model.is_some_and(|model| model.fast),
        );
    }

    fn update_fast(&self, enabled: bool, model_supports_fast: bool) {
        let server_supports_speed = self.turn_speed_supported.get();
        let available = server_supports_speed && model_supports_fast;
        if !available {
            self.fast.set_active(false);
        }
        self.fast.set_sensitive(enabled && available);
        self.fast.set_tooltip_text(Some(if !server_supports_speed {
            "Fast 模式需要 Codex CLI 0.151 或更新版本"
        } else if !model_supports_fast {
            "当前模型未提供 Fast 模式"
        } else {
            "Fast 模式 · 点亮用快速模式，关闭用标准速度"
        }));
    }

    pub fn update(&self, enabled: bool) {
        self.permission.button.set_sensitive(enabled);
        let catalog = self.catalog.borrow();
        self.model
            .button
            .set_sensitive(enabled && !catalog.is_empty());
        let choice = self.model.active_id();
        let model = catalog
            .iter()
            .find(|model| choice.as_deref() == Some(&model.id));
        let efforts = model.is_some_and(|model| !model.efforts.is_empty());
        self.effort.button.set_sensitive(enabled && efforts);
        self.update_fast(enabled, model.is_some_and(|model| model.fast));
    }

    pub fn selection(&self) -> Selection {
        let choice = self.model.active_id();
        let catalog = self.catalog.borrow();
        let model = catalog
            .iter()
            .find(|model| choice.as_deref() == Some(&model.id));
        Selection {
            model: model.map(|model| model.id.clone()),
            effort: self.effort.active_id().filter(|id| !id.is_empty()),
            images: model.is_none_or(|model| model.images),
            speed: self
                .turn_speed_supported
                .get()
                .then_some(if self.fast.is_active() {
                    "priority"
                } else {
                    "default"
                }),
            permission: self
                .permission_mode()
                .filter(|mode| Some(*mode) != self.applied_permission.get()),
        }
    }

    pub fn remember(&self) {
        let selection = self.selection();
        if let Some(mode) = selection.permission {
            self.render_permissions(Some(mode));
        }
        if let Some(model) = selection.model {
            self.current.replace((model, selection.effort));
        }
    }

    fn render_permissions(&self, mode: Option<PermissionMode>) {
        self.applied_permission.set(mode);
        let mut choices = Vec::new();
        if mode.is_none() {
            choices.push(Choice {
                id: String::new(),
                name: "沿用会话".into(),
                is_default: false,
            });
        }
        let offset = choices.len();
        choices.extend(PermissionMode::ALL.map(|mode| Choice {
            id: mode.id().into(),
            name: mode.name().into(),
            is_default: mode == PermissionMode::Workspace,
        }));
        self.permission
            .replace(choices, mode.map_or("", PermissionMode::id));
        for (index, mode) in PermissionMode::ALL.into_iter().enumerate() {
            if let Some(row) = self.permission.list.row_at_index((offset + index) as i32) {
                row.set_tooltip_text(Some(mode.description()));
            }
        }
        self.update_permission();
    }

    fn permission_mode(&self) -> Option<PermissionMode> {
        let id = self.permission.active_id()?;
        PermissionMode::ALL.into_iter().find(|mode| mode.id() == id)
    }

    fn update_permission(&self) {
        let mode = self.permission_mode();
        let button = &self.permission.button;
        if mode == Some(PermissionMode::Full) {
            button.style_context().add_class("agent-full-access");
        } else {
            button.style_context().remove_class("agent-full-access");
        }
        let description = mode.map_or(
            "沿用 Codex 会话现有的权限配置。",
            PermissionMode::description,
        );
        let tooltip = if mode == self.applied_permission.get() {
            description.to_owned()
        } else {
            format!("从下一轮起生效。{description}")
        };
        button.set_tooltip_text(Some(&tooltip));
        if let Some(accessible) = button.accessible() {
            let name = mode.map_or("沿用会话", PermissionMode::name);
            accessible.set_description(&format!("{name}。{tooltip}"));
        }
    }

    fn select_permission(&self, row: &gtk::ListBoxRow) {
        let index = row.index() as usize;
        let full = self
            .permission
            .choices
            .borrow()
            .get(index)
            .is_some_and(|choice| {
                choice.id == PermissionMode::Full.id() && index != self.permission.selected.get()
            });
        self.permission.dismiss();
        if full {
            let parent = self
                .permission
                .button
                .toplevel()
                .and_downcast::<gtk::Window>();
            let dialog = gtk::Dialog::builder()
                .title("会话权限")
                .modal(true)
                .destroy_with_parent(true)
                .default_width(390)
                .use_header_bar(1)
                .build();
            dialog.set_transient_for(parent.as_ref());
            dialog.style_context().add_class("workbench-dialog");
            let body = dialog.content_area();
            body.style_context().add_class("dialog-body");
            let description = gtk::Label::builder()
                .label(PermissionMode::Full.description())
                .wrap(true)
                .xalign(0.0)
                .build();
            body.add(&description);
            dialog.add_button("取消", gtk::ResponseType::Cancel);
            dialog
                .add_button("启用完全访问", gtk::ResponseType::Accept)
                .style_context()
                .add_class("destructive");
            dialog.set_default_response(gtk::ResponseType::Cancel);
            dialog.show_all();
            let accepted = dialog.run() == gtk::ResponseType::Accept;
            dialog.close();
            if !accepted {
                self.permission.select(self.permission.selected.get());
                return;
            }
        }
        self.permission.select(index);
        self.update_permission();
    }
}

fn effort_name(value: &str) -> &str {
    match value {
        "none" => "关闭",
        "minimal" => "最少",
        "low" => "低",
        "medium" => "中",
        "high" => "高",
        "xhigh" => "极高",
        "ultra" => "Ultra",
        _ => value,
    }
}
