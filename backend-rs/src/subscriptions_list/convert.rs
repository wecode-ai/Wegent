// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `_convert_to_subscription_in_db` and the subscription-JSON helpers for
//! `GET /api/subscriptions`.
use std::collections::{HashMap, HashSet};

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::KindRow;
use super::workspaces::RepoFields;

/// `settings.SUBSCRIPTION_MIN_INTERVAL_MINUTES` (default 15; the deployment
/// keeps the default).
const MIN_INTERVAL_MINUTES: i64 = 15;

/// The `kinds.json` document of a Subscription row. The business fields the
/// response consumes are typed; `_internal` keeps only the keys the
/// conversion reads.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SubscriptionJson {
    spec: Option<SubscriptionSpecJson>,
}

/// `spec` block of the subscription CRD.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SubscriptionSpecJson {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    description: Option<String>,
    #[serde(rename = "taskType")]
    task_type: Option<String>,
    #[serde(rename = "visibility")]
    visibility: Option<String>,
    trigger: Option<Value>,
    #[serde(rename = "teamRef")]
    team_ref: Option<Value>,
    #[serde(rename = "workspaceRef")]
    workspace_ref: Option<WorkspaceRefJson>,
    #[serde(rename = "modelRef")]
    model_ref: Option<NameNamespaceJson>,
    #[serde(rename = "forceOverrideBotModel")]
    force_override_bot_model: Option<bool>,
    #[serde(rename = "promptTemplate")]
    prompt_template: Option<String>,
    #[serde(rename = "retryCount")]
    retry_count: Option<i64>,
    #[serde(rename = "timeoutSeconds")]
    timeout_seconds: Option<i64>,
    #[serde(rename = "executionTarget")]
    execution_target: Option<Value>,
    #[serde(rename = "preserveHistory")]
    preserve_history: Option<bool>,
    #[serde(rename = "historyMessageCount")]
    history_message_count: Option<i64>,
    #[serde(rename = "notificationWebhooks")]
    notification_webhooks: Option<Value>,
    #[serde(rename = "knowledgeBaseRefs")]
    knowledge_base_refs: Option<Value>,
    #[serde(rename = "skillRefs")]
    skill_refs: Option<Value>,
}

/// A `{name, namespace}` reference (`spec.modelRef`, `spec.workspaceRef`).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct NameNamespaceJson {
    name: Option<String>,
    namespace: Option<String>,
}

/// `spec.workspaceRef` (`SubscriptionWorkspaceRef`).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct WorkspaceRefJson {
    name: Option<String>,
    namespace: Option<String>,
}

/// The response model: `SubscriptionListResponse`.
#[derive(Debug, Serialize)]
pub(super) struct SubscriptionListResponse {
    pub(super) total: usize,
    pub(super) items: Vec<SubscriptionItem>,
    pub(super) invalid_schedule_count: usize,
}

/// One `SubscriptionInDB` item in pydantic field declaration order.
#[derive(Debug, Serialize)]
pub(super) struct SubscriptionItem {
    name: Option<String>,
    display_name: String,
    description: Option<String>,
    task_type: String,
    visibility: String,
    trigger_type: String,
    trigger_config: Value,
    team_id: i64,
    workspace_id: i64,
    git_repo: Option<String>,
    git_repo_id: Option<i64>,
    git_domain: Option<String>,
    branch_name: Option<String>,
    model_ref: Option<NameNamespace>,
    force_override_bot_model: bool,
    prompt_template: String,
    retry_count: i64,
    timeout_seconds: i64,
    enabled: bool,
    execution_target: Value,
    preserve_history: bool,
    history_message_count: i64,
    notification_webhooks: Value,
    knowledge_base_refs: Option<Value>,
    skill_refs: Option<Value>,
    market_whitelist_user_ids: Option<Value>,
    id: i32,
    user_id: i32,
    namespace: String,
    pub(super) webhook_url: Option<String>,
    webhook_secret: Option<String>,
    last_execution_time: Option<String>,
    last_execution_status: Option<String>,
    next_execution_time: Option<String>,
    execution_count: i64,
    success_count: i64,
    failure_count: i64,
    bound_task_id: i64,
    followers_count: i64,
    is_following: bool,
    owner_username: Option<String>,
    is_rental: bool,
    source_subscription_id: Option<i64>,
    source_subscription_name: Option<String>,
    source_subscription_display_name: Option<String>,
    source_owner_username: Option<String>,
    rental_count: i64,
    pub(super) trigger_config_valid: bool,
    trigger_config_error: Option<String>,
    expires_at: Option<String>,
    is_expired: bool,
    created_at: String,
    updated_at: String,
}

