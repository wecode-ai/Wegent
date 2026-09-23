// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/cloud-devices/{device_id}/status`.
//!
//! Mirrors `wecode.api.cloud_devices.get_cloud_device_nevis_status` (router
//! prefix `/cloud-devices`, mounted under the app prefix `/api`):
//!
//! 1. authenticate the bearer token (`app.core.security.get_current_user`);
//! 2. resolve the target owner (`_resolve_target_user_id`): the caller, or
//!    another owner only when the caller's `role` is `admin`;
//! 3. load the device status (`_get_accessible_cloud_device_status` ->
//!    `CloudDeviceProvider.get_status`), rendering its missing-device result as
//!    `404 {"detail": "Cloud device '<id>' not found"}`;
//! 4. resolve the Nevis sandbox id (`_resolve_sandbox_id`);
//! 5. read the sandbox (`CloudDeviceProvider.get_vm_status` ->
//!    `NevisClient.get_sandbox`) and persist the observed address
//!    (`cloud_device_ip_index_service.persist_observation`: the `FOR UPDATE`
//!    reload, the `UPDATE`, and the `db.commit()` of one transaction),
//!    tolerating any failure of the index write;
//! 6. render `NevisSandboxStatus`.
//!
//! `_resolve_target_user_id` is called twice by the source (once inside the
//! access helper and once for the persisted target); it is pure, so the target
//! resolves it once.
use brz_http_server::StatusCode;
use serde::Serialize;

use super::cloud_device_provider::{
    SandboxStatus, device_status, get_vm_status, resolve_sandbox_id,
};
use super::nevis::NevisClientError;
use super::nevis_ip_index::{CloudDeviceIpTarget, normalize_nevis_ip, persist_observation};
use super::startup::SharedWecodeAppState;
use wegent_backend_rs::auth::UserRow;
use wegent_backend_rs::http_compat::FastApiError;

/// `NevisSandboxStatus` (`wecode.schemas.cloud_device`): field order is the
/// model's declaration order, and every optional field serializes as JSON
/// `null` when absent.
#[derive(Debug, Serialize)]
struct NevisSandboxStatus {
    sandbox_id: String,
    status: String,
    ip_address: Option<String>,
    vnc_url: Option<String>,
    created_at: Option<String>,
}

/// GET /api/cloud-devices/{device_id}/status: the endpoint free function,
/// injecting the internal state and its shared public dependencies.
#[brz_http_server::get(
    "/api/cloud-devices/:device_id/status",
    group = crate::wecode::startup::wecode_apis
)]
async fn get_cloud_device_nevis_status(
    #[inject(wecode)] state: &SharedWecodeAppState,
    device_id: String,
    user_id: Option<String>,
    #[auth] user: wegent_backend_rs::auth::SessionUser,
) -> Result<NevisSandboxStatus, FastApiError> {
    let target_user_id = parse_optional_user_id(user_id.as_deref())?;
    cloud_device_nevis_status(state, &user, &device_id, target_user_id).await
}

