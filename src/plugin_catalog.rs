// The plugin directory can include tens of MiB of screenshot data. Deserialize
// only the fields the list uses so those assets never become GTK-side strings.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize, Serialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Identity {
    display_name: Option<String>,
    short_description: Option<String>,
    category: Option<String>,
    #[serde(deserialize_with = "icon")]
    logo_url_dark: Option<String>,
    #[serde(deserialize_with = "icon")]
    composer_icon_url: Option<String>,
    #[serde(deserialize_with = "icon")]
    logo_url: Option<String>,
}

fn icon<'de, D: serde::Deserializer<'de>>(input: D) -> Result<Option<String>, D::Error> {
    #[derive(Deserialize)]
    struct Reference<'a>(#[serde(borrow)] std::borrow::Cow<'a, str>);
    Ok(Option::<Reference>::deserialize(input)?
        .filter(|s| crate::extension_art::usable_reference(&s.0))
        .map(|s| s.0.into_owned()))
}

#[derive(Deserialize, Serialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Plugin {
    id: Option<String>,
    name: Option<String>,
    interface: Option<Identity>,
    installed: Option<bool>,
    enabled: Option<bool>,
    availability: Option<String>,
    install_policy: Option<String>,
    must_show_installation_interstitial: Option<bool>,
}

#[derive(Deserialize, Serialize)]
struct Marketplace {
    name: Option<String>,
    path: Option<String>,
    interface: Option<Identity>,
    #[serde(default)]
    plugins: Vec<Plugin>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Directory {
    marketplaces: Vec<Marketplace>,
    #[serde(default)]
    marketplace_load_errors: Vec<Value>,
}

#[derive(Deserialize, Serialize)]
struct Reply {
    id: u64,
    result: Directory,
}

pub fn decode(bytes: &[u8], pending_lists: &[u64]) -> serde_json::Result<Value> {
    #[derive(Deserialize)]
    struct Header {
        id: u64,
    }
    if !pending_lists.is_empty()
        && let Ok(header) = serde_json::from_slice::<Header>(bytes)
        && pending_lists.contains(&header.id)
        && let Ok(reply) = serde_json::from_slice::<Reply>(bytes)
    {
        return serde_json::to_value(reply);
    }
    serde_json::from_slice(bytes)
}
