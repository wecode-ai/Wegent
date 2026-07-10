// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use serde_json::json;

pub(crate) fn is_unmapped_pending_codex_shadow(
    link: &RuntimeTaskLink,
    discovered_codex_task_signatures: &HashSet<String>,
) -> bool {
    is_unmapped_pending_codex_task(link)
        && codex_task_signature(link)
            .as_ref()
            .is_some_and(|signature| discovered_codex_task_signatures.contains(signature))
}

pub(crate) fn normalize_inactive_running_codex_task(link: &mut RuntimeTaskLink) -> bool {
    if !is_inactive_running_codex_task(link) {
        return false;
    }
    link.status = "active".to_owned();
    link.running = false;
    link.updated_at = now_ms();
    true
}

pub(crate) fn is_inactive_running_codex_task(link: &RuntimeTaskLink) -> bool {
    if !link.running || !is_codex_runtime(&link.runtime) {
        return false;
    }
    let status = link.status.replace(['_', '-'], "").to_ascii_lowercase();
    matches!(
        status.as_str(),
        "running" | "inprogress" | "busy" | "pending"
    )
}

pub(crate) fn is_unmapped_pending_codex_task(link: &RuntimeTaskLink) -> bool {
    if !is_inactive_running_codex_task(link) {
        return false;
    }
    link.thread_id.is_none()
}

pub(crate) fn codex_task_signature(link: &RuntimeTaskLink) -> Option<String> {
    if !is_codex_runtime(&link.runtime) {
        return None;
    }
    let title = link.title.trim().to_ascii_lowercase();
    if title.is_empty() || link.workspace_path.trim().is_empty() {
        return None;
    }
    Some(format!(
        "{}\0{}",
        workspace_group_path(&link.workspace_path),
        title
    ))
}

pub(crate) fn task_fields(task_id: &str, subtask_id: &str) -> Vec<(&'static str, String)> {
    vec![
        ("task_id", task_id.to_owned()),
        ("subtask_id", subtask_id.to_owned()),
    ]
}

pub(crate) fn request_user_input_response(payload: &Value) -> Option<Value> {
    payload
        .get("requestUserInputResponse")
        .or_else(|| payload.get("request_user_input_response"))
        .filter(|value| value.is_object())
        .cloned()
}

pub(crate) fn empty_request_user_input_response() -> Value {
    json!({ "answers": {} })
}

pub(crate) struct RuntimeTranscriptLog<'a> {
    pub(crate) started_at: Instant,
    pub(crate) local_task_id: &'a str,
    pub(crate) thread_id: &'a str,
    pub(crate) source: &'a str,
    pub(crate) refresh: bool,
    pub(crate) running_hint: bool,
    pub(crate) limit: Option<usize>,
    pub(crate) before_cursor: Option<&'a str>,
    pub(crate) after_cursor: Option<&'a str>,
    pub(crate) message_count: usize,
    pub(crate) running: bool,
}

pub(crate) struct RuntimeProjectFilterLog<'a> {
    pub(crate) action: &'a str,
    pub(crate) reason: &'a str,
    pub(crate) workspace_kind: &'a str,
    pub(crate) group_path: Option<&'a str>,
    pub(crate) matched_by: Option<&'a str>,
    pub(crate) project_workspace_path: Option<&'a str>,
    pub(crate) project_name: Option<&'a str>,
    pub(crate) thread_hint: Option<&'a str>,
    pub(crate) project_count: usize,
}

pub(crate) fn log_runtime_project_filter_item(
    link: &RuntimeTaskLink,
    details: RuntimeProjectFilterLog<'_>,
) {
    log_executor_event(
        "runtime work project filter item",
        &[
            ("action", details.action.to_owned()),
            ("reason", details.reason.to_owned()),
            ("local_task_id", link.local_task_id.clone()),
            (
                "thread_id",
                link.thread_id.as_deref().unwrap_or("none").to_owned(),
            ),
            ("title", link.title.clone()),
            ("runtime", link.runtime.clone()),
            ("status", link.status.clone()),
            ("workspace_path", link.workspace_path.clone()),
            ("workspace_kind", details.workspace_kind.to_owned()),
            ("group_path", optional_str(details.group_path)),
            ("matched_by", optional_str(details.matched_by)),
            (
                "project_workspace_path",
                optional_str(details.project_workspace_path),
            ),
            ("project_name", optional_str(details.project_name)),
            ("thread_hint", optional_str(details.thread_hint)),
            ("project_count", details.project_count.to_string()),
        ],
    );
}

