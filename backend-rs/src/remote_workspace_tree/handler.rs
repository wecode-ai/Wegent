// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/{task_id}/remote-workspace/tree`.
//!
//! Mirrors source `app/api/endpoints/adapter/tasks.py::get_remote_workspace_tree`
//! and `app/services/remote_workspace_service.py::RemoteWorkspaceService.list_tree`.
//!
//! Request flow (source-ordered):
//! 1. `get_current_user`: verify the Authorization bearer JWT and load the
//!    user through the public direct SQL reader.
//! 2. `_get_sandbox_payload`: GET
//!    `{EXECUTOR_MANAGER_URL}/executor-manager/sandboxes/{task_id}`.
//! 3. `_resolve_root_path` + `normalize_and_validate_workspace_path`.
//! 4. `_get_task_detail`: load the task, verify access, resolve workspace,
//!    team, fork lineage/subtasks/contexts, group-chat members.
//! 5. When the sandbox is running: POST
//!    `{sandbox_base_url}/filesystem.Filesystem/ListDir` with
//!    `{"path": ..., "depth": 1}` and map entries to the tree response;
//!    otherwise `_ensure_sandbox_available` then the executor-manager
//!    workspace/tree endpoint.
use std::sync::Arc;

use crate::remote_workspace_payload::ExecutorPayload;
use brz_http::Client as HttpClient;
use brz_mysql::Mysql;
use brz_redis::Redis;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::config::Config;
use super::error::ApiError;
use super::executor_binding;
use super::kinds::KindStore;
use super::task_detail;

pub(crate) const WORKSPACE_ROOT: &str = "/workspace";
pub(crate) const SANDBOX_HOME_ROOT: &str = "/home/user";

/// Process-lifetime dependency clients and configuration.
pub struct Deps<M: Mysql, R: Redis> {
    pub(crate) config: Config,
    pub(crate) http: HttpClient,
    pub(crate) mysql: M,
    /// The deployment's task-shard policy: selects the physical task and
    /// subtask tables and enables the migrated-legacy probes.
    pub(crate) task_policy: crate::task_routing::TaskPolicy,
    /// Employee-directory provider for the team redaction check's
    /// entity-derived membership pass.
    pub(crate) erp: std::sync::Arc<dyn crate::erp_provider::ErpProvider<R> + Send + Sync>,
    /// The user-cache client of the deployment's cached reader
    /// (`user:v2:data` reads); `None` keeps direct SQL.
    pub(crate) redis: Option<R>,
    /// The kinds-cache client of the deployment's cached reader
    /// (`kind:v2:idx` / `kind:v2:data` reads); `None` keeps direct SQL.
    pub(crate) kinds_redis: Option<R>,
}

/// Assemble supplied clients; construction and routing belong to the caller.
pub fn build_deps<M: Mysql, R: Redis>(
    config: Config,
    mysql: M,
    task_policy: crate::task_routing::TaskPolicy,
    http: HttpClient,
    redis: Option<R>,
    kinds_redis: Option<R>,
    erp: std::sync::Arc<dyn crate::erp_provider::ErpProvider<R> + Send + Sync>,
) -> Arc<Deps<M, R>> {
    Arc::new(Deps {
        config,
        http,
        mysql,
        task_policy,
        erp,
        redis,
        kinds_redis,
    })
}

/// GET /api/tasks/{task_id}/remote-workspace/tree: the remote-workspace tree
/// free function, injecting the process-lifetime dependency state. Mirrors
/// `get_remote_workspace_tree` in source `app/api/endpoints/adapter/tasks.py`.
#[brz_http_server::get(
    "/api/tasks/:task_id/remote-workspace/tree",
    group = remote_workspace_tree
)]
async fn get_remote_workspace_tree(
    #[inject(rwt)] state: &crate::startup::TreeState,
    task_id: u64,
    #[auth] current_user: crate::auth::SessionUser,
    path: Option<String>,
) -> Result<TreeResponse, ApiError> {
    tree(state, task_id, i64::from(current_user.id), path.as_deref()).await
}

