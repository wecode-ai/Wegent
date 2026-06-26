// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{env, path::PathBuf, sync::Arc};

use serde_json::{json, Value};

use crate::local::session::{
    LocalSessionHandler, SessionResult, SessionStartRequest, SessionType, UnixSessionPtyManager,
};

pub(super) fn default_session_handler() -> LocalSessionHandler {
    let gateway_enabled = env_bool("DEVICE_SESSION_GATEWAY_ENABLED", true);
    let public_base_url = env::var("DEVICE_PUBLIC_BASE_URL")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "http://localhost:17888".to_owned());
    let code_server_port = env::var("DEVICE_CODE_SERVER_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(18080);
    let workspace_root = env::var("LOCAL_WORKSPACE_ROOT")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".wegent-executor").join("workspace"));
    LocalSessionHandler::new(
        &public_base_url,
        gateway_enabled,
        code_server_port,
        workspace_root,
        Arc::new(UnixSessionPtyManager),
    )
}

pub(super) fn session_start_request(
    payload: Value,
    session_type: SessionType,
) -> Result<SessionStartRequest, String> {
    Ok(SessionStartRequest {
        session_type,
        session_id: value_string(payload.get("session_id"))
            .ok_or_else(|| "session_id is required".to_owned())?,
        project_id: value_u64(payload.get("project_id"))
            .ok_or_else(|| "project_id is required".to_owned())?,
        path: value_string(payload.get("path")).ok_or_else(|| "path is required".to_owned())?,
        access_token: value_string(payload.get("access_token"))
            .ok_or_else(|| "access_token is required".to_owned())?,
        rows: value_u16(payload.get("rows")),
        cols: value_u16(payload.get("cols")),
        create_if_missing: payload
            .get("create_if_missing")
            .or_else(|| payload.get("createIfMissing"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        ttl_seconds: value_u64(
            payload
                .get("ttl_seconds")
                .or_else(|| payload.get("ttlSeconds")),
        ),
    })
}

pub(super) fn session_result_payload(result: SessionResult) -> Value {
    let mut payload = json!({
        "success": result.success,
    });
    if let Some(error) = result.error {
        payload["error"] = json!(error);
    }
    if let Some(session_id) = result.session_id {
        payload["session_id"] = json!(session_id);
    }
    if let Some(project_id) = result.project_id {
        payload["project_id"] = json!(project_id);
    }
    if let Some(session_type) = result.session_type {
        payload["type"] = json!(match session_type {
            SessionType::Terminal => "terminal",
            SessionType::CodeServer => "code_server",
        });
    }
    if let Some(path) = result.path {
        payload["path"] = json!(path.display().to_string());
    }
    if !result.url.is_empty() {
        payload["url"] = json!(result.url);
    }
    if let Some(transport) = result.transport {
        payload["transport"] = json!(transport);
    }
    payload
}

pub(super) fn value_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub(super) fn value_u16(value: Option<&Value>) -> Option<u16> {
    value_u64(value).and_then(|value| u16::try_from(value).ok())
}

fn value_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
            .or_else(|| value.as_str().and_then(|raw| raw.trim().parse().ok()))
    })
}

fn env_bool(name: &str, default: bool) -> bool {
    env::var(name)
        .ok()
        .map(|value| {
            !matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "" | "0" | "false" | "no" | "off"
            )
        })
        .unwrap_or(default)
}

fn home_dir() -> PathBuf {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}
