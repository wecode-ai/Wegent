// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Count only accepted, committed runtime execution transitions.

use serde_json::Value;

use wegent_runtime_execution::execution_aggregate::ExecutionRow;
use wegent_runtime_execution::runtime_projection::{RuntimeIdentity, error_text, event_data};

pub(super) fn record(row: Option<&ExecutionRow>, identity: &RuntimeIdentity<'_>) {
    let Some(row) = row.filter(|row| row.is_terminal()) else {
        return;
    };
    let data = event_data(identity.payload);
    let error = identity.payload.get("error").or_else(|| data?.get("error"));
    let code = error
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
        .or_else(|| data?.get("code")?.as_str())
        .or_else(|| {
            data?.get("type")?.as_str().filter(|code| {
                crate::chat_errors::classify_chat_error(Some(code), None).code != "generic_error"
            })
        });
    let message = error.map(error_text);
    let info = crate::chat_errors::classify_chat_error(code, message.as_deref());
    record_classified(row, info.code, message.as_deref());
}

/// Record a terminal transition elected by reconciliation, where no runtime
/// event carries the failure fields. The committed execution row is the
/// durable source for both the outcome and its bounded diagnostic.
pub(super) fn record_row(row: Option<&ExecutionRow>, message: Option<&str>) {
    let Some(row) = row.filter(|row| row.is_terminal()) else {
        return;
    };
    let info = crate::chat_errors::classify_chat_error(None, message);
    record_classified(row, info.code, message);
}

fn record_classified(row: &ExecutionRow, code: &str, message: Option<&str>) {
    let entrypoint = if row
        .automation_run_id
        .as_deref()
        .is_some_and(|id| !id.is_empty())
    {
        "automation"
    } else {
        "wework"
    };
    let mode = match row.execution_environment.as_deref() {
        Some("local") => "local",
        Some("cloud") => "remote",
        _ => "unknown",
    };
    wegent_execution_completion::chat_metrics::record_terminal(
        row.status_or_empty(),
        Some(code),
        message,
        crate::chat_errors::error_stage(code),
        wegent_execution_completion::chat_metrics::RunLabels::new(entrypoint, "unknown", mode),
    );
}
