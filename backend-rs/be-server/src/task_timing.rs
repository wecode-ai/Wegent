// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/:task_id/timing` — task time triage and detailed spans.

use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response, StatusCode};
use serde::Serialize;
use serde_json::Value;

use crate::state::AppState;
use crate::task_pipeline_stage_info_repo as task_repo;

#[brz_http_server::get("/api/tasks/:task_id/timing")]
async fn get_task_timing(
    #[inject(state)] state: &AppState,
    task_id: i64,
    #[auth] current_user: crate::auth::SessionUser,
) -> Result<TaskTimingResponse, ApiError> {
    let task = load_accessible_task(state, task_id, &current_user).await?;
    let session = SessionBoundaries::from_task_row(task.repo_row());
    let owner_user_id = task.user_id();
    let spans = load_spans(state, task_id).await?;
    Ok(aggregate(task_id, owner_user_id, session, spans))
}

#[derive(Debug, brz_mysql::FromMysqlRow)]
struct TimingSpanRow {
    id: i64,
    subtask_id: Option<i64>,
    turn_id: String,
    parent_span_id: String,
    span_id: String,
    kind: String,
    actor_id: String,
    actor_type: String,
    actor_label: String,
    status: String,
    start_at_ms: Option<i64>,
    end_at_ms: Option<i64>,
    duration_ms: Option<i64>,
    clock: String,
    source: String,
    metadata: brz_mysql::Json<Value>,
}

#[derive(Debug, Serialize)]
struct TaskTimingResponse {
    task_id: i64,
    owner_user_id: i64,
    wall_time_ms: Option<i64>,
    session_start_at_ms: Option<i64>,
    session_end_at_ms: Option<i64>,
    triage: Vec<TimingCategory>,
    coverage: Vec<TimingCategory>,
    top_suspects: Vec<TopSuspect>,
    spans: Vec<SpanView>,
    has_spans: bool,
}

#[derive(Debug, Serialize)]
struct TimingCategory {
    kind: &'static str,
    duration_ms: i64,
}

#[derive(Debug, Serialize)]
struct TopSuspect {
    span_id: String,
    label: String,
    category: String,
    duration_ms: i64,
    status: String,
    suggestion: String,
}

#[derive(Debug, Clone, Serialize)]
struct SpanView {
    id: i64,
    subtask_id: Option<i64>,
    turn_id: String,
    parent_span_id: String,
    span_id: String,
    kind: String,
    actor_id: String,
    actor_type: String,
    actor_label: String,
    status: String,
    start_at_ms: Option<i64>,
    end_at_ms: Option<i64>,
    duration_ms: Option<i64>,
    clock: String,
    source: String,
    metadata: Value,
}

struct ApiError {
    status: StatusCode,
    detail: String,
}

impl IntoHttpError for ApiError {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        crate::http_compat::FastApiError::detail(self.status, self.detail).into_http_error(arena)
    }
}

struct AccessibleTask {
    task: task_repo::TaskRow,
}

impl AccessibleTask {
    fn repo_row(&self) -> &task_repo::TaskRow {
        &self.task
    }

    fn user_id(&self) -> i64 {
        self.task.user_id
    }
}

struct SessionBoundaries {
    start_at_ms: Option<i64>,
    end_at_ms: Option<i64>,
}

impl SessionBoundaries {
    fn from_task_row(task: &task_repo::TaskRow) -> Self {
        let timestamp = |value: Option<chrono::NaiveDateTime>| {
            value
                .and_then(|value| value.and_local_timezone(chrono::Local).single())
                .map(|value| value.timestamp_millis())
        };
        Self {
            start_at_ms: timestamp(task.created_at),
            end_at_ms: task.completed_at.as_deref().and_then(crd_timestamp_ms),
        }
    }
}

/// A CRD timestamp is a local ISO string; convert it explicitly so that task
/// boundaries stay comparable with executor Unix epoch milliseconds.
fn crd_timestamp_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
                .ok()
                .and_then(|value| value.and_local_timezone(chrono::Local).single())
                .map(|value| value.with_timezone(&chrono::FixedOffset::east_opt(0).unwrap()))
        })
        .map(|value| value.timestamp_millis())
}