#[derive(Serialize)]
struct TreeEntry {
    name: String,
    path: String,
    is_directory: bool,
    size: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified_at: Option<String>,
}

#[derive(Serialize)]
struct TreeResponse {
    path: String,
    entries: Vec<TreeEntry>,
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct SandboxListResponse {
    entries: Option<Vec<Option<SandboxEntry>>>,
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct SandboxEntry {
    name: Option<String>,
    path: Option<String>,
    #[serde(rename = "type")]
    entry_type: Option<String>,
    size: Option<JsonScalar>,
    modified_time: Option<JsonScalar>,
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct ManagerEntry {
    name: Option<String>,
    path: Option<String>,
    is_directory: Option<bool>,
    size: Option<JsonScalar>,
    modified_at: Option<JsonScalar>,
}

/// A scalar JSON field whose non-string/non-number forms remain observable
/// when the legacy endpoint stringifies them.
#[derive(Clone, Deserialize)]
#[serde(untagged)]
enum JsonScalar {
    String(String),
    Integer(i64),
    Unsigned(u64),
    Float(f64),
    Other(crate::json_compat::OpaqueJson),
}

impl Serialize for JsonScalar {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::String(value) => value.serialize(serializer),
            Self::Integer(value) => value.serialize(serializer),
            Self::Unsigned(value) => value.serialize(serializer),
            Self::Float(value) => value.serialize(serializer),
            Self::Other(value) => value.serialize(serializer),
        }
    }
}

impl JsonScalar {
    fn size(&self) -> i64 {
        match self {
            Self::Integer(value) => *value,
            Self::Unsigned(value) => (*value as f64) as i64,
            Self::Float(value) => *value as i64,
            _ => 0,
        }
    }

