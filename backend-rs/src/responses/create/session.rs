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
use crate::internal_callback::completion::task_column;
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
    /// The assistant subtask row's `executor_name` / `executor_namespace`
    /// (`TaskRequestBuilder` copies them onto the execution request).
    pub assistant_executor_name: String,
    pub assistant_executor_namespace: String,
    /// The assistant subtask row's `executor_deleted_at`: `_build_session_context`
    /// reads it to decide whether the persisted sessions join the inherited
    /// list. The create flow inserts the row, so it is always false there.
    pub assistant_executor_deleted: bool,
    /// The inserted assistant subtask's `created_at` (the task-run-metric
    /// hook's captured value, read inside the insert's savepoint).
    pub assistant_created_at: Option<chrono::NaiveDateTime>,
    /// `task_fork_history_resolver.resolve_for_task`'s subtasks: the task's
    /// rows from before this request inserted its pair (empty for a new
    /// task). `ExecutionSessionSetup.existing_subtasks` carries them to the
    /// memory-context builder and the pipeline-handoff branch.
    pub existing_subtasks: Vec<brz_mysql::MysqlRow>,
    /// The Task CRD the request built or reused (`session.task` in the
    /// source): the endpoint hands it to `build_execution_request`, and the
    /// memory save reads its `workspaceRef` and `is_group_chat`.
    pub task_json: serde_json::Value,
    /// `_merge_project_workspace`'s selector (`request_builder.py:3119-3143`):
    /// a resumed Task's physical `project_id` (else digit-only
    /// `metadata.labels.projectId`) or the created Task's source group.
    pub workspace_project_id: i64,
    /// The Task's raw physical `project_id` property (`session.task.project_id`
    /// in `chat_session.py:157-166`), `None` when the column is NULL/zero. The
    /// memory metadata uses this value, never the label fallback.
    pub raw_project_id: Option<i64>,
}

/// `setup_chat_session` inputs after resolution.
pub struct SetupChatSessionInput<'a> {
    pub user_id: i64,
    /// The authenticated principal id (`user.id`), as the task lookups bind it.
    pub owner_user_id: i32,
    /// The resolved `previous_response_id` follow-up: its Task was read on the
    /// request session at `openapi_responses.py:522-547`'s position, before
    /// team and model resolution. `None` creates a new Task.
    pub continuation: Option<continuation::Continuation>,
    pub team_id: i64,
    pub bot_ids: &'a [i64],
    pub input_text: &'a str,
    /// The Task CRD template; its `task_id` is replaced with the allocated id.
    pub crd: TaskCrdInput<'a>,
    pub repository: WorkspaceRepository<'a>,
    pub client_origin: &'a str,
    /// `create_new_task`'s resolved API source group
    /// (`get_or_create_task_source_group(task_source="api")`); `0` when the
    /// request reuses a Task and no group is resolved.
    pub project_id: i64,
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

