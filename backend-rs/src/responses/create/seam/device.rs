// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared traditional-device routing, executor binding and turn dispatch.

use brz_http_server::StatusCode;
use serde_json::Value;

use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::{
    ExecutionRequest, build_failure_message, mark_subtask_running, recover_before_dispatch, routing,
};

/// `ExecutionDispatcher._resolve_device_route_id` (`dispatcher.py:391-415`):
/// map a submitted device identity to its heartbeat connection route. A missing
/// owned row falls back to the submitted route; it never errors or drops the
/// device routing.
pub(super) async fn resolve_device_route_id(
    state: &AppState,
    request: &ExecutionRequest,
    device_id: Option<&str>,
) -> Result<Option<String>, FastApiError> {
    let Some(device_id) = device_id else {
        return Ok(None);
    };
    if request.user.get("id").and_then(Value::as_i64).is_none()
        || has_fork_workspace_archive(request)
    {
        return Ok(Some(device_id.to_string()));
    }
    match crate::device_identity::resolve_owned_device_alias(
        &state.mysql,
        request.user_id,
        device_id,
    )
    .await
    {
        Ok(Some(device)) => Ok(Some(crate::device_identity::device_connection_route_id(
            &device,
        ))),
        Ok(None) => Ok(Some(device_id.to_string())),
        Err(error) => {
            tracing::error!(%error, task_id = request.task_id, "device route resolution failed");
            Err(FastApiError::internal())
        }
    }
}