    fn modified_at(&self) -> Option<String> {
        match self {
            Self::String(value) => Some(value.clone()),
            Self::Integer(value) => normalize_timestamp(*value as f64),
            Self::Unsigned(value) => normalize_timestamp(*value as f64),
            Self::Float(value) => normalize_timestamp(*value),
            Self::Other(value) if value.is_null() => None,
            Self::Other(value) => serde_json::to_string(value).ok(),
        }
    }
}

trait DirectoryEntryInput {
    fn into_tree_entry(self, default_path: &str) -> TreeEntry;
}

impl DirectoryEntryInput for ManagerEntry {
    fn into_tree_entry(self, default_path: &str) -> TreeEntry {
        TreeEntry {
            name: self.name.unwrap_or_default(),
            path: self.path.unwrap_or_else(|| default_path.to_owned()),
            is_directory: self.is_directory.unwrap_or(false),
            size: self.size.as_ref().map_or(0, JsonScalar::size),
            modified_at: self.modified_at.as_ref().and_then(JsonScalar::modified_at),
        }
    }
}

/// Handler body for `GET /api/tasks/{task_id}/remote-workspace/tree`.
async fn tree(
    deps: &Arc<Deps<impl Mysql, impl Redis>>,
    task_id: u64,
    user_id: i64,
    path: Option<&str>,
) -> Result<TreeResponse, ApiError> {
    let kinds = KindStore {
        mysql: &deps.mysql,
        redis: deps.kinds_redis.as_ref(),
    };
    let erp = crate::teams::group_membership::ErpContext {
        erp: deps.erp.as_ref(),
        redis: deps.redis.as_ref(),
    };

    let sandbox_payload = get_sandbox_payload(&deps.http, &deps.config, task_id).await;
    let root_path = resolve_root_path(task_id, &sandbox_payload);
    let normalized_path = normalize_and_validate_workspace_path(path, &root_path)?;

    // Source calls `_get_task_detail` here; the tree response consumes only
    // its access-control outcome, but the call sequence is reproduced.
    // The first load's rows are dropped: the second `_get_task_detail`
    // round below (in `_ensure_sandbox_available`) is the one whose
    // subtasks feed the executor binding.
    let _task = task_detail::load_task_detail(
        &deps.mysql,
        deps.redis.as_ref(),
        deps.task_policy,
        &erp,
        &kinds,
        task_id,
        user_id,
    )
    .await?;

    let entries_payload = if is_sandbox_available(&sandbox_payload) {
        let sandbox_base_url = sandbox_payload
            .as_ref()
            .and_then(|payload| payload.base_url.as_deref())
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_owned();
        list_directory_via_sandbox(&deps.http, &sandbox_base_url, &normalized_path).await?
    } else {
        // `_ensure_sandbox_available`: the source re-runs the FULL
        // `_get_task_detail` chain here (second round of task/workspace/
        // team/subtask/member loads and kind-cache reads), resolves the
        // executor binding, then `_resolve_workspace_base_url` re-fetches
        // the sandbox payload and falls back to
        // `_get_executor_payload` (executor-manager `/executor/address`)
        // before the manager tree call. 409 when no runtime base URL.
        let detail = task_detail::load_task_detail(
            &deps.mysql,
            deps.redis.as_ref(),
            deps.task_policy,
            &erp,
            &kinds,
            task_id,
            user_id,
        )
        .await?;
        let binding = {
            let subtasks = &detail.subtasks;
            executor_binding::ensure_sandbox_available(subtasks).await?
        };
        let sandbox_payload = get_sandbox_payload(&deps.http, &deps.config, task_id).await;
        if !is_sandbox_available(&sandbox_payload) {
            match binding.as_ref() {
                Some((name, namespace)) => {
                    let base_url = executor_binding::resolve_executor_base_url(
                        &deps.http,
                        &deps.config,
                        name,
                        if namespace.is_empty() {
                            None
                        } else {
                            Some(namespace)
                        },
                    )
                    .await;
                    if base_url.is_none() {
                        return Err(ApiError::conflict("Remote workspace is unavailable"));
                    }
                }
                None => {
                    return Err(ApiError::conflict("Remote workspace is unavailable"));
                }
            }
        }
        let executor_name = binding.as_ref().map(|(name, _)| name.clone());
        list_directory_via_manager(
            &deps.http,
            &deps.config,
            task_id,
            executor_name.as_deref(),
            &normalized_path,
        )
        .await?
    };

    let entries = entries_payload
        .into_iter()
        .map(|item| item.into_tree_entry(&normalized_path))
        .collect();

    Ok(TreeResponse {
        path: normalized_path,
        entries,
    })
}

/// `_get_sandbox_payload`: GET `{executor_manager}/executor-manager/sandboxes/{id}`.
/// Any transport or non-200 outcome yields `None` (source logs and continues).
pub(crate) async fn get_sandbox_payload(
    http: &HttpClient,
    config: &Config,
    task_id: u64,
) -> Option<ExecutorPayload> {
    let url = format!(
        "{}/executor-manager/sandboxes/{}",
        config.executor_manager_url, task_id
    );
    let response = http
        .get(&url)
        .map_err(|error| {
            tracing::warn!(%error, url = %url, "[remote_workspace] sandbox query build failed");
            error
        })
        .ok()?
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(%error, url = %url, "[remote_workspace] sandbox query failed");
            error
        })
        .ok()?;
    if response.status().as_u16() != 200 {
        tracing::info!(
            status = %response.status(),
            url = %url,
            "[remote_workspace] sandbox query non_200"
        );
        return None;
    }
    let body = response.bytes().await.ok()?;
    if body.is_empty() {
        tracing::warn!(url = %url, "[remote_workspace] sandbox query empty body");
        return None;
    }
    ExecutorPayload::parse(&body)
}

/// `_is_sandbox_available`.
pub(crate) fn is_sandbox_available(sandbox_payload: &Option<ExecutorPayload>) -> bool {
    sandbox_payload
        .as_ref()
        .is_some_and(ExecutorPayload::sandbox_available)
}

/// `_resolve_root_path`.
pub(crate) fn resolve_root_path(task_id: u64, sandbox_payload: &Option<ExecutorPayload>) -> String {
    if is_sandbox_available(sandbox_payload) {
        SANDBOX_HOME_ROOT.to_owned()
    } else {
        format!("{WORKSPACE_ROOT}/{task_id}")
    }
}

