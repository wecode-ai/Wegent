// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Provider job creation persists its recovery identity before queue handoff.

#[path = "create_intent.rs"]
mod intent;
#[path = "create_media.rs"]
mod media;
#[path = "create_research.rs"]
mod research;
#[path = "create_seedance.rs"]
mod seedance;

use super::{Poll, poll, store};
use crate::{AppState, responses::create::dispatch::ExecutionRequest};
use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use brz_redis::Redis;
use serde_json::{Value, json};

pub(crate) async fn dispatch(state: &AppState, request: &ExecutionRequest) -> Result<()> {
    let result = if request.model_config["modelType"] == "video" {
        video(state, request).await
    } else if request.model_config["protocol"] == "gemini-deep-research" {
        research::execute(state, request).await
    } else {
        bail!("No polling agent is configured for this model")
    };
    if let Err(error) = &result {
        if request.model_config["modelType"] == "video" {
            #[derive(FromMysqlRow)]
            struct Current {
                result: Option<Json<Value>>,
            }
            let tables = state.task_store.table_templates();
            let current: Option<Current> = state
                .mysql
                .route(crate::task_routing::ByTaskId(request.task_id as u64))
                .fetch_optional(
                    format!(
                        "SELECT result FROM {} WHERE id=? AND task_id=? AND user_id=?",
                        tables.subtasks
                    ),
                    (request.subtask_id, request.task_id, request.user_id),
                )
                .await?;
            if let Some(id) = current
                .as_ref()
                .and_then(|row| row.result.as_ref())
                .and_then(|result| result.0["video_job"]["video_block_id"].as_str())
            {
                emit(state,request,"chat:chunk",json!({"type":"chunk","content":"","offset":0,"result":{"blocks":[poll::video_block(id,0,"error",false)]}})).await?;
            }
        }
        finish(state, request, "FAILED", None, Some(&error.to_string())).await?;
        emit(
            state,
            request,
            "chat:error",
            json!({"type":"error","error":error.to_string()}),
        )
        .await?;
    }
    result
}

async fn video(state: &AppState, request: &ExecutionRequest) -> Result<()> {
    let user = request.user["id"]
        .as_i64()
        .filter(|id| *id != 0)
        .unwrap_or(request.user_id);
    if user == 0 {
        bail!("Video generation requires an authenticated user")
    }
    let block_id = format!(
        "video-{}",
        &crate::background_jobs::project::notifications::uuid().replace('-', "")[..8]
    );
    let mut poll = Poll {
        subtask_id: request.subtask_id,
        task_id: request.task_id,
        user_id: user,
        job_id: String::new(),
        provider_protocol: request.model_config["protocol"]
            .as_str()
            .filter(|v| !v.is_empty())
            .unwrap_or("seedance")
            .into(),
        video_block_id: block_id,
        model_config: request.model_config.clone(),
        message_id: request.message_id,
        intent_result: None,
        poll_count: 0,
        last_progress: 0,
        card_context: None,
        request_id: Some(request.request_id.clone()),
        scheduled_token: None,
    };
    emit(
        state,
        request,
        "chat:start",
        json!({"type":"start","shell_type":"Chat"}),
    )
    .await?;
    if !persist(state, &poll, "creating").await? {
        return Ok(());
    }
    emit_placeholder(state, request, &poll).await?;
    let (mut prompt, mut images) = media::prompt_and_images(request);
    let uploaded = media::uploaded(state, request, user).await?;
    media::merge_images(&mut images, uploaded.images);
    let mut mode = media::image_mode(&request.model_config, &images);
    if images.is_empty()
        && uploaded.videos.is_empty()
        && uploaded.audios.is_empty()
        && request.task_id != 0
    {
        poll.last_progress = 2;
        emit_placeholder(state, request, &poll).await?;
        let analyzed = intent::analyze(state, request, &prompt).await?;
        prompt = analyzed.prompt;
        images = analyzed
            .image
            .into_iter()
            .map(|url| json!({"url":url}))
            .collect();
        mode = analyzed.mode;
    }
    media::validate(
        &request.model_config,
        &images,
        &uploaded.videos,
        &uploaded.audios,
    )?;
    images = match state
        .video_extensions
        .stage_images(state, images.clone(), user)
        .await?
    {
        Some(images) => images,
        None => media::direct_stage(state, images)?,
    };
    if cancelled(state, request).await? {
        finish(state, request, "CANCELLED", None, None).await?;
        return Ok(());
    }
    poll.last_progress = 5;
    emit_placeholder(state, request, &poll).await?;
    poll.job_id = seedance::create(
        state,
        &request.model_config,
        &prompt,
        mode.as_deref(),
        images,
        &uploaded.videos,
        &uploaded.audios,
    )
    .await?;
    if !persist(state, &poll, "polling").await? {
        return Ok(());
    }
    if state.background_jobs.is_enabled(super::POLL) {
        state
            .background_jobs
            .submit(
                super::POLL,
                &poll,
                Some(chrono::Utc::now() + chrono::Duration::seconds(super::interval())),
                Some(format!("video_poll_{}:{}", poll.subtask_id, poll.job_id)),
            )
            .await?;
    } else {
        let payload = serde_json::to_value(&poll)?;
        let kwargs = payload.as_object().expect("serialized poll");
        let task_id = format!("video_poll_{}", poll.subtask_id);
        let queue = crate::config::env_or_dotenv("CELERY_TASK_DEFAULT_QUEUE")
            .unwrap_or_else(|| "wegent_online".into());
        state
            .celery
            .dispatch(
                state
                    .redis
                    .as_ref()
                    .context("Video polling requires Redis")?,
                &crate::celery_broker::CeleryTask {
                    task_name: super::POLL,
                    queue: &queue,
                    task_id: &task_id,
                    kwargs,
                    expires_at: None,
                },
            )
            .await?;
    }
    Ok(())
}

