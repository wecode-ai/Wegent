// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Workspace-archive restore service.
//!
//! Mirrors `app/services/workspace_archive/archive_service.py`'s
//! `ArchiveService.restore_workspace`: read the task's stored archive
//! descriptor, skip an expired or missing archive, confirm the object exists,
//! presign a download URL, and hand it to the executor-manager restore
//! endpoint. Every failure is swallowed into `False`, exactly like the
//! source's broad `except Exception`.
use serde_json::Value;

use crate::state::AppState;

use super::storage::ArchiveStorage;

/// The source `WORKSPACE_ARCHIVE_TIMEZONE` default (`app/core/config.py`).
const DEFAULT_ARCHIVE_TIMEZONE: &str = "Asia/Shanghai";
/// The `runtime_type` the sandbox restore endpoints pass.
pub(crate) const RUNTIME_TYPE_SANDBOX: &str = "sandbox";

/// `ArchiveService.restore_workspace`: `True` when the archive was restored,
/// `False` when no archive applies or any step failed.
pub(crate) async fn restore_workspace(
    state: &AppState,
    task_id: i64,
    task_json: &Value,
    executor_name: &str,
    executor_namespace: &str,
) -> bool {
    match restore(state, task_id, task_json, executor_name, executor_namespace).await {
        Ok(restored) => restored,
        Err(error) => {
            tracing::error!(task_id, %error, "workspace archive restore failed");
            false
        }
    }
}

async fn restore(
    state: &AppState,
    task_id: i64,
    task_json: &Value,
    executor_name: &str,
    executor_namespace: &str,
) -> anyhow::Result<bool> {
    // `Task.model_validate(task.json)` -> `task_crd.status.archive`.
    let Some(archive) = archive_status(task_json)? else {
        tracing::info!(task_id, "no archive found; git clone path applies");
        return Ok(false);
    };
    // `not archive_info or not archive_info.storageKey`.
    let Some(storage_key) = archive.get("storageKey").and_then(Value::as_str) else {
        return Ok(false);
    };
    if storage_key.is_empty() {
        return Ok(false);
    }
    if is_expired(archive.get("expiresAt"))? {
        tracing::info!(task_id, "archive expired");
        return Ok(false);
    }

    // `archive_storage_service.archive_exists` -> `generate_download_url`.
    let storage = ArchiveStorage::from_env()?;
    if !storage
        .archive_exists(&state.attachment_http, storage_key)
        .await?
    {
        tracing::warn!(task_id, "archive object not found in storage");
        return Ok(false);
    }
    let download_url = storage
        .generate_download_url(&state.attachment_http, storage_key)
        .await?;

    // `_call_executor_restore`: a missing result or `success != True` skips
    // the restore.
    let Some(result) = state
        .executor_manager
        .restore_workspace(
            task_id,
            &download_url,
            executor_name,
            executor_namespace,
            RUNTIME_TYPE_SANDBOX,
        )
        .await
    else {
        return Ok(false);
    };
    Ok(result.get("success").and_then(Value::as_bool) == Some(true))
}

/// The `status.archive` object of a validated `Task` CRD, or `None` when the
/// status or archive is absent.
fn archive_status(task_json: &Value) -> anyhow::Result<Option<&Value>> {
    let Some(task) = task_json.as_object() else {
        anyhow::bail!("task json is not an object");
    };
    let Some(status) = task.get("status") else {
        return Ok(None);
    };
    if status.is_null() {
        return Ok(None);
    }
    let Some(status) = status.as_object() else {
        anyhow::bail!("task status is not an object");
    };
    Ok(status.get("archive").filter(|archive| !archive.is_null()))
}

/// The source's expired check: `normalize_workspace_archive_datetime(expiresAt)
/// < workspace_archive_now()`. A missing `expiresAt` is never expired.
fn is_expired(expires_at: Option<&Value>) -> anyhow::Result<bool> {
    let Some(expires_at) = expires_at else {
        return Ok(false);
    };
    let offset = archive_offset();
    let expires_at = archive_datetime(expires_at, offset)?;
    Ok(expires_at < chrono::Utc::now().with_timezone(&offset))
}

/// Parse a stored archive timestamp: an RFC 3339 instant, or a naive value
/// interpreted in the configured archive zone (`normalize_workspace_archive_datetime`).
fn archive_datetime(
    value: &Value,
    offset: chrono::FixedOffset,
) -> anyhow::Result<chrono::DateTime<chrono::FixedOffset>> {
    let Some(raw) = value.as_str() else {
        anyhow::bail!("archive expiresAt is not a string");
    };
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Ok(parsed.with_timezone(&offset));
    }
    let naive = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f")?;
    naive
        .and_local_timezone(offset)
        .single()
        .ok_or_else(|| anyhow::anyhow!("ambiguous archive timestamp in the configured zone"))
}

/// `get_workspace_archive_timezone()`: the configured zone offset. The source
/// default is `Asia/Shanghai`; only its fixed `+08:00` offset and `UTC` are
/// modeled here, and an unknown zone falls back to UTC like the source's
/// `ZoneInfoNotFoundError` branch.
fn archive_offset() -> chrono::FixedOffset {
    let zone = crate::config::env_or_dotenv("WORKSPACE_ARCHIVE_TIMEZONE")
        .unwrap_or_else(|| DEFAULT_ARCHIVE_TIMEZONE.to_string());
    match zone.trim() {
        "Asia/Shanghai" | "Asia/Chongqing" | "Asia/Harbin" | "Asia/Urumqi" => {
            chrono::FixedOffset::east_opt(8 * 3600).expect("+08:00 is a valid offset")
        }
        _ => chrono::FixedOffset::east_opt(0).expect("UTC is a valid offset"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn absent_status_or_archive_is_no_archive() {
        assert!(archive_status(&json!({})).unwrap().is_none());
        assert!(archive_status(&json!({"status": null})).unwrap().is_none());
        assert!(
            archive_status(&json!({"status": {"archive": null}}))
                .unwrap()
                .is_none()
        );
        assert!(archive_status(&json!("nope")).is_err());
    }

    #[test]
    fn reads_the_stored_archive_descriptor() {
        let task = json!({
            "status": {"archive": {"storageKey": "workspace-archives/1/archive.tar.gz"}}
        });
        let archive = archive_status(&task).unwrap().unwrap();
        assert_eq!(
            archive.get("storageKey").and_then(Value::as_str),
            Some("workspace-archives/1/archive.tar.gz")
        );
    }

    #[test]
    fn expiry_compares_against_the_configured_zone() {
        let offset = archive_offset();
        assert!(!is_expired(None).unwrap());
        assert!(is_expired(Some(&json!("2000-01-01T00:00:00+00:00"))).unwrap());
        assert!(!is_expired(Some(&json!("2999-01-01T00:00:00+00:00"))).unwrap());
        assert!(archive_datetime(&json!("2026-10-10T06:25:57"), offset).is_ok());
        assert!(archive_datetime(&json!(123), offset).is_err());
    }
}
