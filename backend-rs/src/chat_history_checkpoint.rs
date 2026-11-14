// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Summary-checkpoint semantics for unbounded historical reads.

use crate::chat_history::ForkHistoryItem;
use crate::chat_repository::SubtaskRow;
use serde_json::Value;

pub(super) fn subtask_has_summary_checkpoint(subtask: &SubtaskRow) -> bool {
    if subtask.role != "ASSISTANT" || subtask.status != "COMPLETED" {
        return false;
    }
    let Some(result) = subtask.result.as_ref().map(|json| &json.0) else {
        return false;
    };
    let Some(chain) = result.get("messages_chain").and_then(Value::as_array) else {
        return false;
    };
    chain.iter().any(|msg| {
        msg.get("additional_kwargs")
            .and_then(Value::as_object)
            .and_then(|kwargs| kwargs.get("summary_compacted"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    })
}

pub(super) fn scope_to_latest_checkpoint(
    subtasks: &[ForkHistoryItem],
) -> (&[ForkHistoryItem], Option<usize>) {
    match subtasks
        .iter()
        .rposition(|item| subtask_has_summary_checkpoint(&item.subtask))
    {
        None => (subtasks, None),
        Some(index) => (&subtasks[index..], Some(index)),
    }
}
