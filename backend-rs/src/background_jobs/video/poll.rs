// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! A poll is one durable continuation; normal waiting never spends retries.

use super::{Poll, VideoArtifact, VideoResult, VideoStatus, card, store};
use crate::AppState;
use anyhow::{Result, bail};
use brz_mysql::Json;
use brz_redis::Redis;
use brz_schedule::{Completion, JobContext, Lease};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

pub async fn run(
    state: &Arc<AppState>,
    context: &JobContext,
    mut poll: Poll,
) -> Result<Completion> {
    if let Some(token) = poll.scheduled_token.take() {
        state
            .background_jobs
            .locks()?
            .release(&Lease {
                key: format!("video_poll_scheduled:{}", poll.subtask_id),
                token,
                expires_at_ms: 0,
            })
            .await?;
    }
    if context.cancellation.is_cancelled() {
        return continuation(&poll);
    }
    let result = crate::background_jobs::with_lock_watchdog(
        &state.background_jobs,
        context,
        &format!("wegent:lock:video:poll:{}", poll.subtask_id),
        Duration::from_secs(300),
        run_locked(state, &mut poll),
    )
    .await;
    finish_attempt(context, &poll, result)
}

fn finish_attempt(
    context: &JobContext,
    poll: &Poll,
    result: Result<Option<Completion>>,
) -> Result<Completion> {
    match result {
        Ok(Some(result)) => Ok(result),
        Ok(None) => continuation(poll),
        // The watchdog interrupts provider work during an ordinary worker stop.
        // Preserve the durable polling cursor without spending failure retries.
        Err(_) if context.cancellation.is_cancelled() => continuation(poll),
        Err(error) => Err(error),
    }
}

async fn run_locked(state: &Arc<AppState>, poll: &mut Poll) -> Result<Completion> {
    if !store::claim(state, poll).await? {
        return Ok(Completion::Success(json!({"status":"stale"})));
    }
    let redis = state
        .redis
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("video polling requires Redis"))?;
    let cancelled: Option<String> = redis
        .get(format!("chat:cancel:{}", poll.subtask_id))
        .await?;
    if cancelled.as_deref() == Some("true") {
        return terminal(
            state,
            poll,
            "CANCELLED",
            Some("Video generation cancelled"),
            None,
        )
        .await;
    }
    if poll.card_context.is_some() {
        return poll_card(state, poll).await;
    }
    match poll_provider(state, poll).await {
        Ok(value) => Ok(value),
        Err(_error) => {
            terminal(
                state,
                poll,
                "FAILED",
                Some("Video provider request failed"),
                None,
            )
            .await
        }
    }
}

fn continuation(poll: &Poll) -> Result<Completion> {
    Ok(Completion::ContinueAt {
        run_at_ms: brz_schedule::now_ms() + super::interval() * 1000,
        payload: Some(serde_json::to_value(poll)?),
    })
}

async fn poll_provider(state: &Arc<AppState>, poll: &mut Poll) -> Result<Completion> {
    if poll.provider_protocol != "seedance" {
        bail!("Unsupported video provider")
    }
    let data = request(poll, 10).await?;
    let status = state.video_extensions.parse_status(
        &data,
        VideoStatus {
            progress: data["progress"].as_i64().unwrap_or(0),
            completed: data["status"] == "succeeded",
            failed: data["status"] == "failed",
            error: error_message(&data["error"]),
        },
    );
    poll.last_progress = estimate(status.progress, poll.poll_count, poll.last_progress);
    if !store::save(state, poll, None, poll.last_progress, None, None, None).await? {
        return Ok(Completion::Success(json!({"status":"stale"})));
    }
    if status.completed {
        return complete_video(state, poll).await;
    }
    if status.failed {
        return terminal(
            state,
            poll,
            "FAILED",
            Some(status.error.as_deref().unwrap_or("Video generation failed")),
            None,
        )
        .await;
    }
    emit_chunk(state, poll, "streaming", true).await?;
    if poll.poll_count >= super::maximum() {
        return terminal(
            state,
            poll,
            "FAILED",
            Some("Video generation timed out"),
            None,
        )
        .await;
    }
    continuation(poll)
}

