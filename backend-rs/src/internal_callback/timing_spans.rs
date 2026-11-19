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
    status = IF(status = 'running', VALUES(status), status), \
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
    pub label: &'static str,
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
    let Some(timing) = event.data.get("timing").filter(|timing| timing.is_object()) else {
        return Ok(());
    };
    let source = executor_source(executor_name, executor_namespace);
    for mut span in spans(event, timing) {
        if let Some(clock) = timing.get("clock").and_then(Value::as_str) {
            if let Some(metadata) = span.metadata.as_object_mut() {
                metadata.insert("clock".into(), Value::String(clock.to_string()));
            }
        }
        if let Some(metadata) = span.metadata.as_object_mut() {
            metadata.insert("source".into(), Value::String(source.clone()));
        }
        let clock = timing
            .get("clock")
            .and_then(Value::as_str)
            .unwrap_or("executor-manager");
        let duration_ms = span.duration_ms();
        let result = mysql
            .execute(
                INSERT_SPAN_SQL,
                (
                    event.task_id,
                    Some(event.subtask_id),
                    event.subtask_id.to_string(),
                    "",
                    span.span_id.as_str(),
                    span.kind,
                    span.label,
                    "runtime",
                    span.label,
                    span.status,
                    span.start_at_ms,
                    span.end_at_ms,
                    duration_ms,
                    clock,
                    source.as_str(),
                    Json(span.metadata),
                ),
            )
            .await?;
        let _ = result;
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

fn spans(event: &ExecutionEvent, timing: &Value) -> Vec<NewTimingSpan> {
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
        "instanceCreateFinishedAt",
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
    let start_at_ms = integer(start_key);
    let mut end_at_ms = integer(end_key);
    if end_at_ms.is_none() && start_at_ms.is_some() {
        end_at_ms = integer(duration_key).and_then(|duration| start_at_ms?.checked_add(duration));
    }
    if start_at_ms.is_none() && end_at_ms.is_none() {
        return;
    }
    spans.push(NewTimingSpan {
        span_id: format!("task-{}-subtask-{}-{kind}", event.task_id, event.subtask_id),
        kind,
        label,
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
                "agentStartedAt": 6,
                "agentFinishedAt": 9,
            }),
        )]);
        event
    }

    #[test]
    fn extracts_queue_provision_and_agent_spans() {
        let spans = spans(&event(), event().data.get("timing").unwrap());
        assert_eq!(spans.len(), 3);
        assert_eq!(spans[0].kind, "queue");
        assert_eq!(spans[0].duration_ms(), Some(1));
        assert_eq!(spans[1].kind, "provision");
        assert_eq!(spans[1].duration_ms(), Some(2));
        assert_eq!(spans[2].kind, "agent");
        assert_eq!(spans[2].duration_ms(), Some(3));
    }

    #[test]
    fn duration_only_boundaries_start_from_start() {
        let timing = json!({"agentStartedAt": 10, "agentDurationMs": 7});
        let spans = spans(&event(), &timing);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].start_at_ms, Some(10));
        assert_eq!(spans[0].end_at_ms, Some(17));
    }

    #[test]
    fn insert_uses_first_observed_values() {
        assert!(INSERT_SPAN_SQL.contains("ON DUPLICATE KEY UPDATE"));
        assert!(INSERT_SPAN_SQL.contains("IF(start_at_ms IS NULL"));
        assert!(INSERT_SPAN_SQL.contains("IF(end_at_ms IS NULL"));
    }
}