async fn load_accessible_task(
    state: &AppState,
    task_id: i64,
    current_user: &crate::auth::SessionUser,
) -> Result<AccessibleTask, ApiError> {
    let Some(task) = task_repo::get_active_task(&*state.task_store, task_id)
        .await
        .map_err(|error| dependency("read task", error))?
    else {
        return Err(not_found());
    };
    let user_id = i64::from(current_user.id);
    if task.user_id == user_id {
        return Ok(AccessibleTask { task });
    }
    #[derive(brz_mysql::FromMysqlRow)]
    struct MemberRow {
        #[allow(dead_code)]
        id: i64,
    }
    let member: Option<MemberRow> = state
        .mysql
        .fetch_optional(
            "SELECT id FROM resource_members \
             WHERE resource_type='Task' AND resource_id=? \
             AND entity_type='user' AND entity_id=? \
             AND status='approved' AND copied_resource_id=0 LIMIT 1",
            (task_id, user_id.to_string()),
        )
        .await
        .map_err(|error| dependency("read task member", error))?;
    member
        .is_some()
        .then_some(AccessibleTask { task })
        .ok_or_else(not_found)
}

async fn load_spans(state: &AppState, task_id: i64) -> Result<Vec<TimingSpanRow>, ApiError> {
    state
        .mysql
        .fetch_all(
            "SELECT id, subtask_id, turn_id, parent_span_id, span_id, kind, actor_id, \
             actor_type, actor_label, status, start_at_ms, end_at_ms, duration_ms, \
             clock, source, metadata FROM task_timing_spans WHERE task_id=? \
             ORDER BY COALESCE(start_at_ms, 0), id",
            (task_id,),
        )
        .await
        .map_err(|error| dependency("read timing spans", error))
}

fn aggregate(
    task_id: i64,
    owner_user_id: i64,
    session: SessionBoundaries,
    rows: Vec<TimingSpanRow>,
) -> TaskTimingResponse {
    let spans: Vec<SpanView> = rows
        .iter()
        .map(|row| SpanView {
            id: row.id,
            subtask_id: row.subtask_id,
            turn_id: row.turn_id.clone(),
            parent_span_id: row.parent_span_id.clone(),
            span_id: row.span_id.clone(),
            kind: row.kind.clone(),
            actor_id: row.actor_id.clone(),
            actor_type: row.actor_type.clone(),
            actor_label: row.actor_label.clone(),
            status: row.status.clone(),
            start_at_ms: row.start_at_ms,
            end_at_ms: row.end_at_ms,
            duration_ms: row.duration_ms,
            clock: row.clock.clone(),
            source: row.source.clone(),
            metadata: row.metadata.0.clone(),
        })
        .collect();

    let window = session_window(&session, &rows);
    let wall_time_ms = window.map(|(start, end)| (end - start).max(0));
    let has_spans = !spans.is_empty();
    let triage = triage_categories(&spans, window);
    let coverage = coverage_categories(&spans, window);
    let top_suspects = top_suspects(&spans);

    TaskTimingResponse {
        task_id,
        owner_user_id,
        wall_time_ms,
        session_start_at_ms: session.start_at_ms,
        session_end_at_ms: session.end_at_ms,
        triage,
        coverage,
        top_suspects,
        spans,
        has_spans,
    }
}

fn session_window(session: &SessionBoundaries, rows: &[TimingSpanRow]) -> Option<(i64, i64)> {
    let first = session
        .start_at_ms
        .or_else(|| rows.iter().filter_map(|row| row.start_at_ms).min())?;
    let last = session
        .end_at_ms
        .or_else(|| {
            rows.iter()
                .filter_map(|row| row.end_at_ms.or(row.start_at_ms))
                .max()
        })
        .unwrap_or(first)
        .max(first);
    Some((first, last))
}

#[cfg(test)]
mod timestamp_tests {
    use super::*;
    use chrono::NaiveDateTime;