async fn request(poll: &Poll, seconds: u64) -> Result<Value> {
    let base = poll.model_config["base_url"]
        .as_str()
        .unwrap_or("")
        .trim_end_matches('/');
    let mut url = url::Url::parse(&format!("{base}/contents/generations/tasks/"))?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("Invalid video provider URL"))?
        .push(&poll.job_id);
    let http = brz_http::Client::builder()
        .connect_timeout(Duration::from_secs(seconds))
        .read_timeout(Duration::from_secs(seconds))
        .configure(|b| b.redirect(brz_http::reqwest::redirect::Policy::none()))
        .build()?;
    let mut request = http
        .as_reqwest()
        .get(url)
        .bearer_auth(poll.model_config["api_key"].as_str().unwrap_or(""))
        .header("Content-Type", "application/json");
    if let Some(headers) = poll.model_config["default_headers"].as_object() {
        for (key, value) in headers {
            if let Some(value) = value.as_str() {
                request = request.header(key, value);
            }
        }
    }
    let response = request.send().await?;
    if !response.status().is_success() {
        bail!("Video provider returned an error")
    }
    let bytes = super::super::knowledge::sources::bounded_body(response, 10 * 1024 * 1024).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn error_message(value: &Value) -> Option<String> {
    if value.is_null() {
        None
    } else {
        Some(
            value
                .as_str()
                .or_else(|| value["message"].as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string()),
        )
    }
}

fn estimate(provider: i64, count: u32, last: i64) -> i64 {
    let next = if provider > 0 {
        provider.min(99)
    } else {
        5 + (94.0 * (f64::from(count) * super::interval() as f64 / 600.0).min(1.0)) as i64
    };
    next.max(last).min(99)
}

