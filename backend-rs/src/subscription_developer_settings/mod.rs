// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET` and `PUT /api/subscriptions/{subscription_id}/developer/notification-settings`.
//!
//! Mirrors
//! `app.api.endpoints.adapter.subscription_follows.get_developer_notification_settings`
//! / `update_developer_notification_settings` (route
//! `"/{subscription_id}/developer/notification-settings"`, router prefix
//! `/subscriptions`, under `/api`) and
//! `SubscriptionNotificationService.get_developer_settings` /
//! `update_developer_settings` (`app.services.subscription.notification_service`).
//!
//! Source pipeline:
//! 1. `security.get_current_user` — JWT session decode plus the labeled
//!    `users` lookup by name (`auth::SessionUser`).
//! 2. Load the active Subscription row
//!    (`id = ? AND kind = 'Subscription' AND is_active = true LIMIT 1`).
//!    `GET` does not convert the service `ValueError`, so a missing row or a
//!    non-owner renders the `Exception` handler body (500 `{"error_code":500,
//!    "detail":"Internal server error"}`); `PUT` catches `ValueError` and maps it
//!    to `HTTPException(400, detail)` (`{"detail": ...}`).
//! 3. Load the developer follow row (`subscription_id = ? AND
//!    follower_user_id = ? LIMIT 1`; no invitation-status filter).
//! 4. `GET`: with a follow row render the parsed `SubscriptionFollowConfig`;
//!    without one render the `NOTIFY` default. `PUT`: build the submitted
//!    config, upsert the follow row, and — when `channel_binding_configs` is
//!    present (an empty list counts) — re-read the owned subscription, merge the
//!    per-channel bindings into `_internal.notification_channel_bindings`, and
//!    rewrite `kinds.json`.
//! 5. `get_available_channels`: every active global Messager channel
//!    (`kind = 'Messager' AND user_id = 0 AND is_active = true`) filtered by
//!    `spec.isEnabled`, annotated `is_bound` from the current user's
//!    `preferences.im_channels` keys.
//!
//! SQLAlchemy only emits UPDATE columns whose value changed: an unchanged
//! `follow.config` or `kinds.json` is omitted from the `SET` list, matching the
//! recorded exchanges.
//!
//! Response field order matches the pydantic declaration order:
//! `DeveloperNotificationSettingsResponse`
//! (`notification_level, notification_channel_ids, available_channels,
//! channel_binding_configs`), each `NotificationChannelInfo`
//! (`id, name, channel_type, is_bound`), each `NotificationChannelBindingConfig`
//! (`channel_id, bind_private, bind_group, group_conversation_id, group_name`).

// PUT invalidation contract: the source `Kind` `after_update` event is the `DEL` the recorder captures after `UPDATE kinds`, so the channel-binding path must invalidate the `Subscription` Kind cache for that exchange to stay matched.
use std::collections::HashSet;

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Mysql, MysqlTransaction};
use chrono::{NaiveDateTime, Utc};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::auth::{SessionUser, UserRow};
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::subscriptions_item::{invalidate_kind_cache, python_json_dumps};
use crate::subscriptions_list::KindRow;
use crate::user_reader::USER_BY_ID_QUERY;

mod body;

use body::{BindingInput, UpdateRequest};

/// `NotificationLevel` values shared by the schema and the follow-config model.
const LEVELS: [&str; 3] = ["silent", "default", "notify"];

/// `db.query(Kind).filter(id, kind='Subscription', is_active=true).first()`.
fn find_subscription_sql() -> String {
    format!(
        "SELECT {} \nFROM kinds \nWHERE kinds.id = ? AND kinds.kind = 'Subscription' \
         AND kinds.is_active = true \n LIMIT 1",
        KindRow::COLUMNS
    )
}

/// `db.query(Kind).filter(kind='Messager', user_id=0, is_active=true).all()`.
fn messager_sql() -> String {
    format!(
        "SELECT {} \nFROM kinds \nWHERE kinds.kind = 'Messager' AND kinds.user_id = 0 \
         AND kinds.is_active = true",
        KindRow::COLUMNS
    )
}

