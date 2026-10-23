// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Post-commit execution of an automatic pipeline's committed next turn.
use brz_mysql::{Json, MysqlRow, MysqlTransaction};
use serde_json::{Value, json};

use crate::http_compat::FastApiError;
use crate::responses::create::{dispatch, executor_client, request, routing, seam};
use crate::responses::dispatch::DispatchJob;
use crate::state::AppState;
use crate::task_store::PipelineStageAdvance;

/// Source stage creation/notification failures still propagate, while the
/// asynchronous next-stage request-preparation/dispatch failure is contained.
pub(super) async fn dispatch_next(
    state: &AppState,
    advance: PipelineStageAdvance,
) -> Result<(), FastApiError> {
    if let Some(redis) = state.redis.as_ref() {
        super::socketio::publish_emit(
            redis,
            "task:status",
            advance.task_id,
            json!({"task_id": advance.task_id,"status":"RUNNING","progress":0}),
        )
        .await
        .map_err(|error| {
            tracing::error!(%error, "pipeline task status emit failed");
            FastApiError::internal()
        })?;
        super::socketio::publish_emit(
            redis,
            "chat:message",
            advance.task_id,
            user_message(&advance),
        )
        .await
        .map_err(|error| {
            tracing::error!(%error, "pipeline user message emit failed");
            FastApiError::internal()
        })?;
    }
    let task_id = advance.task_id;
    let subtask_id = advance.pair.assistant_subtask_id;
    let user_id = advance.user_id;
    if let Err(error) = dispatch_execution(state, advance).await {
        tracing::error!(
            ?error,
            task_id,
            subtask_id,
            "pipeline next-stage dispatch failed"
        );
        if let Some(redis) = state.redis.as_ref() {
            let ctx = super::completion::Completion {
                mysql: &state.mysql,
                redis,
                tables: super::tables(state),
                executor_manager: &state.executor_manager,
            };
            super::completion::persist_completed_result(
                &ctx,
                task_id,
                subtask_id,
                "FAILED",
                None,
                Some("Pipeline stage dispatch failed"),
                None,
                None,
            )
            .await;
            if let Err(error) = super::socketio::publish_emit_in_room(
                redis,
                "task:status",
                &format!("user:{user_id}"),
                json!({"task_id":task_id,"status":"FAILED","progress":null}),
            )
            .await
            {
                tracing::error!(%error, task_id, "pipeline dispatch-failure status emit failed");
            }
        }
    }
    Ok(())
}