/// `_has_fork_workspace_archive`: a fork runtime with a stored archive keeps
/// its submitted route.
fn has_fork_workspace_archive(request: &ExecutionRequest) -> bool {
    request
        .fork_runtime
        .as_ref()
        .and_then(|runtime| runtime.get("workspaceArchive"))
        .and_then(|archive| archive.get("storageKey"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

/// `ExecutionDispatcher._dispatch_websocket` (`dispatcher.py:571-620`): set
/// the device executor on the subtask, emit the START pair on `/chat`, then
/// publish `task:execute` to the device room.
pub(super) async fn dispatch_device_turn(
    state: &AppState,
    request: &ExecutionRequest,
    created_task: Option<crate::internal_callback::emitter::CreatedTask>,
    device_route: &str,
) -> Result<(), FastApiError> {
    set_subtask_executor(state, request, device_route).await?;
    mark_subtask_running(state, request).await?;
    let Some(redis) = state.redis.as_ref() else {
        tracing::error!(task_id = request.task_id, "device dispatch has no Redis");
        return Err(FastApiError::internal());
    };
    let shell = routing::shell_type(request);
    if let Err(error) = crate::internal_callback::publish_chat_start(
        redis,
        request.task_id,
        request.subtask_id,
        Value::String(request.bot_name.clone()),
        &shell,
        request.message_id,
    )
    .await
    {
        tracing::error!(%error, task_id = request.task_id, "chat:start emit failed");
        return Err(FastApiError::internal());
    }
    if let Some(created) = created_task.as_ref()
        && let Err(error) =
            crate::internal_callback::publish_task_created(redis, request.task_id, created).await
    {
        tracing::error!(%error, task_id = request.task_id, "task:created emit failed");
        return Err(FastApiError::internal());
    }
    let mut payload = super::super::dispatch::device_execution_payload(request, device_route);
    if let Some(user) = payload.get_mut("user").and_then(Value::as_object_mut) {
        user.remove("git_token");
        user.remove("gitToken");
    }
    payload["git_auth_transport"] = serde_json::json!("device_local");
    let message = crate::socketio_emit::device_execution_message(
        "task:execute",
        &payload,
        "/local-executor",
        &format!("device:{}:{device_route}", request.user_id),
    );
    use brz_redis::Redis as _;
    if let Err(error) = redis
        .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
        .await
    {
        tracing::error!(%error, task_id = request.task_id, "task:execute publish failed");
        return Err(FastApiError::internal());
    }
    Ok(())
}

/// `SubtaskStore.update_executor_info` (`dispatcher.py:417-454`): the subtask's
/// executor identity must name the device before its progress/result events
/// pass the device namespace's ownership check.
async fn set_subtask_executor(
    state: &AppState,
    request: &ExecutionRequest,
    runtime_device_id: &str,
) -> Result<(), FastApiError> {
    let redis = state.redis.as_ref().ok_or_else(FastApiError::internal)?;
    let tables = state.task_store.table_templates();
    let mysql = state
        .mysql
        .route(crate::task_routing::ByTaskId(request.task_id as u64));
    // `update_executor_info`'s `db.query(...).first()` is a different shape
    // from the shared no-limit `db.refresh` helper, so this call site adds the
    // Source's `LIMIT 1`.
    let read = format!(
        "{} \n LIMIT 1",
        crate::task_store_statements::subtask_by_id_labeled_refresh_statement(tables.subtasks)
    );
    // `_set_subtask_executor`'s subtask session also loads the subtask's
    // contexts (`WHERE subtask_id IN (?) ORDER BY id ASC`) before the update.
    let contexts = format!(
        "SELECT {} \nFROM subtask_contexts \n\
         WHERE subtask_contexts.subtask_id IN (?) \
         ORDER BY subtask_contexts.id ASC",
        crate::task_store_listing::subtask_context_columns()
    );
    use brz_mysql::MysqlTransaction as _;
    let now = chrono::Local::now().naive_local();
    mysql
        .with_transaction(async |transaction| {
            let registration = crate::device_records::lock_online_device_for_binding(
                transaction,
                redis,
                request.user_id,
                runtime_device_id,
            )
            .await?;
            if !registration.is_some_and(|device| {
                crate::device_identity::device_connection_route_id(&device) == runtime_device_id
            }) {
                return Ok(Err(FastApiError::detail(
                    StatusCode::BAD_REQUEST,
                    "Selected device is offline",
                )));
            }
            // The turn has just been committed. Read it on the binding writer
            // after taking the device owner lock that protects registration.
            let row: Option<brz_mysql::MysqlRow> = transaction
                .fetch_optional(read, (request.subtask_id,))
                .await?;
            if row.is_none() {
                return Ok(Err(FastApiError::detail(
                    StatusCode::NOT_FOUND,
                    "Subtask not found",
                )));
            }
            let _: Vec<brz_mysql::MysqlRow> = transaction
                .fetch_all(contexts, (request.subtask_id,))
                .await?;
            transaction
                .execute(
                    format!(
                        "UPDATE {table} SET executor_namespace=?, executor_name=?, updated_at=? \
                         WHERE {table}.id=? AND task_id=? AND status IN ('PENDING', 'RUNNING')",
                        table = tables.subtasks
                    ),
                    (
                        format!("user-{}", request.user_id),
                        format!("device-{runtime_device_id}"),
                        now,
                        request.subtask_id,
                        request.task_id,
                    ),
                )
                .await?;
            Ok(Ok(()))
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, subtask_id = request.subtask_id, "executor update failed");
            FastApiError::internal()
        })?
}

/// Dispatch the Responses turn through the ordinary traditional-device path.
pub(crate) async fn dispatch_responses_device(
    state: &AppState,
    request: &mut ExecutionRequest,
    device_route: &str,
) -> Result<(), FastApiError> {
    recover_before_dispatch(state, request, Some(device_route)).await?;
    let dispatched = dispatch_device_turn(state, request, None, device_route).await;
    if let Err(error) = &dispatched {
        crate::internal_callback::process_device_dispatch_failure(
            state,
            request.task_id,
            request.subtask_id,
            request.message_id,
            build_failure_message(error),
        )
        .await;
    }
    dispatched
}

/// Admit a device Responses turn to the startup-owned supervisor after the
/// callback reader exists. The request path can then be cancelled without
/// cancelling the RUNNING transition or the subsequent `task:execute` emit.
pub(crate) fn enqueue_responses_device(
    state: &AppState,
    request: &ExecutionRequest,
    device_route: &str,
) -> Result<(), FastApiError> {
    if state
        .responses_dispatch
        .submit(crate::responses::dispatch::DefaultDispatchJob::Device {
            request: Box::new(request.clone()),
            device_route: device_route.to_owned(),
            consumer: Box::new(crate::responses::dispatch::ConsumerState::from_app(state)),
        })
    {
        return Ok(());
    }
    tracing::error!(
        task_id = request.task_id,
        subtask_id = request.subtask_id,
        "device dispatch queue unavailable"
    );
    Err(FastApiError::internal())
}
