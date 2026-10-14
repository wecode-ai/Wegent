// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared response filtering from `app.services.team_access_policy`.
use std::collections::BTreeMap;

use brz_json::{OpaqueJson, RawJson};

/// The only agent configuration fields retained by `team_usage_summary`.
const MODEL_REFERENCE_FIELDS: [&str; 4] = [
    "bind_model",
    "bind_model_type",
    "bind_model_namespace",
    "allowed_models",
];

/// Keep model selection while removing prompts, credentials, and provider settings.
/// Present null values stay present, as in the Python dict comprehension.
pub(crate) fn filtered_agent_config(config: &RawJson) -> RawJson {
    let projected: BTreeMap<String, RawJson> =
        serde_json::from_str(config.get()).unwrap_or_default();
    let kept = projected
        .into_iter()
        .filter(|(key, _)| MODEL_REFERENCE_FIELDS.contains(&key.as_str()))
        .collect::<BTreeMap<String, RawJson>>();
    OpaqueJson::from_serializable(kept).to_raw_value()
}
