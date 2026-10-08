// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Available notification channels for `GET /api/users/me/available-channels`.
//!
//! Mirrors `app.api.endpoints.users.get_user_available_channels`, which calls
//! `subscription_notification_service.get_available_channels`. The request
//! authenticates the bearer token (`get_current_user` loads the active `users`
//! row by name), lists every active system `Messager` `Kind`
//! (`kind = 'Messager' AND user_id = 0 AND is_active = true`, in the database's
//! natural order because the source has no `ORDER BY`), loads the caller's
//! `preferences.im_channels` bindings (`get_user_im_bindings`), and renders
//! `list[NotificationChannelInfo]` in the pydantic model's field order:
//! `id`, `name`, `channel_type`, `is_bound`. A channel whose `spec.isEnabled`
//! is false is skipped.
use std::collections::HashSet;

use brz_mysql::{FromMysqlRow, Json};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::auth::{SessionUser, UserRow};
use crate::http_compat::FastApiError;
use crate::json_compat::JsonProjection;
use crate::state::AppState;
use crate::user_reader::USER_BY_ID_QUERY;

/// A `Messager` `kinds` row selected with the full labeled source column list
/// (`db.query(Kind)`); only `id`, `name`, and `json` are consumed.
#[derive(Debug, FromMysqlRow)]
struct MessagerKindRow {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_user_id")]
    user_id: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_kind")]
    kind: String,
    #[mysql(rename = "kinds_name")]
    name: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_namespace")]
    namespace: String,
    #[mysql(rename = "kinds_json")]
    json: Json<JsonProjection<MessagerInput>>,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_is_active")]
    is_active: i8,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_created_at")]
    created_at: chrono::NaiveDateTime,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_updated_at")]
    updated_at: chrono::NaiveDateTime,
}

/// The source listing query (`db.query(Kind).filter(Kind.kind == MESSAGER_KIND,
/// Kind.user_id == MESSAGER_USER_ID, Kind.is_active == True)`): every active
/// system `Messager` row. All filter values are source constants and therefore
/// inline; the statement runs with no bind parameters and no `ORDER BY`, so the
/// rows keep the database's natural order like the source iteration.
const MESSAGER_CHANNELS_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at \nFROM kinds \nWHERE kinds.kind = 'Messager' \
     AND kinds.user_id = 0 AND kinds.is_active = true";

/// The `Messager` CRD document (`kinds.json`) fields the response consumes.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct MessagerInput {
    spec: Option<MessagerSpec>,
    metadata: Option<MessagerMetadata>,
}

/// `Messager` `spec` fields the response consumes.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct MessagerSpec {
    #[serde(rename = "channelType")]
    channel_type: Option<String>,
    #[serde(rename = "isEnabled")]
    is_enabled: Option<bool>,
}

/// The CRD `metadata` object.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct MessagerMetadata {
    name: Option<String>,
}

/// `NotificationChannelInfo` (`app.schemas.subscription`) in pydantic field
/// declaration order.
#[derive(Debug, Serialize)]
struct NotificationChannelInfo {
    id: i64,
    name: String,
    channel_type: String,
    is_bound: bool,
}

/// `get_user_im_bindings`: the channel-id strings whose stored
/// `preferences.im_channels` entry validates as an `IMChannelBinding`. A blank
/// preference, invalid JSON, or a missing `im_channels` object yields an empty
/// set; an entry that fails validation is dropped.
fn bound_channel_ids(preferences: &str) -> HashSet<String> {
    if preferences.is_empty() {
        return HashSet::new();
    }
    let Ok(preferences) = serde_json::from_str::<Value>(preferences) else {
        return HashSet::new();
    };
    let Some(im_channels) = preferences.get("im_channels").and_then(Value::as_object) else {
        return HashSet::new();
    };
    im_channels
        .iter()
        .filter(|(_, binding)| is_valid_binding(binding))
        .map(|(channel_id, _)| channel_id.clone())
        .collect()
}

