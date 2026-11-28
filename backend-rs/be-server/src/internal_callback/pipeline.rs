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

pub(super) use wegent_task_store::task_store_pipeline::pending_pipeline_child as pending_child;

pub(crate) fn execution_lease_key(task_id: i64, subtask_id: i64) -> String {
    format!("wegent:lock:pipeline-execution:{task_id}:{subtask_id}")
}

/// Resources can change between the receipt and handoff transactions. Settle
/// only an intent that still owns the most recent turn under the Task lock.
pub(super) async fn settle_unavailable_advance(
    state: &AppState,
    task_id: i64,
    parent: i64,
) -> Result<Option<super::completion::CollaborationStatus>, FastApiError> {
    let tables = state
        .task_store
        .message_edit_tables(task_id)
        .await
        .map_err(dependency)?;
    let mysql = state
        .mysql
        .route(crate::task_routing::ByTaskId(task_id as u64));
    let document: Option<(Json<Value>,)> = mysql
        .with_transaction(async |tx| {
            tx.fetch_optional(
                format!("SELECT json FROM {} WHERE id=?", tables.tasks),
                (task_id,),
            )
            .await
        })
        .await
        .map_err(dependency)?;
    let child = document.and_then(|(Json(task),)| pending_child(&task, parent));
    let settle = async || {
        mysql
            .with_transaction(async |tx| {
                wegent_execution_completion::persist::settle_unavailable_on(
                    tx,
                    &tables.tasks,
                    &tables.subtasks,
                    task_id,
                    parent,
                    child,
                )
                .await
            })
            .await
            .map_err(dependency)
    };
    let Some(child) = child else {
        return settle().await;
    };
    // A Chat Shell consumer can own the pair before its first accepted SSE
    // event. Fence settlement with the same lease as the streaming worker.
    let redis = state.redis.as_ref().ok_or_else(FastApiError::internal)?;
    super::completion::with_owned_lease(
        redis,
        &execution_lease_key(task_id, child),
        FastApiError::internal,
        Some(|| {
            Some(super::completion::CollaborationStatus {
                status: "RUNNING".into(),
                progress: Some(0),
                auto_advance: true,
            })
        }),
        |_| settle(),
    )
    .await
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
    match prepare_dispatch(state, &advance).await {
        Ok(job) => claim_and_dispatch(state, &advance, job).await,
        Err(error) if error.status().is_server_error() => Err(error),
        Err(error) => {
            tracing::error!(
                ?error,
                task_id = advance.task_id,
                "pipeline next-stage dispatch failed"
            );
            settle_unavailable_pair(state, &advance).await
        }
    }
}

async fn settle_unavailable_pair(
    state: &AppState,
    advance: &PipelineStageAdvance,
) -> Result<(), FastApiError> {
    // A previous attempt may already have admitted this child.
    if let Some(parent) = wegent_task_store::pending_pipeline_parent(&advance.task_json)
        && let Some(status) = settle_unavailable_advance(state, advance.task_id, parent).await?
        && status.status == "FAILED"
        && let Some(redis) = state.redis.as_ref()
    {
        super::socketio::publish_emit_in_room(
            redis,
            "task:status",
            &format!("user:{}", advance.user_id),
            json!({"task_id": advance.task_id, "status":status.status, "progress":status.progress}),
        )
        .await
        .map_err(|_| FastApiError::internal())?;
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
            allow_new_session_fallback: false,
            knowledge_base_refs: &[],
            knowledge_base_names: &[],
            web_runtime_guidance: false,
            subtask_bot_resolved: false,
            attachment_ids: &[],
        },
        // The pipeline advance carries no request `{"type": "skill"}` settings.
        &[],
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
    enum Claim {
        Stale,
        Revoked,
        Eligible,
    }
    let claim = mysql.with_transaction(async |transaction| {
        let task: Option<MysqlRow> = transaction.fetch_optional(
            crate::task_store::task_for_update_first_statement(&tables.tasks), (advance.task_id,)).await?;
        let Some(Json(mut current)) = task.as_ref().filter(|row| super::completion::is_active_task(row)).and_then(|row| super::completion::task_column::<Json<Value>>(row, "json")) else { return Ok(Claim::Stale); };
        if current.pointer("/spec/currentStage") != advance.task_json.pointer("/spec/currentStage")
            || current.pointer(PIPELINE_HANDOFF_PATH) != advance.task_json.pointer(PIPELINE_HANDOFF_PATH)
        {
            return Ok(Claim::Stale);
        }
        if super::completion::dispatchable_task_status(&current).is_none() {
            if let Some(parent) = wegent_task_store::pending_pipeline_parent(&current) {
                wegent_task_store::retire_pipeline_handoff(
                    transaction, &tables.tasks, advance.task_id, &mut current, parent,
                ).await?;
            }
            return Ok(Claim::Stale);
        }
        if current.pointer("/spec/teamRef") != advance.task_json.pointer("/spec/teamRef") {
            return Ok(Claim::Revoked);
        }
        // Lock the live execution resources through claim commit so archival
        // and this dispatch have a definite order.
        let eligible: Option<i64> = transaction.fetch_optional(
            "SELECT t.id FROM kinds t JOIN kinds b ON b.user_id=t.user_id WHERE t.id=? AND t.user_id=? AND t.namespace=? AND t.name=? AND t.kind='Team' AND t.is_active=1 AND b.id=? AND b.namespace=? AND b.name=? AND b.kind='Bot' AND b.is_active=1 FOR SHARE",
            (advance.team.id, advance.team.user_id, advance.team.namespace.as_str(), advance.team.name.as_str(),
             advance.bot.id, advance.bot.namespace.as_str(), advance.bot.name.as_str()),
        ).await?;
        if eligible.is_none() { return Ok(Claim::Revoked); }
        let child: Option<i64> = transaction.fetch_optional(
            format!("SELECT id FROM {} WHERE id=? AND task_id=? AND status IN ('PENDING','RUNNING') FOR SHARE", tables.subtasks),
            (advance.pair.assistant_subtask_id, advance.task_id),
        ).await?;
        Ok(if child.is_some() { Claim::Eligible } else { Claim::Stale })
    }).await.map_err(dependency)?;
    match claim {
        Claim::Stale => return Ok(()),
        Claim::Revoked => return settle_unavailable_pair(state, advance).await,
        Claim::Eligible => {}
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
    let running = mysql
        .with_transaction(async |tx| {
            wegent_task_store::task_store_pipeline::record_accepted_pair(
                tx,
                &tables.tasks,
                &tables.subtasks,
                advance,
                executor_owns_execution,
            )
            .await
        })
        .await
        .map_err(dependency)?;
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