async fn dispatch_execution(
    state: &AppState,
    mut advance: PipelineStageAdvance,
) -> Result<(), FastApiError> {
    let bot_ids = [advance.bot.id];
    let request_id = format!(
        "pipeline-{}-{}",
        advance.task_id, advance.pair.assistant_subtask_id
    );
    let mut execution = request::build_execution_request(
        state,
        &request::BuildExecutionRequestInput {
            user_id: advance.user_id,
            user_name: &advance.user_name,
            task_id: advance.task_id,
            assistant_subtask_id: advance.pair.assistant_subtask_id,
            user_subtask_id: advance.pair.user_subtask_id,
            team: &advance.team,
            bot: &advance.bot,
            bot_role: advance
                .member
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("worker"),
            team_member_prompt: advance.member.get("prompt").and_then(Value::as_str),
            bot_ids: &bot_ids,
            message: &advance.message,
            enable_tools: true,
            enable_web_search: false,
            enable_deep_thinking: true,
            task_json: &advance.task_json,
            request_id: &request_id,
            message_id: advance.message_id + 1,
            is_group_chat: advance
                .task_json
                .pointer("/spec/is_group_chat")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            task_project_id: advance.project_id,
            executor_name: &advance.pair.executor.name,
            executor_namespace: &advance.pair.executor.namespace,
        },
    )
    .await?;
    execution.new_session = advance.previous_bot_id != advance.bot.id;
    let chat_shell = seam::chat_shell_url();
    let executor_manager = seam::executor_manager_url();
    let shell = routing::shell_type(&execution);
    let target = routing::route(&routing::RouteInputs {
        shell_type: &shell,
        chat_shell_url: &chat_shell,
        executor_manager_url: &executor_manager,
        device_id: advance
            .task_json
            .pointer("/spec/device_id")
            .and_then(Value::as_str),
        model_is_video: execution
            .model_config
            .get("model_type")
            .and_then(Value::as_str)
            == Some("video"),
        model_protocol: execution
            .model_config
            .get("protocol")
            .and_then(Value::as_str),
    });
    let tables = state
        .task_store
        .message_edit_tables(advance.task_id)
        .await
        .map_err(dependency)?;
    let mysql = state
        .mysql
        .route(crate::task_routing::ByTaskId(advance.task_id as u64));
    let running = mysql.with_transaction(async |transaction| {
        let task: Option<MysqlRow> = transaction.fetch_optional(
            crate::task_store::task_for_update_first_statement(&tables.tasks), (advance.task_id,)).await?;
        let current = task.as_ref().and_then(|row| super::completion::task_column::<Json<Value>>(row, "json"));
        if current.as_ref().and_then(|json| json.0.pointer("/spec/currentStage")) != advance.task_json.pointer("/spec/currentStage") { return Ok(false); }
        let now = chrono::Local::now().naive_local().format("%Y-%m-%d %H:%M:%S%.6f").to_string();
        let changed = transaction.execute(
            format!("UPDATE {} SET status = 'RUNNING', updated_at = ? WHERE id = ? AND task_id = ? AND status = 'PENDING'", tables.subtasks),
            (now.as_str(), advance.pair.assistant_subtask_id, advance.task_id)).await?;
        if changed.rows_affected == 0 { return Ok(false); }
        advance.task_json["status"]["status"] = json!("RUNNING");
        transaction.execute(crate::task_store::update_task_json_statement(&tables.tasks),
            (crate::json_compat::python_json_value(&advance.task_json), now, advance.task_id)).await?;
        Ok(true)
    }).await.map_err(dependency)?;
    if !running {
        return Ok(());
    }
    if routing::supports_streaming(&target) {
        let url = target.url.as_deref().ok_or_else(FastApiError::internal)?;
        state
            .responses_dispatch
            .submit(DispatchJob::ChatShell {
                url: format!("{}/v1/responses", url.trim_end_matches('/')),
                request_id,
                body: serde_json::to_value(dispatch::assemble(&execution, true, false))
                    .map_err(|_| FastApiError::internal())?,
            })
            .await;
    } else {
        let url = target.url.as_deref().ok_or_else(FastApiError::internal)?;
        state
            .responses_dispatch
            .submit(DispatchJob::Executor {
                url: executor_client::executor_responses_url(url),
                body: serde_json::to_value(dispatch::assemble(&execution, false, true))
                    .map_err(|_| FastApiError::internal())?,
            })
            .await;
    }
    Ok(())
}

fn user_message(advance: &PipelineStageAdvance) -> Value {
    json!({"subtask_id": advance.pair.user_subtask_id, "task_id": advance.task_id,
        "message_id": advance.message_id,"role":"user","content":advance.message,
        "sender":{"user_id":advance.user_id,"user_name":advance.user_name},
        "created_at":chrono::Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S%.6f").to_string(),
        "attachment":null,"attachments":[],"contexts":[]})
}

fn dependency(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "pipeline advancement database failure");
    FastApiError::internal()
}

/// Read the committed task status on the writer after callback persistence.
pub(super) async fn task_status(
    state: &AppState,
    task_id: i64,
) -> Result<Option<String>, FastApiError> {
    let tables = state
        .task_store
        .message_edit_tables(task_id)
        .await
        .map_err(dependency)?;
    state
        .mysql
        .route(crate::task_routing::ByTaskId(task_id as u64))
        .with_transaction(async |transaction| {
            let row: Option<MysqlRow> = transaction
                .fetch_optional(
                    crate::task_store::task_for_update_first_statement(&tables.tasks),
                    (task_id,),
                )
                .await?;
            Ok(row
                .and_then(|row| super::completion::task_column::<Json<Value>>(&row, "json"))
                .and_then(|json| {
                    json.0
                        .pointer("/status/status")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                }))
        })
        .await
        .map_err(dependency)
}
