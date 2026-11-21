use crate::agent_execution::{Model, PermissionMode};
use crate::theme;
use iced::widget::{button, container, pick_list, row, text, tooltip};
use iced::{Center, Element};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fmt;

#[derive(Debug, Clone)]
pub enum Change {
    Model(String),
    Effort(String),
    Permission(PermissionMode),
    Fast,
}

#[derive(Default)]
pub struct Settings {
    pub supports_fast: bool,
    pub context: Option<(u64, u64)>,
    models: Vec<Model>,
    cursors: HashSet<String>,
    current_model: String,
    current_effort: Option<String>,
    current_permission: Option<PermissionMode>,
    model: Option<String>,
    effort: Option<String>,
    permission: Option<PermissionMode>,
    fast: bool,
}

impl Settings {
    pub fn open(&mut self, result: &Value) {
        *self = Self {
            supports_fast: self.supports_fast,
            current_model: result["model"].as_str().unwrap_or_default().to_owned(),
            current_effort: result["reasoningEffort"].as_str().map(str::to_owned),
            current_permission: PermissionMode::from_response(result),
            ..Self::default()
        };
    }

    pub fn add_page(&mut self, result: &Value) -> Option<String> {
        if let Some(data) = result["data"].as_array() {
            for model in data.iter().filter_map(Model::parse) {
                if self.models.len() >= 200 {
                    break;
                }
                if !self.models.iter().any(|item| item.id == model.id) {
                    self.models.push(model);
                }
            }
        }
        result["nextCursor"]
            .as_str()
            .filter(|cursor| !cursor.is_empty() && cursor.len() <= 4096)
            .filter(|_| self.models.len() < 200 && self.cursors.len() < 10)
            .filter(|cursor| self.cursors.insert(cursor.to_string()))
            .map(str::to_owned)
    }

    fn active_model(&self) -> Option<&Model> {
        let id = self.model.as_deref().unwrap_or(&self.current_model);
        self.models.iter().find(|model| model.id == id)
    }

    fn fast_available(&self) -> bool {
        self.supports_fast && self.active_model().is_some_and(|model| model.fast)
    }

    pub fn change(&mut self, change: Change) {
        match change {
            Change::Model(id) => {
                if let Some(model) = self.models.iter().find(|model| model.id == id)
                    && self.model.as_ref().unwrap_or(&self.current_model) != &id
                {
                    self.effort = model
                        .default_effort
                        .as_ref()
                        .filter(|effort| model.efforts.contains(effort))
                        .cloned();
                    self.model = Some(id);
                    self.fast &= self.fast_available();
                }
            }
            Change::Effort(effort) => {
                if self
                    .active_model()
                    .is_some_and(|model| model.efforts.contains(&effort))
                {
                    self.effort = Some(effort);
                }
            }
            Change::Permission(permission) => self.permission = Some(permission),
            Change::Fast if self.fast_available() => self.fast = !self.fast,
            Change::Fast => {}
        }
    }

    pub fn apply(&self, params: &mut Value) {
        if let Some(model) = &self.model {
            params["model"] = json!(model);
        }
        if let Some(effort) = &self.effort {
            params["effort"] = json!(effort);
        }
        if self.supports_fast {
            params["serviceTierForTurn"] = json!(if self.fast { "priority" } else { "default" });
        }
        if let Some(permission) = self.permission {
            permission.apply(params);
        }
    }

    pub fn view(&self, running: bool) -> Element<'_, Change> {
        let model = self.active_model();
        let model_placeholder = if self.current_model.is_empty() {
            "Session model"
        } else {
            self.current_model.as_str()
        };
        let models: Element<'_, Change> = if self.models.is_empty() {
            text(model_placeholder).size(13).color(theme::MUTED).into()
        } else {
            pick_list(self.models.as_slice(), model, |model: Model| {
                Change::Model(model.id)
            })
            .placeholder(model_placeholder)
            .width(156)
            .menu_height(226)
            .padding([5, 8])
            .text_size(13)
            .into()
        };
        let mut toolbar = row![
            models,
            pick_list(
                PermissionMode::ALL.as_slice(),
                self.permission.or(self.current_permission),
                Change::Permission
            )
            .placeholder("Session access")
            .width(131)
            .padding([5, 8])
            .text_size(13),
        ]
        .spacing(6)
        .align_y(Center);
        if let Some(model) = model.filter(|model| !model.efforts.is_empty()) {
            let effort = self
                .effort
                .as_ref()
                .or(self.current_effort.as_ref())
                .filter(|effort| model.efforts.contains(effort));
            toolbar = toolbar.push(
                pick_list(model.efforts.as_slice(), effort, Change::Effort)
                    .placeholder("Reasoning")
                    .width(105)
                    .padding([5, 8])
                    .text_size(13),
            );
        }
        if self.fast_available() {
            toolbar = toolbar.push(tooltip(
                button(text("Fast").size(13))
                    .on_press(Change::Fast)
                    .padding([5, 8])
                    .style(|_, status| theme::button_status(self.fast, status)),
                container(text("Fast processing from the next turn").size(12))
                    .padding(6)
                    .style(|_| theme::panel(theme::CHROME, 6.0)),
                tooltip::Position::Top,
            ));
        }
        if running {
            toolbar = toolbar.push(text("Next turn").size(12).color(theme::MUTED));
        }
        toolbar.wrap().vertical_spacing(5).into()
    }
}

impl fmt::Display for Model {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.name)
    }
}

impl fmt::Display for PermissionMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Workspace => "Workspace access",
            Self::ReadOnly => "Read-only",
            Self::Full => "Full access",
        })
    }
}
