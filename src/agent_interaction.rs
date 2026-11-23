use serde_json::{Value, json};

pub struct Question {
    pub id: String,
    pub header: String,
    pub prompt: String,
    pub secret: bool,
    pub allow_other: bool,
    pub options: Vec<Choice>,
}

pub struct Choice {
    pub label: String,
    pub description: String,
}

impl Question {
    pub fn read(params: &Value) -> Option<Vec<Self>> {
        let questions: Vec<_> = params["questions"]
            .as_array()?
            .iter()
            .map(|value| {
                Some(Self {
                    id: value["id"].as_str()?.into(),
                    header: display(value["header"].as_str().unwrap_or_default()),
                    prompt: display(value["question"].as_str()?),
                    secret: value["isSecret"].as_bool().unwrap_or(false),
                    allow_other: value["isOther"].as_bool().unwrap_or(false),
                    options: value["options"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|choice| {
                            Some(Choice {
                                label: choice["label"].as_str()?.into(),
                                description: display(
                                    choice["description"].as_str().unwrap_or_default(),
                                ),
                            })
                        })
                        .collect(),
                })
            })
            .collect::<Option<_>>()?;
        (!questions.is_empty()).then_some(questions)
    }

    pub fn answer<'a>(&'a self, selected: Option<usize>, input: &'a str) -> Option<&'a str> {
        if let Some(choice) = selected.and_then(|index| self.options.get(index)) {
            return Some(&choice.label);
        }
        let input = input.trim();
        (self.options.is_empty() || (self.allow_other && selected == Some(self.options.len())))
            .then_some(input)
            .filter(|input| !input.is_empty())
    }
}

pub fn answers<'a>(
    fields: impl Iterator<Item = (&'a Question, Option<usize>, &'a str)>,
) -> Option<Value> {
    let answers = fields
        .map(|(question, selected, input)| {
            Some((
                question.id.clone(),
                json!({"answers":[question.answer(selected, input)?]}),
            ))
        })
        .collect::<Option<serde_json::Map<_, _>>>()?;
    Some(json!({"answers": answers}))
}

pub fn display(text: &str) -> String {
    text.replace('\0', "�")
}

#[derive(Default)]
pub struct Reasoning {
    item: String,
    index: u64,
    partial: String,
    headline: String,
}

impl Reasoning {
    pub fn delta(&mut self, params: &Value) {
        let (Some(id), Some(index), Some(delta)) = (
            params["itemId"].as_str(),
            params["summaryIndex"].as_u64(),
            params["delta"].as_str(),
        ) else {
            return;
        };
        if self.item == id && index < self.index {
            return;
        }
        if self.item != id || self.index != index {
            self.item = id.into();
            self.index = index;
            self.partial.clear();
        }
        self.partial.extend(
            delta
                .chars()
                .take(512_usize.saturating_sub(self.partial.len())),
        );
        if let Some(headline) = headline(&self.partial) {
            self.headline = headline;
        }
    }

    pub fn complete(&mut self, item: &Value) {
        let Some(id) = item["id"].as_str() else {
            return;
        };
        let Some(parts) = item["summary"].as_array() else {
            return;
        };
        if let Some((index, text)) = parts
            .iter()
            .enumerate()
            .rev()
            .find_map(|(index, value)| Some((index, headline(value.as_str()?)?)))
        {
            self.item = id.into();
            self.index = index as u64;
            self.partial.clear();
            self.headline = text;
        }
    }

    pub fn current(&self) -> Option<&str> {
        (!self.headline.is_empty()).then_some(self.headline.as_str())
    }
}

fn headline(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let line = line.trim().trim_matches(['*', '_', '#', '`']).trim();
        (!line.is_empty()).then(|| display(&line.chars().take(180).collect::<String>()))
    })
}

// Presentation state only. Dismissing a card leaves the server's goal intact.
#[derive(Default)]
pub struct GoalVisibility {
    key: Option<(Option<i64>, String)>,
    dismissed: bool,
}

impl GoalVisibility {
    pub fn read(&mut self, goal: &Value, restored: bool) {
        let key = goal["objective"]
            .as_str()
            .map(|objective| (goal["createdAt"].as_i64(), objective.to_owned()));
        if key != self.key {
            self.key = key;
            self.dismissed = restored && goal["status"].as_str() == Some("complete");
        }
    }

    pub fn is_visible(&self) -> bool {
        self.key.is_some() && !self.dismissed
    }

    pub fn dismiss(&mut self) {
        self.dismissed = true;
    }

    pub fn reveal(&mut self) {
        self.dismissed = false;
    }
}

pub fn elapsed(seconds: u64) -> String {
    let minutes = seconds / 60;
    if minutes < 60 {
        format!("{minutes}:{:02}", seconds % 60)
    } else {
        format!("{}:{:02}:{:02}", minutes / 60, minutes % 60, seconds % 60)
    }
}
