// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;

use serde_json::Value;

use super::{non_empty_string_field, ClaudeSubagentUpdate};

#[derive(Debug)]
struct Subagent {
    tool_use_id: Option<String>,
    status: &'static str,
}

#[derive(Debug, Default)]
pub struct ClaudeAsyncTaskTracker {
    tasks: BTreeMap<String, Subagent>,
    result_error: Option<String>,
}

impl ClaudeAsyncTaskTracker {
    pub fn observe(&mut self, value: &Value) {
        if value["type"] == "result" && value["parent_tool_use_id"].is_null() {
            // A later notification can start another parent turn. Only its
            // latest result describes the final subagent accounting.
            self.result_error = result_subagent_error(value);
        }
        if value["type"] != "system" {
            return;
        }
        let task_id = non_empty_string_field(value, "task_id");
        let tool_use_id = non_empty_string_field(value, "tool_use_id");
        if value["subtype"] == "task_started" && value["task_type"] == "local_agent" {
            if let Some(id) = task_id.or_else(|| tool_use_id.clone()) {
                self.tasks.insert(
                    id,
                    Subagent {
                        tool_use_id,
                        status: "running",
                    },
                );
            }
            return;
        }
        let status = match value["subtype"].as_str() {
            Some("task_updated") => value["patch"]["status"].as_str(),
            Some("task_notification") => value["status"].as_str(),
            _ => return,
        };
        let Some(status) = status.and_then(terminal_status) else {
            return;
        };
        if let Some(task) = task_id.as_ref().and_then(|id| self.tasks.get_mut(id)) {
            task.status = status;
        } else if let Some(id) = tool_use_id {
            for task in self.tasks.values_mut() {
                if task.tool_use_id.as_deref() == Some(id.as_str()) {
                    task.status = status;
                }
            }
        }
    }

    pub fn has_active_task(&self) -> bool {
        self.tasks.values().any(|task| task.status == "running")
    }

    pub(super) fn completion_error(&self) -> Option<String> {
        if let Some(error) = &self.result_error {
            return Some(error.clone());
        }
        let incomplete = self
            .tasks
            .values()
            .filter(|task| task.status != "completed")
            .count();
        (incomplete > 0).then(|| {
            format!("Claude exited with {incomplete} unfinished or unsuccessful subagent(s); the task was not completed")
        })
    }
}

fn terminal_status(status: &str) -> Option<&'static str> {
    match status {
        "completed" | "succeeded" | "success" => Some("completed"),
        "failed" | "error" => Some("failed"),
        "killed" | "stopped" | "cancelled" | "canceled" => Some("stopped"),
        _ => None,
    }
}

fn result_subagent_error(value: &Value) -> Option<String> {
    let stats = value.get("subagent_stats")?;
    let system_killed = stats["killed"]["system"].as_u64().unwrap_or(0);
    if system_killed > 0 {
        return Some(format!(
            "Claude runtime terminated {system_killed} unfinished subagent(s); the task was not completed"
        ));
    }
    let spawned = stats["spawned"].as_u64()?;
    let terminal = stats["killed"]
        .as_object()
        .into_iter()
        .flat_map(|counts| counts.values())
        .filter_map(Value::as_u64)
        .chain([
            stats["completed"].as_u64().unwrap_or(0),
            stats["failed"].as_u64().unwrap_or(0),
        ])
        .fold(0_u64, u64::saturating_add);
    let unfinished = spawned.saturating_sub(terminal);
    (unfinished > 0).then(|| {
        format!(
            "Claude exited with {unfinished} unfinished subagent(s); the task was not completed"
        )
    })
}

pub fn extract_claude_subagent_update(value: &Value) -> Option<ClaudeSubagentUpdate> {
    if value.get("type").and_then(Value::as_str) != Some("system") {
        return None;
    }
    let subtype = value.get("subtype").and_then(Value::as_str)?;
    let tool_use_id = non_empty_string_field(value, "tool_use_id")?;
    match subtype {
        "task_started" if value.get("task_type").and_then(Value::as_str) == Some("local_agent") => {
            Some(ClaudeSubagentUpdate {
                tool_use_id,
                status: "invoking".to_owned(),
                summary: None,
            })
        }
        "task_notification" => {
            let status = match value.get("status").and_then(Value::as_str)? {
                "completed" | "succeeded" | "success" => "done",
                "failed" | "error" | "cancelled" | "canceled" | "stopped" => "error",
                _ => return None,
            };
            Some(ClaudeSubagentUpdate {
                tool_use_id,
                status: status.to_owned(),
                summary: non_empty_string_field(value, "summary"),
            })
        }
        _ => None,
    }
}
