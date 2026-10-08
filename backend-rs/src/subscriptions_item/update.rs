// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `PUT /api/subscriptions/{subscription_id}`
//! (`SubscriptionService.update_subscription`).
//!
//! The update reapplies the submitted `SubscriptionUpdate` onto the stored CRD,
//! re-validating every reference the request touches (team, workspace, device),
//! rebuilding the trigger config, and recalibrating the next execution time,
//! before rewriting `kinds.json`. A `db.refresh` then renders `SubscriptionInDB`.

use brz_mysql::{Json, MysqlTransaction};
use chrono::NaiveDateTime;
use chrono::Utc;
use serde_json::{Map, Value, json};

use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::subscriptions_list::convert::{SubscriptionItem, convert_to_subscription_in_db};

use super::body::Update;
use super::crd;
use super::cron;
use super::{
    code_wiki_id, code_wiki_rejected, find_subscription, internal_error, invalidate_kind_cache,
    not_found, now_utc, updated_at_bind,
};

/// `db.commit()`'s flush of the rewritten Subscription row.
const UPDATE_SUBSCRIPTION_QUERY: &str = "UPDATE kinds SET json=?, updated_at=? WHERE kinds.id = ?";

/// `SUBSCRIPTION_MIN_INTERVAL_MINUTES` (deployment default).
const MIN_INTERVAL_MINUTES: i64 = 15;

/// `task_store.get_active_workspace_by_id`: the owner's active Workspace row.
const ACTIVE_WORKSPACE_QUERY: &str = "SELECT tasks.id AS tasks_id, tasks.user_id AS tasks_user_id, \
     tasks.kind AS tasks_kind, tasks.name AS tasks_name, \
     tasks.namespace AS tasks_namespace, tasks.json AS tasks_json, \
     tasks.is_active AS tasks_is_active, tasks.created_at AS tasks_created_at, \
     tasks.updated_at AS tasks_updated_at \nFROM tasks \n\
     WHERE tasks.id = ? AND tasks.kind = 'Workspace' AND tasks.is_active = 1 \n LIMIT 1";

/// `task_store.get_workspace_by_ref`: the owner's workspace for a git reference.
const WORKSPACE_BY_REF_QUERY: &str = "SELECT tasks.id AS tasks_id, tasks.user_id AS tasks_user_id, \
     tasks.kind AS tasks_kind, tasks.name AS tasks_name, \
     tasks.namespace AS tasks_namespace, tasks.json AS tasks_json, \
     tasks.is_active AS tasks_is_active, tasks.created_at AS tasks_created_at, \
     tasks.updated_at AS tasks_updated_at \nFROM tasks \n\
     WHERE tasks.user_id = ? AND tasks.kind = 'Workspace' AND tasks.name = ? \
     AND tasks.namespace = ? AND tasks.is_active = 1 \n LIMIT 1";

/// `task_store.create_workspace` + `db.flush()`.
const CREATE_WORKSPACE_QUERY: &str = "INSERT INTO tasks \
     (user_id, kind, name, namespace, json, is_active, created_at, updated_at, \
     project_id, client_origin, is_group_chat) \
     VALUES (?, 'Workspace', ?, ?, ?, 1, ?, ?, 0, 'frontend', 0)";

/// `users` probe used by the market-whitelist filter.
/// `SubscriptionService.update_subscription`.
pub(super) async fn update_subscription(
    state: &AppState,
    user_id: i64,
    subscription_id: i64,
    update: &Update,
) -> Result<SubscriptionItem, FastApiError> {
    let outcome = state
        .mysql
        .with_transaction(async |transaction| {
            apply_update(transaction, state, user_id, subscription_id, update).await
        })
        .await
        .map_err(internal_error)?;

    match outcome {
        UpdateOutcome::Saved => refresh(state, subscription_id).await,
        UpdateOutcome::NotFound => Err(not_found()),
        UpdateOutcome::Rejected => Err(code_wiki_rejected()),
        UpdateOutcome::BadRequest(message) => Err(FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            message,
        )),
        UpdateOutcome::EncryptionFailed => Err(FastApiError::internal()),
    }
}

