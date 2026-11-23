// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `ReasoningConfig` (`app/schemas/openapi_response.py:163-197`) and
//! `merge_model_reasoning` (`app/services/wework_model_config.py:72-81`),
//! applied at `request_preparation.py:902-919`.
//!
//! The API's `reasoning` selection overrides the Model's own default on either
//! field, and both fields are always emitted because the source dumps the
//! Pydantic model with its defaults. When nothing is selected the Model's
//! `think_config` becomes `reasoning` unchanged.
use serde::Deserialize;
use serde_json::{Map, Value};

/// `ReasoningConfig.effort`. An unsupported value is the Pydantic validation
/// error, which the create handler renders as its `422` body.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    #[default]
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

/// `ReasoningConfig.summary`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningSummary {
    #[default]
    Auto,
    Concise,
    Detailed,
}

/// `ReasoningConfig`: both fields default, so `{"effort": "none"}` becomes
/// `{"effort": "none", "summary": "auto"}` exactly as `model_dump()` does.
/// Pydantic's default `extra` behaviour ignores unknown keys.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(default)]
pub struct ReasoningConfig {
    pub effort: ReasoningEffort,
    pub summary: ReasoningSummary,
}

impl ReasoningConfig {
    /// The selected fields as the source's `model_dump()` renders them.
    fn selected(&self) -> Map<String, Value> {
        let mut selected = Map::new();
        selected.insert(
            "effort".to_string(),
            serde_json::to_value(self.effort).unwrap_or(Value::Null),
        );
        selected.insert(
            "summary".to_string(),
            serde_json::to_value(self.summary).unwrap_or(Value::Null),
        );
        selected
    }
}

/// `merge_model_reasoning` + `request_preparation.py:902-919`: the selected
/// reasoning over the Model's configured default, with the `think_config`
/// fallback only when nothing is selected.
///
/// The Model default is unwrapped when it is the nested
/// `{"reasoning": {...}}` shape a `think_config` copy carries, so a selection
/// overrides those inner fields instead of nesting beside them.
pub fn merge_model_reasoning(
    model_config: &mut Map<String, Value>,
    selected: Option<&ReasoningConfig>,
) {
    let defaults = model_config
        .get("reasoning")
        .and_then(Value::as_object)
        .map(
            |defaults| match defaults.get("reasoning").and_then(Value::as_object) {
                Some(nested) => nested,
                None => defaults,
            },
        );
    let mut reasoning = defaults.cloned().unwrap_or_default();
    if let Some(selected) = selected {
        for (key, value) in selected.selected() {
            reasoning.insert(key, value);
        }
    }
    if !reasoning.is_empty() {
        model_config.insert("reasoning".to_string(), Value::Object(reasoning));
        return;
    }
    // `elif request.model_config.get("think_config")`: the Model's stored
    // thinking configuration is forwarded verbatim.
    if let Some(think_config) = model_config
        .get("think_config")
        .filter(|value| brz_json::adapters::python_truthy(value))
        .cloned()
    {
        model_config.insert("reasoning".to_string(), think_config);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model(defaults: Value) -> Map<String, Value> {
        let mut model_config = Map::new();
        if !defaults.is_null() {
            model_config.insert("reasoning".to_string(), defaults);
        }
        model_config
    }

    fn merged(model_config: &mut Map<String, Value>, selected: Option<&ReasoningConfig>) -> Value {
        merge_model_reasoning(model_config, selected);
        model_config
            .get("reasoning")
            .cloned()
            .unwrap_or(Value::Null)
    }

    /// The recorded case's inbound `{"effort": "none"}`: the summary default is
    /// filled in, and the Model's nested default is overridden rather than kept.
    #[test]
    fn an_effort_only_selection_fills_the_summary_default() {
        let selected: ReasoningConfig = serde_json::from_value(json!({"effort": "none"})).unwrap();
        assert_eq!(selected.summary, ReasoningSummary::Auto);
        let mut model_config = model(json!({"reasoning": {"summary": "detailed"}}));
        assert_eq!(
            merged(&mut model_config, Some(&selected)),
            json!({"summary": "auto", "effort": "none"})
        );
    }

    /// A selection overrides only the fields it carries, keeping the Model's
    /// other default fields.
    #[test]
    fn a_selection_overrides_the_model_default_fields() {
        let selected: ReasoningConfig =
            serde_json::from_value(json!({"effort": "high", "summary": "concise"})).unwrap();
        let mut model_config = model(json!({"effort": "low", "summary": "detailed", "budget": 8}));
        assert_eq!(
            merged(&mut model_config, Some(&selected)),
            json!({"effort": "high", "summary": "concise", "budget": 8})
        );
    }

    /// With no API selection the Model's default is emitted as-is; the
    /// `think_config` fallback only applies when there is no default either.
    #[test]
    fn no_selection_keeps_the_model_default_or_the_think_config() {
        let mut with_default = model(json!({"reasoning": {"summary": "detailed"}}));
        assert_eq!(
            merged(&mut with_default, None),
            json!({"summary": "detailed"})
        );

        let mut without_default = Map::new();
        without_default.insert(
            "think_config".to_string(),
            json!({"reasoning": {"summary": "detailed"}}),
        );
        assert_eq!(
            merged(&mut without_default, None),
            json!({"reasoning": {"summary": "detailed"}})
        );

        // An empty Model default counts as no default (`reasoning or None`).
        let mut empty_default = model(json!({"reasoning": {}}));
        empty_default.insert("think_config".to_string(), json!({"effort": "low"}));
        assert_eq!(merged(&mut empty_default, None), json!({"effort": "low"}));

        // Nothing at all leaves the key absent.
        let mut nothing = Map::new();
        merge_model_reasoning(&mut nothing, None);
        assert!(!nothing.contains_key("reasoning"));
    }

    /// Pydantic rejects an unknown enum member or a wrong type; the create
    /// handler turns the deserialization error into its `422` body.
    #[test]
    fn invalid_values_are_rejected() {
        for body in [
            json!({"effort": "superhigh"}),
            json!({"summary": "verbose"}),
            json!({"effort": 3}),
            json!({"summary": null}),
            json!("high"),
        ] {
            assert!(
                serde_json::from_value::<ReasoningConfig>(body.clone()).is_err(),
                "{body}"
            );
        }
        // Every documented member is accepted, and unknown keys are ignored.
        for effort in [
            "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ] {
            let parsed: ReasoningConfig =
                serde_json::from_value(json!({"effort": effort})).unwrap();
            assert_eq!(serde_json::to_value(parsed.effort).unwrap(), json!(effort));
        }
        let extra: ReasoningConfig =
            serde_json::from_value(json!({"effort": "low", "verbosity": "x"})).unwrap();
        assert_eq!(extra.effort, ReasoningEffort::Low);
        assert_eq!(extra.summary, ReasoningSummary::Auto);
    }
}
