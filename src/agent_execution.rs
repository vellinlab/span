use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionMode {
    Workspace,
    ReadOnly,
    Full,
}

impl PermissionMode {
    pub const ALL: [Self; 3] = [Self::Workspace, Self::ReadOnly, Self::Full];

    pub fn id(self) -> &'static str {
        match self {
            Self::Workspace => "workspaceWrite",
            Self::ReadOnly => "readOnly",
            Self::Full => "dangerFullAccess",
        }
    }

    fn approval_policy(self) -> &'static str {
        if self == Self::Workspace {
            "on-request"
        } else {
            "never"
        }
    }

    pub fn from_response(result: &Value) -> Option<Self> {
        Self::ALL.into_iter().find(|mode| {
            result["sandbox"]["type"] == mode.id()
                && result["approvalPolicy"] == mode.approval_policy()
                && (*mode == Self::Full || result["sandbox"]["networkAccess"] != true)
        })
    }

    pub fn apply(self, params: &mut Value) {
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

#[derive(Clone, PartialEq, Eq)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
    pub images: bool,
    pub fast: bool,
}

impl Model {
    pub fn parse(value: &Value) -> Option<Self> {
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

pub fn supports_turn_speed(result: &Value) -> bool {
    // Codex app-server 0.151 introduced per-turn speeds.
    result["userAgent"]
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
        })
}
