use crate::agent_render;
use gtk::prelude::*;
use serde_json::{Map, Value, json};

struct Field {
    id: String,
    choices: Option<gtk::ComboBoxText>,
    other: Option<gtk::Entry>,
}

impl Field {
    fn answer(&self) -> Option<String> {
        if let Some(choices) = &self.choices {
            match choices.active_id()?.as_str() {
                "other" => {}
                index => {
                    index.parse::<u32>().ok()?;
                    return choices.active_text().map(|text| text.to_string());
                }
            }
        }
        self.other
            .as_ref()
            .map(|entry| entry.text().trim().to_owned())
            .filter(|text| !text.is_empty())
    }
}

pub fn card(params: &Value, submit: impl Fn(Value) + 'static) -> Option<gtk::Box> {
    let questions = params["questions"].as_array()?;
    if questions.is_empty() {
        return None;
    }
    let card = gtk::Box::new(gtk::Orientation::Vertical, 8);
    card.style_context().add_class("agent-approval");
    card.add(&agent_render::text("Codex 需要你确认"));
    let mut fields = Vec::new();
    for question in questions {
        let id = question["id"].as_str()?.to_owned();
        let description = question["question"].as_str()?;
        card.add(&agent_render::text(description));
        let secret = question["isSecret"].as_bool().unwrap_or(false);
        let allow_other = question["isOther"].as_bool().unwrap_or(false);
        let options = question["options"]
            .as_array()
            .filter(|options| !options.is_empty());
        let input = (options.is_none() || allow_other).then(|| {
            let entry = gtk::Entry::new();
            entry.set_placeholder_text(Some(if secret {
                "输入答案（内容隐藏）"
            } else {
                "输入答案"
            }));
            entry.set_visibility(!secret);
            card.add(&entry);
            entry
        });
        let choices = options.map(|options| {
            let selection = gtk::ComboBoxText::new();
            let mut descriptions = Vec::new();
            for (index, option) in options.iter().enumerate() {
                if let Some(label) = option["label"]
                    .as_str()
                    .filter(|label| !label.contains('\0'))
                {
                    selection.append(Some(&index.to_string()), label);
                    if let Some(description) = option["description"].as_str() {
                        descriptions.push(format!("{label} · {description}"));
                    }
                }
            }
            if allow_other {
                selection.append(Some("other"), "其他答案");
            }
            if !descriptions.is_empty() {
                let descriptions = agent_render::text(&descriptions.join("\n"));
                descriptions.style_context().add_class("agent-status");
                card.add(&descriptions);
            }
            card.add(&selection);
            if let Some(input) = &input {
                input.set_no_show_all(true);
                input.hide();
                let weak = input.downgrade();
                selection.connect_changed(move |selection| {
                    if let Some(input) = weak.upgrade() {
                        input.set_visible(selection.active_id().as_deref() == Some("other"));
                    }
                });
            }
            selection
        });
        fields.push(Field {
            id,
            choices,
            other: input,
        });
    }
    let footer = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let status = agent_render::text("");
    status.style_context().add_class("agent-status");
    let answer = gtk::Button::with_label("提交答案");
    answer.style_context().add_class("primary");
    footer.pack_start(&status, true, true, 0);
    footer.pack_end(&answer, false, false, 0);
    card.add(&footer);

    answer.connect_clicked(move |_| {
        let mut answers = Map::new();
        for field in &fields {
            let Some(answer) = field.answer() else {
                status.set_text("请回答所有问题");
                return;
            };
            answers.insert(field.id.clone(), json!({"answers":[answer]}));
        }
        submit(json!({"answers":answers}));
    });
    Some(card)
}
