// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::response::RuntimeTaskLink;
use serde::{Deserialize, Serialize};

/// Local transcripts and their outcomes are durable facts, unlike process liveness.
#[derive(Clone, Deserialize, Serialize)]
pub(super) struct PersistedLocalExecution {
    status: String,
    turn_status: Option<String>,
    completed_at: Option<i64>,
}

impl PersistedLocalExecution {
    pub(super) fn from_runtime(task: &RuntimeTaskLink) -> Option<Self> {
        if task.runtime != "claude_code" {
            return None;
        }
        // Completion and its message must survive even if the process exits before
        // the separate in-memory execution control has been released.
        if let Some(message) = task
            .runtime_handle
            .get("messages")
            .and_then(serde_json::Value::as_array)
            .and_then(|messages| messages.last())
        {
            let status = message.get("status").and_then(serde_json::Value::as_str);
            if message.get("role").and_then(serde_json::Value::as_str) == Some("assistant")
                && matches!(status, Some("done" | "failed" | "cancelled"))
            {
                return Some(Self {
                    status: status.unwrap().to_owned(),
                    turn_status: Some(
                        match status.unwrap() {
                            "done" => "completed",
                            other => other,
                        }
                        .to_owned(),
                    ),
                    completed_at: message
                        .get("completedAt")
                        .and_then(serde_json::Value::as_i64)
                        .or(task.completed_at),
                });
            }
        }
        Some(Self {
            status: task.status.clone(),
            turn_status: task.turn_status.clone(),
            completed_at: task.completed_at,
        })
    }

    pub(super) fn restore(self, task: &mut RuntimeTaskLink) {
        if task.runtime != "claude_code" || task.status == "archived" {
            return;
        }
        // A saved process state is never evidence that a process survived restart.
        let interrupted = matches!(self.status.as_str(), "running" | "starting");
        task.status = if interrupted {
            "interrupted".to_owned()
        } else {
            self.status
        };
        task.turn_status = if interrupted {
            Some("interrupted".to_owned())
        } else {
            self.turn_status
        };
        task.completed_at = self.completed_at;
    }
}
