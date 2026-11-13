// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Recover a coding executor and its workspace before dispatching a turn.
use anyhow::{Context, Result, ensure};
use brz_mysql::{Json, Mysql, MysqlResult, MysqlRow};
use serde_json::Value;

use crate::chat_repository::{ChatHistoryRepository, TaskRow, contexts_by_subtask_ids_statement};
use crate::json_compat::{python_str, python_truthy};
use crate::state::AppState;
use crate::task_routing::ByTaskId;
use crate::task_store::TableTemplates;
use crate::task_store_statements::{
    assistant_subtasks_by_task_statement, subtask_by_id_statement, subtask_column_index,
};
use crate::workspace_archive::service::{
    recovery_archive_available, restore_workspace_for_runtime,
};

use super::dispatch::ExecutionRequest;
use super::streaming::request_shell_type;

/// `_recover_executor_if_needed`'s shell gate:
/// `shell_type in {"ClaudeCode", "Agno", "CodeX", "Codex"}`.
pub(crate) fn shell_supports_recovery(shell_type: &str) -> bool {
    matches!(shell_type, "ClaudeCode" | "Agno" | "CodeX" | "Codex")
}

/// `_has_fork_workspace_archive`: a non-blank `workspaceArchive.storageKey` in
/// the request's fork runtime.
pub(crate) fn has_fork_workspace_archive(fork_runtime: Option<&Value>) -> bool {
    fork_runtime
        .and_then(|runtime| runtime.get("workspaceArchive"))
        .and_then(Value::as_object)
        .and_then(|archive| archive.get("storageKey"))
        .and_then(Value::as_str)
        .is_some_and(|storage_key| !storage_key.trim().is_empty())
}

/// What the recovery decision reads from `subtask_store.get_by_id`.
pub(crate) struct RecoverySubtask {
    pub(crate) executor_deleted: bool,
    pub(crate) task_id: i64,
    pub(crate) executor_name: String,
    pub(crate) executor_namespace: String,
}

/// `subtask_store.get_by_id` with the ORM's eager `Subtask.contexts` load
/// (`_attach_contexts`), read from the subtask's shard table.
///
/// The read is the same statement the RUNNING transition issues later; the
/// source performs it twice (recovery decision, then the status update).
pub(crate) async fn read_subtask_with_contexts<M: Mysql>(
    mysql: &M,
    templates: TableTemplates,
    subtask_id: i64,
) -> MysqlResult<Option<RecoverySubtask>> {
    let routed = mysql.route(ByTaskId(subtask_id as u64));
    let row: Option<MysqlRow> = routed
        .fetch_optional(subtask_by_id_statement(templates.subtasks), (subtask_id,))
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    // `_attach_contexts`: every context of the subtask in ascending id order.
    routed
        .fetch_all::<_, _, MysqlRow>(contexts_by_subtask_ids_statement(1), vec![subtask_id])
        .await?;
    let column = |name: &str| {
        subtask_column_index(name).and_then(|index| row.get_at::<Option<i64>>(index).ok().flatten())
    };
    let text = |name: &str| {
        subtask_column_index(name)
            .and_then(|index| row.get_at::<Option<String>>(index).ok().flatten())
    };
    Ok(Some(RecoverySubtask {
        executor_deleted: column("executor_deleted_at").is_some_and(|value| value != 0),
        task_id: column("task_id").unwrap_or(0),
        executor_name: text("executor_name").unwrap_or_default(),
        executor_namespace: text("executor_namespace").unwrap_or_default(),
    }))
}

/// `_mark_missing_executor_deleted`'s probe gate
/// (`dispatcher.py:341-343`): a blank or `device-*` binding is never probed.
pub(crate) fn probes_executor_binding(executor_name: &str) -> bool {
    let name = executor_name.trim();
    !name.is_empty() && !name.starts_with("device-")
}

/// `remote_workspace_service.executor_alive`'s payload interpretation
/// (`remote_workspace_service.py:604-625`): only a terminal phase
/// (`Succeeded`/`Failed`) or the executor-manager "No pod found for executor"
/// error reports the pod as missing. A `status: success` payload, any other
/// phase/error, and a `None` payload (transport failure, non-200, empty or
/// non-object body) are all treated as alive.
pub(crate) fn payload_reports_missing(payload: &Value) -> bool {
    let status = payload
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if status.eq_ignore_ascii_case("success") {
        return false;
    }
    if matches!(
        payload.get("phase").and_then(Value::as_str),
        Some("Succeeded" | "Failed")
    ) {
        return true;
    }
    payload
        .get("error_msg")
        .and_then(Value::as_str)
        .is_some_and(|message| message.contains("No pod found for executor"))
}

