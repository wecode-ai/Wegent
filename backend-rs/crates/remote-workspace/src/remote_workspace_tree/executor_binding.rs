// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Executor-binding resolution for the sandbox-unavailable branch of the
//! remote-workspace tree endpoint
//! (`remote_workspace_service._ensure_sandbox_available`,
//! `_get_connected_executor_binding`, and the
//! `_resolve_workspace_base_url` fallback `_get_executor_payload`).
use super::error::ApiError;
use super::task_detail::SubtaskRow;

/// `_ensure_sandbox_available`: resolve the executor binding from the
/// already-loaded task detail (the source re-runs the full
/// `_get_task_detail`, but the subtask rows it reads are the same ones this
/// request already produced — replay of those reads is covered by the first
/// load), then `_resolve_workspace_base_url` which, when the sandbox is not
/// running, falls back to `_get_executor_payload` (the executor-manager
/// `/executor-manager/executor/address` GET; performed by the caller via
/// `resolve_executor_base_url`). Raises 409 when no runtime base URL is
/// available. Returns the executor name.
pub(crate) async fn ensure_sandbox_available(
    subtasks: &[SubtaskRow],
) -> Result<Option<(String, String)>, ApiError> {
    match connected_executor_binding(subtasks) {
        Some(binding) => Ok(Some(binding)),
        None => Err(ApiError::conflict("Remote workspace is unavailable")),
    }
}

/// `_get_connected_executor_binding`: the latest non-deleted executor
/// binding, else the latest deleted one.
fn connected_executor_binding(rows: &[SubtaskRow]) -> Option<(String, String)> {
    let mut latest_deleted: Option<(String, String)> = None;
    for row in rows.iter().rev() {
        let name = row.executor_name.trim();
        if name.is_empty() {
            continue;
        }
        let namespace = row.executor_namespace.trim().to_owned();
        if row.executor_deleted_at == 0 {
            return Some((name.to_owned(), namespace));
        }
        if latest_deleted.is_none() {
            latest_deleted = Some((name.to_owned(), namespace));
        }
    }
    latest_deleted
}

/// `_resolve_workspace_base_url` fallback branch: `_get_executor_payload`
/// — GET `{executor_manager}/executor-manager/executor/address` with
/// `executor_name` (+ `executor_namespace` when present), returning the
/// `base_url` for a success payload and `None` on any failure. Used when
/// the sandbox is not running so the manager tree call can be addressed.
pub(crate) async fn resolve_executor_base_url(
    http: &brz_http::Client,
    config: &super::config::Config,
    executor_name: &str,
    executor_namespace: Option<&str>,
) -> Option<String> {
    let url = format!(
        "{}/executor-manager/executor/address",
        config.executor_manager_url
    );
    let builder = http.get(&url).ok()?;
    let mut query: Vec<(&str, &str)> = vec![("executor_name", executor_name)];
    if let Some(namespace) = executor_namespace {
        query.push(("executor_namespace", namespace));
    }
    let response = builder.query(&query).send().await.ok()?;
    if response.status().as_u16() != 200 {
        return None;
    }
    /// `_get_executor_payload` response fields (status/base_url).
    #[derive(serde::Deserialize)]
    struct ExecutorAddress {
        status: Option<String>,
        base_url: Option<String>,
    }
    let payload = response.json::<ExecutorAddress>().await.ok()?;
    let status = payload.status.unwrap_or_default().to_lowercase();
    let base_url = payload.base_url?;
    if base_url.is_empty() {
        return None;
    }
    if !status.is_empty() && status != "success" {
        return None;
    }
    Some(base_url.trim_end_matches('/').to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subtask(name: &str, deleted: i8) -> SubtaskRow {
        crate::remote_workspace_tree::task_detail::test_subtask_row(name, deleted)
    }

    #[test]
    fn prefers_latest_non_deleted_binding() {
        let rows = vec![subtask("e1", 0), subtask("e2", 0)];
        assert_eq!(
            connected_executor_binding(&rows),
            Some(("e2".to_owned(), String::new()))
        );
    }

    #[test]
    fn falls_back_to_latest_deleted_binding() {
        let rows = vec![subtask("e1", 1), subtask("e2", 1)];
        assert_eq!(
            connected_executor_binding(&rows),
            Some(("e2".to_owned(), String::new()))
        );
    }

    #[test]
    fn empty_binding_is_none() {
        let rows = vec![subtask("", 0), subtask("  ", 0)];
        assert!(connected_executor_binding(&rows).is_none());
    }
}