/// A serialized `{name, namespace}` model reference.
#[derive(Debug, Serialize)]
struct NameNamespace {
    name: String,
    namespace: String,
}

/// `_convert_to_subscription_in_db`: build one item in pydantic field
/// declaration order.
pub(super) fn convert_to_subscription_in_db(
    row: &KindRow,
    cache: &HashMap<i64, RepoFields>,
) -> SubscriptionItem {
    let json = &row.json.0;
    let document: SubscriptionJson = serde_json::from_value(json.clone()).unwrap_or_default();
    let internal = internal_object(json);
    let spec = document.spec.unwrap_or_default();

    // Trigger config validation (minimum interval rules).
    let (trigger_config, trigger_config_valid, trigger_config_error) =
        validated_trigger_config(&spec.trigger);

    // Workspace repository fields: cache by workspace_id, else resolve by
    // workspaceRef.
    let workspace_id = internal_i64(&internal, "workspace_id").unwrap_or(0);
    let repo_fields = if workspace_id != 0 {
        cache.get(&workspace_id).cloned().unwrap_or_default()
    } else if let Some(ref workspace_ref) = spec.workspace_ref {
        // The source resolves the ref through a database lookup; the list
        // flow always supplies the cache, and a missing cache entry means
        // the workspace row is absent — the empty fields.
        let _ = workspace_ref;
        RepoFields::default()
    } else {
        RepoFields::default()
    };

    let webhook_token = internal_string(&internal, "webhook_token");
    let webhook_url = webhook_token
        .as_ref()
        .map(|token| format!("/api/subscriptions/webhook/{token}"));

    let model_ref = spec.model_ref.as_ref().map(|r| NameNamespace {
        name: r.name.clone().unwrap_or_default(),
        namespace: r.namespace.clone().unwrap_or_default(),
    });

    let last_execution_time =
        internal_datetime(&internal, "last_execution_time").map(pydantic_datetime);
    let next_execution_time =
        internal_datetime(&internal, "next_execution_time").map(pydantic_datetime);
    let expires_at = internal_datetime(&internal, "expires_at");
    let is_expired = expires_at
        .map(|expires_at| chrono::Utc::now().naive_utc() >= expires_at)
        .unwrap_or(false);

    let execution_target = spec
        .execution_target
        .clone()
        .unwrap_or_else(|| json!({"type": "managed", "device_id": null}));

    let market_whitelist_user_ids =
        normalize_market_whitelist_user_ids(internal.get("market_whitelist_user_ids"));

    let enabled = internal_flag(&internal, "enabled", true);

    SubscriptionItem {
        name: Some(row.name.clone()),
        display_name: spec.display_name.clone().unwrap_or_default(),
        description: spec.description.clone(),
        task_type: spec
            .task_type
            .clone()
            .unwrap_or_else(|| "collection".to_string()),
        visibility: spec
            .visibility
            .clone()
            .unwrap_or_else(|| "private".to_string()),
        trigger_type: internal
            .get("trigger_type")
            .and_then(Value::as_str)
            .unwrap_or("cron")
            .to_string(),
        trigger_config,
        team_id: internal_i64(&internal, "team_id").unwrap_or(0),
        workspace_id,
        git_repo: repo_fields.git_repo,
        git_repo_id: repo_fields.git_repo_id,
        git_domain: repo_fields.git_domain,
        branch_name: repo_fields.branch_name,
        model_ref,
        force_override_bot_model: spec.force_override_bot_model.unwrap_or(false),
        prompt_template: spec.prompt_template.clone().unwrap_or_default(),
        retry_count: spec.retry_count.unwrap_or(0),
        timeout_seconds: spec.timeout_seconds.unwrap_or(600),
        enabled,
        execution_target,
        preserve_history: spec.preserve_history.unwrap_or(false),
        history_message_count: spec.history_message_count.unwrap_or(10),
        notification_webhooks: spec
            .notification_webhooks
            .clone()
            .unwrap_or_else(|| Value::Null),
        knowledge_base_refs: spec.knowledge_base_refs.clone(),
        skill_refs: spec.skill_refs.clone(),
        market_whitelist_user_ids,
        id: row.id,
        user_id: row.user_id,
        namespace: row.namespace.clone(),
        webhook_url,
        webhook_secret: internal_string(&internal, "webhook_secret"),
        last_execution_time,
        last_execution_status: internal_string(&internal, "last_execution_status"),
        next_execution_time,
        execution_count: internal_i64(&internal, "execution_count").unwrap_or(0),
        success_count: internal_i64(&internal, "success_count").unwrap_or(0),
        failure_count: internal_i64(&internal, "failure_count").unwrap_or(0),
        bound_task_id: internal_i64(&internal, "bound_task_id").unwrap_or(0),
        followers_count: 0,
        is_following: false,
        owner_username: None,
        is_rental: internal_flag(&internal, "is_rental", false),
        source_subscription_id: internal_i64(&internal, "source_subscription_id"),
        source_subscription_name: internal_string(&internal, "source_subscription_name"),
        source_subscription_display_name: internal_string(
            &internal,
            "source_subscription_display_name",
        ),
        source_owner_username: internal_string(&internal, "source_owner_username"),
        rental_count: internal_i64(&internal, "rental_count").unwrap_or(0),
        trigger_config_valid,
        trigger_config_error,
        expires_at: expires_at.map(pydantic_datetime),
        is_expired,
        created_at: pydantic_datetime(row.created_at),
        updated_at: pydantic_datetime(row.updated_at),
    }
}