/// `normalize_and_validate_workspace_path` from source
/// `remote_workspace_service.py` (POSIX semantics, no host filesystem).
pub(crate) fn normalize_and_validate_workspace_path(
    path: Option<&str>,
    root_path: &str,
) -> Result<String, ApiError> {
    let mut normalized_root = root_path.trim();
    if normalized_root.is_empty() {
        normalized_root = WORKSPACE_ROOT;
    }
    let mut normalized_root = normalized_root.to_owned();
    if !normalized_root.starts_with('/') {
        normalized_root = format!("/{normalized_root}");
    }
    normalized_root = posix_normpath(&normalized_root);

    let mut normalized = match path {
        Some(value) => value.trim().to_owned(),
        None => normalized_root.clone(),
    };
    if normalized.is_empty() {
        normalized = normalized_root.clone();
    }
    if !normalized.starts_with('/') {
        normalized = format!("/{normalized}");
    }
    normalized = posix_normpath(&normalized);

    // Legacy `/workspace` remap to `/home/user` in the sandbox runtime.
    if normalized_root == SANDBOX_HOME_ROOT && normalized.starts_with(WORKSPACE_ROOT) {
        let suffix = &normalized[WORKSPACE_ROOT.len()..];
        normalized = posix_normpath(&format!("{SANDBOX_HOME_ROOT}{suffix}"));
    }

    // Legacy `/workspace` remap to the task-scoped workspace root.
    let is_task_scoped_workspace_root = normalized_root.starts_with(&format!("{WORKSPACE_ROOT}/"));
    let already_under_root =
        normalized == normalized_root || normalized.starts_with(&format!("{normalized_root}/"));
    if is_task_scoped_workspace_root
        && !already_under_root
        && normalized.starts_with(WORKSPACE_ROOT)
    {
        let suffix = &normalized[WORKSPACE_ROOT.len()..];
        normalized = posix_normpath(&format!("{normalized_root}{suffix}"));
    }

    if normalized == normalized_root || normalized.starts_with(&format!("{normalized_root}/")) {
        Ok(normalized)
    } else {
        Err(ApiError::bad_request(format!(
            "Path must stay within {normalized_root}"
        )))
    }
}

/// `posixpath.normpath` for absolute paths with `..`/`.` resolution.
fn posix_normpath(path: &str) -> String {
    if path == "/" {
        return "/".to_owned();
    }
    let mut resolved: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                resolved.pop();
            }
            other => resolved.push(other),
        }
    }
    if resolved.is_empty() {
        "/".to_owned()
    } else {
        format!("/{}", resolved.join("/"))
    }
}

/// `_list_directory_via_sandbox`: POST `{base}/filesystem.Filesystem/ListDir`.
///
/// Maps sandbox `entries` items (`name`, `path`, `type`, `size`,
/// `modified_time`) into the source's intermediate entry shape
/// (`is_directory` = `type == "FILE_TYPE_DIRECTORY"`).
async fn list_directory_via_sandbox(
    http: &HttpClient,
    base_url: &str,
    path: &str,
) -> Result<Vec<ManagerEntry>, ApiError> {
    let url = format!("{base_url}/filesystem.Filesystem/ListDir");
    let response = http
        .post(&url)
        .map_err(|error| {
            tracing::warn!(%error, url = %url, "[remote_workspace] sandbox list_dir build failed");
            error
        })
        .ok()
        .ok_or_else(|| ApiError::service_unavailable("Failed to query remote workspace"))?
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", "1")
        .body(json!({"path": path, "depth": 1}).to_string())
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(%error, url = %url, "[remote_workspace] sandbox list_dir request failed");
            ApiError::service_unavailable("Failed to query remote workspace")
        })?;
    let status = response.status().as_u16();
    if status == 404 {
        return Err(ApiError::not_found("Path not found"));
    }
    if status >= 400 {
        return Err(ApiError::bad_gateway("Remote workspace list failed"));
    }
    let body = response.bytes().await.map_err(|error| {
        tracing::warn!(%error, url = %url, "[remote_workspace] sandbox list_dir body read failed");
        ApiError::bad_gateway("Remote workspace list failed")
    })?;
    let payload: crate::json_compat::JsonProjection<SandboxListResponse> =
        serde_json::from_slice(&body).map_err(|error| {
            tracing::warn!(%error, url = %url, "[remote_workspace] sandbox list_dir invalid json");
            ApiError::bad_gateway("Invalid remote workspace response")
        })?;

    Ok(sandbox_entries(payload, path))
}

