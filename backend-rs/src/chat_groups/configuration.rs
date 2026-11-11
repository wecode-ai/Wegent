//! Group board preferences contain presentation data, never project/resource grants.
use super::error;
use crate::http_compat::FastApiError;
use serde_json::{Map, Value};
use std::collections::HashSet;

pub(super) const KEYS: &[&str] = &["board_config", "board_views", "card_display", "tags"];

pub(super) fn board_configuration(value: &Value) -> Result<Value, FastApiError> {
    let defaults =
        crate::cloud_projects::normalize_board_setting("board_config", &serde_json::json!({}))?;
    let mut config = if value.is_null() {
        serde_json::json!({})
    } else {
        value.clone()
    };
    let Some(config) = config.as_object_mut() else {
        return Err(error(422, "Invalid group board configuration"));
    };
    config.insert("statuses".into(), defaults["statuses"].clone());
    config.insert(
        "processing_start_status_id".into(),
        defaults["processing_start_status_id"].clone(),
    );
    crate::cloud_projects::normalize_board_setting("board_config", &Value::Object(config.clone()))
}

pub(super) fn normalize(value: &Value) -> Result<Value, FastApiError> {
    let Some(settings) = value.as_object() else {
        return Err(error(422, "Invalid group configuration"));
    };
    if value.to_string().len() > 262_144 || settings.keys().any(|key| !KEYS.contains(&key.as_str()))
    {
        return Err(error(422, "Invalid group configuration"));
    }
    let mut normalized = Map::new();
    for (key, value) in settings {
        let value = match key.as_str() {
            "board_config" => board_configuration(value)?,
            "card_display" => crate::cloud_projects::normalize_board_setting(key, value)?,
            "board_views" => {
                validate_views(value)?;
                value.clone()
            }
            "tags" => {
                let Some(tags) = value.as_array() else {
                    return Err(error(422, "Invalid group tags"));
                };
                if tags.len() > 50 || tags.iter().any(|tag| !bounded(tag, 80)) {
                    return Err(error(422, "Invalid group tags"));
                }
                value.clone()
            }
            _ => unreachable!(),
        };
        normalized.insert(key.clone(), value);
    }
    Ok(Value::Object(normalized))
}

fn bounded(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|text| !text.trim().is_empty() && text.chars().count() <= max)
}

fn validate_views(config: &Value) -> Result<(), FastApiError> {
    let invalid = || error(422, "Invalid or unsupported board views");
    let Some(views) = config["views"].as_array() else {
        return Err(invalid());
    };
    if config["schema_version"] != 1 || views.len() > 30 {
        return Err(invalid());
    }
    let mut ids = HashSet::new();
    for view in views {
        if !bounded(&view["id"], 128)
            || view["id"] == "default"
            || !ids.insert(view["id"].as_str().unwrap())
            || !bounded(&view["name"], 100)
        {
            return Err(invalid());
        }
        let Some(columns) = view["columns"].as_array() else {
            return Err(invalid());
        };
        if columns.is_empty() || columns.len() > 50 {
            return Err(invalid());
        }
        let mut column_ids = HashSet::new();
        let mut bindings = HashSet::new();
        for column in columns {
            if !bounded(&column["id"], 128)
                || !bounded(&column["value"], 80)
                || !column_ids.insert(column["id"].as_str().unwrap())
                || !matches!(
                    column["type"].as_str(),
                    Some("status" | "tag" | "unmatched")
                )
            {
                return Err(invalid());
            }
            let binding = (
                column["type"].as_str().unwrap(),
                if column["type"] == "unmatched" {
                    ""
                } else {
                    column["value"].as_str().unwrap()
                },
            );
            if !bindings.insert(binding) {
                return Err(invalid());
            }
        }
        if let Some(filter) = view.get("filter") {
            if !filter.is_object()
                || !matches!(
                    filter.get("match").and_then(Value::as_str),
                    None | Some("all" | "any")
                )
            {
                return Err(invalid());
            }
            if let Some(tags) = filter.get("tags") {
                if !tags
                    .as_array()
                    .is_some_and(|tags| tags.len() <= 50 && tags.iter().all(|tag| bounded(tag, 80)))
                {
                    return Err(invalid());
                }
            }
        }
        if let Some(sorts) = view.get("sorts") {
            let Some(sorts) = sorts.as_object() else {
                return Err(invalid());
            };
            for rules in sorts.values() {
                let Some(rules) = rules.as_array() else {
                    return Err(invalid());
                };
                let mut fields = HashSet::new();
                for rule in rules {
                    let Some(rule) = rule.as_str() else {
                        return Err(invalid());
                    };
                    if !matches!(
                        rule,
                        "priority-desc"
                            | "priority-asc"
                            | "created-desc"
                            | "created-asc"
                            | "updated-desc"
                            | "updated-asc"
                    ) || !fields.insert(rule.split('-').next().unwrap())
                    {
                        return Err(invalid());
                    }
                }
            }
        }
    }
    let default_id = config
        .get("default_view_id")
        .and_then(Value::as_str)
        .unwrap_or("default");
    if default_id != "default" && !ids.contains(default_id) {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn thread_statuses_are_shared_while_display_and_free_tags_remain_configurable() {
        let normalized = normalize(&json!({"tags":["any-new-label"],"board_config":{"group_by":"tag","statuses":[{"id":"private_flow","name":"Custom","color":"gray"}],"processing_start_status_id":"private_flow","schedule_view":{"group_by":"priority"}}})).unwrap();
        assert_eq!(normalized["tags"], json!(["any-new-label"]));
        assert_eq!(normalized["board_config"]["group_by"], "tag");
        assert_eq!(
            normalized["board_config"]["statuses"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["inbox", "pending", "in_progress", "in_review", "completed"]
        );
        assert_eq!(
            normalized["board_config"]["processing_start_status_id"],
            "pending"
        );
        assert_eq!(
            normalized["board_config"]["schedule_view"]["group_by"],
            "priority"
        );
    }
    #[test]
    fn board_preferences_cannot_write_authority_or_credentials() {
        for key in [
            "provider_config",
            "execution_environment",
            "role",
            "membership_mode",
        ] {
            assert!(normalize(&json!({key:{}})).is_err());
        }
        assert!(normalize(&json!({"board_views":{"schema_version":1,"views":[]}})).is_ok());
        assert!(normalize(&json!({"board_views":{"schema_version":2,"views":[]}})).is_err());
        assert!(
            normalize(
                &json!({"board_views":{"schema_version":1,"default_view_id":"absent","views":[]}})
            )
            .is_err()
        );
    }
}