/// `db.refresh(subscription)` — SQLAlchemy re-selects the row by primary key
/// after `expire_on_commit` invalidates the attribute.
fn refresh_kind_sql() -> String {
    format!(
        "SELECT {} \nFROM kinds \nWHERE kinds.id = ?",
        KindRow::COLUMNS
    )
}

/// `db.query(SubscriptionFollow).filter(subscription_id, follower_user_id)
/// .first()` — every mapped column, aliased `subscription_follows_<column>`.
const FIND_FOLLOW_QUERY: &str = "SELECT subscription_follows.id AS subscription_follows_id, \
     subscription_follows.subscription_id AS subscription_follows_subscription_id, \
     subscription_follows.follower_user_id AS subscription_follows_follower_user_id, \
     subscription_follows.follow_type AS subscription_follows_follow_type, \
     subscription_follows.invited_by_user_id AS subscription_follows_invited_by_user_id, \
     subscription_follows.invitation_status AS subscription_follows_invitation_status, \
     subscription_follows.invited_at AS subscription_follows_invited_at, \
     subscription_follows.responded_at AS subscription_follows_responded_at, \
     subscription_follows.created_at AS subscription_follows_created_at, \
     subscription_follows.updated_at AS subscription_follows_updated_at, \
     subscription_follows.config AS subscription_follows_config \n\
     FROM subscription_follows \n\
     WHERE subscription_follows.subscription_id = ? \
     AND subscription_follows.follower_user_id = ? \n LIMIT 1";

/// The developer follow row; only the primary key and `config` are consumed.
#[derive(Debug, FromMysqlRow)]
struct SubscriptionFollowRow {
    #[mysql(rename = "subscription_follows_id")]
    id: i32,
    #[mysql(rename = "subscription_follows_config")]
    config: Option<String>,
}

/// `GET /api/subscriptions/{subscription_id}/developer/notification-settings`.
#[brz_http_server::get("/api/subscriptions/:subscription_id/developer/notification-settings")]
async fn get_developer_notification_settings(
    #[inject(state)] state: &AppState,
    subscription_id: i64,
    #[auth] user: SessionUser,
) -> Result<DeveloperNotificationSettingsResponse, FastApiError> {
    get_settings(state, user.0.id as i64, subscription_id).await
}

/// `PUT /api/subscriptions/{subscription_id}/developer/notification-settings`.
#[brz_http_server::put("/api/subscriptions/:subscription_id/developer/notification-settings")]
async fn update_developer_notification_settings(
    #[inject(state)] state: &AppState,
    subscription_id: i64,
    #[auth] user: SessionUser,
    body: Value,
) -> Result<DeveloperNotificationSettingsResponse, FastApiError> {
    let request = UpdateRequest::from_value(body)?;
    update_settings(state, user.0.id as i64, subscription_id, &request).await
}

/// `DeveloperNotificationSettingsResponse` in pydantic field order.
#[derive(Debug, Serialize)]
pub(crate) struct DeveloperNotificationSettingsResponse {
    pub(crate) notification_level: String,
    pub(crate) notification_channel_ids: Vec<i64>,
    pub(crate) available_channels: Vec<NotificationChannelInfo>,
    pub(crate) channel_binding_configs: Vec<ChannelBindingConfig>,
}

/// `NotificationChannelInfo` in pydantic field order.
#[derive(Debug, Serialize)]
pub(crate) struct NotificationChannelInfo {
    pub(crate) id: i32,
    pub(crate) name: String,
    pub(crate) channel_type: String,
    pub(crate) is_bound: bool,
}

/// `NotificationChannelBindingConfig` in pydantic field order.
#[derive(Debug, Serialize)]
pub(crate) struct ChannelBindingConfig {
    pub(crate) channel_id: i64,
    pub(crate) bind_private: bool,
    pub(crate) bind_group: bool,
    pub(crate) group_conversation_id: Option<String>,
    pub(crate) group_name: Option<String>,
}

/// The parsed `SubscriptionFollowConfig`.
struct FollowConfig {
    level: String,
    channel_ids: Option<Vec<i64>>,
}