async fn complete_video(state: &Arc<AppState>, poll: &Poll) -> Result<Completion> {
    let mut progress = poll.clone();
    progress.last_progress = 99;
    emit_chunk(state, &progress, "streaming", true).await?;
    let data = request(poll, 30).await?;
    let result = state.video_extensions.parse_result(
        &data,
        VideoResult {
            video_url: data
                .pointer("/content/video_url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            thumbnail: None,
            duration: data["duration"].as_f64(),
            metadata: Default::default(),
        },
    );
    let artifact = match state
        .video_extensions
        .prepare_artifact(state, &result, poll.user_id, poll.task_id, poll.subtask_id)
        .await?
    {
        Some(artifact) => artifact,
        None => upload(state, poll, &result).await?,
    };
    let mut block = json!({"id":poll.video_block_id,"type":"video","status":"done","is_placeholder":false,"video_url":artifact.video_url,"video_thumbnail":artifact.thumbnail,"video_duration":artifact.duration,"video_attachment_id":artifact.attachment_id,"video_progress":100,"timestamp":chrono::Utc::now().timestamp_millis()});
    for (key, value) in artifact.block_metadata {
        block[key] = value;
    }
    let result =
        json!({"value":"Video generation completed","image":artifact.thumbnail,"blocks":[block]});
    if store::save(
        state,
        poll,
        Some("COMPLETED"),
        100,
        None,
        Some(&result),
        None,
    )
    .await?
    {
        let mut websocket = result.clone();
        websocket["blocks"][0]["video_url"] = artifact.websocket_video_url.into();
        emit(
            state,
            poll,
            "chat:done",
            json!({"type":"done","message_id":poll.message_id,"offset":0,"result":websocket}),
        )
        .await?;
    }
    Ok(Completion::Success(
        json!({"status":"completed","job_id":poll.job_id}),
    ))
}

async fn upload(state: &Arc<AppState>, poll: &Poll, result: &VideoResult) -> Result<VideoArtifact> {
    let http = brz_http::Client::builder()
        .connect_timeout(Duration::from_secs(120))
        .read_timeout(Duration::from_secs(120))
        .configure(|b| b.redirect(brz_http::reqwest::redirect::Policy::none()))
        .build()?;
    let response = http.as_reqwest().get(&result.video_url).send().await?;
    if !response.status().is_success() {
        bail!("Generated video could not be downloaded")
    }
    let bytes = super::super::knowledge::sources::bounded_body(response, 100 * 1024 * 1024).await?;
    let attachment_id = crate::attachments::upload::upload_attachment_context(
        state,
        poll.user_id,
        &format!("video_{}_{}.mp4", poll.task_id, poll.subtask_id),
        &bytes,
        poll.subtask_id,
        None,
    )
    .await?;
    state.mysql.execute("UPDATE subtask_contexts SET type_data=JSON_SET(COALESCE(type_data,JSON_OBJECT()),'$.video_metadata',CAST(? AS JSON)),updated_at=NOW() WHERE id=? AND user_id=? AND subtask_id=?",(Json(json!({"thumbnail":result.thumbnail,"duration":result.duration})),attachment_id,poll.user_id,poll.subtask_id)).await?;
    let video_url = format!("/api/attachments/{attachment_id}/download");
    Ok(VideoArtifact {
        websocket_video_url: video_url.clone(),
        video_url,
        attachment_id,
        thumbnail: result.thumbnail.clone(),
        duration: result.duration,
        block_metadata: Default::default(),
    })
}

async fn poll_card(state: &Arc<AppState>, poll: &mut Poll) -> Result<Completion> {
    let context = poll.card_context.as_ref().expect("card context");
    let snapshot = match card::fetch(state, context["query_url"].as_str().unwrap_or("")).await {
        Ok(snapshot) => snapshot,
        Err(_) if poll.poll_count < super::maximum() => return continuation(poll),
        Err(_) => {
            return terminal(
                state,
                poll,
                "FAILED",
                Some("Card workflow status request failed"),
                None,
            )
            .await;
        }
    };
    // Terminal writes must persist this snapshot's progress, just as waiting
    // snapshots do, rather than the previous continuation's progress.
    poll.last_progress = snapshot.progress;
    let block = card::block(&poll.video_block_id, context, &snapshot);
    if snapshot.status == "failed" {
        return terminal(
            state,
            poll,
            "FAILED",
            Some(
                snapshot
                    .error
                    .as_deref()
                    .unwrap_or("Video generation failed"),
            ),
            Some(block),
        )
        .await;
    }
    if snapshot.status == "completed" {
        return terminal(state, poll, "COMPLETED", None, Some(block)).await;
    }
    if store::save(
        state,
        poll,
        None,
        snapshot.progress,
        Some(&block),
        None,
        None,
    )
    .await?
    {
        emit_card(state, poll, &block).await?;
    }
    if poll.poll_count >= super::maximum() {
        return terminal(
            state,
            poll,
            "FAILED",
            Some("Video generation timed out"),
            None,
        )
        .await;
    }
    let mut next = poll.clone();
    next.last_progress = snapshot.progress;
    continuation(&next)
}

async fn terminal(
    state: &Arc<AppState>,
    poll: &Poll,
    status: &str,
    error: Option<&str>,
    block: Option<Value>,
) -> Result<Completion> {
    let block = block.or_else(|| {
        poll.card_context.as_ref().map(|context| {
            card::block(
                &poll.video_block_id,
                context,
                &card::Snapshot {
                    status: "failed".into(),
                    progress: poll.last_progress,
                    progress_text: String::new(),
                    card: json!({}),
                    error: error.map(str::to_owned),
                },
            )
        })
    });
    if store::save(
        state,
        poll,
        Some(status),
        poll.last_progress,
        block.as_ref(),
        None,
        error,
    )
    .await?
    {
        if let Some(block) = &block {
            emit_card(state, poll, block).await?;
        } else {
            emit_chunk(
                state,
                poll,
                if status == "CANCELLED" {
                    "cancelled"
                } else {
                    "error"
                },
                status == "CANCELLED",
            )
            .await?;
        }
        let (event, kind) = match status {
            "COMPLETED" => ("chat:done", "done"),
            "CANCELLED" => ("chat:cancelled", "cancelled"),
            _ => ("chat:error", "error"),
        };
        let mut payload = json!({"type":kind,"message_id":poll.message_id});
        if status == "COMPLETED" {
            payload["offset"] = 0.into();
            payload["result"] = json!({"value":"","blocks":[block]});
        } else if status == "FAILED" {
            payload["error"] = error.unwrap_or("Video generation failed").into();
        }
        emit(state, poll, event, payload).await?;
    }
    Ok(Completion::Success(
        json!({"status":status.to_lowercase(),"job_id":poll.job_id}),
    ))
}

pub fn video_block(id: &str, progress: i64, status: &str, placeholder: bool) -> Value {
    json!({"id":id,"type":"video","status":status,"is_placeholder":placeholder,"video_url":"","video_thumbnail":null,"video_duration":null,"video_attachment_id":null,"video_progress":progress,"content":"","timestamp":chrono::Utc::now().timestamp_millis()})
}
async fn emit_chunk(state: &AppState, poll: &Poll, status: &str, placeholder: bool) -> Result<()> {
    emit(state,poll,"chat:chunk",json!({"type":"chunk","message_id":poll.message_id,"content":"","offset":0,"result":{"blocks":[video_block(&poll.video_block_id,poll.last_progress,status,placeholder)]}})).await
}
async fn emit_card(state: &AppState, poll: &Poll, block: &Value) -> Result<()> {
    let mut payload = block.clone();
    payload["block_id"] = block["id"].clone();
    if let Some(map) = payload.as_object_mut() {
        for key in ["id", "type", "timestamp"] {
            map.shift_remove(key);
        }
    }
    emit(state, poll, "chat:block_updated", payload).await
}
async fn emit(state: &AppState, poll: &Poll, event: &str, mut payload: Value) -> Result<()> {
    payload["task_id"] = poll.task_id.into();
    payload["subtask_id"] = poll.subtask_id.into();
    let payload = crate::task_detail_api::assembly::sanitize_client_payload(payload);
    let message = crate::socketio_emit::emit_message(
        event,
        &json!([payload]).to_string(),
        "/chat",
        &format!("task:{}", poll.task_id),
    );
    state
        .redis
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("video polling requires Redis"))?
        .publish("socketio", message)
        .await?;
    Ok(())
}

#[cfg(test)]
#[path = "poll_tests.rs"]
mod tests;