/// `IMChannelBinding.model_validate`: `channel_type` and `sender_id` are
/// required strings; every other key is optional.
fn is_valid_binding(binding: &Value) -> bool {
    let Some(object) = binding.as_object() else {
        return false;
    };
    object.get("channel_type").is_some_and(Value::is_string)
        && object.get("sender_id").is_some_and(Value::is_string)
}

/// The `spec` of a row, or the empty default when the CRD is absent or of the
/// wrong shape (`channel.json.get("spec", {})`).
fn spec_of(row: &MessagerKindRow) -> MessagerSpec {
    row.json
        .0
        .value
        .as_ref()
        .and_then(|input| input.spec.as_ref())
        .map(|spec| MessagerSpec {
            channel_type: spec.channel_type.clone(),
            is_enabled: spec.is_enabled,
        })
        .unwrap_or_default()
}

/// The channel display name: the CRD `metadata.name` when present, otherwise
/// the `kinds.name` column.
fn channel_name(row: &MessagerKindRow) -> String {
    row.json
        .0
        .value
        .as_ref()
        .and_then(|input| input.metadata.as_ref())
        .and_then(|metadata| metadata.name.clone())
        .unwrap_or_else(|| row.name.clone())
}

/// `get_available_channels`: render every enabled channel with its binding
/// status.
fn render_channels(
    rows: &[MessagerKindRow],
    bound: &HashSet<String>,
) -> Vec<NotificationChannelInfo> {
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let spec = spec_of(row);
        // `if not spec.get("isEnabled", True): continue`
        if spec.is_enabled == Some(false) {
            continue;
        }
        result.push(NotificationChannelInfo {
            id: row.id,
            name: channel_name(row),
            channel_type: spec.channel_type.unwrap_or_else(|| "unknown".to_owned()),
            is_bound: bound.contains(&row.id.to_string()),
        });
    }
    result
}

/// GET /api/users/me/available-channels: the available-channels free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/users/me/available-channels")]
async fn get_user_available_channels(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
) -> Result<Vec<NotificationChannelInfo>, FastApiError> {
    available_channels(state, current_user.0).await
}