/// The observable outcomes of the update transaction.
enum UpdateOutcome {
    /// `db.commit()` succeeded.
    Saved,
    /// No owned active Subscription row.
    NotFound,
    /// A Code Wiki scheduler row cannot be updated here (409).
    Rejected,
    /// A `HTTPException(400, ...)` raised inside the service.
    BadRequest(String),
    /// `encrypt_sensitive_data` raised `CryptoConfigurationError`.
    EncryptionFailed,
}

/// `db.refresh(subscription)` then `_convert_to_subscription_in_db`.
async fn refresh(state: &AppState, subscription_id: i64) -> Result<SubscriptionItem, FastApiError> {
    let row = state
        .mysql
        .fetch_optional(super::REFRESH_SUBSCRIPTION_QUERY, (subscription_id,))
        .await
        .map_err(internal_error)?
        .ok_or_else(not_found)?;
    Ok(convert_to_subscription_in_db(&row, &Default::default()))
}

/// The transaction body of `update_subscription`.
async fn apply_update<T: MysqlTransaction>(
    transaction: &mut T,
    state: &AppState,
    user_id: i64,
    subscription_id: i64,
    update: &Update,
) -> Result<UpdateOutcome, brz_mysql::MysqlError> {
    let Some(row) = find_subscription(transaction, user_id, subscription_id).await? else {
        return Ok(UpdateOutcome::NotFound);
    };
    let stored = row.json.0.clone();
    if code_wiki_id(&stored).is_some() {
        return Ok(UpdateOutcome::Rejected);
    }

    let mut document = crd::build_crd_document(&stored);
    let mut spec = crd::build_spec(stored.get("spec").unwrap_or(&Value::Null));
    let mut internal = stored
        .get("_internal")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));

    // team reference
    if update.contains("team_id") {
        let value = update.get("team_id").cloned().unwrap_or(Value::Null);
        let team_id = value.as_i64().unwrap_or(0);
        let team = transaction
            .fetch_optional::<_, _, super::KindRow>(super::TEAM_QUERY, (team_id,))
            .await?;
        let Some(team) = team else {
            return Ok(UpdateOutcome::BadRequest(format!(
                "Team with id {} not found",
                display(&value)
            )));
        };
        set(&mut internal, "team_id", json!(team_id));
        set(
            &mut spec,
            "teamRef",
            json!({"name": team.name, "namespace": team.namespace}),
        );
    }

    // workspace reference (explicit id) or git reference
    if update.contains("workspace_id") {
        let value = update.get("workspace_id").cloned().unwrap_or(Value::Null);
        if truthy(&value) {
            let workspace_id = value.as_i64().unwrap_or(0);
            let workspace = active_workspace(transaction, workspace_id, Some(user_id)).await?;
            let Some(workspace) = workspace else {
                return Ok(UpdateOutcome::BadRequest(format!(
                    "Workspace with id {workspace_id} not found"
                )));
            };
            set(
                &mut spec,
                "workspaceRef",
                json!({"name": workspace.name, "namespace": workspace.namespace}),
            );
            set(&mut internal, "workspace_id", json!(workspace_id));
        } else {
            set(&mut spec, "workspaceRef", Value::Null);
            set(&mut internal, "workspace_id", json!(0));
        }
    } else if update.contains("git_repo")
        || update.contains("git_repo_id")
        || update.contains("git_domain")
        || update.contains("branch_name")
    {
        let git_repo = update.get("git_repo").cloned().unwrap_or(Value::Null);
        if truthy(&git_repo) {
            let git_repo = git_repo.as_str().unwrap_or("").to_string();
            let git_repo_id = update.get("git_repo_id").and_then(Value::as_i64);
            let git_domain = update
                .get("git_domain")
                .and_then(Value::as_str)
                .unwrap_or("github.com")
                .to_string();
            let branch_name = update
                .get("branch_name")
                .and_then(Value::as_str)
                .unwrap_or("main")
                .to_string();
            let workspace_id = create_or_get_workspace(
                transaction,
                user_id,
                &git_repo,
                git_repo_id,
                &git_domain,
                &branch_name,
            )
            .await?;
            if let Some(workspace) = active_workspace(transaction, workspace_id, None).await? {
                set(
                    &mut spec,
                    "workspaceRef",
                    json!({"name": workspace.name, "namespace": workspace.namespace}),
                );
                set(&mut internal, "workspace_id", json!(workspace.id));
            }
        } else {
            set(&mut spec, "workspaceRef", Value::Null);
            set(&mut internal, "workspace_id", json!(0));
        }
    }

    // simple scalar fields
    for (request_key, spec_key) in [
        ("display_name", "displayName"),
        ("description", "description"),
        ("task_type", "taskType"),
        ("prompt_template", "promptTemplate"),
        ("retry_count", "retryCount"),
        ("timeout_seconds", "timeoutSeconds"),
        ("force_override_bot_model", "forceOverrideBotModel"),
        ("history_message_count", "historyMessageCount"),
        ("knowledge_base_refs", "knowledgeBaseRefs"),
        ("skill_refs", "skillRefs"),
    ] {
        if let Some(value) = update.value(request_key) {
            set(&mut spec, spec_key, value);
        }
    }

    // visibility change side effect
    if let Some(value) = update.value("visibility") {
        let old = spec
            .get("visibility")
            .and_then(Value::as_str)
            .unwrap_or("private")
            .to_string();
        let new = value.as_str().map(str::to_string);
        set(&mut spec, "visibility", value);
        if old == "public" && new.as_deref() == Some("private") {
            clear_direct_follows(transaction, subscription_id).await?;
        }
    }

    if let Some(value) = update.value("enabled") {
        set(&mut spec, "enabled", value.clone());
        set(&mut internal, "enabled", value);
    }

    if update.contains("execution_target") {
        let value = update
            .get("execution_target")
            .cloned()
            .unwrap_or(Value::Null);
        match validate_execution_target(transaction, user_id, &value).await? {
            Ok(normalized) => set(&mut spec, "executionTarget", normalized),
            Err(message) => return Ok(UpdateOutcome::BadRequest(message)),
        }
    }

    if let Some(value) = update.value("model_ref") {
        if truthy(&value) {
            let name = value.get("name").cloned().unwrap_or_else(|| json!(""));
            let namespace = value
                .get("namespace")
                .cloned()
                .unwrap_or_else(|| json!("default"));
            set(
                &mut spec,
                "modelRef",
                json!({"name": name, "namespace": namespace}),
            );
        } else {
            set(&mut spec, "modelRef", Value::Null);
        }
    }

    if let Some(value) = update.value("preserve_history") {
        set(&mut spec, "preserveHistory", value.clone());
        if !truthy(&value) {
            set(&mut internal, "bound_task_id", json!(0));
        }
    }

    if update.contains("notification_webhooks") {
        let value = update
            .get("notification_webhooks")
            .cloned()
            .unwrap_or(Value::Null);
        if truthy(&value) {
            match encrypt_webhooks(&value) {
                Some(webhooks) => set(&mut spec, "notificationWebhooks", webhooks),
                None => return Ok(UpdateOutcome::EncryptionFailed),
            }
        } else {
            set(&mut spec, "notificationWebhooks", Value::Null);
        }
    }

    if update.contains("market_whitelist_user_ids") {
        let value = update
            .get("market_whitelist_user_ids")
            .cloned()
            .unwrap_or(Value::Null);
        let filtered = filter_existing_market_users(transaction, &value).await?;
        set(&mut internal, "market_whitelist_user_ids", json!(filtered));
    }

    if update.contains("expires_at") {
        let value = update.get("expires_at").cloned().unwrap_or(Value::Null);
        if truthy(&value) {
            set(&mut internal, "expires_at", value);
        } else {
            set(&mut internal, "expires_at", Value::Null);
        }
    }

    if update.contains("trigger_type") || update.contains("trigger_config") {
        let trigger_type = match update.value("trigger_type") {
            Some(value) => value,
            None => internal.get("trigger_type").cloned().unwrap_or(Value::Null),
        };
        let trigger_type = trigger_type.as_str().unwrap_or("").to_string();
        let config = match update.value("trigger_config") {
            Some(value) => value,
            None => extract_trigger_config(spec.get("trigger")),
        };
        if let Err(message) = validate_trigger_config(&trigger_type, &config) {
            return Ok(UpdateOutcome::BadRequest(message));
        }

        let current = internal
            .get("trigger_type")
            .and_then(Value::as_str)
            .unwrap_or("");
        if trigger_type == "event" && current != "event" {
            // `secrets.token_urlsafe(32)` for both the token and the key.
            set(
                &mut internal,
                "webhook_token",
                json!(random_token_urlsafe(32)),
            );
            set(
                &mut internal,
                "webhook_secret",
                json!(random_token_urlsafe(32)),
            );
        } else if trigger_type != "event" {
            set(&mut internal, "webhook_token", json!(""));
            set(&mut internal, "webhook_secret", json!(""));
        }

        set(
            &mut spec,
            "trigger",
            build_trigger_value(&trigger_type, &config),
        );
        set(&mut internal, "trigger_type", json!(trigger_type));
        let next =
            cron::calculate_next_execution_time(&trigger_type, &config, Utc::now().naive_utc());
        let next_value = next
            .map(crd::pydantic_datetime)
            .map(|value| json!(value))
            .unwrap_or(Value::Null);
        set(&mut internal, "next_execution_time", next_value);
    }

    // webhook URL derives from the (possibly new) token.
    if let Some(token) = internal.get("webhook_token").and_then(Value::as_str)
        && !token.is_empty()
    {
        if !document.get("status").is_some_and(Value::is_object) {
            document.insert("status".to_string(), default_status());
        }
        if let Some(status) = document.get_mut("status").and_then(Value::as_object_mut) {
            status.insert(
                "webhookUrl".to_string(),
                json!(format!("/api/subscriptions/webhook/{token}")),
            );
        }
    }

    document.insert("spec".to_string(), spec);
    document.insert("_internal".to_string(), internal);

    let json = crd::python_json_dumps(&Value::Object(document));
    let updated_at = updated_at_bind(now_utc());
    transaction
        .execute(
            UPDATE_SUBSCRIPTION_QUERY,
            (json, updated_at, subscription_id),
        )
        .await?;

    invalidate_kind_cache(
        state.redis.as_ref(),
        "Subscription",
        i64::from(row.id),
        user_id,
        &row.namespace,
        &row.name,
    )
    .await;
    Ok(UpdateOutcome::Saved)
}

