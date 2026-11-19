// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task timing span extraction and idempotent persistence.
//!
//! Timing is diagnostic data: a database failure is logged but never changes
//! the callback's task-completion result.
use brz_mysql::{Json, Mysql};
use serde_json::{Value, json};

use super::event::ExecutionEvent;

const INSERT_SPAN_SQL: &str = "INSERT INTO task_timing_spans \
    (task_id, subtask_id, turn_id, parent_span_id, span_id, kind, actor_id, actor_type, actor_label, status, start_at_ms, end_at_ms, duration_ms, clock, source, metadata) \
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
    ON DUPLICATE KEY UPDATE \
    subtask_id = IF(subtask_id IS NULL, VALUES(subtask_id), subtask_id), \
    turn_id = IF(turn_id = '', VALUES(turn_id), turn_id), \
    parent_span_id = IF(parent_span_id = '', VALUES(parent_span_id), parent_span_id), \
    actor_id = IF(actor_id = '', VALUES(actor_id), actor_id), \
    actor_type = IF(actor_type = '', VALUES(actor_type), actor_type), \
    actor_label = IF(actor_label = '', VALUES(actor_label), actor_label), \
    status = IF(status IN ('running', 'waiting'), VALUES(status), status), \
    start_at_ms = IF(start_at_ms IS NULL, VALUES(start_at_ms), start_at_ms), \
    end_at_ms = IF(end_at_ms IS NULL, VALUES(end_at_ms), end_at_ms), \
    duration_ms = IF(duration_ms IS NULL, VALUES(duration_ms), duration_ms), \
    clock = IF(clock = '', VALUES(clock), clock), \
    source = IF(source = '', VALUES(source), source), \
    metadata = IF(JSON_LENGTH(metadata) = 0, VALUES(metadata), metadata)";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NewTimingSpan {
    pub span_id: String,
    pub kind: &'static str,
    pub parent_span_id: Option<String>,
    pub actor_id: String,
    pub actor_type: &'static str,
    pub actor_label: String,
    pub status: &'static str,
    pub start_at_ms: Option<i64>,
    pub end_at_ms: Option<i64>,
    pub metadata: Value,
}

impl NewTimingSpan {
    fn duration_ms(&self) -> Option<i64> {
        Some(self.end_at_ms?.checked_sub(self.start_at_ms?)?.max(0))
    }
}

pub(crate) async fn persist_callback_timing<M: Mysql>(
    mysql: &M,
    event: &ExecutionEvent,
    executor_name: Option<&str>,
    executor_namespace: Option<&str>,
) -> Result<(), brz_mysql::MysqlError> {
    let mut spans = event_timing_spans(event);
    if let Some(timing) = event.data.get("timing").filter(|timing| timing.is_object()) {
        spans.extend(boundary_spans(event, timing));
    }
    if let Some(span) = waiting_user_span(event) {
        spans.push(span);
    }
    if spans.is_empty() {
        return Ok(());
    }
    let source = executor_source(executor_name, executor_namespace);
    let clock = event
        .data
        .get("timing")
        .and_then(|timing| timing.get("clock"))
        .and_then(Value::as_str)
        .unwrap_or("executor")
        .to_string();
    let default_clock = clock.as_str();
    for mut span in spans {
        let span_clock = span_clock(span.kind, default_clock);
        if let Some(metadata) = span.metadata.as_object_mut() {
            metadata.insert("clock".into(), Value::String(span_clock.to_string()));
            metadata.insert("source".into(), Value::String(source.clone()));
        }
        let duration_ms = span.duration_ms();
        mysql
            .execute(
                INSERT_SPAN_SQL,
                (
                    event.task_id,
                    Some(event.subtask_id),
                    event.subtask_id.to_string(),
                    span.parent_span_id.as_deref().unwrap_or(""),
                    span.span_id.as_str(),
                    span.kind,
                    span.actor_id.as_str(),
                    span.actor_type,
                    span.actor_label.as_str(),
                    span.status,
                    span.start_at_ms,
                    span.end_at_ms,
                    duration_ms,
                span_clock.as_str(),
                    source.as_str(),
                    Json(span.metadata),
                ),
            )
            .await?;
    }
    Ok(())
}

