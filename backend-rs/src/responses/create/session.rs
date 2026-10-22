// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `setup_chat_session` for the create flow
//! (`app/services/openapi/chat_session.py` -> `app/services/chat/trigger/
//! lifecycle.py:prepare_execution_session`).
//!
//! The source creates the placeholder Task and its Workspace, rewrites the
//! Task CRD, then numbers and inserts the paired user/assistant subtasks. The
//! recorded create case pins the row values: message ids 1/2 (an empty task
//! numbers from 1), the user subtask `COMPLETED`/`USER` and the assistant
//! subtask `PENDING`/`TEAM`, both carrying `bot_ids` as a JSON array.
use crate::http_compat::FastApiError;
use crate::json_compat::python_json_value;
use crate::task_creation::{
    self, TaskCrdInput, WorkspaceRepository, build_task_crd, build_workspace_payload, task_name,
};
use crate::task_store::{
    CreateSubtasksRequest, CreateTaskShellRequest, NewSubtaskRow, TaskStore, WorkspacePayload,
};

use super::continuation;

/// The ids `setup_chat_session` returns to the caller.
pub struct ChatSessionSetup {
    pub task_id: i64,
    pub workspace_id: i64,
    pub user_subtask_id: i64,
    pub assistant_subtask_id: i64,
    /// The assistant subtask's `message_id` (`message_ids.next_message_id + 1`).
    pub assistant_message_id: i64,
}

/// `setup_chat_session` inputs after resolution.
pub struct SetupChatSessionInput<'a> {
    pub user_id: i64,
    /// The authenticated principal id (`user.id`), as the task lookups bind it.
    pub owner_user_id: i32,
    /// `request_body.previous_response_id`: a `resp_{task_id}` follow-up reuses
    /// that Task instead of creating one.
    pub previous_response_id: Option<&'a str>,
    pub team_id: i64,
    pub bot_ids: &'a [i64],
    pub input_text: &'a str,
    /// The Task CRD template; its `task_id` is replaced with the allocated id.
    pub crd: TaskCrdInput<'a>,
    pub repository: WorkspaceRepository<'a>,
    pub client_origin: &'a str,
    /// DB datetime strings for the inserted rows.
    pub created_at: &'a str,
    pub updated_at: &'a str,
    pub completed_at: &'a str,
}

/// The next subtask message id and the parent it replies to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MessageIds {
    pub next_message_id: i64,
    pub parent_id: i64,
}

/// `task_fork_history_resolver.get_next_message_id` for an empty/continued
/// task: the next message id after `existing_max` and the parent message id.
pub fn next_message_ids(existing_max: Option<i64>) -> MessageIds {
    let next_message_id = existing_max.map_or(1, |max| max + 1);
    let parent_id = if next_message_id > 1 {
        next_message_id - 1
    } else {
        0
    };
    MessageIds {
        next_message_id,
        parent_id,
    }
}

/// The paired user/assistant subtask rows (`create_user_and_assistant_subtasks`
/// values) for `ids`.
pub fn subtask_rows<'a>(
    user_id: i64,
    task_id: i64,
    team_id: i64,
    bot_ids: &'a str,
    input_text: &'a str,
    completed_at: &'a str,
    ids: MessageIds,
) -> (NewSubtaskRow<'a>, NewSubtaskRow<'a>) {
    let user_subtask = NewSubtaskRow {
        id: 0,
        user_id,
        task_id,
        team_id,
        title: "User message",
        bot_ids,
        role: "USER",
        executor_namespace: "",
        executor_name: "",
        executor_deleted_at: 0,
        prompt: input_text,
        message_id: ids.next_message_id,
        parent_id: ids.parent_id,
        status: "COMPLETED",
        progress: 100,
        // `build_user_subtask_result` with no video/image/source config.
        result: "null",
        error_message: "",
        completed_at,
        sender_type: "USER",
        sender_user_id: user_id,
        reply_to_subtask_id: 0,
    };
    let assistant_subtask = NewSubtaskRow {
        id: 0,
        user_id,
        task_id,
        team_id,
        title: "Assistant response",
        bot_ids,
        role: "ASSISTANT",
        executor_namespace: "",
        executor_name: "",
        executor_deleted_at: 0,
        prompt: "",
        message_id: ids.next_message_id + 1,
        parent_id: ids.next_message_id,
        status: "PENDING",
        progress: 0,
        result: "null",
        error_message: "",
        completed_at,
        sender_type: "TEAM",
        sender_user_id: 0,
        reply_to_subtask_id: 0,
    };
    (user_subtask, assistant_subtask)
}