/// `SubscriptionStatus()` defaults.
fn default_status() -> Value {
    json!({
        "state": "Available",
        "lastExecutionTime": null,
        "lastExecutionStatus": null,
        "nextExecutionTime": null,
        "webhookUrl": null,
        "executionCount": 0,
        "successCount": 0,
        "failureCount": 0,
    })
}

/// Set a key on a JSON object.
fn set(object: &mut Value, key: &str, value: Value) {
    if let Some(object) = object.as_object_mut() {
        object.insert(key.to_string(), value);
    }
}

/// Python truthiness (`bool(value)`).
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
    }
}

/// Python `str(value)` for an f-string of a request value.
fn display(value: &Value) -> String {
    match value {
        Value::Null => "None".to_string(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// `secrets.token_urlsafe(32)` — 32 random bytes, URL-safe Base64 without
/// padding. A failure to gather entropy yields an empty token, matching the
/// source's behavior of surfacing whatever `os.urandom` returned.
pub(crate) fn random_token_urlsafe(byte_count: usize) -> String {
    use base64::Engine;
    let mut bytes = vec![0u8; byte_count];
    if getrandom::getrandom(&mut bytes).is_err() {
        return String::new();
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// `extract_trigger_config` — the stored trigger's config for its type.
fn extract_trigger_config(trigger: Option<&Value>) -> Value {
    let Some(trigger) = trigger.and_then(Value::as_object) else {
        return json!({});
    };
    match trigger.get("type").and_then(Value::as_str).unwrap_or("") {
        "cron" => trigger.get("cron").cloned().unwrap_or_else(|| json!({})),
        "interval" => trigger
            .get("interval")
            .cloned()
            .unwrap_or_else(|| json!({})),
        "one_time" => {
            let execute_at = trigger
                .get("one_time")
                .and_then(|one_time| one_time.get("execute_at"))
                .cloned()
                .unwrap_or(Value::Null);
            json!({"execute_at": execute_at})
        }
        "event" => trigger.get("event").cloned().unwrap_or_else(|| json!({})),
        _ => json!({}),
    }
}

/// `SubscriptionService._validate_trigger_config`.
pub(crate) fn validate_trigger_config(trigger_type: &str, config: &Value) -> Result<(), String> {
    match trigger_type {
        "interval" => {
            let value = config.get("value").and_then(Value::as_i64).unwrap_or(1);
            let unit = config
                .get("unit")
                .and_then(Value::as_str)
                .unwrap_or("hours");
            if unit == "minutes" && value < MIN_INTERVAL_MINUTES {
                return Err(format!(
                    "Interval must be at least {MIN_INTERVAL_MINUTES} minutes"
                ));
            }
            Ok(())
        }
        "cron" => {
            let expression = config
                .get("expression")
                .and_then(Value::as_str)
                .unwrap_or("");
            let parts: Vec<&str> = expression.split_whitespace().collect();
            if parts.len() == 5
                && let Some(step) = parts[0].strip_prefix("*/")
                && let Ok(interval) = step.parse::<i64>()
                && interval < MIN_INTERVAL_MINUTES
            {
                return Err(format!(
                    "Cron interval must be at least {MIN_INTERVAL_MINUTES} minutes"
                ));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// `build_trigger_config` — the normalized `SubscriptionTriggerConfig`.
pub(crate) fn build_trigger_value(trigger_type: &str, config: &Value) -> Value {
    match trigger_type {
        "cron" => json!({
            "type": "cron",
            "cron": {
                "expression": config.get("expression").cloned().unwrap_or_else(|| json!("0 9 * * *")),
                "timezone": config.get("timezone").cloned().unwrap_or_else(|| json!("UTC")),
            },
            "interval": null,
            "one_time": null,
            "event": null,
        }),
        "interval" => {
            let value = config.get("value").and_then(Value::as_i64).unwrap_or(1);
            let unit = config
                .get("unit")
                .and_then(Value::as_str)
                .unwrap_or("hours");
            let value = if unit == "minutes" && value < MIN_INTERVAL_MINUTES {
                MIN_INTERVAL_MINUTES
            } else {
                value
            };
            json!({
                "type": "interval",
                "cron": null,
                "interval": {"value": value, "unit": unit},
                "one_time": null,
                "event": null,
            })
        }
        "one_time" => {
            let execute_at = config
                .get("execute_at")
                .and_then(Value::as_str)
                .map(|raw| raw.replace('Z', "+00:00"))
                .and_then(|raw| {
                    chrono::DateTime::parse_from_rfc3339(&raw)
                        .map(|aware| crd::pydantic_datetime(aware.naive_utc()))
                        .ok()
                        .or_else(|| {
                            NaiveDateTime::parse_from_str(&raw, "%Y-%m-%dT%H:%M:%S")
                                .ok()
                                .map(crd::pydantic_datetime)
                        })
                })
                .unwrap_or_default();
            json!({
                "type": "one_time",
                "cron": null,
                "interval": null,
                "one_time": {"execute_at": execute_at},
                "event": null,
            })
        }
        "event" => {
            let event_type = config
                .get("event_type")
                .and_then(Value::as_str)
                .unwrap_or("webhook");
            let git_push = if event_type == "git_push" {
                let git = config.get("git_push").cloned().unwrap_or_else(|| json!({}));
                json!({
                    "repository": git.get("repository").cloned().unwrap_or_else(|| json!("")),
                    "branch": git.get("branch").cloned().unwrap_or(Value::Null),
                })
            } else {
                Value::Null
            };
            json!({
                "type": "event",
                "cron": null,
                "interval": null,
                "one_time": null,
                "event": {"event_type": event_type, "git_push": git_push, "inbox_message": null},
            })
        }
        other => json!({"type": other}),
    }
}

/// `_validate_execution_target`: returns the normalized target or the source's
/// 400 detail message.
pub(crate) async fn validate_execution_target<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    value: &Value,
) -> Result<Result<Value, String>, brz_mysql::MysqlError> {
    let target_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("managed")
        .to_string();
    let device_id = value
        .get("device_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let normalized = json!({
        "type": target_type,
        "device_id": device_id.clone().map(Value::String).unwrap_or(Value::Null),
    });

    if target_type == "managed" {
        if device_id.is_some_and(|id| !id.is_empty()) {
            return Ok(Err(
                "Managed execution target cannot specify a device".to_string()
            ));
        }
        return Ok(Ok(normalized));
    }

    let Some(device_id) = device_id.filter(|id| !id.is_empty()) else {
        return Ok(Err(
            "execution_target.device_id is required for device execution targets".to_string(),
        ));
    };

    let devices: Vec<super::KindRow> = transaction
        .fetch_all::<_, _, super::KindRow>(super::DEVICES_QUERY, (user_id,))
        .await?;
    let Some(device) = resolve_device_alias(&devices, &device_id) else {
        return Ok(Err(format!("Device '{device_id}' not found")));
    };
    let actual_type = device
        .json
        .0
        .get("spec")
        .and_then(|spec| spec.get("deviceType"))
        .and_then(Value::as_str)
        .unwrap_or("local")
        .to_string();
    if actual_type != target_type {
        return Ok(Err(format!(
            "Device '{device_id}' is type '{actual_type}', expected '{target_type}'"
        )));
    }
    Ok(Ok(normalized))
}

/// `resolve_owned_device_alias` over the already-selected owned device rows.
fn resolve_device_alias(devices: &[super::KindRow], device_id: &str) -> Option<super::KindRow> {
    let submitted = device_id.trim();
    if submitted.is_empty() {
        return None;
    }
    if let Some(record_id) = record_id_from_route(submitted) {
        let device = devices
            .iter()
            .find(|device| i64::from(device.id) == record_id)?;
        return (device_type(device) == "app").then(|| device.clone());
    }
    let matches: Vec<&super::KindRow> = devices
        .iter()
        .filter(|device| device_identity_ids(device).iter().any(|id| id == submitted))
        .collect();
    match matches.as_slice() {
        [] => None,
        [single] => Some((*single).clone()),
        many => {
            let app: Vec<&&super::KindRow> = many
                .iter()
                .filter(|device| device_type(device) == "app")
                .collect();
            match app.as_slice() {
                [single] => Some((**single).clone()),
                _ => None,
            }
        }
    }
}

/// `record_id_from_route`: an App transport route's numeric record id.
fn record_id_from_route(device_id: &str) -> Option<i64> {
    let suffix = device_id.strip_prefix("app-record-")?;
    suffix.parse::<i64>().ok().filter(|id| *id > 0)
}

/// The persisted `spec.deviceType`, normalized (`device_kind_type`).
fn device_type(device: &super::KindRow) -> String {
    let raw = device
        .json
        .0
        .get("spec")
        .and_then(|spec| spec.get("deviceType"))
        .and_then(Value::as_str)
        .unwrap_or("local");
    match raw {
        "app" => "app".to_string(),
        "cloud" => "cloud".to_string(),
        "remote" => "remote".to_string(),
        _ => "local".to_string(),
    }
}

/// `device_identity_ids`: every persisted identity for one device record.
fn device_identity_ids(device: &super::KindRow) -> Vec<String> {
    let spec = device.json.0.get("spec");
    let route = if device_type(device) == "app" {
        format!("app-record-{}", device.id)
    } else {
        device.name.clone()
    };
    let field = |key: &str| {
        spec.and_then(|spec| spec.get(key))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let mut out: Vec<String> = vec![route, device.name.trim().to_string()];
    out.push(field("deviceId"));
    out.push(field("appDeviceId"));
    out.retain(|value| !value.is_empty());
    let mut seen = std::collections::HashSet::new();
    out.retain(|value| seen.insert(value.clone()));
    out
}

/// `db.query(User.id).filter(User.id.in_(ids), User.is_active == True)` and the
/// order-preserving filter, or `[]` for an empty normalized input.
pub(crate) async fn filter_existing_market_users<T: MysqlTransaction>(
    transaction: &mut T,
    value: &Value,
) -> Result<Vec<i64>, brz_mysql::MysqlError> {
    let normalized = normalize_market_ids(value);
    if normalized.is_empty() {
        return Ok(Vec::new());
    }
    let existing = existing_user_ids(transaction, &normalized).await?;
    Ok(normalized
        .into_iter()
        .filter(|id| existing.contains(id))
        .collect())
}

/// `normalize_market_whitelist_user_ids` for an update value.
fn normalize_market_ids(value: &Value) -> Vec<i64> {
    let Value::Array(entries) = value else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    entries
        .iter()
        .filter_map(Value::as_i64)
        .filter(|id| *id > 0 && seen.insert(*id))
        .collect()
}

/// `db.query(User.id).filter(User.id.in_(normalized), User.is_active == True)`.
async fn existing_user_ids<T: MysqlTransaction>(
    transaction: &mut T,
    ids: &[i64],
) -> Result<std::collections::HashSet<i64>, brz_mysql::MysqlError> {
    let placeholders = vec!["?"; ids.len()].join(", ");
    let sql = "SELECT users.id AS users_id \nFROM users \n\
         WHERE users.id IN ("
        .to_string()
        + &placeholders
        + ") AND users.is_active = true";
    let rows: Vec<UserIdRow> = transaction.fetch_all(sql, ids.to_vec()).await?;
    Ok(rows.into_iter().map(|row| row.id).collect())
}

/// A `users.id` probe row.
#[derive(brz_mysql::FromMysqlRow)]
struct UserIdRow {
    #[mysql(rename = "users_id")]
    id: i64,
}

/// `task_store.get_active_workspace_by_id`.
pub(crate) async fn active_workspace<T: MysqlTransaction>(
    transaction: &mut T,
    workspace_id: i64,
    owner_user_id: Option<i64>,
) -> Result<Option<TaskWorkspaceRow>, brz_mysql::MysqlError> {
    if let Some(owner) = owner_user_id {
        let sql = format!("{ACTIVE_WORKSPACE_QUERY_BASE} AND tasks.user_id = ? \n LIMIT 1");
        return transaction
            .fetch_optional::<_, _, TaskWorkspaceRow>(sql, (workspace_id, owner))
            .await;
    }
    transaction
        .fetch_optional::<_, _, TaskWorkspaceRow>(ACTIVE_WORKSPACE_QUERY, (workspace_id,))
        .await
}

const ACTIVE_WORKSPACE_QUERY_BASE: &str = "SELECT tasks.id AS tasks_id, tasks.user_id AS tasks_user_id, \
     tasks.kind AS tasks_kind, tasks.name AS tasks_name, \
     tasks.namespace AS tasks_namespace, tasks.json AS tasks_json, \
     tasks.is_active AS tasks_is_active, tasks.created_at AS tasks_created_at, \
     tasks.updated_at AS tasks_updated_at \nFROM tasks \n\
     WHERE tasks.id = ? AND tasks.kind = 'Workspace' AND tasks.is_active = 1";

/// `create_or_get_workspace`: an existing workspace for the git reference, or a
/// freshly created one.
pub(crate) async fn create_or_get_workspace<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    git_repo: &str,
    git_repo_id: Option<i64>,
    git_domain: &str,
    branch_name: &str,
) -> Result<i64, brz_mysql::MysqlError> {
    let workspace_name = format!("{}-{}", git_repo.replace('/', "-"), branch_name).to_lowercase();
    let workspace_name: String = workspace_name.chars().take(100).collect();
    let namespace = "default";

    if let Some(existing) = transaction
        .fetch_optional::<_, _, TaskWorkspaceRow>(
            WORKSPACE_BY_REF_QUERY,
            (user_id, workspace_name.as_str(), namespace),
        )
        .await?
    {
        return Ok(existing.id);
    }

    let workspace_json = json!({
        "apiVersion": "wegent.io/v1",
        "kind": "Workspace",
        "metadata": {"name": workspace_name, "namespace": namespace},
        "spec": {
            "repository": {
                "gitUrl": format!("https://{git_domain}/{git_repo}.git"),
                "gitRepo": git_repo,
                "gitRepoId": git_repo_id.unwrap_or(0),
                "gitDomain": git_domain,
                "branchName": branch_name,
            }
        }
    });
    let bind = updated_at_bind(now_utc());
    transaction
        .execute(
            CREATE_WORKSPACE_QUERY,
            (
                user_id,
                workspace_name.as_str(),
                namespace,
                crd::python_json_dumps(&workspace_json),
                bind.as_str(),
                bind.as_str(),
            ),
        )
        .await?;
    let id: Option<i64> = transaction
        .fetch_optional::<_, _, LastInsertId>("SELECT LAST_INSERT_ID() AS id", ())
        .await?
        .map(|row| row.id);
    Ok(id.unwrap_or(0))
}

/// `LAST_INSERT_ID()` probe row.
#[derive(brz_mysql::FromMysqlRow)]
struct LastInsertId {
    id: i64,
}

/// The `tasks` Workspace row projection.
#[derive(Clone, brz_mysql::FromMysqlRow)]
pub(crate) struct TaskWorkspaceRow {
    #[mysql(rename = "tasks_id")]
    pub(crate) id: i64,
    #[allow(dead_code, reason = "selected to match the source projection")]
    #[mysql(rename = "tasks_name")]
    pub(crate) name: String,
    #[allow(dead_code, reason = "selected to match the source projection")]
    #[mysql(rename = "tasks_namespace")]
    pub(crate) namespace: String,
    #[allow(dead_code, reason = "selected to match the source projection")]
    #[mysql(rename = "tasks_json")]
    json: Json<Value>,
}

/// `SubscriptionFollow` direct rows for one subscription.
async fn clear_direct_follows<T: MysqlTransaction>(
    transaction: &mut T,
    subscription_id: i64,
) -> Result<(), brz_mysql::MysqlError> {
    transaction
        .execute(
            "DELETE FROM subscription_follows WHERE subscription_id = ? AND follow_type = 'direct'",
            (subscription_id,),
        )
        .await?;
    Ok(())
}

/// `NotificationWebhook.model_validate` + the `ENC:` encryption the source
/// applies to a plaintext signing key.
fn encrypt_webhooks(value: &Value) -> Option<Value> {
    let Value::Array(entries) = value else {
        return Some(Value::Null);
    };
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let mut webhook = Map::new();
        let url = entry.get("url").cloned().unwrap_or(Value::Null);
        let mut key = entry.get("secret").cloned().unwrap_or(Value::Null);
        if let Some(text) = key.as_str()
            && !text.is_empty()
            && !text.starts_with("ENC:")
        {
            match super::crypto::encrypt_sensitive_data(text) {
                Ok(encrypted) => key = json!(format!("ENC:{encrypted}")),
                Err(_) => return None,
            }
        }
        webhook.insert(
            "type".to_string(),
            entry.get("type").cloned().unwrap_or(Value::Null),
        );
        webhook.insert("url".to_string(), url);
        webhook.insert("secret".to_string(), key);
        webhook.insert(
            "enabled".to_string(),
            entry.get("enabled").cloned().unwrap_or_else(|| json!(true)),
        );
        out.push(Value::Object(webhook));
    }
    Some(Value::Array(out))
}