/// Handler body for `GET /api/cloud-devices/{device_id}/status`.
async fn cloud_device_nevis_status(
    state: &SharedWecodeAppState,
    user: &wegent_backend_rs::auth::SessionUser,
    device_id: &str,
    target_user_id: Option<i64>,
) -> Result<NevisSandboxStatus, FastApiError> {
    let resolved_user_id = resolve_target_user_id(user, target_user_id)?;

    let status = device_status(
        state.public().as_ref(),
        &state.app.mysql,
        resolved_user_id,
        device_id,
    )
    .await
    .map_err(|error| {
        // `_get_accessible_cloud_device_status` runs before the endpoint's
        // `try`, so a lookup failure reaches the app-level handler.
        tracing::error!(error = %error, "[CloudDevice] device lookup failed");
        FastApiError::unhandled()
    })?;
    let Some(status) = status else {
        return Err(device_not_found(device_id));
    };
    let sandbox_id = resolve_sandbox_id(device_id, status.cloud_config.as_ref());

    let sandbox = match get_vm_status(state.nevis_client(), &sandbox_id).await {
        Ok(sandbox) => sandbox,
        Err(NevisClientError::InvalidBody) => return Err(status_failure()),
        Err(error) if error.status_code() == Some(404) => {
            return Err(FastApiError::detail(
                StatusCode::NOT_FOUND,
                format!("Nevis sandbox '{device_id}' not found"),
            ));
        }
        Err(error) => {
            tracing::error!(error = ?error, "[CloudDevice] Nevis API error getting status");
            return Err(FastApiError::detail(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to get cloud device status: {}", error.message()),
            ));
        }
    };

    // The address observation is best-effort: a failure of the index write
    // never fails the status response.
    if let Some(nevis_ip) = normalize_nevis_ip(sandbox.ip_address.as_deref()) {
        let target = CloudDeviceIpTarget {
            user_id: resolved_user_id,
            device_name: &status.device_id,
            sandbox_id: &sandbox_id,
        };
        if let Err(error) = persist_observation(&state.app.mysql, &target, &nevis_ip).await {
            tracing::warn!(
                %error,
                user_id = resolved_user_id,
                device_id = status.device_id,
                sandbox_id,
                "[CloudDevice] failed to persist Nevis IP observation",
            );
        }
    }

    build_response(sandbox)
}

/// `NevisSandboxStatus(**nevis_status)`: the response model validates the five
/// provider members, and its only transformation is the datetime
/// normalization of `created_at`.
fn build_response(sandbox: SandboxStatus) -> Result<NevisSandboxStatus, FastApiError> {
    let created_at = match sandbox.created_at.as_deref() {
        None => None,
        Some(raw) => Some(format_created_at(raw).ok_or_else(status_failure)?),
    };
    Ok(NevisSandboxStatus {
        sandbox_id: sandbox.sandbox_id,
        status: sandbox.status,
        ip_address: sandbox.ip_address,
        vnc_url: sandbox.vnc_url,
        created_at,
    })
}

/// `_resolve_target_user_id`: non-admin callers may only reach their own
/// devices.
fn resolve_target_user_id(
    user: &UserRow,
    target_user_id: Option<i64>,
) -> Result<i64, FastApiError> {
    let current_user_id = i64::from(user.id);
    let Some(target_user_id) = target_user_id else {
        return Ok(current_user_id);
    };
    if target_user_id == current_user_id {
        return Ok(current_user_id);
    }
    if user.role != "admin" {
        return Err(FastApiError::forbidden(
            "Only admins can access another user's cloud device",
        ));
    }
    Ok(target_user_id)
}

/// `user_id: int | None = None`: an absent query parameter means the caller,
/// and a non-integer renders FastAPI's 422 validation array.
fn parse_optional_user_id(raw: Option<&str>) -> Result<Option<i64>, FastApiError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    raw.trim()
        .parse::<i64>()
        .map(Some)
        .map_err(|_| validation_error(raw))
}

/// FastAPI's query-parameter validation body for `user_id`.
fn validation_error(raw: &str) -> FastApiError {
    FastApiError::validation(QueryValidationError {
        kind: "int_parsing",
        loc: ["query", "user_id"],
        msg: "Input should be a valid integer, unable to parse string as an integer",
        input: raw,
    })
}

/// One entry of FastAPI's 422 `detail` array.
#[derive(Debug, Serialize)]
struct QueryValidationError<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    loc: [&'a str; 2],
    msg: &'a str,
    input: &'a str,
}