/// Handler body for `GET /api/users/me/available-channels`.
async fn available_channels(
    state: &AppState,
    current_user: UserRow,
) -> Result<Vec<NotificationChannelInfo>, FastApiError> {
    let channels: Vec<MessagerKindRow> = state
        .mysql
        .fetch_all(MESSAGER_CHANNELS_QUERY, ())
        .await
        .map_err(|error| {
        tracing::error!(%error, "available-channels kinds database dependency failure");
        FastApiError::unhandled()
    })?;

    // `get_user_im_bindings`: a missing user or an unparsable preference yields
    // no bindings.
    let user: Option<UserRow> = state
        .mysql
        .fetch_optional(USER_BY_ID_QUERY, (i64::from(current_user.id),))
        .await
        .map_err(|error| {
            tracing::error!(%error, "available-channels user database dependency failure");
            FastApiError::unhandled()
        })?;
    let bound = user.map_or_else(HashSet::new, |user| bound_channel_ids(&user.preferences));

    Ok(render_channels(&channels, &bound))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(id: i64, name: &str, json: Value) -> MessagerKindRow {
        MessagerKindRow {
            id,
            user_id: 0,
            kind: "Messager".to_string(),
            name: name.to_string(),
            namespace: "default".to_string(),
            json: Json(JsonProjection::from(json)),
            is_active: 1,
            created_at: chrono::NaiveDate::from_ymd_opt(2026, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            updated_at: chrono::NaiveDate::from_ymd_opt(2026, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
        }
    }

    fn messager(name: &str, channel_type: &str, enabled: bool) -> Value {
        json!({
            "kind": "Messager",
            "spec": {"isEnabled": enabled, "channelType": channel_type},
            "metadata": {"name": name, "namespace": "default"},
        })
    }

    #[test]
    fn channels_query_matches_the_source_projection() {
        // Every mapped column keeps its SQLAlchemy label; the statement runs
        // with no bind parameter and no `ORDER BY`.
        for label in [
            "kinds_id",
            "kinds_user_id",
            "kinds_kind",
            "kinds_name",
            "kinds_namespace",
            "kinds_json",
            "kinds_is_active",
            "kinds_created_at",
            "kinds_updated_at",
        ] {
            assert!(MESSAGER_CHANNELS_QUERY.contains(label), "missing {label}");
        }
        assert!(!MESSAGER_CHANNELS_QUERY.contains('?'));
        assert!(!MESSAGER_CHANNELS_QUERY.contains("ORDER BY"));
        assert!(MESSAGER_CHANNELS_QUERY.contains(
            "WHERE kinds.kind = 'Messager' AND kinds.user_id = 0 AND kinds.is_active = true"
        ));
    }

    #[test]
    fn renders_channels_in_pydantic_field_order() {
        // Arrange
        let rows = vec![
            row(101, "alpha", messager("alpha", "dingtalk", true)),
            row(202, "beta", messager("beta", "feishu", true)),
        ];
        let bound = HashSet::from(["101".to_string()]);

        // Act
        let rendered = serde_json::to_string(&render_channels(&rows, &bound)).unwrap();

        // Assert
        assert_eq!(
            rendered,
            "[{\"id\":101,\"name\":\"alpha\",\"channel_type\":\"dingtalk\",\"is_bound\":true},\
             {\"id\":202,\"name\":\"beta\",\"channel_type\":\"feishu\",\"is_bound\":false}]"
        );
    }

    #[test]
    fn skips_disabled_channels_and_defaults_missing_spec_fields() {
        // Arrange: a disabled channel, one without a spec, and one whose only
        // spec field is a channel type.
        let rows = vec![
            row(1, "disabled", messager("disabled", "dingtalk", false)),
            row(2, "bare", json!({"kind": "Messager"})),
            row(3, "typed", json!({"spec": {"channelType": "feishu"}})),
        ];

        // Act
        let rendered = serde_json::to_string(&render_channels(&rows, &HashSet::new())).unwrap();

        // Assert: a missing `isEnabled` keeps the channel; a missing
        // `channelType` renders the source default `unknown`.
        assert_eq!(
            rendered,
            "[{\"id\":2,\"name\":\"bare\",\"channel_type\":\"unknown\",\"is_bound\":false},\
             {\"id\":3,\"name\":\"typed\",\"channel_type\":\"feishu\",\"is_bound\":false}]"
        );
    }

    #[test]
    fn name_falls_back_to_the_kinds_column_without_metadata() {
        // Arrange: the CRD carries no `metadata.name`.
        let rows = vec![row(
            7,
            "column-name",
            json!({"spec": {"channelType": "dingtalk"}}),
        )];

        // Act / Assert
        let rendered = render_channels(&rows, &HashSet::new());
        assert_eq!(rendered[0].name, "column-name");
    }

    #[test]
    fn bindings_require_string_channel_type_and_sender_id() {
        // Arrange
        let preferences = json!({
            "im_channels": {
                "1": {"channel_type": "dingtalk", "sender_id": "s-1"},
                "2": {"channel_type": "dingtalk"},
                "3": {"sender_id": "s-3"},
                "4": {"channel_type": 7, "sender_id": "s-4"},
                "5": "not-an-object",
            },
            "send_key": "enter",
        })
        .to_string();

        // Act
        let bound = bound_channel_ids(&preferences);

        // Assert
        assert_eq!(bound, HashSet::from(["1".to_string()]));
    }

    #[test]
    fn missing_or_invalid_preferences_yield_no_bindings() {
        assert!(bound_channel_ids("").is_empty());
        assert!(bound_channel_ids("{not json").is_empty());
        assert!(bound_channel_ids("{}").is_empty());
        assert!(bound_channel_ids(r#"{"im_channels": []}"#).is_empty());
    }
}
