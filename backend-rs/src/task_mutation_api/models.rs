// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Request and response models for the task mutation endpoints.
use serde::{Deserialize, Serialize};

use crate::json_compat::OpaqueJson;

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

/// A `TaskUpdate` field that records whether the request carried it.
///
/// Pydantic's `model_dump(exclude_unset=True)` distinguishes an absent key
/// from a present `null`; a bare `Option<T>` conflates them. `Present` is
/// `None` when the key is absent, `Some(None)` for an explicit `null`, and
/// `Some(Some(value))` otherwise.
#[derive(Debug, Clone)]
pub(crate) struct Present<T>(Option<Option<T>>);

impl<T> Default for Present<T> {
    fn default() -> Self {
        Self(None)
    }
}

impl<T> Present<T> {
    /// The value when the key was present and not null.
    pub(crate) fn value(&self) -> Option<&T> {
        match &self.0 {
            Some(Some(value)) => Some(value),
            _ => None,
        }
    }

    /// Whether the request carried the key (including an explicit `null`).
    pub(crate) fn is_present(&self) -> bool {
        self.0.is_some()
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Present<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self(Some(Option::<T>::deserialize(deserializer)?)))
    }
}

/// `TaskUpdate` (`app/schemas/task.py`): the fields `update_task` consumes.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct TaskUpdateBody {
    #[serde(default)]
    pub title: Present<String>,
    #[serde(default)]
    pub prompt: Present<String>,
    #[serde(default)]
    pub status: Present<String>,
    #[serde(default)]
    pub progress: Present<i64>,
    #[serde(default)]
    pub result: Present<OpaqueJson>,
    #[serde(default)]
    pub error_message: Present<String>,
    #[serde(default)]
    pub git_url: Present<String>,
    #[serde(default)]
    pub git_repo_id: Present<i64>,
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