fn executor_source(executor_name: Option<&str>, executor_namespace: Option<&str>) -> String {
    match (executor_name, executor_namespace) {
        (Some(name), Some(namespace)) => format!("{name}/{namespace}"),
        (Some(name), None) => name.to_string(),
        (None, Some(namespace)) => format!("unknown/{namespace}"),
        (None, None) => "executor".to_string(),
    }
}

fn span_clock(kind: &str, default_clock: &str) -> String {
    match kind {
        "queue" | "provision" => "executor-manager".to_string(),
        "tool" | "subagent" | "agent" | "waiting_user" => "executor".to_string(),
        _ => default_clock.to_string(),
    }
}

fn event_timing_spans(event: &ExecutionEvent) -> Vec<NewTimingSpan> {
    match event.event_type.as_str() {
        "block_created" => block_event_spans(event),
        "block_updated" => subagent_activity_spans(event),
        _ => Vec::new(),
    }
}

fn subagent_activity_spans(event: &ExecutionEvent) -> Vec<NewTimingSpan> {
    let agent_id = event
        .data
        .get("agent_thread_id")
        .or_else(|| event.data.get("agent_id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let occurred_at = event.data.get("occurred_at_ms").and_then(Value::as_i64);
    if agent_id.is_empty() || occurred_at.is_none() {
        return Vec::new();
    }
    let status: &'static str = event
        .data
        .get("status")
        .and_then(Value::as_str)
        .and_then(|status| match status {
            "running" => Some("running"),
            "done" => Some("completed"),
            "error" | "interrupted" | "cancelled" | "canceled" => Some("failed"),
            _ => None,
        })
        .unwrap_or("running");
    let end_at_ms = if status != "running" {
        occurred_at
    } else {
        None
    };
    vec![NewTimingSpan {
        span_id: subagent_span_id(event, agent_id),
        kind: "subagent",
        parent_span_id: Some(format!(
            "task-{}-subtask-{}-agent",
            event.task_id, event.subtask_id
        )),
        actor_id: agent_id.to_string(),
        actor_type: "subagent",
        actor_label: event
            .data
            .get("agent_path")
            .or_else(|| event.data.get("agent_name"))
            .and_then(Value::as_str)
            .unwrap_or(agent_id)
            .to_string(),
        status,
        start_at_ms: occurred_at,
        end_at_ms,
        metadata: json!({"activity": event.data.clone()}),
    }]
}

fn subagent_span_id(event: &ExecutionEvent, agent_id: &str) -> String {
    format!(
        "task-{}-subtask-{}-subagent-{agent_id}",
        event.task_id, event.subtask_id
    )
}

fn waiting_user_span(event: &ExecutionEvent) -> Option<NewTimingSpan> {
    if event.event_type != "done" {
        return None;
    }
    let result = event.result.as_ref()?;
    if result.get("silent_exit_reason").and_then(Value::as_str) != Some("waiting_for_user_input") {
        return None;
    }
    let timing = event.data.get("timing")?;
    let start_at_ms = timing.get("agentFinishedAt").and_then(Value::as_i64)?;
    Some(NewTimingSpan {
        span_id: format!(
            "task-{}-subtask-{}-waiting-user",
            event.task_id, event.subtask_id
        ),
        kind: "waiting_user",
        parent_span_id: Some(format!(
            "task-{}-subtask-{}-agent",
            event.task_id, event.subtask_id
        )),
        actor_id: "user".to_string(),
        actor_type: "user",
        actor_label: "Waiting for user".to_string(),
        status: "waiting",
        start_at_ms: Some(start_at_ms),
        end_at_ms: None,
        metadata: json!({"result": result.clone()}),
    })
}

fn block_event_spans(event: &ExecutionEvent) -> Vec<NewTimingSpan> {
    let Some(block) = event.data.get("block").filter(|block| block.is_object()) else {
        return Vec::new();
    };
    let Some(kind) = block_kind(block) else {
        return Vec::new();
    };
    let start_at_ms = integer_field(block, "timestamp")
        .or_else(|| integer_field(block, "createdAt"))
        .or_else(|| integer_field(block, "created_at"));
    let Some(start_at_ms) = start_at_ms else {
        return Vec::new();
    };
    let completed_at =
        integer_field(block, "completedAt").or_else(|| integer_field(block, "completed_at"));
    let duration_ms =
        integer_field(block, "durationMs").or_else(|| integer_field(block, "duration_ms"));
    let end_at_ms =
        completed_at.or_else(|| duration_ms.and_then(|duration| start_at_ms.checked_add(duration)));
    let id = block
        .get("id")
        .or_else(|| block.get("tool_use_id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if id.is_empty() {
        return Vec::new();
    }
    let status: &'static str = block
        .get("status")
        .and_then(Value::as_str)
        .and_then(|status| match status {
            "running" => Some("running"),
            "done" => Some("completed"),
            "error" => Some("failed"),
            _ => None,
        })
        .unwrap_or(if end_at_ms.is_some() {
            "completed"
        } else {
            "running"
        });
    let span_id = if kind == "subagent" {
        block
            .get("agent_thread_id")
            .or_else(|| block.get("agent_id"))
            .and_then(Value::as_str)
            .map(|agent_id| subagent_span_id(event, agent_id))
    } else {
        Some(span_id(event, kind, id))
    };
    let Some(span_id) = span_id else {
        return Vec::new();
    };

    vec![NewTimingSpan {
        span_id,
        kind,
        parent_span_id: parent_span_id(event, kind),
        actor_id: actor_id(block, kind),
        actor_type: kind,
        actor_label: actor_label(block, kind),
        status,
        start_at_ms: Some(start_at_ms),
        end_at_ms,
        metadata: json!({"block": block.clone()}),
    }]
}

fn span_id(event: &ExecutionEvent, kind: &str, id: &str) -> String {
    format!(
        "task-{}-subtask-{}-{kind}-{id}",
        event.task_id, event.subtask_id
    )
}

fn block_kind(block: &Value) -> Option<&'static str> {
    match block.get("type").and_then(Value::as_str) {
        Some("tool") => Some("tool"),
        Some("subagent") => Some("subagent"),
        _ => None,
    }
}

fn parent_span_id(event: &ExecutionEvent, kind: &str) -> Option<String> {
    (kind == "subagent")
        .then(|| format!("task-{}-subtask-{}-agent", event.task_id, event.subtask_id))
}

fn actor_id(block: &Value, kind: &str) -> String {
    if kind == "subagent" {
        block
            .get("agent_thread_id")
            .or_else(|| block.get("agent_id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    } else {
        block
            .get("tool_use_id")
            .or_else(|| block.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    }
}

fn actor_label(block: &Value, kind: &str) -> String {
    if kind == "subagent" {
        block
            .get("agent_path")
            .or_else(|| block.get("agent_name"))
            .or_else(|| block.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("Subagent")
            .to_string()
    } else {
        block
            .get("tool_name")
            .or_else(|| block.get("command"))
            .or_else(|| block.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("Tool")
            .to_string()
    }
}

fn integer_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn boundary_spans(event: &ExecutionEvent, timing: &Value) -> Vec<NewTimingSpan> {
    let mut spans = Vec::new();
    push_boundary_span(
        &mut spans,
        event,
        timing,
        "queue",
        "Queue",
        "enqueuedAt",
        "dequeuedAt",
        "queueDurationMs",
    );
    push_boundary_span(
        &mut spans,
        event,
        timing,
        "provision",
        "Runtime provision",
        "instanceCreateStartedAt",
        "taskDispatchedAt",
        "provisionDurationMs",
    );
    push_boundary_span(
        &mut spans,
        event,
        timing,
        "agent",
        "Agent execution",
        "agentStartedAt",
        "agentFinishedAt",
        "agentDurationMs",
    );
    spans
}

#[allow(clippy::too_many_arguments)]
fn push_boundary_span(
    spans: &mut Vec<NewTimingSpan>,
    event: &ExecutionEvent,
    timing: &Value,
    kind: &'static str,
    label: &'static str,
    start_key: &str,
    end_key: &str,
    duration_key: &str,
) {
    let integer = |key: &str| timing.get(key).and_then(Value::as_i64);
    let end_value = integer(end_key);
    let start_at_ms = integer(start_key)
        .or_else(|| integer(duration_key).and_then(|duration| end_value?.checked_sub(duration)));
    let mut end_at_ms = end_value;
    if end_at_ms.is_none() && start_at_ms.is_some() {
        end_at_ms = integer(duration_key).and_then(|duration| start_at_ms?.checked_add(duration));
    }
    if start_at_ms.is_none() && end_at_ms.is_none() {
        return;
    }
    spans.push(NewTimingSpan {
        span_id: format!("task-{}-subtask-{}-{kind}", event.task_id, event.subtask_id),
        kind,
        parent_span_id: None,
        actor_id: label.to_string(),
        actor_type: "runtime",
        actor_label: label.to_string(),
        status: if end_at_ms.is_some() {
            "completed"
        } else {
            "running"
        },
        start_at_ms,
        end_at_ms,
        metadata: json!({
            "startBoundary": start_key,
            "endBoundary": end_key,
        }),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;

    fn event() -> ExecutionEvent {
        let mut event = ExecutionEvent::new(super::super::event::EventType::Done, 7, 11);
        event.data = Map::from_iter([(
            "timing".to_string(),
            json!({
                "enqueuedAt": 1,
                "dequeuedAt": 2,
                "instanceCreateStartedAt": 3,
                "instanceCreateFinishedAt": 5,
                "taskDispatchedAt": 10,
                "agentStartedAt": 6,
                "agentFinishedAt": 9,
            }),
        )]);
        event
    }

    fn done_event(data: Value, result: Value) -> ExecutionEvent {
        let mut event = ExecutionEvent::new(super::super::event::EventType::Done, 7, 11);
        event.data = data.as_object().cloned().unwrap_or_default();
        event.result = Some(result);
        event
    }

    fn block_event(event_type: super::super::event::EventType, data: Value) -> ExecutionEvent {
        let mut event = ExecutionEvent::new(event_type, 7, 11);
        event.data = data.as_object().cloned().unwrap_or_default();
        event
    }

    #[test]
    fn extracts_queue_provision_and_agent_spans() {
        let spans = boundary_spans(&event(), event().data.get("timing").unwrap());
        assert_eq!(spans.len(), 3);
        assert_eq!(spans[0].kind, "queue");
        assert_eq!(spans[0].duration_ms(), Some(1));
        assert_eq!(spans[1].kind, "provision");
        assert_eq!(spans[1].duration_ms(), Some(7));
        assert_eq!(spans[2].kind, "agent");
        assert_eq!(spans[2].duration_ms(), Some(3));
    }

    #[test]
    fn reused_containers_record_dispatch_to_provision_boundary() {
        let timing = json!({
            "instanceReadyAt": 10,
            "taskDispatchedAt": 20,
            "provisionDurationMs": 10
        });
        let spans = boundary_spans(&event(), &timing);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].kind, "provision");
        assert_eq!(spans[0].start_at_ms, Some(10));
        assert_eq!(spans[0].end_at_ms, Some(20));
    }

    #[test]
    fn duration_only_boundaries_start_from_start() {
        let timing = json!({"agentStartedAt": 10, "agentDurationMs": 7});
        let spans = boundary_spans(&event(), &timing);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].start_at_ms, Some(10));
        assert_eq!(spans[0].end_at_ms, Some(17));
    }

    #[test]
    fn waiting_for_user_results_create_waiting_user_spans() {
        let event = done_event(
            json!({"timing": {"agentStartedAt": 10, "agentFinishedAt": 20}}),
            json!({"silent_exit_reason": "waiting_for_user_input"}),
        );
        let spans = event_timing_spans(&event);
        assert!(spans.is_empty());

        let mut spans = boundary_spans(&event, event.data.get("timing").unwrap());
        spans.extend(std::iter::once(waiting_user_span(&event).unwrap()));
        assert_eq!(spans.len(), 2);
        let waiting = spans.last().unwrap();
        assert_eq!(waiting.kind, "waiting_user");
        assert_eq!(waiting.start_at_ms, Some(20));
        assert_eq!(waiting.end_at_ms, None);
        assert_eq!(waiting.status, "waiting");
    }

    #[test]
    fn extracts_tool_blocks_from_created_events() {
        let event = block_event(
            super::super::event::EventType::BlockCreated,
            json!({
                "block": {
                    "id": "tool-1",
                    "type": "tool",
                    "tool_use_id": "tool-1",
                    "tool_name": "exec",
                    "status": "done",
                    "timestamp": 100,
                    "completedAt": 250,
                    "durationMs": 150
                }
            }),
        );
        let spans = event_timing_spans(&event);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].kind, "tool");
        assert_eq!(spans[0].actor_label, "exec");
        assert_eq!(spans[0].duration_ms(), Some(150));
    }

    #[test]
    fn extracts_subagent_blocks_with_parent() {
        let event = block_event(
            super::super::event::EventType::BlockCreated,
            json!({
                "block": {
                    "id": "subagent-1",
                    "type": "subagent",
                    "agent_thread_id": "worker-1",
                    "agent_path": "/root/worker",
                    "status": "running",
                    "timestamp": 300
                }
            }),
        );
        let spans = event_timing_spans(&event);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].kind, "subagent");
        assert_eq!(spans[0].actor_id, "worker-1");
        assert_eq!(
            spans[0].parent_span_id.as_deref(),
            Some("task-7-subtask-11-agent")
        );
        assert_eq!(spans[0].status, "running");
        assert_eq!(spans[0].span_id, "task-7-subtask-11-subagent-worker-1");
    }

    #[test]
    fn block_updates_do_not_infer_tool_spans() {
        let event = block_event(
            super::super::event::EventType::BlockUpdated,
            json!({
                "block_id": "tool-1",
                "updates": {"completedAt": 250, "durationMs": 150}
            }),
        );
        let spans = event_timing_spans(&event);
        assert!(spans.is_empty());
    }

    #[test]
    fn subagent_activity_updates_start_or_end_boundaries() {
        let started = block_event(
            super::super::event::EventType::BlockUpdated,
            json!({
                "agent_thread_id": "worker-1",
                "agent_path": "/root/worker",
                "status": "running",
                "occurred_at_ms": 100
            }),
        );
        let spans = event_timing_spans(&started);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].start_at_ms, Some(100));
        assert_eq!(spans[0].end_at_ms, None);

        let done = block_event(
            super::super::event::EventType::BlockUpdated,
            json!({
                "agent_thread_id": "worker-1",
                "agent_path": "/root/worker",
                "status": "interrupted",
                "occurred_at_ms": 200
            }),
        );
        let spans = event_timing_spans(&done);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].end_at_ms, Some(200));
        assert_eq!(spans[0].status, "failed");
    }

    #[test]
    fn subagent_block_updates_do_not_create_tool_spans() {
        let event = block_event(
            super::super::event::EventType::BlockUpdated,
            json!({
                "block_id": "subagent-worker-1",
                "updates": {"completedAt": 250, "durationMs": 150}
            }),
        );
        assert!(event_timing_spans(&event).is_empty());
    }

    #[test]
    fn insert_uses_first_observed_values() {
        assert!(INSERT_SPAN_SQL.contains("ON DUPLICATE KEY UPDATE"));
        assert!(INSERT_SPAN_SQL.contains("IF(start_at_ms IS NULL"));
        assert!(INSERT_SPAN_SQL.contains("IF(end_at_ms IS NULL"));
    }
}
