// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/im-channels/{channel_id}/status`: the connection status of
//! one admin-managed IM channel.
//!
//! Mirrors `app.api.endpoints.admin.im_channels.get_im_channel_status`
//! (included by `app.api.endpoints.admin.router` under the `/admin` mount in
//! `app.api.api`):
//!
//! 1. `get_admin_user` (`app.core.security`) reuses the session principal and
//!    rejects any non-`admin` `role` with
//!    `403 {"detail": "Permission denied. Admin access required."}`;
//! 2. the active system `Messager` CRD is loaded with
//!    `db.query(Kind).filter(Kind.id == channel_id, Kind.kind == "Messager",
//!    Kind.user_id == 0, Kind.is_active == True).first()`; a miss raises
//!    `404 {"detail": "IM channel with id <id> not found"}`;
//! 3. `IMChannelStatus` (`app.schemas.im_channel`) is rendered from the row's
//!    `spec.channelType` (default `dingtalk`) and `spec.isEnabled` (default
//!    `true`) plus the process-local `ChannelManager.get_status`.
//!
//! The `ChannelManager` (`app.services.channels.manager`) is an in-process
//! registry that only holds providers this process started. The migrated
//! backend does not start IM channel providers, so `get_status(channel_id)`
//! always misses and the endpoint renders the source's not-running branch:
//! `is_connected = false`, `last_error = "Channel not running"`,
//! `uptime_seconds = null`, and `extra_info = null`. That is exactly the
//! recorded source response for the same channel.

use brz_http_server::StatusCode;
use brz_mysql::Json;

use crate::auth::{SessionUser, UserRow};
use crate::http_compat::FastApiError;
use crate::json_compat::JsonProjection;
use crate::state::AppState;

/// `MESSAGER_USER_ID` (`app.api.endpoints.admin.im_channels`): system-level
/// Messager CRDs are owned by user `0`.
const MESSAGER_USER_ID: i32 = 0;

/// `spec.channelType` default when the stored spec omits it.
const DEFAULT_CHANNEL_TYPE: &str = "dingtalk";

/// `get_admin_user`'s rejection detail for a non-admin session.
const ADMIN_REQUIRED: &str = "Permission denied. Admin access required.";

/// `IMChannelStatus.last_error` when the channel has no running provider.
const CHANNEL_NOT_RUNNING: &str = "Channel not running";

/// `db.query(Kind).filter(...).first()` for the status route: the full
/// SQLAlchemy labeled projection (`kinds.<column> AS kinds_<column>`) with the
/// source filter order (`id`, `kind`, `user_id`, `is_active`) and `LIMIT 1`.
const CHANNEL_STATUS_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at \n\
     FROM kinds \n\
     WHERE kinds.id = ? AND kinds.kind = 'Messager' AND kinds.user_id = ? \
     AND kinds.is_active = true \n LIMIT 1";

/// The active system `Messager` CRD row (`kinds` table). Only `id`, `name`, and
/// `json` are consumed; the remaining labeled columns are selected to match the
/// recorded SQLAlchemy projection.
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct MessagerKindRow {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[mysql(rename = "kinds_name")]
    name: String,
    #[mysql(rename = "kinds_json")]
    json: Json<JsonProjection<MessagerDocument>>,
}

/// The stored CRD document with the status route's `spec` projection.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct MessagerDocument {
    spec: Option<MessagerSpec>,
}

/// `spec.channelType` and `spec.isEnabled`, the only spec fields the status
/// route reads.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct MessagerSpec {
    #[serde(rename = "channelType")]
    channel_type: Option<String>,
    #[serde(rename = "isEnabled")]
    is_enabled: Option<bool>,
}

/// `IMChannelStatus` (`app.schemas.im_channel`): the connection-status body.
/// Every optional field is emitted, matching FastAPI's `response_model`
/// serialization of an unset `Optional`.
#[derive(Debug, serde::Serialize)]
struct ImChannelStatus {
    id: i64,
    name: String,
    channel_type: String,
    is_enabled: bool,
    is_connected: bool,
    last_error: Option<String>,
    uptime_seconds: Option<f64>,
    extra_info: Option<serde_json::Value>,
}

/// GET /api/admin/im-channels/{channel_id}/status: the status free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/admin/im-channels/:channel_id/status")]
async fn get_im_channel_status(
    #[inject(state)] state: &AppState,
    channel_id: i64,
    #[auth] user: SessionUser,
) -> Result<ImChannelStatus, FastApiError> {
    channel_status(state, user.0, channel_id).await
}