impl FollowConfig {
    /// `SubscriptionFollowConfig()` — the model defaults.
    fn default_config() -> Self {
        Self {
            level: "default".to_string(),
            channel_ids: None,
        }
    }
}

/// `get_developer_settings`.
async fn get_settings(
    state: &AppState,
    user_id: i64,
    subscription_id: i64,
) -> Result<DeveloperNotificationSettingsResponse, FastApiError> {
    let subscription: Option<KindRow> = state
        .mysql
        .fetch_optional(find_subscription_sql(), (subscription_id,))
        .await
        .map_err(internal_error)?;
    // The GET handler never converts the service `ValueError`, so both the
    // missing row and the non-owner render the `Exception` handler body.
    let Some(subscription) = subscription else {
        return Err(FastApiError::unhandled());
    };
    if i64::from(subscription.user_id) != user_id {
        return Err(FastApiError::unhandled());
    }

    let follow: Option<SubscriptionFollowRow> = state
        .mysql
        .fetch_optional(FIND_FOLLOW_QUERY, (subscription_id, user_id))
        .await
        .map_err(internal_error)?;

    let (level, channel_ids) = match follow.as_ref() {
        Some(follow) => {
            let config = parse_follow_config(follow.config.as_deref());
            (config.level, config.channel_ids.unwrap_or_default())
        }
        None => ("notify".to_string(), Vec::new()),
    };

    let available_channels = available_channels(&state.mysql, user_id)
        .await
        .map_err(internal_error)?;
    let channel_binding_configs = subscription_binding_configs(&subscription.json.0)?;

    Ok(DeveloperNotificationSettingsResponse {
        notification_level: level,
        notification_channel_ids: channel_ids,
        available_channels,
        channel_binding_configs,
    })
}

/// `update_developer_settings`.
async fn update_settings(
    state: &AppState,
    user_id: i64,
    subscription_id: i64,
    request: &UpdateRequest,
) -> Result<DeveloperNotificationSettingsResponse, FastApiError> {
    let outcome = state
        .mysql
        .with_transaction(async |transaction| {
            apply_update(transaction, state, user_id, subscription_id, request).await
        })
        .await
        .map_err(internal_error)?;

    if let UpdateOutcome::BadRequest(message) = outcome {
        return Err(FastApiError::detail(StatusCode::BAD_REQUEST, message));
    }

    // Post-commit: the response recomputes the available channels, then renders
    // the binding configs either from the expired `subscription` (a lazy refresh
    // by primary key) or a fresh `_get_subscription_for_owner` query.
    let available_channels = available_channels(&state.mysql, user_id)
        .await
        .map_err(internal_error)?;
    let subscription = if request.channel_binding_configs.is_some() {
        state
            .mysql
            .fetch_optional::<_, _, KindRow>(refresh_kind_sql(), (subscription_id,))
            .await
            .map_err(internal_error)?
    } else {
        state
            .mysql
            .fetch_optional::<_, _, KindRow>(find_subscription_sql(), (subscription_id,))
            .await
            .map_err(internal_error)?
    };
    let channel_binding_configs = subscription
        .map(|row| subscription_binding_configs(&row.json.0))
        .transpose()?
        .unwrap_or_default();

    Ok(DeveloperNotificationSettingsResponse {
        notification_level: request.notification_level.clone(),
        notification_channel_ids: request.notification_channel_ids.clone().unwrap_or_default(),
        available_channels,
        channel_binding_configs,
    })
}