/// `_merge_project_workspace`'s project selector: the Task's physical
/// `project_id` wins; otherwise `metadata.labels.projectId` counts only when
/// its string form is all digits (`str(value).isdigit()`).
pub(crate) fn resumed_project_id(column: Option<i64>, task_json: &serde_json::Value) -> i64 {
    if let Some(project_id) = column.filter(|project_id| *project_id > 0) {
        return project_id;
    }
    let Some(value) = task_json
        .get("metadata")
        .and_then(|metadata| metadata.get("labels"))
        .and_then(|labels| labels.get("projectId"))
    else {
        return 0;
    };
    let text = match value {
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    if text.is_empty() || !text.chars().all(|character| character.is_ascii_digit()) {
        return 0;
    }
    text.parse().unwrap_or(0)
}

/// `setup_chat_session`: create the Task + Workspace, rewrite the Task CRD, and
/// insert the paired subtasks through the task store.
pub async fn setup_chat_session(
    store: &dyn TaskStore,
    sql: &mut dyn crate::request_sql::RequestSql,
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
        project_id: input.project_id,
        created_at: input.created_at,
        updated_at: input.updated_at,
        pending_name: &pending_name,
        workspace: &workspace,
    };

    // `previous_response_id` follow-up: the recorded conversation's Task is
    // reused, marked `PENDING`, and only gains the paired subtasks
    // (`prepare_execution_session`'s `task_id` branch). The Task row was read
    // on this request's `sql` handle before team/model resolution.
    if let Some(continuation) = input.continuation.as_ref() {
        // `prepare_execution_session`'s `get_task_with_access_check`
        // (`lifecycle.py:287`) re-reads the resumed Task on the request
        // session; its row is what the pending CRD rewrite flushes.
        let row = store
            .get_active_task_owned_on(sql, continuation.task_id, input.owner_user_id)
            .await
            .map_err(internal)?
            .ok_or_else(|| {
                FastApiError::detail(
                    brz_http_server::StatusCode::NOT_FOUND,
                    format!("Task {} not found", continuation.task_id),
                )
            })?;
        let mut task_json = task_column::<brz_mysql::Json<serde_json::Value>>(&row, "json")
            .map(|json| json.0)
            .unwrap_or(serde_json::Value::Null);
        continuation::apply_request_labels(
            &mut task_json,
            input.crd.model_id,
            input.crd.force_override_bot_model,
            input.crd.auto_delete_executor,
        );
        continuation::mark_pending(&mut task_json, input.crd.updated_at);
        let raw_project_id = task_column::<i64>(&row, "project_id").filter(|id| *id > 0);
        let project_id = resumed_project_id(raw_project_id, &task_json);
        let payload = python_json_value(&task_json);
        // A resumed Task skips the task-creation savepoint, so the subtask
        // insert is the session's first nested transaction. The pending
        // `update_json` flush lands just before that savepoint, after the
        // fork-history and executor reads. The snapshot rides back to the
        // caller so the builder sees the resumed Task, not a fresh CRD.
        return append_subtasks(
            store,
            sql,
            input,
            continuation.task_id,
            0,
            "sa_savepoint_1",
            None,
            Some(&payload),
            task_json,
            project_id,
            raw_project_id,
        )
        .await;
    }

    let (task_id, workspace_id) = store
        .create_task_shell_with_workspace(sql, &shell)
        .await
        .map_err(internal)?;

    // `create_new_task`: the Task CRD rewrite (`UPDATE tasks SET name, json`,
    // qs29) happens after the executor-reference reads and before the subtask
    // savepoint, so the CRD is built here but applied inside `append_subtasks`.
    let crd_input = TaskCrdInput {
        task_id,
        ..input.crd
    };
    let task_crd = build_task_crd(&crd_input);
    let task_json = serde_json::to_value(&task_crd).unwrap_or(serde_json::Value::Null);
    let rename = Some((task_name(task_id), python_json_value(&task_crd)));

    append_subtasks(
        store,
        sql,
        input,
        task_id,
        workspace_id,
        "sa_savepoint_2",
        rename,
        None,
        task_json,
        input.project_id,
        (input.project_id != 0).then_some(input.project_id),
    )
    .await
}

