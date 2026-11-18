use gtk::pango;
use gtk::prelude::*;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::HashSet;

pub struct Options {
    pub model: gtk::ComboBoxText,
    effort: gtk::ComboBoxText,
    current: RefCell<(String, Option<String>)>,
    catalog: RefCell<Vec<Model>>,
    cursors: RefCell<HashSet<String>>,
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
    pub fn new(actions: &gtk::Box) -> Self {
        let model = picker("模型", 19);
        let effort = picker("思考强度", 10);
        actions.pack_start(&model, false, false, 0);
        actions.pack_start(&effort, false, false, 0);
        let options = Self {
            model,
            effort,
            current: RefCell::new((String::new(), None)),
            catalog: RefCell::new(Vec::new()),
            cursors: RefCell::new(HashSet::new()),
        };
        options.open(&Value::Null);
        options
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
        self.model.remove_all();
        let catalog = self.catalog.borrow();
        if current.is_empty() || !catalog.iter().any(|item| item.id == current) {
            let title = if current.is_empty() {
                "模型 · 当前默认"
            } else {
                &current
            };
            self.model.append(Some(&current), title);
        }
        for model in catalog.iter() {
            self.model.append(Some(&model.id), &model.name);
        }
        drop(catalog);
        let selected = selected.as_deref().unwrap_or(&current);
        if !self.model.set_active_id(Some(selected)) {
            self.model.set_active(Some(0));
        }
        self.model_changed();
    }

    pub fn model_changed(&self) {
        self.effort.remove_all();
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
        if efforts.is_empty() || select.is_none() {
            let title = previous.map_or_else(
                || "思考 · 默认".into(),
                |id| format!("思考 · {}", effort_name(id)),
            );
            self.effort.append(Some(""), &title);
        }
        for id in efforts {
            let default = if Some(id.as_str()) == default {
                "（默认）"
            } else {
                ""
            };
            self.effort
                .append(Some(id), &format!("思考 · {}{default}", effort_name(id)));
        }
        if select.is_none_or(|id| !self.effort.set_active_id(Some(id))) {
            self.effort.set_active(Some(0));
        }
        self.effort
            .set_sensitive(self.model.is_sensitive() && !efforts.is_empty());
    }

    pub fn update(&self, enabled: bool) {
        let catalog = self.catalog.borrow();
        self.model.set_sensitive(enabled && !catalog.is_empty());
        let choice = self.model.active_id();
        let efforts = catalog
            .iter()
            .any(|model| choice.as_deref() == Some(&model.id) && !model.efforts.is_empty());
        self.effort.set_sensitive(enabled && efforts);
    }

    pub fn selection(&self) -> Selection {
        let choice = self.model.active_id();
        let catalog = self.catalog.borrow();
        let model = catalog
            .iter()
            .find(|model| choice.as_deref() == Some(&model.id));
        Selection {
            model: model.map(|model| model.id.clone()),
            effort: self
                .effort
                .active_id()
                .filter(|id| !id.is_empty())
                .map(|id| id.to_string()),
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

fn picker(label: &str, width: i32) -> gtk::ComboBoxText {
    let picker = gtk::ComboBoxText::new();
    picker.set_tooltip_text(Some(label));
    picker.style_context().add_class("agent-picker");
    for cell in picker.cells() {
        if let Ok(cell) = cell.downcast::<gtk::CellRendererText>() {
            cell.set_ellipsize(pango::EllipsizeMode::End);
            cell.set_max_width_chars(width);
        }
    }
    picker
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