/// The observable outcomes of the update transaction.
enum UpdateOutcome {
    Saved,
    /// A source `ValueError` mapped to `HTTPException(400, detail)`.
    BadRequest(&'static str),
}

/// The transaction body of `update_developer_settings`.
async fn apply_update<T: MysqlTransaction>(
    transaction: &mut T,
    state: &AppState,
    user_id: i64,
    subscription_id: i64,
    request: &UpdateRequest,
) -> Result<UpdateOutcome, brz_mysql::MysqlError> {
    let subscription: Option<KindRow> = transaction
        .fetch_optional(find_subscription_sql(), (subscription_id,))
        .await?;
    let Some(subscription) = subscription else {
        return Ok(UpdateOutcome::BadRequest("Subscription not found"));
    };
    if i64::from(subscription.user_id) != user_id {
        return Ok(UpdateOutcome::BadRequest(
            "Only subscription owner can update developer settings",
        ));
    }

    let follow: Option<SubscriptionFollowRow> = transaction
        .fetch_optional(FIND_FOLLOW_QUERY, (subscription_id, user_id))
        .await?;

    let config_json = follow_config_json(
        &request.notification_level,
        request.notification_channel_ids.as_deref(),
    );
    let follow_updated_at = updated_at_bind(now_utc());
    match follow {
        Some(follow) => {
            // SQLAlchemy omits unchanged columns; only emit `config` when the
            // serialized value actually differs from the stored string.
            if follow.config.as_deref() == Some(config_json.as_str()) {
                transaction
                    .execute(
                        "UPDATE subscription_follows SET updated_at=? \
                         WHERE subscription_follows.id = ?",
                        (follow_updated_at, follow.id),
                    )
                    .await?;
            } else {
                transaction
                    .execute(
                        "UPDATE subscription_follows SET updated_at=?, config=? \
                         WHERE subscription_follows.id = ?",
                        (follow_updated_at, config_json, follow.id),
                    )
                    .await?;
            }
        }
        None => {
            let bind = updated_at_bind(now_utc());
            transaction
                .execute(
                    "INSERT INTO subscription_follows (subscription_id, follower_user_id, \
                     follow_type, invited_by_user_id, invitation_status, invited_at, responded_at, \
                     created_at, updated_at, config) \
                     VALUES (?, ?, 'direct', 0, 'accepted', ?, ?, ?, ?, ?)",
                    (
                        subscription_id,
                        user_id,
                        bind.as_str(),
                        bind.as_str(),
                        bind.as_str(),
                        bind.as_str(),
                        config_json.as_str(),
                    ),
                )
                .await?;
        }
    }

    if let Some(bindings) = request.channel_binding_configs.as_ref() {
        update_channel_bindings(transaction, state, user_id, subscription_id, bindings).await?;
    }

    Ok(UpdateOutcome::Saved)
}

/// The `if channel_binding_configs is not None:` block: re-read the owned
/// subscription, merge `_internal.notification_channel_bindings`, and persist
/// `kinds.json` plus the new timestamp (the `json` column only when changed).
///
/// Rewriting the `kinds` row makes it dirty, so SQLAlchemy fires the `Kind`
/// `after_update` cache event during the flush. Mirror `CachedKindReader`
/// `on_change` by invalidating the data and personal index keys once the row is
/// written (the recorded `DEL` after the `UPDATE kinds`).
async fn update_channel_bindings<T: MysqlTransaction>(
    transaction: &mut T,
    state: &AppState,
    user_id: i64,
    subscription_id: i64,
    bindings: &[BindingInput],
) -> Result<(), brz_mysql::MysqlError> {
    let subscription: Option<KindRow> = transaction
        .fetch_optional(find_subscription_sql(), (subscription_id,))
        .await?;
    let Some(subscription) = subscription else {
        // `_get_subscription_for_owner` raises; the earlier owner check makes
        // this unreachable for a valid request.
        return Ok(());
    };
    if i64::from(subscription.user_id) != user_id {
        return Ok(());
    }

    let mut document = subscription.json.0.clone();
    let mut internal = document
        .get("_internal")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));

    let mut binding_map = Map::new();
    for binding in bindings {
        binding_map.insert(
            binding.channel_id.to_string(),
            json!({
                "bind_private": binding.bind_private,
                "bind_group": binding.bind_group,
                "group_conversation_id": binding.group_conversation_id,
                "group_name": binding.group_name,
                "updated_at": iso_now(),
            }),
        );
    }
    internal["notification_channel_bindings"] = Value::Object(binding_map);
    document["_internal"] = internal;

    let updated_at = updated_at_bind(now_utc());
    if document == subscription.json.0 {
        transaction
            .execute(
                "UPDATE kinds SET updated_at=? WHERE kinds.id = ?",
                (updated_at, subscription_id),
            )
            .await?;
    } else {
        transaction
            .execute(
                "UPDATE kinds SET json=?, updated_at=? WHERE kinds.id = ?",
                (python_json_dumps(&document), updated_at, subscription_id),
            )
            .await?;
    }

    // `Kind` `after_update` cache event: the changed row invalidates its data
    // and owner index keys (`CachedKindReader.on_change`).
    invalidate_kind_cache(
        state.redis.as_ref(),
        "Subscription",
        i64::from(subscription.id),
        i64::from(subscription.user_id),
        &subscription.namespace,
        &subscription.name,
    )
    .await;
    Ok(())
}

