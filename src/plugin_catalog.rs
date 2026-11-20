// The plugin directory can include tens of MiB of screenshot data. Deserialize
// only the fields the list uses so those assets never become GTK-side strings.
use crate::agent_extensions::{self, synopsis};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Identity {
    display_name: Option<String>,
    short_description: Option<String>,
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

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Summary {
    id: Option<String>,
    name: Option<String>,
    interface: Option<Identity>,
    installed: Option<bool>,
    enabled: Option<bool>,
    availability: Option<String>,
    install_policy: Option<String>,
    must_show_installation_interstitial: Option<bool>,
}

#[derive(Deserialize)]
struct Marketplace {
    name: Option<String>,
    path: Option<String>,
    interface: Option<Identity>,
    #[serde(default)]
    plugins: Vec<Summary>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Directory {
    marketplaces: Vec<Marketplace>,
    #[serde(default)]
    marketplace_load_errors: Vec<serde::de::IgnoredAny>,
}

#[derive(Deserialize)]
struct Reply {
    id: u64,
    result: Directory,
}

pub enum Incoming {
    Json(Value),
    Plugins {
        id: u64,
        items: Vec<agent_extensions::Plugin>,
        failures: usize,
    },
}

pub fn decode(bytes: &[u8], pending_lists: &[u64]) -> serde_json::Result<Incoming> {
    #[derive(Deserialize)]
    struct Header {
        id: u64,
    }
    if !pending_lists.is_empty()
        && let Ok(header) = serde_json::from_slice::<Header>(bytes)
        && pending_lists.contains(&header.id)
    {
        if let Ok(reply) = serde_json::from_slice::<Reply>(bytes) {
            let mut items = Vec::new();
            for market in reply.result.marketplaces {
                let Some(name) = market.name else { continue };
                let source = market
                    .interface
                    .and_then(|v| v.display_name)
                    .unwrap_or_else(|| name.clone());
                for item in market.plugins {
                    let (Some(id), Some(plugin_name)) = (item.id, item.name) else {
                        continue;
                    };
                    let ui = item.interface.unwrap_or_default();
                    items.push(agent_extensions::Plugin {
                        id,
                        title: ui.display_name.unwrap_or_else(|| plugin_name.clone()),
                        name: plugin_name,
                        description: synopsis(ui.short_description.as_deref()),
                        logo: ui.logo_url_dark.or(ui.logo_url).or(ui.composer_icon_url),
                        source: source.clone(),
                        path: market.path.clone(),
                        marketplace: name.clone(),
                        installed: item.installed.unwrap_or(false),
                        enabled: item.enabled.unwrap_or(false),
                        available: item.install_policy.as_deref() != Some("NOT_AVAILABLE")
                            && item
                                .availability
                                .as_deref()
                                .is_none_or(|s| s == "AVAILABLE"),
                        review: item.must_show_installation_interstitial.unwrap_or(false),
                    });
                }
            }
            items.sort_by_key(|p| !p.installed);
            return Ok(Incoming::Plugins {
                id: reply.id,
                items,
                failures: reply.result.marketplace_load_errors.len(),
            });
        }
    }
    serde_json::from_slice(bytes).map(Incoming::Json)
}
