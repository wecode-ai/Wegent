// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the completion's statement shapes.
//!
//! `SubscriptionTaskCompletionHandler.on_task_completed`
//! (`app/services/subscription/task_completion_handler.py:78-181`) resolves the
//! execution once through `_find_execution_by_task_id`, maps the terminal status
//! before any database work, and hands the resolved row to the status update.
//! Recording `20261027105553` (case `f742360f-b080-4725-b980-6af764719500`)
//! carries exactly one task-id execution read and no second lookup.
#![cfg(test)]

use chrono::NaiveDateTime;
use serde_json::json;

use super::completion::terminal_result;
use super::model;
use crate::internal_callback::completion::TaskCompletedEvent;

fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn execution() -> model::Execution {
    let clock = NaiveDateTime::default();
    model::Execution {
        id: 2_539_501,
        user_id: 3650,
        subscription_id: 264_564,
        task_id: 501_652_180_355_339,
        inbox_message_id: 0,
        trigger_reason: String::new(),
        prompt: String::new(),
        status: "RUNNING".to_string(),
        result_summary: String::new(),
        error_message: String::new(),
        version: 0,
        started_at: clock,
        completed_at: clock,
        created_at: clock,
        updated_at: clock,
    }
}

/// `_map_status` keeps `COMPLETED_SILENT` only for a silent completion; the
/// silent branch is what skips the follower dispatch afterwards.
#[test]
fn the_terminal_status_mapping_matches_the_source() {
    let user_id = execution().user_id;
    let task_id = execution().task_id;
    let silent = json!({"value": "done", "silent_exit": true});
    let silent_event = TaskCompletedEvent {
        task_id,
        user_id,
        status: "COMPLETED",
        subtask_id: 0,
        result: Some(&silent),
        error: None,
    };
    let result = terminal_result(&silent_event);
    assert_eq!(result.status, "COMPLETED_SILENT");
    assert!(result.silent);
    assert_eq!(result.summary.as_deref(), Some("done"));

    let event = TaskCompletedEvent {
        task_id,
        user_id,
        status: "COMPLETED",
        subtask_id: 0,
        result: None,
        error: None,
    };
    assert_eq!(terminal_result(&event).status, "COMPLETED");
    let failed = TaskCompletedEvent {
        status: "FAILED",
        ..event
    };
    assert_eq!(terminal_result(&failed).status, "FAILED");
    let cancelled = TaskCompletedEvent {
        status: "CANCELLED",
        ..event
    };
    assert_eq!(terminal_result(&cancelled).status, "CANCELLED");
}

/// The execution lookup keeps the recorded task-id reads and the recorded
/// reload; the fused `ORDER BY status IN (...)` statement had no counterpart and
/// made Replay reject the terminal callback.
#[test]
fn the_execution_lookup_keeps_the_recorded_task_reads() {
    let running = normalize(&model::execution_running_by_task());
    assert_eq!(
        running,
        normalize(&format!(
            "SELECT {} FROM background_executions \
             WHERE background_executions.task_id = ? \
             AND background_executions.status IN ('PENDING', 'RUNNING') \
             ORDER BY background_executions.id DESC LIMIT 1",
            model::EXECUTION_COLUMNS
        ))
    );
    assert!(!running.contains("ORDER BY status IN"), "{running}");

    let latest = normalize(&model::execution_latest_by_task());
    assert!(
        latest.starts_with(&format!(
            "SELECT {} FROM background_executions",
            model::EXECUTION_COLUMNS
        )),
        "{latest}"
    );
    assert!(
        latest.ends_with(
            "WHERE background_executions.task_id = ? \
             ORDER BY background_executions.id DESC LIMIT 1"
        ) && !latest.contains("status IN"),
        "{latest}"
    );

    assert_eq!(
        normalize(&model::execution_by_id()),
        normalize(&format!(
            "SELECT {} FROM background_executions WHERE background_executions.id = ?",
            model::EXECUTION_COLUMNS
        ))
    );
    assert!(
        normalize(&model::execution_status_read())
            .ends_with("WHERE background_executions.id = ? LIMIT 1"),
        "the status read is the ORM's `.first()`, so it ends in LIMIT 1"
    );
}