#[tracing::instrument(skip_all, fields(task_id = request.task_id, subtask_id = request.subtask_id))]
pub(crate) async fn recover_executor_if_needed(
    state: &AppState,
    request: &mut ExecutionRequest,
    device_id: Option<&str>,
) -> Result<bool> {
    if !shell_supports_recovery(&request_shell_type(request)) {
        return Ok(false);
    }
    let restore_fork_workspace = has_fork_workspace_archive(request.fork_runtime.as_ref());
    if device_id.is_some_and(|id| !id.is_empty()) && restore_fork_workspace {
        return Ok(false);
    }
    let Some(subtask) = read_subtask_with_contexts(
        &state.mysql,
        state.task_store.table_templates(),
        request.subtask_id,
    )
    .await
    .context("Could not read the executor binding")?
    else {
        return Ok(false);
    };
    ensure!(
        subtask.task_id == request.task_id,
        "Executor binding belongs to another task"
    );
    if !subtask.executor_deleted && !restore_fork_workspace {
        if !probes_executor_binding(&subtask.executor_name) {
            return Ok(false);
        }
        let payload = state
            .executor_manager
            .executor_address(subtask.executor_name.trim(), &subtask.executor_namespace)
            .await;
        if !payload.as_ref().is_some_and(payload_reports_missing) {
            return Ok(false);
        }
        mark_executor_missing(state, request.subtask_id, &subtask).await?;
    }
    recover_executor(state, request, &subtask).await?;
    Ok(true)
}

async fn mark_executor_missing(
    state: &AppState,
    subtask_id: i64,
    subtask: &RecoverySubtask,
) -> Result<()> {
    let table = state.task_store.table_templates().subtasks;
    state
        .mysql
        .route(ByTaskId(subtask_id as u64))
        .execute(
            format!(
                "UPDATE {table} SET executor_deleted_at = true, updated_at = ? \
                 WHERE id = ? AND task_id = ? AND executor_name = ? AND COALESCE(executor_namespace, '') = ?"
            ),
            (
                chrono::Local::now().naive_local(),
                subtask_id,
                subtask.task_id,
                subtask.executor_name.as_str(),
                subtask.executor_namespace.as_str(),
            ),
        )
        .await
        .context("Could not mark the missing executor")?;
    Ok(())
}

async fn recover_executor(
    state: &AppState,
    request: &mut ExecutionRequest,
    subtask: &RecoverySubtask,
) -> Result<()> {
    let task = ChatHistoryRepository::new(&state.mysql, state.task_store.as_ref())
        .get_task_by_id(request.task_id)
        .await
        .context("Could not load the task for executor recovery")?
        .context("Task not found for executor recovery")?;
    let task_json = task.json.as_ref().map_or(&Value::Null, |json| &json.0);
    let restore_archive = recovery_archive_available(request.task_id, task_json)?;
    let mut prepare = request.clone();
    prepare.skip_git_clone = Some(restore_archive);
    prepare.executor_name = None;
    prepare.executor_namespace = None;
    let executor = state.executor_manager.prepare_executor(&prepare).await?;
    let namespace = executor
        .executor_namespace
        .as_deref()
        .map(str::trim)
        .filter(|namespace| !namespace.is_empty())
        .unwrap_or_else(|| {
            let previous = subtask.executor_namespace.trim();
            if previous.is_empty() {
                "default"
            } else {
                previous
            }
        });

    let recovered = async {
        if restore_archive {
            restore_archive_for_executor(state, request, &task, &executor.executor_name, namespace)
                .await?;
        }
        save_recovered_binding(state, request, subtask, &executor.executor_name, namespace).await
    };
    if let Err(error) = recovered.await {
        delete_prepared_executor(state, request.task_id, &executor.executor_name, namespace).await;
        return Err(error);
    }

    request.executor_name = Some(executor.executor_name);
    request.executor_namespace = Some(namespace.to_owned());
    request.skip_git_clone = prepare.skip_git_clone;
    tracing::info!(
        task_id = request.task_id,
        subtask_id = request.subtask_id,
        "recovered executor"
    );
    Ok(())
}

async fn delete_prepared_executor(
    state: &AppState,
    task_id: i64,
    name: &str,
    namespace: &str,
) -> bool {
    match state
        .executor_manager
        .delete_executor_task(name, namespace)
        .await
    {
        Ok(()) => true,
        Err(error) => {
            tracing::warn!(task_id, executor_name = name, %error, "could not clean up prepared executor");
            false
        }
    }
}

pub(crate) async fn discard_recovered_executor(state: &AppState, request: &ExecutionRequest) {
    let (Some(name), Some(namespace)) = (&request.executor_name, &request.executor_namespace)
    else {
        return;
    };
    if !delete_prepared_executor(state, request.task_id, name, namespace).await {
        return;
    }
    let subtask = RecoverySubtask {
        executor_deleted: false,
        task_id: request.task_id,
        executor_name: name.clone(),
        executor_namespace: namespace.clone(),
    };
    if let Err(error) = mark_executor_missing(state, request.subtask_id, &subtask).await {
        tracing::warn!(task_id = request.task_id, subtask_id = request.subtask_id, %error, "could not mark the discarded executor deleted");
    }
}