pub(crate) fn log_runtime_archive_link(event: &str, link: &RuntimeTaskLink, archived_query: bool) {
    log_executor_event(
        event,
        &[
            ("archived_query", archived_query.to_string()),
            ("local_task_id", link.local_task_id.clone()),
            (
                "thread_id",
                link.thread_id.as_deref().unwrap_or("none").to_owned(),
            ),
            ("workspace_path", link.workspace_path.clone()),
            ("runtime", link.runtime.clone()),
            ("status", link.status.clone()),
            ("running", link.running.to_string()),
            (
                "session_id",
                runtime_session_id_from_link(link).unwrap_or_else(|| "none".to_owned()),
            ),
        ],
    );
}

pub(crate) fn log_runtime_transcript_finished(details: RuntimeTranscriptLog<'_>) {
    log_executor_event(
        "runtime work transcript finished",
        &[
            ("elapsed_ms", elapsed_ms(details.started_at)),
            ("local_task_id", details.local_task_id.to_owned()),
            ("thread_id", details.thread_id.to_owned()),
            ("source", details.source.to_owned()),
            ("refresh", details.refresh.to_string()),
            ("running_hint", details.running_hint.to_string()),
            ("running", details.running.to_string()),
            ("limit", optional_usize(details.limit)),
            ("before_cursor", details.before_cursor.is_some().to_string()),
            ("after_cursor", details.after_cursor.is_some().to_string()),
            ("messages", details.message_count.to_string()),
        ],
    );
}

pub(crate) fn elapsed_ms(started_at: Instant) -> String {
    started_at.elapsed().as_millis().to_string()
}

pub(crate) fn optional_usize(value: Option<usize>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "none".to_owned())
}

pub(crate) fn optional_str(value: Option<&str>) -> String {
    value
        .map(str::to_owned)
        .unwrap_or_else(|| "none".to_owned())
}

pub(crate) fn codex_project_workspaces(
    project_index: &CodexGlobalProjectIndex,
) -> Vec<RuntimeWorkspaceLink> {
    let now = now_ms();
    project_index
        .projects()
        .iter()
        .map(|project| RuntimeWorkspaceLink {
            workspace_path: project.workspace_path.clone(),
            title: project.name.clone(),
            runtime: "codex".to_owned(),
            created_at: now,
            updated_at: now,
            workspace_source: project.source.clone(),
            remote_host_id: project.remote_host_id.clone(),
        })
        .collect()
}

pub(crate) fn codex_started_thread_id(message: &Value) -> Option<String> {
    let notification = codex_notification(message);
    if notification.method != "thread/started" {
        return None;
    }
    notification
        .params
        .get("thread")
        .and_then(|thread| string_field(thread, "id"))
        .or_else(|| string_field(notification.params, "threadId"))
        .or_else(|| string_field(notification.params, "thread_id"))
}

pub(crate) fn pending_thread_event_route_id(local_task_id: &str) -> String {
    format!("{PENDING_THREAD_EVENT_ROUTE_PREFIX}{local_task_id}")
}

pub(crate) fn is_pending_thread_event_route_id(route_id: &str) -> bool {
    route_id.starts_with(PENDING_THREAD_EVENT_ROUTE_PREFIX)
}

pub(crate) fn codex_notification_thread_id(message: &Value) -> Option<String> {
    let notification = codex_notification(message);
    codex_stream_thread_id(notification.params).or_else(|| codex_stream_thread_id(message))
}