/// `max(subtasks.message_id)` then `create_assistant_subtask`'s executor
/// reference resolution and the paired user/assistant subtask insert for
/// `task_id`, shared by the new-task and `previous_response_id` paths.
#[allow(clippy::too_many_arguments)]
async fn append_subtasks(
    store: &dyn TaskStore,
    sql: &mut dyn crate::request_sql::RequestSql,
    input: &SetupChatSessionInput<'_>,
    task_id: i64,
    workspace_id: i64,
    savepoint: &str,
    rename: Option<(String, String)>,
    json_update: Option<&str>,
    task_json: serde_json::Value,
    workspace_project_id: i64,
    raw_project_id: Option<i64>,
) -> Result<ChatSessionSetup, FastApiError> {
    // `task_fork_history_resolver.resolve_for_task` (`lifecycle.py:363-370`):
    // `subtask_store.list_by_task_ordered(task_id, owner_user_id)` reads the
    // task's subtasks in `message_id, created_at` order before the next
    // message id is computed. A new task has none.
    let existing_subtasks = store
        .list_subtasks_by_task_ordered_on(sql, task_id, input.user_id)
        .await
        .map_err(internal)?
        .rows;
    // `resolve_lineage`'s depth-0 read for the created task (qs25): the
    // source's `_lineage_task` reads the current task through the owner guard
    // before it breaks on `fork is None`. It is a distinct business read from
    // the qs23 owner guard even though the SQL shape is the same.
    let _lineage_task = store
        .lineage_task_on(sql, task_id, input.user_id)
        .await
        .map_err(internal)?;
    let existing_max = store
        .max_subtask_message_id(sql, task_id)
        .await
        .map_err(internal)?;
    let ids = next_message_ids(existing_max);

    // `create_assistant_subtask` resolves the executor reference in the same
    // transaction as the insert (qs27/28).
    let executor = store
        .resolve_task_executor_on(sql, task_id)
        .await
        .map_err(internal)?;

    // qs29: `create_new_task`'s `UPDATE tasks SET name, json`, emitted after
    // the executor reads and before the subtask savepoint.
    if let Some((name, payload)) = rename {
        store
            .rename_and_update_task_json(
                sql,
                task_id,
                input.user_id,
                &name,
                &payload,
                input.updated_at,
            )
            .await
            .map_err(internal)?;
    }

    // A resumed Task's `update_json` flush: one `UPDATE tasks SET json`
    // immediately before the subtask savepoint, as the source's session
    // flushes the pending CRD when `begin_nested()` starts.
    if let Some(payload) = json_update {
        store
            .update_task_json_on(sql, task_id, input.user_id, payload, input.updated_at)
            .await
            .map_err(internal)?;
    }

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
    // `create_assistant_subtask` resolves the executor reference in the same
    // transaction as the insert; `build_execution_request` later reads the
    // assistant subtask's executor fields from the inserted row.
    let inserted = store
        .create_subtasks_with_executor(
            sql,
            savepoint,
            &CreateSubtasksRequest {
                user_subtask,
                assistant_subtask,
            },
            &executor,
        )
        .await
        .map_err(internal)?;

    Ok(ChatSessionSetup {
        task_json,
        workspace_project_id,
        raw_project_id,
        task_id,
        workspace_id,
        user_subtask_id: inserted.user_subtask_id,
        assistant_subtask_id: inserted.assistant_subtask_id,
        assistant_message_id: ids.next_message_id + 1,
        assistant_executor_name: inserted.executor.name,
        assistant_executor_namespace: inserted.executor.namespace,
        assistant_executor_deleted: false,
        assistant_created_at: inserted.assistant_created_at,
        existing_subtasks,
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
    fn resumed_project_id_prefers_the_column_then_digit_labels() {
        // `_merge_project_workspace` (`request_builder.py:3119-3143`): the
        // physical `project_id` wins; otherwise `metadata.labels.projectId`
        // counts only when `str(value).isdigit()`.
        let labels = |value: serde_json::Value| serde_json::json!({"metadata": {"labels": {"projectId": value}}});
        assert_eq!(
            resumed_project_id(Some(2584), &labels(serde_json::json!("1"))),
            2584
        );
        assert_eq!(
            resumed_project_id(Some(0), &labels(serde_json::json!("2584"))),
            2584
        );
        assert_eq!(
            resumed_project_id(None, &labels(serde_json::json!(2584))),
            2584
        );
        assert_eq!(
            resumed_project_id(Some(0), &labels(serde_json::json!("-1"))),
            0
        );
        assert_eq!(
            resumed_project_id(Some(0), &labels(serde_json::json!("12a"))),
            0
        );
        assert_eq!(
            resumed_project_id(Some(0), &labels(serde_json::json!(true))),
            0
        );
        assert_eq!(
            resumed_project_id(Some(0), &serde_json::json!({"metadata": {}})),
            0
        );
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