/// Handler body for `GET /api/admin/im-channels/{channel_id}/status`.
async fn channel_status(
    state: &AppState,
    user: UserRow,
    channel_id: i64,
) -> Result<ImChannelStatus, FastApiError> {
    // `get_admin_user` dependency runs before the handler body, so a non-admin
    // session is rejected before the channel lookup.
    require_admin(&user)?;

    let row: Option<MessagerKindRow> = state
        .mysql
        .fetch_optional(CHANNEL_STATUS_QUERY, (channel_id, MESSAGER_USER_ID))
        .await
        .map_err(database_error)?;

    let Some(row) = row else {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            format!("IM channel with id {channel_id} not found"),
        ));
    };

    Ok(status_response(&row))
}

/// `get_admin_user`: the session's `role` must be `admin`.
fn require_admin(user: &UserRow) -> Result<(), FastApiError> {
    if user.role != "admin" {
        return Err(FastApiError::forbidden(ADMIN_REQUIRED));
    }
    Ok(())
}

/// `IMChannelStatus` for a channel with no running provider.
fn status_response(row: &MessagerKindRow) -> ImChannelStatus {
    let spec = row
        .json
        .0
        .value
        .as_ref()
        .and_then(|document| document.spec.as_ref());
    ImChannelStatus {
        id: row.id,
        name: row.name.clone(),
        channel_type: spec
            .and_then(|spec| spec.channel_type.clone())
            .unwrap_or_else(|| DEFAULT_CHANNEL_TYPE.to_string()),
        is_enabled: spec.and_then(|spec| spec.is_enabled).unwrap_or(true),
        is_connected: false,
        last_error: Some(CHANNEL_NOT_RUNNING.to_string()),
        uptime_seconds: None,
        extra_info: None,
    }
}

/// Unexpected database failure: the source endpoint does not convert it, so it
/// reaches the application's `Exception` handler
/// (`app/core/exceptions.py:python_exception_handler`).
fn database_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "im-channel status database dependency failure");
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(spec: serde_json::Value) -> MessagerKindRow {
        MessagerKindRow {
            id: 1001,
            name: "dingtalk-example-inner".to_string(),
            json: Json(JsonProjection::<MessagerDocument>::from_json(
                &json!({ "spec": spec }),
            )),
        }
    }

    fn admin() -> UserRow {
        UserRow {
            id: 157,
            user_name: "example-user".to_string(),
            users_password_hash: "hash".to_string(),
            email: None,
            git_info: Json(crate::json_compat::OpaqueJson::from(json!(null))),
            is_active: 1,
            role: "admin".to_string(),
            auth_source: "local".to_string(),
            preferences: "{}".to_string(),
            created_at: chrono::NaiveDateTime::default(),
            updated_at: chrono::NaiveDateTime::default(),
        }
    }

    #[test]
    fn requires_the_admin_role() {
        let mut user = admin();
        assert!(require_admin(&user).is_ok());
        user.role = "user".to_string();
        let error = require_admin(&user).unwrap_err();
        assert_eq!(error.status(), StatusCode::FORBIDDEN);
        assert_eq!(error.detail_message(), Some(ADMIN_REQUIRED));
    }

    /// The recorded body for the not-running channel: `channelType` and
    /// `isEnabled` come from the stored spec (both present in the record).
    #[test]
    fn status_body_matches_the_recorded_response() {
        let body = status_response(&row(json!({
            "channelType": "dingtalk",
            "isEnabled": true,
        })));
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            "{\"id\":1001,\"name\":\"dingtalk-example-inner\",\
             \"channel_type\":\"dingtalk\",\"is_enabled\":true,\
             \"is_connected\":false,\"last_error\":\"Channel not running\",\
             \"uptime_seconds\":null,\"extra_info\":null}"
        );
    }

    /// A spec that omits the fields falls back to the source defaults.
    #[test]
    fn status_body_applies_the_source_defaults() {
        let body = status_response(&row(json!({})));
        assert_eq!(body.channel_type, DEFAULT_CHANNEL_TYPE);
        assert!(body.is_enabled);
    }

    /// Every `kinds` projection keeps its SQLAlchemy `<table>_<column>` alias
    /// and the source filter order.
    #[test]
    fn statement_keeps_the_source_sqlalchemy_rendering() {
        assert!(
            CHANNEL_STATUS_QUERY.starts_with("SELECT kinds.id AS kinds_id"),
            "{CHANNEL_STATUS_QUERY}"
        );
        assert!(CHANNEL_STATUS_QUERY.contains("kinds.json AS kinds_json"));
        assert!(CHANNEL_STATUS_QUERY.contains("kinds.kind = 'Messager'"));
        assert!(CHANNEL_STATUS_QUERY.contains("kinds.is_active = true"));
        assert!(CHANNEL_STATUS_QUERY.ends_with("LIMIT 1"));
        let filter = CHANNEL_STATUS_QUERY
            .split_once("WHERE ")
            .expect("query has a WHERE clause")
            .1;
        assert!(
            filter.starts_with("kinds.id = ? AND kinds.kind = 'Messager' AND kinds.user_id = ?"),
            "{filter}"
        );
    }
}
