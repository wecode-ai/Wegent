// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/schemas/runner_routing.py::RunnerCatalog` validation.
//!
//! `runtime.tasks.pull` accepts the Executor's capability report as
//! `runner_catalog`. The source validates it with pydantic (`extra="forbid"`)
//! and, on success, stores `RunnerCatalog.model_dump()` under
//! `spec.runnerCatalog` (`app/services/runner_routing.py::save_catalog`). A
//! `ValidationError` becomes `{"success": false, "error": "Invalid runner
//! capability report"}`.
//!
//! The normalized value keeps pydantic's field order and defaults, including
//! explicit JSON nulls for `source` and `cloud_model`, so a later comparison
//! with the stored catalogue is a value comparison.

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

const RUNTIMES: [&str; 2] = ["codex", "claude_code"];
const CLOUD_MODEL_TYPES: [&str; 3] = ["public", "user", "group"];

const CATALOG_KEYS: [&str; 3] = ["errors", "runtimes", "models"];
const MODEL_KEYS: [&str; 9] = [
    "runtime",
    "provider",
    "model_id",
    "source",
    "cloud_model",
    "label",
    "local_model_id",
    "account_label",
    "is_default",
];
const CLOUD_MODEL_KEYS: [&str; 4] = ["name", "type", "namespace", "resource_user_id"];

/// `RunnerCatalog.model_validate(value)` + `model_dump()`.
///
/// Returns `None` where pydantic raises `ValidationError`.
pub(crate) fn normalize(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    only_keys(object, &CATALOG_KEYS)?;

    let errors = match object.get("errors") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            if items.len() > 10 {
                return None;
            }
            let mut errors = Vec::with_capacity(items.len());
            for item in items {
                errors.push(item.as_str()?.to_owned());
            }
            errors
        }
        Some(_) => return None,
    };

    let runtimes = match object.get("runtimes") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            let mut runtimes = Vec::with_capacity(items.len());
            for item in items {
                let runtime = item.as_str()?;
                if !RUNTIMES.contains(&runtime) {
                    return None;
                }
                runtimes.push(runtime.to_owned());
            }
            runtimes
        }
        Some(_) => return None,
    };

    let models = match object.get("models") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            if items.len() > 1000 {
                return None;
            }
            let mut models = Vec::with_capacity(items.len());
            for item in items {
                models.push(normalize_model(item)?);
            }
            models
        }
        Some(_) => return None,
    };

    // `unique_models`: only native models, unique identities, one default per
    // reported runtime.
    let mut identities = BTreeSet::new();
    let mut reported_runtimes = BTreeSet::new();
    for model in &models {
        if model["source"] == json!("cloud") {
            return None;
        }
        let runtime = model["runtime"].as_str()?;
        reported_runtimes.insert(runtime.to_owned());
        let identity = (
            runtime.to_owned(),
            model["provider"].as_str()?.to_owned(),
            model["model_id"].as_str()?.to_owned(),
        );
        if !identities.insert(identity) {
            return None;
        }
    }
    reported_runtimes.extend(runtimes.iter().cloned());
    for runtime in reported_runtimes {
        let defaults = models
            .iter()
            .filter(|model| {
                model["runtime"] == json!(runtime) && model["is_default"] == json!(true)
            })
            .count();
        if defaults > 1 {
            return None;
        }
    }

    Some(json!({
        "errors": errors,
        "runtimes": runtimes,
        "models": models,
    }))
}

fn normalize_model(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    only_keys(object, &MODEL_KEYS)?;
    let runtime = object.get("runtime")?.as_str()?;
    if !RUNTIMES.contains(&runtime) {
        return None;
    }
    let provider = bounded_text(object, "provider", 1, 200)?;
    let model_id = bounded_text(object, "model_id", 1, 255)?;
    let label = bounded_text(object, "label", 1, 255)?;
    let local_model_id = bounded_text(object, "local_model_id", 1, 255)?;

    let source = match object.get("source") {
        None | Some(Value::Null) => None,
        Some(Value::String(source)) if matches!(source.as_str(), "native" | "cloud") => {
            Some(source.clone())
        }
        Some(_) => return None,
    };
    let cloud_model = match object.get("cloud_model") {
        None | Some(Value::Null) => None,
        Some(value @ Value::Object(_)) => Some(normalize_cloud_model(value)?),
        Some(_) => return None,
    };
    // `(self.source == "cloud") != (self.cloud_model is not None)`.
    if (source.as_deref() == Some("cloud")) != cloud_model.is_some() {
        return None;
    }

    let account_label = match object.get("account_label") {
        None => String::new(),
        Some(Value::String(label)) if label.chars().count() <= 255 => label.clone(),
        Some(_) => return None,
    };
    let is_default = match object.get("is_default") {
        None => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => return None,
    };

    Some(json!({
        "runtime": runtime,
        "provider": provider,
        "model_id": model_id,
        "source": source,
        "cloud_model": cloud_model,
        "label": label,
        "local_model_id": local_model_id,
        "account_label": account_label,
        "is_default": is_default,
    }))
}