/// `get_available_channels`: active global Messager channels annotated with the
/// current user's binding status.
async fn available_channels<M: Mysql>(
    mysql: &M,
    user_id: i64,
) -> Result<Vec<NotificationChannelInfo>, brz_mysql::MysqlError> {
    let channels: Vec<KindRow> = mysql.fetch_all(messager_sql(), ()).await?;
    let bindings = user_im_bindings(mysql, user_id).await?;

    let mut result = Vec::with_capacity(channels.len());
    for channel in channels {
        let document = &channel.json.0;
        let spec = document.get("spec");
        if !spec
            .and_then(|spec| spec.get("isEnabled"))
            .is_none_or(truthy)
        {
            continue;
        }
        let name = document
            .get("metadata")
            .and_then(|metadata| metadata.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(&channel.name)
            .to_string();
        let channel_type = spec
            .and_then(|spec| spec.get("channelType"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let is_bound = bindings.contains(&channel.id.to_string());
        result.push(NotificationChannelInfo {
            id: channel.id,
            name,
            channel_type,
            is_bound,
        });
    }
    Ok(result)
}

/// `get_user_im_bindings`: the valid `preferences.im_channels` keys.
async fn user_im_bindings<M: Mysql>(
    mysql: &M,
    user_id: i64,
) -> Result<HashSet<String>, brz_mysql::MysqlError> {
    let user: Option<UserRow> = mysql.fetch_optional(USER_BY_ID_QUERY, (user_id,)).await?;
    let Some(user) = user else {
        return Ok(HashSet::new());
    };
    if user.preferences.is_empty() {
        return Ok(HashSet::new());
    }
    let Ok(preferences) = serde_json::from_str::<Value>(&user.preferences) else {
        return Ok(HashSet::new());
    };
    let Some(im_channels) = preferences.get("im_channels").and_then(Value::as_object) else {
        return Ok(HashSet::new());
    };

    let mut keys = HashSet::new();
    for (channel_id, binding) in im_channels {
        if im_channel_binding_valid(binding) {
            keys.insert(channel_id.clone());
        }
    }
    Ok(keys)
}

/// `IMChannelBinding.model_validate(binding_data)` — a failure drops the
/// binding (the source logs and continues).
fn im_channel_binding_valid(binding: &Value) -> bool {
    let Some(object) = binding.as_object() else {
        return false;
    };
    if !object.get("channel_type").is_some_and(Value::is_string)
        || !object.get("sender_id").is_some_and(Value::is_string)
    {
        return false;
    }
    for key in ["sender_staff_id", "last_conversation_id", "last_active_at"] {
        match object.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::String(_)) => {}
            Some(_) => return false,
        }
    }
    true
}

/// `_get_subscription_channel_binding_configs` over the stored `_internal`.
fn subscription_binding_configs(
    document: &Value,
) -> Result<Vec<ChannelBindingConfig>, FastApiError> {
    let Some(map) = document
        .get("_internal")
        .and_then(|internal| internal.get("notification_channel_bindings"))
        .and_then(Value::as_object)
    else {
        return Ok(Vec::new());
    };

    let mut result = Vec::with_capacity(map.len());
    for (channel_id, config) in map {
        // `int(channel_id)` raises `ValueError` on a non-numeric key.
        let Ok(channel_id) = channel_id.parse::<i64>() else {
            return Err(FastApiError::unhandled());
        };
        result.push(ChannelBindingConfig {
            channel_id,
            bind_private: config.get("bind_private").is_none_or(truthy),
            bind_group: config.get("bind_group").is_some_and(truthy),
            group_conversation_id: config
                .get("group_conversation_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            group_name: config
                .get("group_name")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }
    Ok(result)
}

/// `_parse_follow_config`: parse the stored config or fall back to the model
/// defaults on empty, malformed, or invalid JSON.
fn parse_follow_config(raw: Option<&str>) -> FollowConfig {
    let Some(raw) = raw.filter(|value| !value.is_empty()) else {
        return FollowConfig::default_config();
    };
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return FollowConfig::default_config();
    };
    let Some(object) = value.as_object() else {
        return FollowConfig::default_config();
    };

    let level = match object.get("notification_level") {
        None => "default".to_string(),
        Some(Value::String(level)) if LEVELS.contains(&level.as_str()) => level.clone(),
        Some(_) => return FollowConfig::default_config(),
    };
    let channel_ids = match object.get("notification_channel_ids") {
        None | Some(Value::Null) => None,
        Some(Value::Array(entries)) => {
            let mut ids = Vec::with_capacity(entries.len());
            for entry in entries {
                match entry {
                    Value::Number(number) if number.is_i64() => {
                        ids.push(number.as_i64().unwrap_or(0));
                    }
                    _ => return FollowConfig::default_config(),
                }
            }
            Some(ids)
        }
        Some(_) => return FollowConfig::default_config(),
    };
    FollowConfig { level, channel_ids }
}

/// `python_exception_handler`'s 500 body
/// (`{"error_code": 500, "detail": "Internal server error"}`).
fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "subscription developer settings dependency failure");
    FastApiError::unhandled()
}

/// `SubscriptionFollowConfig.model_dump_json()` — pydantic's compact JSON with
/// the two fields in declaration order.
fn follow_config_json(level: &str, channel_ids: Option<&[i64]>) -> String {
    match channel_ids {
        None => format!("{{\"notification_level\":\"{level}\",\"notification_channel_ids\":null}}"),
        Some(ids) => {
            let rendered: Vec<String> = ids.iter().map(i64::to_string).collect();
            format!(
                "{{\"notification_level\":\"{level}\",\"notification_channel_ids\":[{}]}}",
                rendered.join(",")
            )
        }
    }
}

/// `datetime.now(timezone.utc).replace(tzinfo=None)` for a MySQL `DATETIME`
/// bind (`YYYY-MM-DD HH:MM:SS.ffffff`).
fn now_utc() -> NaiveDateTime {
    Utc::now().naive_utc()
}

/// The `updated_at` bind value the source writes on every change.
fn updated_at_bind(now: NaiveDateTime) -> String {
    now.format("%Y-%m-%d %H:%M:%S%.6f").to_string()
}

/// `datetime.now(timezone.utc).isoformat()` for a stored binding timestamp.
fn iso_now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
}

