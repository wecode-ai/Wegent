// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Session-hook projection for task-run metrics
//! (`app/services/task_run_metric_hooks.py`).
//!
//! The source registers SQLAlchemy `before_flush` / `after_flush_postexec` /
//! `after_commit` listeners on the session factory. Target code performs the
//! same writes through explicit store calls, so the only shared piece is the
//! event a committed assistant-subtask status change publishes.

use chrono::NaiveDateTime;
use serde_json::Value;

use crate::task_run_metrics::{SubtaskMetricEvent, failure_message};

/// `TaskRunMetricHooks._after_flush_postexec` for a committed assistant
/// subtask status change (`update_fields`): the row keeps its creation time
/// and error message, while the committed status and result produce the
/// published message. A row without a creation time queues no event, and an
/// existing-row update never records the id in the run totals.
pub(crate) fn committed_status_change(
    created_at: Option<NaiveDateTime>,
    subtask_id: i64,
    failed: bool,
    error_message: Option<&str>,
    result: Option<&Value>,
    state_changed_at: NaiveDateTime,
) -> Option<SubtaskMetricEvent> {
    Some(SubtaskMetricEvent {
        subtask_id,
        created_at: created_at?,
        failed,
        state_changed_at,
        message: failure_message(error_message, result),
        record_total: false,
        sync_failure: true,
    })
}