    #[test]
    fn crd_completion_timestamps_are_local_iso_strings() {
        let completed =
            NaiveDateTime::parse_from_str("2026-11-20T12:00:00.123456", "%Y-%m-%dT%H:%M:%S%.f")
                .unwrap();
        let expected = completed
            .and_local_timezone(chrono::Local)
            .single()
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            crd_timestamp_ms("2026-11-20T12:00:00.123456"),
            Some(expected)
        );
    }
}

fn triage_categories(spans: &[SpanView], window: Option<(i64, i64)>) -> Vec<TimingCategory> {
    let tool_intervals = clip_intervals(intervals_by_kinds(spans, &["tool"]), window);
    let subagent_intervals = clip_intervals(intervals_by_kinds(spans, &["subagent"]), window);
    let child_intervals = merge_intervals(&subagent_intervals, &tool_intervals);
    let exclusive_subagent_intervals = subtract_intervals(&subagent_intervals, &tool_intervals);
    let agent_intervals = subtract_intervals(
        &clip_intervals(intervals_by_kinds(spans, &["agent"]), window),
        &child_intervals,
    );
    let mut categories = vec![
        category("tool", union_ms(&tool_intervals)),
        category("subagent", union_ms(&exclusive_subagent_intervals)),
        category("agent", union_ms(&agent_intervals)),
        category(
            "waiting_user",
            union_by_kinds(spans, &["waiting_user"], window),
        ),
        category(
            "runtime",
            union_by_kinds(spans, &["queue", "provision"], window),
        ),
    ];
    let observed = union_ms(&clip_intervals(observable_intervals(spans), window));
    if let Some((start, end)) = window {
        let wall_time_ms = (end - start).max(0);
        categories.push(category("gap", (wall_time_ms - observed).max(0)));
    }
    categories
}

fn coverage_categories(spans: &[SpanView], window: Option<(i64, i64)>) -> Vec<TimingCategory> {
    vec![
        category(
            "agent",
            union_ms(&clip_intervals(
                intervals_by_kinds(spans, &["agent", "subagent"]),
                window,
            )),
        ),
        category(
            "tool",
            union_ms(&clip_intervals(
                intervals_by_kinds(spans, &["tool"]),
                window,
            )),
        ),
        category(
            "subagent",
            union_ms(&clip_intervals(
                intervals_by_kinds(spans, &["subagent"]),
                window,
            )),
        ),
        category(
            "waiting_user",
            union_ms(&clip_intervals(
                intervals_by_kinds(spans, &["waiting_user"]),
                window,
            )),
        ),
        category(
            "runtime",
            union_ms(&clip_intervals(
                intervals_by_kinds(spans, &["queue", "provision"]),
                window,
            )),
        ),
    ]
}

fn category(kind: &'static str, duration_ms: i64) -> TimingCategory {
    TimingCategory { kind, duration_ms }
}

fn union_by_kinds(spans: &[SpanView], kinds: &[&str], window: Option<(i64, i64)>) -> i64 {
    union_ms(&clip_intervals(intervals_by_kinds(spans, kinds), window))
}

fn clip_intervals(intervals: Vec<(i64, i64)>, window: Option<(i64, i64)>) -> Vec<(i64, i64)> {
    let Some((window_start, window_end)) = window else {
        return intervals;
    };
    intervals
        .into_iter()
        .filter_map(|(start, end)| {
            let clipped_start = start.max(window_start);
            let clipped_end = end.min(window_end);
            (clipped_end > clipped_start).then_some((clipped_start, clipped_end))
        })
        .collect()
}

fn intervals_by_kinds(spans: &[SpanView], kinds: &[&str]) -> Vec<(i64, i64)> {
    spans
        .iter()
        .filter(|span| kinds.contains(&span.kind.as_str()))
        .filter_map(|span| {
            let start = span.start_at_ms?;
            let end = span
                .end_at_ms
                .filter(|end| *end >= start)
                .or_else(|| span.duration_ms.map(|duration| start + duration))?;
            Some((start, end))
        })
        .collect()
}

fn merge_intervals(left: &[(i64, i64)], right: &[(i64, i64)]) -> Vec<(i64, i64)> {
    let mut merged = left.to_vec();
    merged.extend_from_slice(right);
    merged.sort();
    normalized_intervals(&merged)
}