pub(crate) fn codex_stream_thread_id(value: &Value) -> Option<String> {
    string_field(value, "threadId")
        .or_else(|| string_field(value, "thread_id"))
        .or_else(|| {
            value.get("item").and_then(|item| {
                string_field(item, "threadId").or_else(|| string_field(item, "thread_id"))
            })
        })
        .or_else(|| {
            value.get("payload").and_then(|payload| {
                string_field(payload, "threadId").or_else(|| string_field(payload, "thread_id"))
            })
        })
        .or_else(|| {
            value.get("thread").and_then(|thread| {
                string_field(thread, "id")
                    .or_else(|| string_field(thread, "threadId"))
                    .or_else(|| string_field(thread, "thread_id"))
            })
        })
}

pub(crate) fn debug_unrouted_codex_notification(message: &Value, reason: &str) {
    let notification = codex_notification(message);
    log_executor_event(
        "runtime work codex notification unrouted",
        &[
            ("reason", reason.to_owned()),
            ("method", notification.method),
            (
                "raw_len",
                serde_json::to_string(message)
                    .map(|raw| raw.len().to_string())
                    .unwrap_or_else(|_| "0".to_owned()),
            ),
        ],
    );
}

pub(crate) fn runtime_event_request_from_link(link: &RuntimeTaskLink) -> ExecutionRequest {
    ExecutionRequest {
        task_id: link.local_task_id.clone(),
        subtask_id: format!("{}-context-compact", link.local_task_id),
        project_workspace_path: Some(link.workspace_path.clone()),
        prompt: Value::String(link.title.clone()),
        ..ExecutionRequest::default()
    }
}

pub(crate) fn runtime_project_workspace_path(
    payload: &Value,
    project_index: &CodexGlobalProjectIndex,
) -> Option<String> {
    workspace_path(payload)
        .map(|path| {
            project_index
                .project_for_key(&path)
                .map(|project| project.workspace_path.clone())
                .unwrap_or_else(|| workspace_group_path(&path))
        })
        .or_else(|| {
            let key = string_field(payload, "runtimeProjectKey")
                .or_else(|| string_field(payload, "runtime_project_key"))?;
            let normalized_key = key.strip_prefix("local:").unwrap_or(&key);
            project_index
                .project_for_key(normalized_key)
                .map(|project| project.workspace_path.clone())
                .or_else(|| {
                    Some(super::super::super::util::normalize_workspace_path(
                        normalized_key,
                    ))
                })
        })
}

#[derive(Clone, Default)]
pub(crate) struct CodexThreadListCache {
    state: Arc<Mutex<CodexThreadListCacheState>>,
}

#[derive(Default)]
pub(crate) struct CodexThreadListCacheState {
    active: Option<CachedCodexThreadList>,
    archived: Option<CachedCodexThreadList>,
}

#[derive(Clone)]
pub(crate) struct CachedCodexThreadList {
    loaded_at: i64,
    threads: Vec<Value>,
}

impl CodexThreadListCache {
    pub(crate) fn get(&self, archived: bool) -> Option<Vec<Value>> {
        let state = self.state.lock().ok()?;
        let cached = if archived {
            state.archived.as_ref()
        } else {
            state.active.as_ref()
        }?;
        if now_ms().saturating_sub(cached.loaded_at) > CODEX_THREAD_LIST_CACHE_TTL_MS {
            return None;
        }
        Some(cached.threads.clone())
    }

    pub(crate) fn set(&self, archived: bool, threads: Vec<Value>) {
        if let Ok(mut state) = self.state.lock() {
            let cached = Some(CachedCodexThreadList {
                loaded_at: now_ms(),
                threads,
            });
            if archived {
                state.archived = cached;
            } else {
                state.active = cached;
            }
        }
    }

    pub(crate) fn find_thread(&self, thread_id: &str) -> Option<Value> {
        let state = self.state.lock().ok()?;
        state
            .active
            .as_ref()
            .into_iter()
            .chain(state.archived.as_ref())
            .flat_map(|cached| cached.threads.iter())
            .find(|thread| string_field(thread, "id").as_deref() == Some(thread_id))
            .cloned()
    }

    pub(crate) fn invalidate(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.active = None;
            state.archived = None;
        }
    }
}