async fn persist(state: &AppState, poll: &Poll, status: &str) -> Result<bool> {
    #[derive(FromMysqlRow)]
    struct Row {
        status: String,
        result: Option<Json<Value>>,
    }
    let tables = state.task_store.table_templates();
    let mysql = state
        .mysql
        .route(crate::task_routing::ByTaskId(poll.task_id as u64));
    Ok(mysql.with_transaction(async|tx|{
        let row:Option<Row>=tx.fetch_optional(format!("SELECT s.status,s.result FROM {} s JOIN {} t ON t.id=s.task_id WHERE s.id=? AND s.task_id=? AND t.user_id=? AND t.is_active=1 AND s.role='ASSISTANT' FOR UPDATE",tables.subtasks,tables.tasks),(poll.subtask_id,poll.task_id,poll.user_id)).await?;
        let Some(row)=row else{return Ok(false)};if row.status!="RUNNING"{return Ok(false)}
        let mut tracking=store::tracking(poll,status,poll.last_progress);
        tracking["model_name"]=poll.model_config["model_name"].clone();tracking["model_namespace"]=poll.model_config["model_namespace"].clone();
        if status=="polling"{tracking["started_at"]=json!(chrono::Utc::now().to_rfc3339());}
        let result=store::merge(row.result.map(|v|v.0).unwrap_or(json!({})),&tracking,None);
        tx.execute(format!("UPDATE {} SET result=?,updated_at=NOW() WHERE id=?",tables.subtasks),(Json(result),poll.subtask_id)).await?;Ok(true)
    }).await?)
}

async fn emit_placeholder(state: &AppState, request: &ExecutionRequest, poll: &Poll) -> Result<()> {
    emit(state,request,"chat:chunk",json!({"type":"chunk","content":"","offset":0,"result":{"blocks":[poll::video_block(&poll.video_block_id,poll.last_progress,"streaming",true)]}})).await
}

pub(super) async fn emit(
    state: &AppState,
    request: &ExecutionRequest,
    event: &str,
    mut value: Value,
) -> Result<()> {
    value["task_id"] = json!(request.task_id);
    value["subtask_id"] = json!(request.subtask_id);
    value["message_id"] = json!(request.message_id);
    let value = crate::task_detail_api::assembly::sanitize_client_payload(value);
    let message = crate::socketio_emit::emit_message(
        event,
        &json!([value]).to_string(),
        "/chat",
        &format!("task:{}", request.task_id),
    );
    state
        .redis
        .as_ref()
        .context("Polling execution requires Redis")?
        .publish("socketio", message)
        .await?;
    Ok(())
}

pub(super) async fn cancelled(state: &AppState, request: &ExecutionRequest) -> Result<bool> {
    let flag: Option<String> = state
        .redis
        .as_ref()
        .context("Polling execution requires Redis")?
        .get(format!("chat:cancel:{}", request.subtask_id))
        .await?;
    Ok(flag.as_deref() == Some("true"))
}

pub(super) async fn finish(
    state: &AppState,
    request: &ExecutionRequest,
    status: &str,
    result: Option<&Value>,
    error: Option<&str>,
) -> Result<()> {
    let redis = state
        .redis
        .as_ref()
        .context("Polling execution requires Redis")?;
    let context = crate::internal_callback::completion::Completion {
        app: Some(state),
        mysql: &state.mysql,
        redis,
        tables: crate::internal_callback::tables(state),
        executor_manager: &state.executor_manager,
    };
    crate::internal_callback::completion::complete_terminal(
        &context,
        request.task_id,
        request.subtask_id,
        status,
        result,
        error,
        None,
        None,
        None,
    )
    .await;
    Ok(())
}
