// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Chat task device-target resolution.
//!
//! Source: `app/services/chat/task_device_resolution.py`. `on_chat_send`
//! computes `params.device_id = resolve_chat_task_device_id(...)` before
//! `create_chat_task`, so the persisted Task carries the validated,
//! canonicalized runtime route instead of the raw client payload.
//!
//! The resolution runs on the handler's pinned transaction: the Source shares
//! one SQLAlchemy session for the whole `chat:send` write, so both Device-kind
//! reads below are members of the same transaction and appear in this order.

use brz_mysql::MysqlError;
use serde_json::Value;

use crate::device_identity::{
    DeviceKindRow, DeviceType, KINDS_DEVICE_QUERY, identity_from_device,
    resolve_owned_device_alias_on,
};
use crate::plugins_marketplace::query::PluginQuery;
use crate::projects;

/// The Source's `HTTPException(409, ...)` detail for an ambiguous historical
/// App device (`task_device_resolution.py:109/130`).
pub(crate) const AMBIGUOUS_DEVICE_MESSAGE: &str =
    "Ambiguous historical device; select a specific Wework installation";

/// `resolve_chat_task_device_id`'s failure modes.
#[derive(Debug)]
pub(crate) enum DeviceResolutionError {
    /// `HTTPException(409, AMBIGUOUS_DEVICE_MESSAGE)`; the socket handler's
    /// outer `except Exception` renders it as `{"error": str(exc)}`.
    Ambiguous,
    Mysql(MysqlError),
}

impl From<MysqlError> for DeviceResolutionError {
    fn from(error: MysqlError) -> Self {
        Self::Mysql(error)
    }
}

/// `resolve_chat_task_device_id`.
///
/// An existing task reuses its own bound device; a new task uses the explicit
/// payload device, otherwise the project execution target.
pub(crate) async fn resolve_chat_task_device_id<Q: PluginQuery>(
    query: &mut Q,
    user_id: i64,
    requested_device_id: Option<&str>,
    existing_task: Option<&Value>,
    project_id: i64,
    client_origin: &str,
) -> Result<Option<String>, DeviceResolutionError> {
    if let Some(task) = existing_task {
        return resolve_task_device_id(query, user_id, task).await;
    }
    if let Some(candidate) = clean_string(requested_device_id) {
        return resolve_local_executor_device_id(query, user_id, Some(&candidate)).await;
    }
    let Some(project_device_id) =
        extract_project_device_id(query, user_id, project_id, client_origin).await?
    else {
        return Ok(None);
    };
    resolve_local_executor_device_id(query, user_id, Some(&project_device_id)).await
}

/// `resolve_task_device_id`: follow-ups keep the device bound to the task.
async fn resolve_task_device_id<Q: PluginQuery>(
    query: &mut Q,
    user_id: i64,
    task: &Value,
) -> Result<Option<String>, DeviceResolutionError> {
    if extract_task_type(task).as_deref() == Some("code") {
        return Ok(None);
    }
    let Some(device_id) = extract_task_device_id(task) else {
        return Ok(None);
    };
    resolve_local_executor_device_id(query, user_id, Some(&device_id)).await
}

/// `resolve_local_executor_device_id`.
///
/// The first read is `resolve_runtime_route_identity`'s aliased-device
/// lookup; every non-App submission then repeats the active-Device query to
/// apply the historical App ambiguity rules.
async fn resolve_local_executor_device_id<Q: PluginQuery>(
    query: &mut Q,
    user_id: i64,
    device_id: Option<&str>,
) -> Result<Option<String>, DeviceResolutionError> {
    let Some(candidate) = clean_string(device_id) else {
        return Ok(None);
    };
    let device = resolve_owned_device_alias_on(query, user_id, &candidate).await?;
    let identity = device.as_ref().and_then(identity_from_device);
    // Real App routes return the executor Socket.IO id before the fallback
    // scan; only unresolved or non-App submissions read the list again.
    if let Some(identity) = identity.as_ref()
        && identity.device_type == DeviceType::App
    {
        return Ok(Some(identity.runtime_device_id.clone()));
    }
    let devices: Vec<DeviceKindRow> = query.fetch_all(KINDS_DEVICE_QUERY, (user_id,)).await?;
    for device in &devices {
        if device.name == candidate {
            if spec_string(device, "deviceType") == Some("app") && identity.is_none() {
                return Err(DeviceResolutionError::Ambiguous);
            }
            return Ok(Some(candidate));
        }
    }
    for device in &devices {
        if clean_string(spec_string(device, "appDeviceId")).as_deref() == Some(&candidate) {
            if spec_string(device, "deviceType") == Some("app") {
                return Err(DeviceResolutionError::Ambiguous);
            }
            return Ok(Some(
                clean_string(Some(device.name.as_str())).unwrap_or(candidate),
            ));
        }
    }
    Ok(Some(candidate))
}

/// `_extract_project_device_id`: the project's persisted execution target.
async fn extract_project_device_id<Q: PluginQuery>(
    query: &mut Q,
    user_id: i64,
    project_id: i64,
    client_origin: &str,
) -> Result<Option<String>, DeviceResolutionError> {
    if project_id == 0 {
        return Ok(None);
    }
    let Some(config) =
        projects::project_config_on(query, user_id, project_id, client_origin).await?
    else {
        return Ok(None);
    };
    if let Some(execution) = config.get("execution").filter(|value| value.is_object()) {
        let target_type = execution.get("targetType").and_then(Value::as_str);
        if matches!(target_type, Some("local" | "cloud" | "remote")) {
            return Ok(clean_string(
                execution.get("deviceId").and_then(Value::as_str),
            ));
        }
    }
    Ok(clean_string(
        config.get("device_id").and_then(Value::as_str),
    ))
}

/// `extract_task_device_id`: the Task spec's bound device id.
fn extract_task_device_id(task: &Value) -> Option<String> {
    clean_string(task.pointer("/spec/device_id").and_then(Value::as_str))
}

/// `extract_task_type`: the persisted Task CRD's `taskType` label.
fn extract_task_type(task: &Value) -> Option<String> {
    clean_string(
        task.pointer("/metadata/labels/taskType")
            .and_then(Value::as_str),
    )
}

/// `_clean_string`: only a string value can name a device, trimmed.
pub(crate) fn clean_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// `device.json["spec"][key]` as a string (the Source's dict `.get`).
fn spec_string<'a>(device: &'a DeviceKindRow, key: &str) -> Option<&'a str> {
    device
        .json
        .get("spec")
        .and_then(|spec| spec.get(key))
        .and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clean_string_only_accepts_non_empty_strings() {
        assert_eq!(clean_string(Some("  dev  ")), Some("dev".to_string()));
        assert_eq!(clean_string(Some("   ")), None);
        assert_eq!(clean_string(None), None);
    }

    #[test]
    fn the_task_identity_reads_match_the_source_paths() {
        let task = json!({
            "metadata": {"labels": {"taskType": "code"}},
            "spec": {"device_id": "dev-1"},
        });
        assert_eq!(extract_task_type(&task).as_deref(), Some("code"));
        assert_eq!(extract_task_device_id(&task).as_deref(), Some("dev-1"));
        assert_eq!(
            extract_task_device_id(&json!({"spec": {"device_id": " "}})),
            None
        );
    }
}
