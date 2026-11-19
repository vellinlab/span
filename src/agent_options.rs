use crate::icons::{self, Icon};
use gtk::pango;
use gtk::prelude::*;
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;

pub struct Options {
    model: Picker,
    effort: Picker,
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
    fn new(name: &str, prefix: &'static str, chars: i32, menu_width: i32) -> Self {
        let button = gtk::MenuButton::new();
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
        label.set_ellipsize(pango::EllipsizeMode::End);
        label.set_max_width_chars(chars);
        let trigger = gtk::Box::new(gtk::Orientation::Horizontal, 4);
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

    fn activate(&self, row: &gtk::ListBoxRow) -> bool {
        let index = row.index() as usize;
        let changed = self.selected.get() != index;
        self.select(index);
        if let Some(popover) = self.button.popover() {
            popover.popdown();
        }
        changed
    }

    fn active_id(&self) -> Option<String> {
        self.choices
            .borrow()
            .get(self.selected.get())
            .map(|item| item.id.clone())
    }
}

struct Model {
    id: String,
    name: String,
    efforts: Vec<String>,
    default_effort: Option<String>,
    images: bool,
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
        })
    }
}

pub struct Selection {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub images: bool,
}

impl Selection {
    pub fn apply(&self, params: &mut Value) {
        if let Some(model) = &self.model {
            params["model"] = json!(model);
        }
        if let Some(effort) = &self.effort {
            params["effort"] = json!(effort);
        }
    }
}

impl Options {
    pub fn new(actions: &gtk::Box) -> Rc<Self> {
        let model = Picker::new("选择模型", "", 19, 182);
        let effort = Picker::new("思考强度", "思考 · ", 14, 126);
        actions.pack_start(&model.button, false, false, 0);
        actions.pack_start(&effort.button, false, false, 0);
        let options = Rc::new(Self {
            model,
            effort,
            current: RefCell::new((String::new(), None)),
            catalog: RefCell::new(Vec::new()),
            cursors: RefCell::new(HashSet::new()),
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

    pub fn open(&self, result: &Value) {
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
    }

    pub fn update(&self, enabled: bool) {
        let catalog = self.catalog.borrow();
        self.model
            .button
            .set_sensitive(enabled && !catalog.is_empty());
        let choice = self.model.active_id();
        let efforts = catalog
            .iter()
            .any(|model| choice.as_deref() == Some(&model.id) && !model.efforts.is_empty());
        self.effort.button.set_sensitive(enabled && efforts);
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
        }
    }

    pub fn remember(&self) {
        let selection = self.selection();
        if let Some(model) = selection.model {
            self.current.replace((model, selection.effort));
        }
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
