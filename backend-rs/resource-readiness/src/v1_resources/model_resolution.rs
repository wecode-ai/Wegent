// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Model resolution for the Team readiness check.
//!
//! Mirrors `app/services/chat/config/model_lookup.py::_find_model_with_namespace`,
//! `_resolve_bind_model_pointer`, and the `get_model_config_for_bot` /
//! `_extract_model_config` usability gate. The readiness check only needs to
//! know whether the Bot's model resolves to a configuration with a usable
//! `modelConfig.env`, so this module returns success or failure instead of the
//! decoded config. Every read goes through the request-local
//! [`CapabilityLookup`] so the batched name sets stay shared across Teams.

use serde_json::Value;

use crate::ResourceReadinessState;
use crate::auth::UserRow;
use crate::http_compat::FastApiError;
use crate::v1_resources::capability_lookup::{CapabilityLookup, spec_of};

/// `CODEX_RUNTIME_MODEL_NAME`: the runtime-only Codex model the source derives
/// instead of reading a `kinds` row.
const CODEX_RUNTIME_MODEL_NAME: &str = "codex-gpt-5.5";

/// `CODEX_RUNTIME`: the runtime config entry that enables it.
const CODEX_RUNTIME: &str = "codex";

/// `_MAX_BIND_MODEL_POINTER_DEPTH`.
const MAX_BIND_MODEL_POINTER_DEPTH: usize = 5;

/// `get_model_config_for_bot`'s usability gate for a Bot's configured model:
/// true only when the resolved Model carries a usable `modelConfig.env`.
pub async fn model_is_usable(
    state: &ResourceReadinessState,
    lookup: &mut CapabilityLookup<'_>,
    bot_spec: &Value,
    user: &UserRow,
) -> Result<bool, FastApiError> {
    // `_resolve_model_for_bot`: no model name is the "no model configured"
    // ValueError.
    let Some(model_name) = configured_model_name(bot_spec) else {
        return Ok(false);
    };
    // `_resolve_bind_model_pointer` follows a Model whose `modelConfig` is a
    // `bind_model` pointer (or the final spec for a normal Model).
    let Some(mut spec) = find_model(state, lookup, user, &model_name).await? else {
        return Ok(false);
    };
    let mut visited: Vec<String> = Vec::new();
    loop {
        if !brz_json::adapters::python_truthy(&spec) {
            return Ok(false);
        }
        let config = spec
            .get("modelConfig")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
        if config
            .get("env")
            .is_some_and(brz_json::adapters::python_truthy)
        {
            return Ok(true);
        }
        let Some(bind_model) = config
            .get("bind_model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Ok(false);
        };
        if visited.iter().any(|known| known == bind_model)
            || visited.len() >= MAX_BIND_MODEL_POINTER_DEPTH
        {
            return Ok(false);
        }
        visited.push(bind_model.to_string());
        let Some(next) = find_model(state, lookup, user, bind_model).await? else {
            return Ok(false);
        };
        spec = next;
    }
}

/// `_resolve_model_for_bot`'s model name: `agent_config.bind_model`, then the
/// legacy `spec.modelRef.name`.
fn configured_model_name(bot_spec: &Value) -> Option<String> {
    if let Some(agent_config) = bot_spec
        .get("agent_config")
        .filter(|value| value.is_object())
        && let Some(bind_model) = agent_config.get("bind_model").and_then(Value::as_str)
    {
        let bind_model = bind_model.trim();
        if !bind_model.is_empty() {
            return Some(bind_model.to_string());
        }
    }
    bot_spec
        .get("modelRef")
        .and_then(|model_ref| model_ref.get("name"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

/// `_find_model_with_namespace`: the caller's private Model, then a referenced
/// capability shared with the caller, then a group Model, then each group's
/// referenced Model, then the public Model behind the whitelist, then the
/// runtime-only Codex model.
///
/// Returns the Model `spec` document, matching the source caller that only
/// inspects `spec`. Group membership is resolved only after the private and
/// referenced reads miss, exactly like the source.
async fn find_model(
    state: &ResourceReadinessState,
    lookup: &mut CapabilityLookup<'_>,
    user: &UserRow,
    name: &str,
) -> Result<Option<Value>, FastApiError> {
    if let Some(kind) = lookup.personal("Model", name, None).await?
        && let Some(spec) = spec_of(&kind)
    {
        return Ok(Some(spec));
    }
    if let Some(kind) = lookup.referenced("Model", name, "default").await?
        && let Some(spec) = spec_of(&kind)
    {
        return Ok(Some(spec));
    }
    let groups = lookup.groups().await?;
    if !groups.is_empty() {
        if let Some(kind) = lookup.group("Model", name, &groups).await?
            && let Some(spec) = spec_of(&kind)
        {
            return Ok(Some(spec));
        }
        for group in &groups {
            if let Some(kind) = lookup.referenced("Model", name, group).await?
                && let Some(spec) = spec_of(&kind)
            {
                return Ok(Some(spec));
            }
        }
    }
    if let Some(kind) = lookup.public("Model", name).await?
        && let Some(spec) = spec_of(&kind)
    {
        // `is_public_model_allowed_for_user`: the caller's row is already
        // loaded by authentication (a `db.get(User, user_id)` identity-map
        // hit), so this read issues no SQL.
        let json = brz_json::OpaqueJson::from(kind.json.0.clone());
        if wegent_access::public_models::allowed_for_user_name(&json, Some(user.user_name.as_str()))
        {
            return Ok(Some(spec));
        }
        return Ok(None);
    }
    runtime_model_spec(state, lookup.user_id, name).await
}

/// `get_enabled_codex_runtime_model_spec`: the runtime-only Codex model when
/// the user enabled their own Codex runtime.
async fn runtime_model_spec(
    state: &ResourceReadinessState,
    user_id: i64,
    name: &str,
) -> Result<Option<Value>, FastApiError> {
    if name != CODEX_RUNTIME_MODEL_NAME {
        return Ok(None);
    }
    let user: Option<UserRow> = state
        .mysql
        .fetch_optional(crate::user_reader::USER_BY_ID_QUERY, (user_id,))
        .await
        .map_err(super::capability_lookup::internal)?;
    let Some(user) = user else {
        return Ok(None);
    };
    let status = crate::users_runtime_configs::get_execution_config(
        &state.mysql,
        user_id,
        &user.preferences,
        CODEX_RUNTIME,
    )
    .await?;
    if status.configured && status.use_user_config {
        Ok(Some(serde_json::json!({
            "modelConfig": {
                "env": {"model": "openai", "model_id": "gpt-5.5"},
            },
            "protocol": "openai-responses",
            "apiFormat": "responses",
            "modelType": "llm",
        })))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `agent_config.bind_model` wins over the legacy `modelRef`.
    #[test]
    fn configured_model_name_prefers_the_bot_binding() {
        let spec = serde_json::json!({
            "modelRef": {"name": "legacy-model"},
            "agent_config": {"bind_model": " bound-model "},
        });
        assert_eq!(configured_model_name(&spec).as_deref(), Some("bound-model"));
    }

    /// A Bot without either field has no configured model.
    #[test]
    fn configured_model_name_requires_a_binding_or_ref() {
        assert_eq!(
            configured_model_name(&serde_json::json!({"ghostRef": {}})),
            None
        );
    }

    /// The runtime-only Codex model is not a `kinds` name, so non-Codex names
    /// never read the user row.
    #[test]
    fn runtime_model_name_is_exact() {
        assert_eq!(CODEX_RUNTIME_MODEL_NAME, "codex-gpt-5.5");
    }
}