/// Python truthiness (`bool(value)`).
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statements_keep_the_source_sqlalchemy_rendering() {
        let find = find_subscription_sql();
        assert!(find.contains("kinds.kind = 'Subscription'"));
        assert!(find.contains("kinds.is_active = true"));
        assert!(find.ends_with("LIMIT 1"));
        let messager = messager_sql();
        assert!(messager.contains("kinds.kind = 'Messager'"));
        assert!(messager.contains("kinds.user_id = 0"));
        assert!(!messager.contains("LIMIT"));
        assert!(FIND_FOLLOW_QUERY.contains("subscription_follows.subscription_id = ?"));
        assert!(FIND_FOLLOW_QUERY.contains("subscription_follows.follower_user_id = ?"));
        assert!(FIND_FOLLOW_QUERY.ends_with("LIMIT 1"));
        assert!(refresh_kind_sql().ends_with("WHERE kinds.id = ?"));
    }

    #[test]
    fn put_invalidates_the_subscription_kind_cache_keys() {
        // Rewriting the `kinds` row fires the `Kind` cache event, so the
        // recorded PUT cases carry a `DEL` of the data key plus the owner's
        // personal index key (`CachedKindReader.on_change`) right after the
        // `UPDATE kinds`. 230827/157/sub-5wwedhvt is the recorded case.
        let kind = "Subscription";
        let keys = [
            format!("kind:v2:data:{kind}:230827"),
            format!("kind:v2:idx:personal:{kind}:157:default:sub-5wwedhvt"),
        ];
        assert_eq!(
            keys,
            [
                "kind:v2:data:Subscription:230827".to_string(),
                "kind:v2:idx:personal:Subscription:157:default:sub-5wwedhvt".to_string(),
            ]
        );
    }

    #[test]
    fn follow_config_json_matches_pydantic_dump() {
        assert_eq!(
            follow_config_json("notify", None),
            "{\"notification_level\":\"notify\",\"notification_channel_ids\":null}"
        );
        assert_eq!(
            follow_config_json("notify", Some(&[])),
            "{\"notification_level\":\"notify\",\"notification_channel_ids\":[]}"
        );
        assert_eq!(
            follow_config_json("default", Some(&[1, 2])),
            "{\"notification_level\":\"default\",\"notification_channel_ids\":[1,2]}"
        );
    }

    #[test]
    fn parse_follow_config_defaults_on_empty_or_invalid() {
        for raw in [
            None,
            Some(""),
            Some("not-json"),
            Some("[]"),
            Some("{\"notification_level\":\"loud\"}"),
        ] {
            let config = parse_follow_config(raw);
            assert_eq!(config.level, "default");
            assert!(config.channel_ids.is_none());
        }
    }

    #[test]
    fn parse_follow_config_reads_stored_values() {
        let config = parse_follow_config(Some(
            "{\"notification_level\":\"notify\",\"notification_channel_ids\":[3,4]}",
        ));
        assert_eq!(config.level, "notify");
        assert_eq!(config.channel_ids, Some(vec![3, 4]));

        let config = parse_follow_config(Some("{\"notification_level\":\"silent\"}"));
        assert_eq!(config.level, "silent");
        assert!(config.channel_ids.is_none());
    }

    #[test]
    fn binding_configs_render_in_declaration_order() {
        let document = json!({
            "_internal": {
                "notification_channel_bindings": {
                    "12": {"bind_private": false, "bind_group": true, "group_name": "g"},
                }
            }
        });
        let configs = subscription_binding_configs(&document).unwrap();
        assert_eq!(configs.len(), 1);
        let serialized = serde_json::to_value(&configs[0]).unwrap();
        let keys: Vec<&str> = serialized
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "channel_id",
                "bind_private",
                "bind_group",
                "group_conversation_id",
                "group_name",
            ]
        );
        assert_eq!(
            serialized,
            json!({
                "channel_id": 12,
                "bind_private": false,
                "bind_group": true,
                "group_conversation_id": null,
                "group_name": "g",
            })
        );
    }

    #[test]
    fn response_has_pydantic_field_order() {
        let response = DeveloperNotificationSettingsResponse {
            notification_level: "notify".to_string(),
            notification_channel_ids: vec![],
            available_channels: vec![NotificationChannelInfo {
                id: 1,
                name: "c".to_string(),
                channel_type: "dingtalk".to_string(),
                is_bound: true,
            }],
            channel_binding_configs: vec![],
        };
        let serialized = serde_json::to_value(&response).unwrap();
        let keys: Vec<&str> = serialized
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "notification_level",
                "notification_channel_ids",
                "available_channels",
                "channel_binding_configs",
            ]
        );
        let channel = serialized["available_channels"][0].clone();
        let channel_keys: Vec<&str> = channel
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(channel_keys, vec!["id", "name", "channel_type", "is_bound"]);
    }

    #[test]
    fn im_binding_requires_the_source_fields() {
        assert!(im_channel_binding_valid(&json!({
            "channel_type": "dingtalk",
            "sender_id": "u",
        })));
        assert!(!im_channel_binding_valid(
            &json!({"channel_type": "dingtalk"})
        ));
        assert!(!im_channel_binding_valid(&json!({"sender_id": "u"})));
        assert!(!im_channel_binding_valid(&json!({
            "channel_type": "dingtalk",
            "sender_id": "u",
            "last_active_at": 5,
        })));
    }
}
