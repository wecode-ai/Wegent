// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Request and response models for the task mutation endpoints.
use serde::{Deserialize, Serialize};

use brz_json::OpaqueJson;

/// `MAX_TASK_DELETE_BATCH_SIZE` (`app/schemas/task.py`).
pub const MAX_TASK_DELETE_BATCH_SIZE: usize = 50;

/// `{"message": "Task deleted successfully"}` (`delete_task`).
#[derive(Debug, Serialize)]
pub(crate) struct TaskDeleted {
    pub message: &'static str,
}

impl TaskDeleted {
    pub(crate) const fn new() -> Self {
        Self {
            message: "Task deleted successfully",
        }
    }
}

/// `TaskArchiveBatchResponse` (`app/schemas/task.py`): field order `message`,
/// `count`.
#[derive(Debug, Serialize)]
pub(crate) struct TaskArchiveBatchResponse {
    pub message: &'static str,
    pub count: i64,
}

/// `TaskBulkDeleteRequest`: `task_ids` with `min_length=1`, `max_length=50`.
#[derive(Debug, Deserialize)]
pub(crate) struct TaskBulkDeleteRequest {
    #[serde(default)]
    pub task_ids: Vec<i64>,
}

impl TaskBulkDeleteRequest {
    /// Validate the list bounds the source declares as field constraints; a
    /// violation is the FastAPI 422 the route renders.
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.task_ids.is_empty() {
            return Err("task_ids must contain at least 1 item".to_owned());
        }
        if self.task_ids.len() > MAX_TASK_DELETE_BATCH_SIZE {
            return Err(format!(
                "task_ids must contain at most {MAX_TASK_DELETE_BATCH_SIZE} items"
            ));
        }
        Ok(())
    }
}

/// `cancel_task`'s returned dict (`app/api/endpoints/adapter/tasks.py:679`):
/// `{"message": ..., "status": ...}` in declaration order.
#[derive(Debug, Serialize)]
pub(crate) struct TaskCancelResponse {
    pub message: &'static str,
    pub status: &'static str,
}

impl TaskCancelResponse {
    /// `_cancel_chat_shell_task` with a running assistant subtask.
    pub(crate) const fn chat_stopped() -> Self {
        Self {
            message: "Chat stopped successfully",
            status: "CANCELLED",
        }
    }

    /// `_cancel_chat_shell_task` without a running stream; the task is
    /// finalized as COMPLETED.
    pub(crate) const fn no_running_stream() -> Self {
        Self {
            message: "No running stream to cancel",
            status: "COMPLETED",
        }
    }

    /// `cancel_task` while a cancellation is already in progress.
    pub(crate) const fn already_cancelling() -> Self {
        Self {
            message: "Task is already being cancelled",
            status: "CANCELLING",
        }
    }

    /// `_cancel_executor_task`'s accepted request.
    pub(crate) const fn cancel_accepted() -> Self {
        Self {
            message: "Cancel request accepted",
            status: "CANCELLED",
        }
    }
}

/// `TaskUpdate` (`app/schemas/task.py`): the fields `update_task` consumes.
#[brz_json::model]
#[derive(Debug, Default, Deserialize)]
pub(crate) struct TaskUpdateBody {
    #[json(presence)]
    pub title: String,
    #[json(presence)]
    pub prompt: String,
    #[json(presence)]
    pub status: String,
    #[json(presence)]
    pub progress: i64,
    #[json(presence)]
    pub result: OpaqueJson,
    #[json(presence)]
    pub error_message: String,
    #[json(presence)]
    pub git_url: String,
    #[json(presence)]
    pub git_repo_id: i64,
}

/// `TaskInDB` (`app/schemas/task.py`): the `PUT /api/tasks/{task_id}`
/// response, in the source model's declaration order. Fields whose stored JSON
/// passes through unchanged are `OpaqueJson` so a present `null` and a nested
/// document survive verbatim.
#[derive(Debug, Serialize)]
pub(crate) struct TaskInDbResponse {
    pub title: OpaqueJson,
    #[serde(rename = "type")]
    pub kind: String,
    pub task_type: String,
    pub team_id: Option<i64>,
    pub git_url: String,
    pub git_repo: String,
    pub git_repo_id: i64,
    pub git_domain: String,
    pub branch_name: String,
    pub prompt: OpaqueJson,
    pub status: String,
    pub progress: OpaqueJson,
    pub result: Option<OpaqueJson>,
    pub error_message: Option<OpaqueJson>,
    pub id: i64,
    pub user_id: i64,
    pub user_name: String,
    pub project_id: i64,
    pub client_origin: String,
    pub created_at: Option<OpaqueJson>,
    pub updated_at: Option<OpaqueJson>,
    pub completed_at: Option<OpaqueJson>,
    pub is_group_chat: bool,
    pub preserve_executor: bool,
    pub execution_workspace_source: Option<String>,
    pub execution_workspace_path: Option<String>,
}