/// `NevisSandboxStatus.created_at`: pydantic parses the provider's ISO value
/// and serializes it with microsecond precision, keeping the offset (rendered
/// as `Z` when it is UTC). `None` when the value is not a timestamp, which the
/// response model would reject.
fn format_created_at(raw: &str) -> Option<String> {
    if let Ok(aware) = chrono::DateTime::parse_from_rfc3339(raw) {
        let text = aware.format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
        return Some(if aware.offset().local_minus_utc() == 0 {
            format!("{text}Z")
        } else {
            format!("{text}{}", aware.format("%:z"))
        });
    }
    // A value without an offset stays naive, so it serializes without one.
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(raw, format) {
            return Some(naive.format("%Y-%m-%dT%H:%M:%S%.6f").to_string());
        }
    }
    None
}

/// `404 {"detail": "Cloud device '<id>' not found"}`.
fn device_not_found(device_id: &str) -> FastApiError {
    FastApiError::detail(
        StatusCode::NOT_FOUND,
        format!("Cloud device '{device_id}' not found"),
    )
}

/// The endpoint's generic failure branch (`except Exception`).
fn status_failure() -> FastApiError {
    FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Failed to get cloud device status",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(id: i32, role: &str) -> UserRow {
        UserRow {
            id,
            user_name: "sifang".to_string(),
            users_password_hash: String::new(),
            email: None,
            git_info: brz_mysql::Json(
                wegent_backend_rs::json_compat::OpaqueJson::from_serializable(
                    serde_json::Value::Null,
                ),
            ),
            is_active: 1,
            role: role.to_string(),
            auth_source: "password".to_string(),
            preferences: "{}".to_string(),
            created_at: chrono::NaiveDateTime::default(),
            updated_at: chrono::NaiveDateTime::default(),
        }
    }

    #[test]
    fn own_devices_and_admins_resolve_like_the_source() {
        for (caller, target, expected) in [
            (user(157, "user"), None, 157),
            (user(157, "user"), Some(157), 157),
            (user(157, "admin"), Some(9), 9),
        ] {
            assert_eq!(resolve_target_user_id(&caller, target).ok(), Some(expected));
        }
        let denied = resolve_target_user_id(&user(157, "user"), Some(9));
        assert_eq!(
            denied.err().map(|error| error.status()),
            Some(StatusCode::FORBIDDEN)
        );
    }

    #[test]
    fn user_id_query_parameter_parsing_matches_fastapi() {
        assert_eq!(parse_optional_user_id(None).ok(), Some(None));
        assert_eq!(parse_optional_user_id(Some("157")).ok(), Some(Some(157)));
        assert_eq!(parse_optional_user_id(Some("-9")).ok(), Some(Some(-9)));
        let invalid = parse_optional_user_id(Some("abc"));
        assert_eq!(
            invalid.err().map(|error| error.status()),
            Some(StatusCode::UNPROCESSABLE_ENTITY)
        );
    }

    #[test]
    fn created_at_serializes_like_the_response_model() {
        assert_eq!(
            format_created_at("2026-06-11T06:47:23.404Z").as_deref(),
            Some("2026-06-11T06:47:23.404000Z")
        );
        assert_eq!(
            format_created_at("2026-06-11T14:47:23.457553").as_deref(),
            Some("2026-06-11T14:47:23.457553")
        );
        assert_eq!(
            format_created_at("2026-06-11T14:47:23.404+08:00").as_deref(),
            Some("2026-06-11T14:47:23.404000+08:00")
        );
        assert_eq!(format_created_at("not-a-timestamp"), None);
    }

    #[test]
    fn response_serializes_every_declared_field_in_order() {
        let response = build_response(SandboxStatus {
            sandbox_id: "sandbox-1".to_string(),
            status: "RUNNING".to_string(),
            ip_address: Some("192.0.2.10".to_string()),
            vnc_url: None,
            created_at: Some("2026-06-11T06:47:23.404Z".to_string()),
        })
        .expect("response");
        assert_eq!(
            serde_json::to_string(&response).expect("serialized response"),
            "{\"sandbox_id\":\"sandbox-1\",\"status\":\"RUNNING\",\
             \"ip_address\":\"192.0.2.10\",\"vnc_url\":null,\
             \"created_at\":\"2026-06-11T06:47:23.404000Z\"}"
        );
    }
}