fn subtract_intervals(source: &[(i64, i64)], exclusions: &[(i64, i64)]) -> Vec<(i64, i64)> {
    let mut remaining = normalized_intervals(source);
    for &(exclude_start, exclude_end) in normalized_intervals(exclusions).iter() {
        let mut next = Vec::with_capacity(remaining.len());
        for &(start, end) in remaining.iter() {
            if exclude_end <= start || end <= exclude_start {
                next.push((start, end));
                continue;
            }
            if start < exclude_start {
                next.push((start, exclude_start));
            }
            if exclude_end < end {
                next.push((exclude_end, end));
            }
        }
        remaining = next;
    }
    remaining
}

fn normalized_intervals(intervals: &[(i64, i64)]) -> Vec<(i64, i64)> {
    let mut sorted = intervals.to_vec();
    sorted.sort();
    let mut normalized: Vec<(i64, i64)> = Vec::with_capacity(sorted.len());
    for (start, end) in sorted {
        if end <= start {
            continue;
        }
        match normalized.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => normalized.push((start, end)),
        }
    }
    normalized
}

fn observable_intervals(spans: &[SpanView]) -> Vec<(i64, i64)> {
    spans
        .iter()
        .filter_map(|span| {
            let start = span.start_at_ms?;
            let end = span
                .end_at_ms
                .filter(|end| *end >= start)
                .or_else(|| span.duration_ms.map(|duration| start + duration))?;
            Some((start, end))
        })
        .collect()
}

fn union_ms(intervals: &[(i64, i64)]) -> i64 {
    normalized_intervals(intervals)
        .into_iter()
        .map(|(start, end)| end - start)
        .sum()
}

fn top_suspects(spans: &[SpanView]) -> Vec<TopSuspect> {
    let mut candidates: Vec<&SpanView> = spans
        .iter()
        .filter(|span| {
            matches!(
                span.kind.as_str(),
                "tool" | "subagent" | "agent" | "waiting_user" | "queue" | "provision"
            )
        })
        .collect();
    candidates.sort_by_key(|span| -span.duration_ms.unwrap_or(0));
    candidates
        .into_iter()
        .take(5)
        .map(|span| TopSuspect {
            span_id: span.span_id.clone(),
            label: suspect_label(span),
            category: span.kind.clone(),
            duration_ms: span.duration_ms.unwrap_or(0),
            status: span.status.clone(),
            suggestion: suggestion(span),
        })
        .collect()
}

fn suspect_label(span: &SpanView) -> String {
    let block = span.metadata.get("block");
    let name = block
        .and_then(|block| block.get("command"))
        .or_else(|| {
            block
                .and_then(|block| block.get("tool_input"))
                .and_then(|input| input.get("command"))
        })
        .or_else(|| block.and_then(|block| block.get("toolName")))
        .or_else(|| block.and_then(|block| block.get("tool_name")))
        .or_else(|| span.metadata.get("command"))
        .or_else(|| span.metadata.get("toolName"))
        .or_else(|| span.metadata.get("tool_name"))
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty());
    if let Some(name) = name {
        name.to_string()
    } else if !span.actor_label.is_empty() {
        span.actor_label.clone()
    } else {
        span.kind.clone()
    }
}

fn suggestion(span: &SpanView) -> String {
    let command = suspect_label(span).to_ascii_lowercase();
    match span.kind.as_str() {
        "tool" => {
            if command.starts_with("npm ")
                || command.starts_with("pnpm ")
                || command.starts_with("uv ")
                || command.starts_with("cargo ")
            {
                "inspect_registry".to_string()
            } else if command.starts_with("git ") {
                "inspect_git".to_string()
            } else {
                "inspect_tool".to_string()
            }
        }
        "subagent" => "inspect_subagent".to_string(),
        "agent" => "inspect_model".to_string(),
        "waiting_user" => "confirm_waiting".to_string(),
        "queue" | "provision" => "inspect_infra".to_string(),
        _ => "inspect_tool".to_string(),
    }
}

fn not_found() -> ApiError {
    ApiError {
        status: StatusCode::NOT_FOUND,
        detail: "Task not found".to_string(),
    }
}