/// The `_internal` object of a subscription document (empty when absent).
pub(super) fn internal_object(json: &Value) -> Value {
    json.get("_internal").cloned().unwrap_or_else(|| json!({}))
}

/// `validate_subscription_for_read` + `extract_trigger_config` +
/// `_fix_invalid_trigger_config_for_read`: validate the stored trigger
/// config against the minimum-interval rules and extract the response's
/// `trigger_config` object.
///
/// Returns `(trigger_config, valid, error)`. An invalid interval/cron
/// frequency marks the item invalid with the fixed config still displayed.
pub(super) fn validated_trigger_config(trigger: &Option<Value>) -> (Value, bool, Option<String>) {
    let Some(trigger) = trigger else {
        return (json!({}), true, None);
    };
    let trigger_type = trigger.get("type").and_then(Value::as_str).unwrap_or("");
    match trigger_type {
        "cron" => {
            let cron = trigger.get("cron").cloned().unwrap_or_else(|| json!({}));
            let expression = cron.get("expression").and_then(Value::as_str).unwrap_or("");
            let timezone = cron
                .get("timezone")
                .and_then(Value::as_str)
                .unwrap_or("UTC")
                .to_string();
            // `Cron interval must be at least N minutes` for `*/N` minute
            // steps below the minimum; fixed to `*/N_min` for display.
            let mut valid = true;
            let mut fixed_expression = expression.to_string();
            let parts: Vec<&str> = expression.split_whitespace().collect();
            if parts.len() == 5
                && let Some(step) = parts[0].strip_prefix("*/")
                && let Ok(interval) = step.parse::<i64>()
                && interval < MIN_INTERVAL_MINUTES
            {
                valid = false;
                fixed_expression = std::iter::once(format!("*/{MIN_INTERVAL_MINUTES}"))
                    .chain(parts[1..].iter().map(|part| (*part).to_string()))
                    .collect::<Vec<String>>()
                    .join(" ");
            }
            (
                json!({"expression": fixed_expression, "timezone": timezone}),
                valid,
                if valid {
                    None
                } else {
                    Some("执行间隔太短，不满足最小间隔要求".to_string())
                },
            )
        }
        "interval" => {
            let interval = trigger
                .get("interval")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let value = interval.get("value").and_then(Value::as_i64).unwrap_or(0);
            let unit = interval
                .get("unit")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let valid = !(unit == "minutes" && value < MIN_INTERVAL_MINUTES);
            let value = if unit == "minutes" && value < MIN_INTERVAL_MINUTES {
                MIN_INTERVAL_MINUTES
            } else {
                value
            };
            (
                json!({"value": value, "unit": unit}),
                valid,
                if valid {
                    None
                } else {
                    Some("执行间隔太短，不满足最小间隔要求".to_string())
                },
            )
        }
        "one_time" => {
            let execute_at = trigger
                .get("one_time")
                .and_then(|one_time| one_time.get("execute_at"))
                .cloned()
                .unwrap_or(Value::Null);
            (json!({"execute_at": execute_at}), true, None)
        }
        "event" => {
            let event = trigger.get("event").cloned().unwrap_or_else(|| json!({}));
            let mut result = json!({
                "event_type": event.get("event_type").cloned().unwrap_or(Value::Null),
            });
            if let Some(git_push) = event.get("git_push") {
                result["git_push"] = json!({
                    "repository": git_push.get("repository").cloned().unwrap_or(Value::Null),
                    "branch": git_push.get("branch").cloned().unwrap_or(Value::Null),
                });
            }
            (result, true, None)
        }
        _ => (json!({}), true, None),
    }
}