async fn save_recovered_binding(
    state: &AppState,
    request: &ExecutionRequest,
    subtask: &RecoverySubtask,
    executor_name: &str,
    namespace: &str,
) -> Result<()> {
    let table = state.task_store.table_templates().subtasks;
    let updated = state
        .mysql
        .route(ByTaskId(request.subtask_id as u64))
        .execute(
            format!(
                "UPDATE {table} SET executor_name = ?, executor_namespace = ?, executor_deleted_at = false, updated_at = ? \
                 WHERE id = ? AND task_id = ? AND COALESCE(executor_name, '') = ? AND COALESCE(executor_namespace, '') = ?"
            ),
            (
                executor_name,
                namespace,
                chrono::Local::now().naive_local(),
                request.subtask_id,
                request.task_id,
                subtask.executor_name.as_str(),
                subtask.executor_namespace.as_str(),
            ),
        )
        .await
        .context("Could not save the recovered executor binding")?;
    ensure!(
        updated.rows_affected != 0,
        "Executor binding changed during recovery"
    );
    Ok(())
}

async fn restore_archive_for_executor(
    state: &AppState,
    request: &ExecutionRequest,
    task: &TaskRow,
    executor_name: &str,
    namespace: &str,
) -> Result<()> {
    let task_json = task.json.as_ref().map_or(&Value::Null, |json| &json.0);
    let restored = restore_workspace_for_runtime(
        state,
        request.task_id,
        task_json,
        executor_name,
        namespace,
        "executor",
    )
    .await;
    if restored.is_none() {
        tracing::warn!(
            task_id = request.task_id,
            "workspace restore failed for prepared executor"
        );
    }
    let session_available = restored.as_ref().is_some_and(|result| {
        python_truthy(&result["session_restored"]) || has_inherited_claude_session(request)
    });
    if requires_claude_session(request)
        && !session_available
        && has_prior_session(state, request, task, task_json).await?
    {
        anyhow::bail!(
            "Claude session context for task {} was not restored. Refusing to send the continuation to a new session.",
            request.task_id
        );
    }
    Ok(())
}

fn request_bots(request: &ExecutionRequest) -> &[Value] {
    request
        .bot
        .as_array()
        .map_or_else(|| std::slice::from_ref(&request.bot), Vec::as_slice)
}

fn requires_claude_session(request: &ExecutionRequest) -> bool {
    !request.new_session
        && request_bots(request)
            .iter()
            .any(|bot| bot["shell_type"] == "ClaudeCode")
}

fn has_inherited_claude_session(request: &ExecutionRequest) -> bool {
    let bot_ids: Vec<String> = request_bots(request)
        .iter()
        .filter_map(|bot| bot.get("id").filter(|id| !id.is_null()).map(python_str))
        .collect();
    request.inherited_sessions.iter().any(|session| {
        if !matches!(
            session["agent"].as_str(),
            Some("ClaudeCode" | "Claude Code")
        ) {
            return false;
        }
        let id = session
            .get("sessionId")
            .filter(|id| python_truthy(id))
            .or_else(|| session.get("session_id"));
        let valid = id.and_then(Value::as_str).map(str::trim).is_some_and(|id| {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        });
        let bot_id = session.get("botId").or_else(|| session.get("bot_id"));
        valid
            && (bot_ids.is_empty()
                || bot_id.is_none_or(|id| id.is_null() || bot_ids.contains(&python_str(id))))
    })
}

async fn has_prior_session(
    state: &AppState,
    request: &ExecutionRequest,
    task: &TaskRow,
    task_json: &Value,
) -> Result<bool> {
    if task_json
        .pointer("/status/archive/sessionFileIncluded")
        .is_some_and(python_truthy)
    {
        return Ok(true);
    }
    if i64::from(task.user_id) != request.user_id {
        return Ok(false);
    }
    let table = state.task_store.table_templates().subtasks;
    let rows: Vec<MysqlRow> = state
        .mysql
        .route(ByTaskId(request.task_id as u64))
        .fetch_all(
            assistant_subtasks_by_task_statement(table),
            (request.task_id,),
        )
        .await
        .context("Could not check prior executor sessions")?;
    let result_column = subtask_column_index("result").expect("subtask result is projected");
    Ok(rows.iter().any(|row| {
        row.get_at::<Option<Json<Value>>>(result_column)
            .ok()
            .flatten()
            .is_some_and(|result| python_truthy(&result.0["executor_session"]))
    }))
}

#[cfg(test)]
#[path = "recover_executor_tests.rs"]
mod tests;
