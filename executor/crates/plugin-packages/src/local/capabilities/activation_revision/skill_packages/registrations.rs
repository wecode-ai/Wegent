// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) fn without_membership(
    store: &GlobalCapabilityStore,
    metadata: &BTreeMap<PathBuf, Value>,
    keys: &[String],
    skill_paths: &BTreeSet<PathBuf>,
    roots: &BTreeSet<PathBuf>,
    definitions: &BTreeMap<String, Value>,
) -> BTreeMap<PathBuf, Value> {
    let mut result = metadata.clone();
    for (path, value) in &mut result {
        match path.file_name().and_then(|name| name.to_str()) {
            Some("config.toml") => {
                for key in keys {
                    if value["plugins"][key] == json!({"enabled":definitions[key]["enabled"]}) {
                        remove(value, "plugins", key);
                    }
                    let market = key.rsplit_once('@').unwrap().1;
                    if value["marketplaces"][market]
                        == json!({"source_type":"local", "source":store.codex_marketplace_dir(market)})
                    {
                        remove(value, "marketplaces", market);
                    }
                }
                super::super::skill_toggles::strip_skill_config(value, skill_paths);
            }
            Some("installed_plugins.json") => {
                for key in keys {
                    if registered_plugin(value["plugins"].get(key), &definitions[key], roots) {
                        remove(value, "plugins", key);
                    }
                }
            }
            Some("settings.json") => {
                for key in keys {
                    if value["enabledPlugins"][key] == definitions[key]["enabled"] {
                        remove(value, "enabledPlugins", key);
                    }
                    let market = key.rsplit_once('@').unwrap().1;
                    let source =
                        json!({"source":"directory", "path":store.claude_marketplace_dir(market)});
                    if value["extraKnownMarketplaces"][market] == json!({"source":source}) {
                        remove(value, "extraKnownMarketplaces", market);
                    }
                }
            }
            Some("known_marketplaces.json") => {
                for key in keys {
                    let market = key.rsplit_once('@').unwrap().1;
                    let directory = store.claude_marketplace_dir(market);
                    if value[market]
                        == json!({"source":{"source":"directory", "path":directory}, "installLocation":directory})
                    {
                        if let Some(object) = value.as_object_mut() {
                            object.remove(market);
                        }
                    }
                }
            }
            Some("marketplace.json") => strip_marketplace(path, value, keys, roots, definitions),
            _ => (),
        }
        collapse(value);
    }
    result
}

fn remove(value: &mut Value, field: &str, key: &str) {
    if let Some(object) = value.get_mut(field).and_then(Value::as_object_mut) {
        object.remove(key);
    }
}

fn strip_marketplace(
    path: &Path,
    value: &mut Value,
    keys: &[String],
    roots: &BTreeSet<PathBuf>,
    definitions: &BTreeMap<String, Value>,
) {
    let Some(market) = value["name"].as_str().map(str::to_owned) else {
        return;
    };
    if let Some(plugins) = value.get_mut("plugins").and_then(Value::as_array_mut) {
        plugins.retain(|plugin| {
            let key = format!("{}@{market}", plugin["name"].as_str().unwrap_or_default());
            !keys.contains(&key)
                || !registered_marketplace_plugin(path, plugin, &definitions[&key], roots)
        });
    }
    // Remove only the exact empty scaffolding produced by the managed publisher.
    let codex = json!({"name":market, "interface":{"displayName":"Wegent"}, "plugins":[]});
    let claude = json!({"$schema":"https://anthropic.com/claude-code/marketplace.schema.json", "name":market, "description":"Plugins managed by Wegent.", "owner":{"name":"Wegent Team"}, "plugins":[]});
    if *value == codex || *value == claude {
        *value = Value::Null;
    }
}

fn collapse(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    for field in [
        "plugins",
        "marketplaces",
        "skills",
        "enabledPlugins",
        "extraKnownMarketplaces",
    ] {
        if object
            .get(field)
            .is_some_and(|entry| entry.is_null() || entry.as_object().is_some_and(Map::is_empty))
        {
            object.remove(field);
        }
    }
    if object.is_empty() || *object == Map::from_iter([("version".to_owned(), json!(2))]) {
        *value = Value::Null;
    }
}

fn registered_plugin(entry: Option<&Value>, definition: &Value, roots: &BTreeSet<PathBuf>) -> bool {
    let Some(entries) = entry.and_then(Value::as_array) else {
        return false;
    };
    entries.len() == 1
        && entries.iter().all(|entry| {
            entry.as_object().is_some_and(|object| {
                object.keys().all(|key| {
                    [
                        "scope",
                        "installPath",
                        "installedPluginId",
                        "checksum",
                        "version",
                        "componentStates",
                    ]
                    .contains(&key.as_str())
                })
            }) && entry["scope"] == "user"
                && entry["version"] == definition["version"]
                && entry["checksum"] == definition["checksum"]
                && entry["installPath"]
                    .as_str()
                    .is_some_and(|path| roots.contains(Path::new(path)))
                && entry.get("componentStates").unwrap_or(&json!({}))
                    == &definition["component_states"]
        })
}

fn registered_marketplace_plugin(
    path: &Path,
    entry: &Value,
    definition: &Value,
    roots: &BTreeSet<PathBuf>,
) -> bool {
    let depth = if path.ends_with(".agents/plugins/marketplace.json") {
        3
    } else {
        2
    };
    let Some(directory) = path.ancestors().nth(depth) else {
        return false;
    };
    let source = entry["source"]
        .as_str()
        .or_else(|| entry["source"]["path"].as_str());
    let Some(source) = source.and_then(|source| source.strip_prefix("./plugins/")) else {
        return false;
    };
    if Path::new(source).components().count() != 1
        || !roots.contains(&directory.join("plugins").join(source))
    {
        return false;
    }
    let name = &entry["name"];
    let claude = json!({"description":"", "name":name, "source":format!("./plugins/{source}"), "version":definition["version"]});
    let mut codex = json!({"name":name, "source":{"source":"local", "path":format!("./plugins/{source}")}, "policy":{"installation":"AVAILABLE", "authentication":"ON_INSTALL"}});
    if *entry == claude || *entry == codex {
        return true;
    }
    codex["policy"]["products"] = json!(["CODEX"]);
    *entry == codex
}