fn sandbox_entries(
    payload: crate::json_compat::JsonProjection<SandboxListResponse>,
    path: &str,
) -> Vec<ManagerEntry> {
    let Some(raw_entries) = payload.value.and_then(|payload| payload.entries) else {
        return Vec::new();
    };
    let mut entries = Vec::with_capacity(raw_entries.len());
    for item in raw_entries.into_iter().flatten() {
        let entry_path = item.path.unwrap_or_else(|| path.to_owned());
        let name = item
            .name
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| basename(&entry_path));
        entries.push(ManagerEntry {
            name: Some(name),
            path: Some(entry_path),
            is_directory: Some(item.entry_type.as_deref() == Some("FILE_TYPE_DIRECTORY")),
            size: item.size,
            modified_at: item.modified_time,
        });
    }
    entries
}

/// `posixpath.basename`.
fn basename(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_owned()
}

/// `_list_directory` via the executor manager (sandbox-unavailable branch).
async fn list_directory_via_manager(
    http: &HttpClient,
    config: &Config,
    task_id: u64,
    executor_name: Option<&str>,
    path: &str,
) -> Result<Vec<ManagerEntry>, ApiError> {
    let url = format!(
        "{}/executor-manager/executor/workspace/tree",
        config.executor_manager_url
    );
    let builder = http
        .get(&url)
        .map_err(|error| {
            tracing::warn!(%error, url = %url, "[remote_workspace] list_dir build failed");
            error
        })
        .ok()
        .ok_or_else(|| ApiError::service_unavailable("Failed to query remote workspace"))?;
    let mut query: Vec<(&str, String)> =
        vec![("task_id", task_id.to_string()), ("path", path.to_owned())];
    if let Some(name) = executor_name {
        query.push(("executor_name", name.to_owned()));
    }
    let response = builder.query(&query).send().await.map_err(|error| {
        tracing::warn!(%error, url = %url, "[remote_workspace] list_dir request failed");
        ApiError::service_unavailable("Failed to query remote workspace")
    })?;
    let status = response.status().as_u16();
    if status == 404 {
        return Err(ApiError::not_found("Path not found"));
    }
    if status >= 400 {
        return Err(ApiError::bad_gateway("Remote workspace list failed"));
    }
    let bytes = response.bytes().await.map_err(|error| {
        tracing::warn!(%error, url = %url, "[remote_workspace] list_dir body read failed");
        ApiError::bad_gateway("Remote workspace list failed")
    })?;
    serde_json::from_slice::<crate::json_compat::JsonProjection<Vec<Option<ManagerEntry>>>>(&bytes)
        .map(|payload| {
            payload
                .value
                .unwrap_or_default()
                .into_iter()
                .flatten()
                .collect()
        })
        .map_err(|_| ApiError::bad_gateway("Invalid remote workspace response"))
}

fn normalize_timestamp(timestamp: f64) -> Option<String> {
    unix_to_rfc3339_z(timestamp.trunc() as i64, timestamp.fract())
}

/// Convert a Unix timestamp (seconds) to `datetime.fromtimestamp(tz=utc)
/// .isoformat()` with `+00:00` replaced by `Z`, matching source
/// `_normalize_modified_at`.
fn unix_to_rfc3339_z(seconds: i64, fraction: f64) -> Option<String> {
    // Python isoformat uses microsecond precision (6 digits).
    let nanos = (fraction * 1_000_000.0).round() as i64;
    let (carry, micros) = (nanos / 1_000_000, nanos % 1_000_000);
    let seconds = seconds + carry;
    let micros = micros as u32;
    let days = seconds.div_euclid(86_400);
    let secs_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days)?;
    let hour = secs_of_day / 3_600;
    let minute = (secs_of_day % 3_600) / 60;
    let second = secs_of_day % 60;
    let mut formatted = format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}");
    if micros > 0 {
        let micros_text = format!("{micros:06}");
        let trimmed = micros_text.trim_end_matches('0');
        formatted.push('.');
        formatted.push_str(trimmed);
    }
    formatted.push('Z');
    Some(formatted)
}