/// `normalize_market_whitelist_user_ids`: keep positive integers, drop
/// duplicates, preserve order; `None` stays `None`, other values normalize
/// to a list.
pub(super) fn normalize_market_whitelist_user_ids(value: Option<&Value>) -> Option<Value> {
    match value {
        None => None,
        Some(Value::Array(entries)) => {
            let mut seen: HashSet<i64> = HashSet::new();
            let mut normalized: Vec<i64> = Vec::new();
            for entry in entries {
                if let Some(user_id) = entry.as_i64()
                    && user_id > 0
                    && seen.insert(user_id)
                {
                    normalized.push(user_id);
                }
            }
            Some(json!(normalized))
        }
        Some(_) => Some(json!([])),
    }
}

/// Read a boolean from `_internal` with its source default.
pub(super) fn internal_flag(internal: &Value, key: &str, default: bool) -> bool {
    match internal.get(key) {
        Some(Value::Bool(value)) => *value,
        _ => default,
    }
}

/// Set a boolean in `_internal` (auto-disable path).
pub(super) fn set_internal_flag(json: &mut Value, key: &str, value: bool) {
    if let Some(internal) = json.get_mut("_internal") {
        if !internal.is_object() {
            *internal = json!({});
        }
        if let Some(object) = internal.as_object_mut() {
            object.insert(key.to_string(), Value::Bool(value));
        }
    }
}

/// Read a string from `_internal`.
pub(super) fn internal_string(internal: &Value, key: &str) -> Option<String> {
    internal
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Read an integer from `_internal`.
pub(super) fn internal_i64(internal: &Value, key: &str) -> Option<i64> {
    internal.get(key).and_then(Value::as_i64)
}

/// Parse an ISO-8601 datetime from `_internal` (`datetime.fromisoformat`
/// accepts `YYYY-MM-DDTHH:MM:SS` and optional microseconds/fractional
/// offsets; the stored values are naive).
pub(super) fn internal_datetime(internal: &Value, key: &str) -> Option<chrono::NaiveDateTime> {
    let raw = internal.get(key)?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt| dt.naive_local())
        .or_else(|| chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S").ok())
        .or_else(|| chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f").ok())
        .or_else(|| chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S").ok())
}

/// pydantic naive-datetime serialization: `YYYY-MM-DDTHH:MM:SS` plus
/// fractional seconds when nonzero.
pub(super) fn pydantic_datetime(value: NaiveDateTime) -> String {
    let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        base
    } else {
        format!("{base}.{:06}", value.and_utc().timestamp_subsec_micros())
    }
}