fn dependency(operation: &'static str, error: brz_mysql::MysqlError) -> ApiError {
    tracing::error!(operation, %error, "[task_timing] database dependency failure");
    ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: "Internal server error".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn span(kind: &str, start: i64, end: i64) -> TimingSpanRow {
        TimingSpanRow {
            id: 1,
            subtask_id: None,
            turn_id: String::new(),
            parent_span_id: String::new(),
            span_id: format!("{kind}-{start}"),
            kind: kind.to_string(),
            actor_id: String::new(),
            actor_type: String::new(),
            actor_label: String::new(),
            status: "completed".to_string(),
            start_at_ms: Some(start),
            end_at_ms: Some(end),
            duration_ms: Some(end - start),
            clock: "executor".to_string(),
            source: "test".to_string(),
            metadata: brz_mysql::Json(json!({})),
        }
    }

    fn session(start: Option<i64>, end: Option<i64>) -> SessionBoundaries {
        SessionBoundaries {
            start_at_ms: start,
            end_at_ms: end,
        }
    }

    #[test]
    fn top_suspects_prefer_command_from_tool_blocks() {
        let mut row = span("tool", 0, 150);
        row.metadata = brz_mysql::Json(json!({
            "block": {
                "tool_name": "bash",
                "tool_input": {"command": "pnpm test"}
            }
        }));
        row.actor_label = "bash".to_string();

        let suspect = &aggregate(1, 7, session(None, None), vec![row]).top_suspects[0];
        assert_eq!(suspect.label, "pnpm test");
        assert_eq!(suspect.suggestion, "inspect_registry");
    }

    #[test]
    fn parallel_spans_do_not_double_wall_time() {
        let rows = vec![span("subagent", 0, 10), span("subagent", 0, 10)];
        let response = aggregate(1, 7, session(None, None), rows);
        let subagent = response
            .coverage
            .iter()
            .find(|item| item.kind == "subagent")
            .unwrap();
        assert_eq!(subagent.duration_ms, 10);
    }

    #[test]
    fn triage_separates_tool_and_agent() {
        let rows = vec![span("agent", 0, 20), span("tool", 5, 15)];
        let response = aggregate(1, 7, session(None, None), rows);
        assert_eq!(response.wall_time_ms, Some(20));
        let get = |kind: &str| {
            response
                .triage
                .iter()
                .find(|item| item.kind == kind)
                .unwrap()
                .duration_ms
        };
        assert_eq!(get("tool"), 10);
        assert_eq!(get("agent"), 10);
        assert_eq!(get("gap"), 0);
    }

    #[test]
    fn triage_categories_do_not_double_overlap() {
        let rows = vec![
            span("agent", 0, 20),
            span("subagent", 5, 15),
            span("tool", 6, 10),
        ];
        let response = aggregate(1, 7, session(None, None), rows);
        let get = |kind: &str| {
            response
                .triage
                .iter()
                .find(|item| item.kind == kind)
                .unwrap()
                .duration_ms
        };
        assert_eq!(get("tool"), 4);
        assert_eq!(get("subagent"), 6);
        assert_eq!(get("agent"), 10);
        assert_eq!(get("gap"), 0);
    }

    #[test]
    fn task_boundaries_define_session_wall_time() {
        let rows = vec![span("agent", 20, 50), span("tool", 0, 30)];
        let response = aggregate(1, 7, session(Some(10), Some(100)), rows);
        assert_eq!(response.wall_time_ms, Some(90));
        let get = |kind: &str| {
            response
                .triage
                .iter()
                .find(|item| item.kind == kind)
                .unwrap()
                .duration_ms
        };
        assert_eq!(get("tool"), 20);
        assert_eq!(get("agent"), 20);
        let gap = response
            .triage
            .iter()
            .find(|item| item.kind == "gap")
            .unwrap();
        assert_eq!(gap.duration_ms, 50);
    }

    #[test]
    fn running_task_uses_creation_time_as_start() {
        let rows = vec![span("agent", 20, 50)];
        let response = aggregate(1, 7, session(Some(10), None), rows);
        assert_eq!(response.wall_time_ms, Some(40));
    }
}