/// Days-since-epoch to civil date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> Option<(i64, u32, u32)> {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some((year, m as u32, d as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_path_normalizes_to_itself() {
        let root = SANDBOX_HOME_ROOT.to_owned();
        assert_eq!(
            normalize_and_validate_workspace_path(Some("/home/user"), &root).unwrap(),
            "/home/user"
        );
    }

    #[test]
    fn legacy_workspace_path_remaps_to_sandbox_home() {
        let root = SANDBOX_HOME_ROOT.to_owned();
        assert_eq!(
            normalize_and_validate_workspace_path(Some("/workspace/foo"), &root).unwrap(),
            "/home/user/foo"
        );
    }

    #[test]
    fn default_path_uses_root() {
        let root = "/workspace/123".to_owned();
        assert_eq!(
            normalize_and_validate_workspace_path(None, &root).unwrap(),
            "/workspace/123"
        );
    }

    #[test]
    fn legacy_workspace_remaps_into_task_scoped_root() {
        let root = "/workspace/123".to_owned();
        assert_eq!(
            normalize_and_validate_workspace_path(Some("/workspace/foo"), &root).unwrap(),
            "/workspace/123/foo"
        );
    }

    #[test]
    fn path_escape_rejected() {
        let root = "/workspace/123".to_owned();
        assert!(normalize_and_validate_workspace_path(Some("/etc/passwd"), &root).is_err());
    }

    #[test]
    fn dot_segments_resolve() {
        let root = "/home/user".to_owned();
        assert_eq!(
            normalize_and_validate_workspace_path(Some("/home/user/a/../b"), &root).unwrap(),
            "/home/user/b"
        );
    }

    #[test]
    fn sandbox_available_requires_running_and_base_url() {
        let payload = serde_json::json!({"status": "running", "base_url": "http://x"});
        assert!(is_sandbox_available(&ExecutorPayload::parse(
            &serde_json::to_vec(&payload).unwrap()
        )));
        let payload = serde_json::json!({"status": "stopped", "base_url": "http://x"});
        assert!(!is_sandbox_available(&ExecutorPayload::parse(
            &serde_json::to_vec(&payload).unwrap()
        )));
        assert!(!is_sandbox_available(&None));
    }

    #[test]
    fn modified_at_number_converts_to_rfc3339_z() {
        let value: JsonScalar = serde_json::from_str("1788506419").unwrap();
        assert_eq!(value.modified_at().as_deref(), Some("2026-09-04T07:20:19Z"));
    }

    #[test]
    fn modified_at_float_converts_with_fraction() {
        let value: JsonScalar = serde_json::from_str("1788506419.0544927").unwrap();
        // Python `datetime.fromtimestamp` keeps microsecond precision.
        assert_eq!(
            value.modified_at().as_deref(),
            Some("2026-09-04T07:20:19.054493Z")
        );
    }

    #[test]
    fn modified_at_null_is_none() {
        let value: JsonScalar = serde_json::from_str("null").unwrap();
        assert_eq!(value.modified_at(), None);
    }

    #[test]
    fn modified_at_string_passthrough() {
        let value: JsonScalar =
            serde_json::from_str(r#""2026-09-04T07:50:07.427592680Z""#).unwrap();
        assert_eq!(
            value.modified_at().as_deref(),
            Some("2026-09-04T07:50:07.427592680Z")
        );
    }

    #[test]
    fn root_path_prefers_sandbox_home_when_running() {
        let payload = serde_json::json!({"status": "running", "base_url": "http://x"});
        assert_eq!(
            resolve_root_path(
                42,
                &ExecutorPayload::parse(&serde_json::to_vec(&payload).unwrap())
            ),
            "/home/user"
        );
        assert_eq!(resolve_root_path(42, &None), "/workspace/42");
    }
}
