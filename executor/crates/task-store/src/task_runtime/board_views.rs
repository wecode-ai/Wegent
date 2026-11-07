// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;

use super::tagging::validate_tag;
use super::TaskRuntimeError;

#[derive(Deserialize)]
struct BoardViews {
    schema_version: u32,
    #[serde(default = "default_view_id")]
    default_view_id: String,
    views: Vec<View>,
}

#[derive(Deserialize)]
struct View {
    id: String,
    name: String,
    columns: Vec<Column>,
    #[serde(default)]
    filter: Filter,
    #[serde(default)]
    sorts: HashMap<String, Vec<String>>,
}

#[derive(Deserialize)]
struct Filter {
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default = "all")]
    r#match: String,
}

impl Default for Filter {
    fn default() -> Self {
        Self {
            tags: Vec::new(),
            r#match: all(),
        }
    }
}

fn all() -> String {
    "all".into()
}

fn default_view_id() -> String {
    "default".into()
}

#[derive(Deserialize)]
struct Column {
    id: String,
    r#type: String,
    value: String,
}

pub(super) fn validate_update(previous: &Value, next: &Value) -> Result<(), TaskRuntimeError> {
    let invalid = || TaskRuntimeError::Invalid("Invalid or unsupported board views".into());
    if !previous.is_null() && previous["schema_version"] != 1 {
        return Err(invalid());
    }
    let config: BoardViews = serde_json::from_value(next.clone()).map_err(|_| invalid())?;
    if config.schema_version != 1 || config.views.len() > 30 {
        return Err(invalid());
    }
    let mut ids = HashSet::new();
    for view in &config.views {
        if !valid_text(&view.id, 128)
            || view.id == "default"
            || !ids.insert(&view.id)
            || !valid_text(&view.name, 100)
            || view.columns.is_empty()
            || view.columns.len() > 50
            || view.filter.tags.len() > 50
            || !matches!(view.filter.r#match.as_str(), "any" | "all")
            || view
                .filter
                .tags
                .iter()
                .any(|tag| validate_tag(tag).is_err())
        {
            return Err(invalid());
        }
        let mut column_ids = HashSet::new();
        let mut bindings = HashSet::new();
        for column in &view.columns {
            if !valid_text(&column.id, 128)
                || !valid_text(&column.value, 80)
                || (column.r#type == "tag" && validate_tag(&column.value).is_err())
                || !matches!(column.r#type.as_str(), "status" | "tag" | "unmatched")
                || !column_ids.insert(&column.id)
                || !bindings.insert((
                    column.r#type.as_str(),
                    if column.r#type == "unmatched" {
                        ""
                    } else {
                        column.value.as_str()
                    },
                ))
            {
                return Err(invalid());
            }
        }
        for rules in view.sorts.values() {
            let mut fields = HashSet::new();
            for rule in rules {
                if !matches!(
                    rule.as_str(),
                    "priority-desc"
                        | "priority-asc"
                        | "created-desc"
                        | "created-asc"
                        | "updated-desc"
                        | "updated-asc"
                ) || !fields.insert(rule.split('-').next())
                {
                    return Err(invalid());
                }
            }
        }
    }
    if config.default_view_id != "default" && !ids.contains(&config.default_view_id) {
        return Err(invalid());
    }
    // Persist the original JSON: validation must never strip future extension fields.
    Ok(())
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn backlog_is_unique_independently_of_its_name() {
        let mut config = json!({"schema_version":1,"views":[{
            "id":"stages","name":"Stages","columns":[
                {"id":"backlog","type":"unmatched","value":"Backlog"},
                {"id":"design","type":"tag","value":"design"}
            ]
        }]});
        assert!(validate_update(&Value::Null, &config).is_ok());
        config["views"][0]["columns"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"other","type":"unmatched","value":"Other"}));
        assert!(validate_update(&Value::Null, &config).is_err());
    }
}
