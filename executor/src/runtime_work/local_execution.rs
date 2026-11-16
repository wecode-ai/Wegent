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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
}

impl PersistedLocalExecution {
    pub(super) fn from_runtime(task: &RuntimeTaskLink) -> Option<Self> {
        if task.runtime == "codex" {
            // Persist a completed turn's fact, never native process liveness.
            if task.running
                || !matches!(task.status.as_str(), "done" | "failed" | "cancelled")
                || task.completed_at.is_none()
            {
                return None;
            }
            return Some(Self {
                status: task.status.clone(),
                turn_status: task.turn_status.clone(),
                completed_at: task.completed_at,
                turn_id: match task.runtime_handle["lastTurnId"].as_str() {
                    Some(id) => Some(id.to_owned()),
                    None if task.status == "failed" && is_failed_start(task, task.completed_at) => {
                        None
                    }
                    None => return None,
                },
            });
        }
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
                    turn_id: None,
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
            turn_id: None,
        })
    }

    pub(super) fn restore(self, task: &mut RuntimeTaskLink) {
        if task.status == "archived" {
            return;
        }
        if task.runtime == "codex" {
            if !matches!(self.status.as_str(), "done" | "failed" | "cancelled")
                || self.completed_at.is_none()
                || task.running
                || task.execution_state.is_some()
                || self.turn_id.as_deref() != task.runtime_handle["lastTurnId"].as_str()
                || (self.turn_id.is_none()
                    && (self.status != "failed" || !is_failed_start(task, self.completed_at)))
            {
                return;
            }
            task.status = self.status;
            task.turn_status = self.turn_status;
            task.completed_at = self.completed_at;
            task.thread_status = if self.turn_id.is_none() && task.thread_id.is_none() {
                "failed"
            } else {
                "idle"
            }
            .into();
            return;
        }
        if task.runtime != "claude_code" {
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

fn is_failed_start(task: &RuntimeTaskLink, completed_at: Option<i64>) -> bool {
    task.runtime_handle["lastTurnId"].is_null()
        && task.runtime_handle["startupFailure"]["failedAt"].as_i64() == completed_at
        && completed_at.is_some()
}