fn normalize_cloud_model(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    only_keys(object, &CLOUD_MODEL_KEYS)?;
    let name = bounded_text(object, "name", 1, 255)?;
    let model_type = bounded_text(object, "type", 1, usize::MAX)?;
    if !CLOUD_MODEL_TYPES.contains(&model_type.as_str()) {
        return None;
    }
    let namespace = bounded_text(object, "namespace", 1, 255)?;
    let resource_user_id = object.get("resource_user_id")?.as_i64()?;
    if resource_user_id < 0 {
        return None;
    }
    Some(json!({
        "name": name,
        "type": model_type,
        "namespace": namespace,
        "resource_user_id": resource_user_id,
    }))
}

fn only_keys(object: &Map<String, Value>, allowed: &[&str]) -> Option<()> {
    object
        .keys()
        .all(|key| allowed.contains(&key.as_str()))
        .then_some(())
}

fn bounded_text(
    object: &Map<String, Value>,
    key: &str,
    minimum: usize,
    maximum: usize,
) -> Option<String> {
    let text = object.get(key)?.as_str()?;
    let length = text.chars().count();
    (length >= minimum && length <= maximum).then(|| text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Value {
        json!({
            "errors": [],
            "runtimes": ["codex"],
            "models": [{
                "label": "GPT-6.1-Sol",
                "source": null,
                "runtime": "codex",
                "model_id": "gpt-6.1-sol",
                "provider": "openai",
                "is_default": true,
                "cloud_model": null,
                "account_label": "CodeX",
                "local_model_id": "gpt-6.1-sol"
            }]
        })
    }

    #[test]
    fn the_recorded_capability_report_is_normalized_with_defaults() {
        let normalized = normalize(&catalog()).expect("recorded catalog is valid");
        assert_eq!(normalized["errors"], json!([]));
        assert_eq!(normalized["runtimes"], json!(["codex"]));
        assert_eq!(
            normalized["models"][0],
            json!({
                "runtime": "codex",
                "provider": "openai",
                "model_id": "gpt-6.1-sol",
                "source": null,
                "cloud_model": null,
                "label": "GPT-6.1-Sol",
                "local_model_id": "gpt-6.1-sol",
                "account_label": "CodeX",
                "is_default": true
            })
        );
    }

    #[test]
    fn absent_optional_sections_default_to_empty_lists() {
        let normalized = normalize(&json!({})).expect("an empty report is valid");
        assert_eq!(
            normalized,
            json!({"errors": [], "runtimes": [], "models": []})
        );
    }

    #[test]
    fn pydantic_forbids_unknown_fields_at_every_level() {
        let mut report = catalog();
        report["extra"] = json!(1);
        assert!(normalize(&report).is_none());

        let mut report = catalog();
        report["models"][0]["extra"] = json!(1);
        assert!(normalize(&report).is_none());
    }

    #[test]
    fn required_model_identity_fields_are_enforced() {
        let mut report = catalog();
        report["models"][0]
            .as_object_mut()
            .unwrap()
            .remove("local_model_id");
        assert!(normalize(&report).is_none());

        let mut report = catalog();
        report["models"][0]["label"] = json!("");
        assert!(normalize(&report).is_none());

        let mut report = catalog();
        report["models"][0]["provider"] = json!("x".repeat(201));
        assert!(normalize(&report).is_none());
    }

    #[test]
    fn duplicate_identities_and_multiple_defaults_are_rejected() {
        let mut report = catalog();
        let duplicate = report["models"][0].clone();
        report["models"].as_array_mut().unwrap().push(duplicate);
        assert!(normalize(&report).is_none());

        let mut report = catalog();
        let mut second = report["models"][0].clone();
        second["model_id"] = json!("gpt-6-sol");
        report["models"].as_array_mut().unwrap().push(second);
        assert!(normalize(&report).is_none());
    }

    #[test]
    fn runner_reports_contain_only_native_models() {
        let mut report = catalog();
        report["models"][0]["source"] = json!("cloud");
        report["models"][0]["cloud_model"] = json!({
            "name": "cloud-model",
            "type": "public",
            "namespace": "default",
            "resource_user_id": 7
        });
        assert!(normalize(&report).is_none());
    }

    #[test]
    fn cloud_model_requires_the_matching_source_and_reference() {
        let mut report = catalog();
        report["models"][0]["source"] = json!("native");
        report["models"][0]["cloud_model"] = json!({
            "name": "cloud-model",
            "type": "public",
            "namespace": "default",
            "resource_user_id": 7
        });
        assert!(normalize(&report).is_none());

        let mut report = catalog();
        report["models"][0]["source"] = json!("cloud");
        assert!(normalize(&report).is_none());
    }

    #[test]
    fn reported_runtimes_must_be_known() {
        let mut report = catalog();
        report["runtimes"] = json!(["python"]);
        assert!(normalize(&report).is_none());
    }

    #[test]
    fn error_lists_are_bounded_and_textual() {
        let mut report = catalog();
        report["errors"] = json!(vec!["e"; 11]);
        assert!(normalize(&report).is_none());

        let mut report = catalog();
        report["errors"] = json!([1]);
        assert!(normalize(&report).is_none());
    }
}