/// `setup_chat_session`: create the Task + Workspace, rewrite the Task CRD, and
/// insert the paired subtasks through the task store.
pub async fn setup_chat_session(
    store: &dyn TaskStore,
    input: &SetupChatSessionInput<'_>,
) -> Result<ChatSessionSetup, FastApiError> {
    let pending_name = task_creation::pending_task_name();
    let workspace = |task_id: i64| {
        let name = format!("workspace-{task_id}");
        let payload = build_workspace_payload(&name, "default", &input.repository);
        WorkspacePayload {
            name,
            namespace: "default".to_string(),
            json: python_json_value(&payload),
        }
    };
    let shell = CreateTaskShellRequest {
        user_id: input.user_id,
        client_origin: input.client_origin,
        is_group_chat: input.crd.is_group_chat,
        project_id: 0,
        created_at: input.created_at,
        updated_at: input.updated_at,
        pending_name: &pending_name,
        workspace: &workspace,
    };

    // `previous_response_id` follow-up: the recorded conversation's Task is
    // reused, marked `PENDING`, and only gains the paired subtasks
    // (`prepare_execution_session`'s `task_id` branch).
    if let Some(previous) = input.previous_response_id
        && let Some(mut continuation) =
            continuation::resolve(store, previous, input.owner_user_id, input.crd.updated_at)
                .await?
    {
        continuation::apply_request_labels(
            &mut continuation.task_json,
            input.crd.model_id,
            input.crd.force_override_bot_model,
            input.crd.auto_delete_executor,
        );
        store
            .update_task_json(
                continuation.task_id,
                input.user_id,
                &python_json_value(&continuation.task_json),
                input.updated_at,
            )
            .await
            .map_err(internal)?;
        // A resumed Task skips the task-creation savepoint, so the subtask
        // insert is the session's first nested transaction.
        return append_subtasks(store, input, continuation.task_id, 0, "sa_savepoint_1").await;
    }

    let (task_id, workspace_id) = store
        .create_task_shell_with_workspace(&shell)
        .await
        .map_err(internal)?;

    // `create_new_task`: build the Task CRD with the allocated id and rewrite
    // `name` / `json` in one UPDATE.
    let crd_input = TaskCrdInput {
        task_id,
        ..input.crd
    };
    let task_crd = build_task_crd(&crd_input);
    store
        .rename_and_update_task_json(
            task_id,
            input.user_id,
            &task_name(task_id),
            &python_json_value(&task_crd),
            input.updated_at,
        )
        .await
        .map_err(internal)?;

    append_subtasks(store, input, task_id, workspace_id, "sa_savepoint_2").await
}

/// `max(subtasks.message_id)` then the paired user/assistant subtask insert for
/// `task_id`, shared by the new-task and `previous_response_id` paths.
async fn append_subtasks(
    store: &dyn TaskStore,
    input: &SetupChatSessionInput<'_>,
    task_id: i64,
    workspace_id: i64,
    savepoint: &str,
) -> Result<ChatSessionSetup, FastApiError> {
    let existing_max = store
        .max_subtask_message_id(task_id)
        .await
        .map_err(internal)?;
    let ids = next_message_ids(existing_max);

    let bot_ids = python_json_value(&serde_json::json!(input.bot_ids));
    let (user_subtask, assistant_subtask) = subtask_rows(
        input.user_id,
        task_id,
        input.team_id,
        &bot_ids,
        input.input_text,
        input.completed_at,
        ids,
    );
    let (user_subtask_id, assistant_subtask_id) = store
        .create_user_and_assistant_subtasks(
            savepoint,
            &CreateSubtasksRequest {
                user_subtask,
                assistant_subtask,
            },
        )
        .await
        .map_err(internal)?;

    Ok(ChatSessionSetup {
        task_id,
        workspace_id,
        user_subtask_id,
        assistant_subtask_id,
        assistant_message_id: ids.next_message_id + 1,
    })
}

/// `setup_chat_session`'s dependency failure: the source propagates the
/// exception, which FastAPI renders as a `500`.
fn internal(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "setup_chat_session dependency failure");
    FastApiError::internal()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_task_numbers_from_one() {
        assert_eq!(
            next_message_ids(None),
            MessageIds {
                next_message_id: 1,
                parent_id: 0
            }
        );
        assert_eq!(
            next_message_ids(Some(2)),
            MessageIds {
                next_message_id: 3,
                parent_id: 2
            }
        );
    }

    #[test]
    fn subtask_rows_match_the_recorded_values() {
        let (user, assistant) = subtask_rows(
            6527,
            897_064_049_841_442,
            568_317,
            "[568316]",
            "不吃糊饼",
            "2026-10-10 14:20:16.519036",
            MessageIds {
                next_message_id: 1,
                parent_id: 0,
            },
        );
        assert_eq!(user.role, "USER");
        assert_eq!(user.title, "User message");
        assert_eq!(user.status, "COMPLETED");
        assert_eq!(user.progress, 100);
        assert_eq!(user.prompt, "不吃糊饼");
        assert_eq!(user.message_id, 1);
        assert_eq!(user.parent_id, 0);
        assert_eq!(user.sender_type, "USER");
        assert_eq!(user.sender_user_id, 6527);
        assert_eq!(user.result, "null");
        assert_eq!(user.bot_ids, "[568316]");

        assert_eq!(assistant.role, "ASSISTANT");
        assert_eq!(assistant.title, "Assistant response");
        assert_eq!(assistant.status, "PENDING");
        assert_eq!(assistant.progress, 0);
        assert_eq!(assistant.prompt, "");
        assert_eq!(assistant.message_id, 2);
        assert_eq!(assistant.parent_id, 1);
        assert_eq!(assistant.sender_type, "TEAM");
        assert_eq!(assistant.sender_user_id, 0);
        assert_eq!(assistant.bot_ids, "[568316]");
    }

    #[test]
    fn bot_ids_render_as_a_json_array() {
        assert_eq!(
            python_json_value(&serde_json::json!([568_316_i64])),
            "[568316]"
        );
        let empty = python_json_value(&serde_json::json!([] as [i64; 0]));
        assert_eq!(empty, "[]");
    }
}
