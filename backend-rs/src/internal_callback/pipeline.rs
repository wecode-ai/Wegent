// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Post-commit execution of an automatic pipeline's committed next turn.
use brz_mysql::{Json, MysqlRow, MysqlTransaction};
use serde_json::{Value, json};

use crate::http_compat::FastApiError;
use crate::responses::create::{executor_client, request, routing, seam};
use crate::responses::dispatch::DefaultDispatchJob;
use crate::state::AppState;
use crate::task_store::PipelineStageAdvance;

const PIPELINE_HANDOFF_PATH: &str = "/metadata/labels/pipelinePendingHandoff";

pub(super) fn pending_child(task: &Value, parent: i64) -> Option<i64> {
    if wegent_task_store::pending_pipeline_parent(task)? != parent {
        return None;
    }
    task.pointer(PIPELINE_HANDOFF_PATH)?
        .as_str()?
        .rsplit_once(':')?
        .1
        .parse()
        .ok()
}

pub(crate) fn execution_lease_key(task_id: i64, subtask_id: i64) -> String {
    format!("wegent:lock:pipeline-execution:{task_id}:{subtask_id}")
}

/// Source stage creation/notification failures still propagate, while the
/// asynchronous next-stage request-preparation/dispatch failure is contained.
pub(super) async fn dispatch_next(
    state: &AppState,
    advance: PipelineStageAdvance,
) -> Result<(), FastApiError> {
    if let Some(redis) = state.redis.as_ref() {
        let key = super::completion::notification_key(
            advance.task_id,
            advance.pair.assistant_subtask_id,
            "pipeline-message",
        );
        super::socketio::publish_terminal_emit(
            redis,
            &key,
            "chat:message",
            &format!("task:{}", advance.task_id),
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
    let error = match prepare_dispatch(state, &advance).await {
        Ok(job) => return claim_and_dispatch(state, &advance, job).await,
        Err(error) => error,
    };
    if error.status().is_server_error() {
        return Err(error);
    }
    tracing::error!(
        ?error,
        task_id,
        subtask_id,
        "pipeline next-stage dispatch failed"
    );
    if let Some(redis) = state.redis.as_ref() {
        let ctx = super::completion::Completion {
            app: Some(state),
            mysql: &state.mysql,
            redis,
            tables: super::tables(state),
            executor_manager: &state.executor_manager,
        };
        let persisted = super::completion::persist_completed_result(
            &ctx,
            task_id,
            subtask_id,
            "FAILED",
            None,
            Some("Pipeline stage dispatch failed"),
            None,
            None,
            None,
        )
        .await;
        match persisted {
            Ok(Some(_)) => {}
            Ok(None) => return Ok(()),
            Err(error) => {
                tracing::error!(%error, task_id, subtask_id, "pipeline failure could not be saved");
                return Err(FastApiError::internal());
            }
        }
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
    Ok(())
}

async fn prepare_dispatch(
    state: &AppState,
    advance: &PipelineStageAdvance,
) -> Result<DefaultDispatchJob, FastApiError> {
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
            // The pipeline callback carries no `users.git_info` row; its
            // request keeps the source's all-null identity.
            user_git_info: &serde_json::Value::Null,
            // `pipeline_advance.py` loads the request `User` row and passes
            // `user=user` into `trigger_ai_response_unified`.
            user_preferences: Some(&advance.user_preferences),
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
            // No API reasoning selection on this job path.
            reasoning: None,
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
            executor_deleted: advance.pair.executor.deleted_at != 0,
            new_session: false,
            knowledge_base_refs: &[],
            knowledge_base_names: &[],
            web_runtime_guidance: false,
            subtask_bot_resolved: false,
        },
    )
    .await?;
    execution.request_id.clone_from(&request_id);
    execution.new_session = advance.previous_bot_id != advance.bot.id;
    let chat_shell = seam::chat_shell_url();
    let chat_shell_mode = routing::chat_shell_mode();
    let executor_manager = seam::executor_manager_url();
    let shell = routing::shell_type(&execution);
    let target = routing::route(&routing::RouteInputs {
        shell_type: &shell,
        chat_shell_mode: &chat_shell_mode,
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
    if routing::supports_streaming(&target) || target.mode == routing::CommunicationMode::Inprocess
    {
        let url = target.url.as_deref().ok_or_else(FastApiError::internal)?;
        let job = crate::responses::dispatch::ChatShellJob {
            task_id: execution.task_id,
            subtask_id: execution.subtask_id,
            consumer: crate::responses::dispatch::ConsumerState::from_app(state),
            target_url: url.to_string(),
            request: execution,
            request_id,
            forward: false,
            start_data: serde_json::Value::Null,
            created_task: None,
        };
        Ok(DefaultDispatchJob::ChatShell(Box::new(job)))
    } else {
        let url = target.url.as_deref().ok_or_else(FastApiError::internal)?;
        Ok(DefaultDispatchJob::Executor {
            consumer: Box::new(crate::responses::dispatch::ConsumerState::from_app(state)),
            task_id: execution.task_id,
            subtask_id: execution.subtask_id,
            user_id: execution.user_id,
            message_id: execution.message_id,
            url: executor_client::executor_responses_url(url),
            body: crate::responses::dispatch::ExecutorDispatchBody::Recover(Box::new(
                execution.clone(),
            )),
            start: state
                .redis
                .clone()
                .map(|redis| crate::responses::dispatch::start_event(redis, &execution, None)),
        })
    }
}

async fn claim_and_dispatch(
    state: &AppState,
    advance: &PipelineStageAdvance,
    job: DefaultDispatchJob,
) -> Result<(), FastApiError> {
    let executor_owns_execution = matches!(&job, DefaultDispatchJob::Executor { .. });
    let permit = state.responses_dispatch.reserve().ok_or_else(|| {
        tracing::warn!(
            task_id = advance.task_id,
            subtask_id = advance.pair.assistant_subtask_id,
            "pipeline dispatch queue unavailable"
        );
        FastApiError::internal()
    })?;
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
        let Some(Json(mut current)) = task.as_ref().filter(|row| super::completion::is_active_task(row)).and_then(|row| super::completion::task_column::<Json<Value>>(row, "json")) else { return Ok(false); };
        if current.pointer("/spec/currentStage") != advance.task_json.pointer("/spec/currentStage")
            || current.pointer(PIPELINE_HANDOFF_PATH) != advance.task_json.pointer(PIPELINE_HANDOFF_PATH)
            || super::completion::dispatchable_task_status(&current).is_none()
        {
            return Ok(false);
        }
        let now = chrono::Local::now().naive_local().format("%Y-%m-%d %H:%M:%S%.6f").to_string();
        let changed = transaction.execute(
            format!("UPDATE {} SET status = 'RUNNING', updated_at = ? WHERE id = ? AND task_id = ? AND status IN ('PENDING','RUNNING')", tables.subtasks),
            (now.as_str(), advance.pair.assistant_subtask_id, advance.task_id)).await?;
        if changed.rows_affected == 0 { return Ok(false); }
        current["status"]["status"] = json!("RUNNING");
        transaction.execute(crate::task_store::update_task_json_statement(&tables.tasks),
            (crate::json_compat::python_json_value(&current), now, advance.task_id)).await?;
        Ok(true)
    }).await.map_err(dependency)?;
    if !running {
        return Ok(());
    }
    if let Some(redis) = state.redis.as_ref() {
        let payload = json!({"task_id": advance.task_id,"status":"RUNNING","progress":0});
        for room in [
            format!("task:{}", advance.task_id),
            format!("user:{}", advance.user_id),
        ] {
            let key = super::completion::notification_key(
                advance.task_id,
                advance.pair.assistant_subtask_id,
                &format!("pipeline-running:{room}"),
            );
            super::socketio::publish_terminal_emit(
                redis,
                &key,
                "task:status",
                &room,
                payload.clone(),
            )
            .await
            .map_err(|error| {
                tracing::error!(%error, "pipeline task status emit failed");
                FastApiError::internal()
            })?;
        }
    }
    let (accepted, acknowledgement) = tokio::sync::oneshot::channel();
    permit.send(DefaultDispatchJob::Pipeline(Box::new(job), accepted));
    acknowledgement
        .await
        .map_err(|_| FastApiError::internal())?
        .map_err(|error| {
            tracing::warn!(%error, task_id = advance.task_id, "pipeline dispatch was not accepted");
            FastApiError::internal()
        })?;
    if executor_owns_execution {
        clear_dispatched_pair(state, advance).await?;
    }
    Ok(())
}

async fn clear_dispatched_pair(
    state: &AppState,
    advance: &PipelineStageAdvance,
) -> Result<(), FastApiError> {
    let tables = state
        .task_store
        .message_edit_tables(advance.task_id)
        .await
        .map_err(dependency)?;
    let mysql = state
        .mysql
        .route(crate::task_routing::ByTaskId(advance.task_id as u64));
    mysql
        .with_transaction(async |transaction| {
            let row: Option<MysqlRow> = transaction
                .fetch_optional(
                    crate::task_store::task_for_update_first_statement(&tables.tasks),
                    (advance.task_id,),
                )
                .await?;
            let Some(Json(mut task)) = row
                .as_ref()
                .and_then(|row| super::completion::task_column::<Json<Value>>(row, "json"))
            else {
                return Ok(());
            };
            if task.pointer(PIPELINE_HANDOFF_PATH)
                == advance.task_json.pointer(PIPELINE_HANDOFF_PATH)
            {
                wegent_task_store::clear_pending_pipeline_handoff(&mut task);
                transaction
                    .execute(
                        format!("UPDATE {} SET json=? WHERE id=?", tables.tasks),
                        (
                            crate::json_compat::python_json_value(&task),
                            advance.task_id,
                        ),
                    )
                    .await?;
            }
            Ok(())
        })
        .await
        .map_err(dependency)
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
