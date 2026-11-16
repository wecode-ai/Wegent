// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Restart recovery reads the existing sharded subtask rows and schedule lease.

use super::Poll;
use crate::{AppState, task_routing::ByTaskId, task_store_maintenance::MaintenanceScan};
use anyhow::Result;
use brz_mysql::{FromMysqlRow, Json};
use brz_schedule::JobContext;
use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

pub async fn run(state: &Arc<AppState>, context: &JobContext) -> Result<Value> {
    if !state.background_jobs.is_enabled(super::POLL) {
        return Ok(json!({"status":"polling_not_owned"}));
    }
    Ok(crate::background_jobs::with_lock_watchdog(
        &state.background_jobs,
        context,
        "wegent:lock:video_recovery",
        Duration::from_secs(120),
        recover(state, context),
    )
    .await?
    .unwrap_or_else(|| json!({"status":"locked"})))
}

async fn recover(state: &Arc<AppState>, context: &JobContext) -> Result<Value> {
    let since = Utc::now().naive_utc()
        - chrono::Duration::hours(super::setting("VIDEO_RECOVERY_LOOKBACK_HOURS", 1));
    let rows = state
        .task_store
        .scan_maintenance_subtasks(&MaintenanceScan::RunningSince {
            created_after: since,
        })
        .await?;
    let mut recovered = 0;
    for row in rows {
        if context.cancellation.is_cancelled() {
            anyhow::bail!("Video recovery cancelled")
        }
        let Some(result) = row.get::<Json<Value>>("result")?.map(|v| v.0) else {
            continue;
        };
        let job = &result["video_job"];
        if !stale(job, Utc::now().timestamp_millis()) {
            continue;
        }
        let Some(job_id) = job["job_id"].as_str().filter(|v| !v.is_empty()) else {
            continue;
        };
        let Some(block) = job["video_block_id"].as_str().filter(|v| !v.is_empty()) else {
            continue;
        };
        let has_card = job["query_url"].as_str().is_some_and(|v| !v.is_empty())
            && job["card_type"].as_str().is_some_and(|v| !v.is_empty());
        if !has_card && job["provider"].as_str().is_none_or(str::is_empty) {
            continue;
        }
        let subtask_id = row.get_required::<i64>("id")?;
        let task_id = row.get_required::<i64>("task_id")?;
        let Some(task) = task(state, task_id).await? else {
            continue;
        };
        let model_config = model(state, task.user_id, &task.json.0)
            .await
            .unwrap_or_else(|_| json!({}));
        let token = crate::background_jobs::client::random_id()?;
        let locks = state.background_jobs.locks()?;
        let Some(lease) = locks
            .try_acquire(
                &format!("video_poll_scheduled:{subtask_id}"),
                &token,
                (super::interval().max(10) * 1000) as u64,
            )
            .await?
        else {
            continue;
        };
        let poll=Poll{subtask_id,task_id,user_id:task.user_id,job_id:job_id.into(),provider_protocol:job["provider"].as_str().unwrap_or("").into(),video_block_id:block.into(),model_config,message_id:row.get("message_id")?,intent_result:job.get("intent_result").cloned(),poll_count:job["poll_count"].as_u64().unwrap_or(0).min(u32::MAX as u64) as u32,last_progress:job["progress"].as_i64().unwrap_or(0),card_context:has_card.then(||json!({"query_url":job["query_url"],"card_type":job["card_type"],"preview_title":job["preview_title"],"progress_text":job["progress_text"]})),request_id:None,scheduled_token:Some(token)};
        let canonical = format!("video_poll_{subtask_id}:{job_id}");
        let key = if state
            .background_jobs
            .snapshot(super::POLL, &canonical)
            .await?
            .is_some_and(|record| record.status.is_terminal())
        {
            format!(
                "{canonical}:recovery:{}",
                crate::background_jobs::client::random_id()?
            )
        } else {
            canonical
        };
        let queued = state
            .background_jobs
            .submit(super::POLL, &poll, None, Some(key))
            .await;
        match queued {
            Ok(brz_schedule::SubmitResult::Inserted) => recovered += 1,
            Ok(_) => {
                locks.release(&lease).await?;
            }
            Err(error) => {
                locks.release(&lease).await?;
                return Err(error);
            }
        }
    }
    Ok(json!({"recovered":recovered}))
}

fn stale(job: &Value, now: i64) -> bool {
    if job["status"] != "polling" {
        return false;
    }
    let Some(raw) = job["last_poll_at"].as_str() else {
        return true;
    };
    let at = DateTime::parse_from_rfc3339(raw)
        .map(|v| v.timestamp_millis())
        .ok()
        .or_else(|| {
            NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f")
                .ok()
                .map(|v| v.and_utc().timestamp_millis())
        });
    at.is_none_or(|at| now - at >= super::setting("VIDEO_RECOVERY_STALE_SECONDS", 10) * 1000)
}

#[derive(FromMysqlRow)]
struct Task {
    user_id: i64,
    json: Json<Value>,
}
async fn task(state: &AppState, id: i64) -> Result<Option<Task>> {
    Ok(state
        .mysql
        .route(ByTaskId(id as u64))
        .fetch_optional(
            format!(
                "SELECT user_id,json FROM {} WHERE id=? AND kind='Task' AND is_active=1",
                state.task_store.table_templates().tasks
            ),
            (id,),
        )
        .await?)
}

#[derive(FromMysqlRow)]
struct Kind {
    json: Json<Value>,
}
async fn kind(
    state: &AppState,
    kind: &str,
    user_id: i64,
    name: &str,
    namespace: &str,
) -> Result<Option<Value>> {
    Ok(state.mysql.fetch_optional::<_,_,Kind>("SELECT json FROM kinds WHERE kind=? AND user_id=? AND name=? AND namespace=? AND is_active=1 LIMIT 1",(kind,user_id,name,namespace)).await?.map(|v|v.json.0))
}

async fn model(state: &AppState, user_id: i64, task: &Value) -> Result<Value> {
    let username: Option<(String,)> = state
        .mysql
        .fetch_optional(
            "SELECT user_name FROM users WHERE id=? AND is_active=1",
            (user_id,),
        )
        .await?;
    let username = username.map(|v| v.0).unwrap_or_default();
    let labels = &task["metadata"]["labels"];
    if labels["forceOverrideBotModel"] == "true"
        && let Some(name) = labels["modelId"].as_str()
    {
        let owner = if labels["forceOverrideBotModelType"]
            .as_str()
            .unwrap_or("public")
            == "public"
        {
            0
        } else {
            user_id
        };
        if let Some(model) = kind(state, "Model", owner, name, "default").await? {
            return super::super::execution::model_config(
                state,
                &model["spec"],
                user_id,
                &username,
            )
            .await;
        }
    }
    let reference = &task["spec"]["teamRef"];
    let owner = reference["user_id"].as_i64().unwrap_or(user_id);
    let Some(name) = reference["name"].as_str() else {
        return Ok(json!({}));
    };
    let Some(team) = kind(
        state,
        "Team",
        owner,
        name,
        reference["namespace"].as_str().unwrap_or("default"),
    )
    .await?
    else {
        return Ok(json!({}));
    };
    if let Some(members) = team["spec"]["members"].as_array() {
        for member in members {
            let reference = &member["botRef"];
            let owner = reference["user_id"].as_i64().unwrap_or(owner);
            let Some(name) = reference["name"].as_str() else {
                continue;
            };
            let Some(bot) = kind(
                state,
                "Bot",
                owner,
                name,
                reference["namespace"].as_str().unwrap_or("default"),
            )
            .await?
            else {
                continue;
            };
            let Some(name) =
                crate::responses::create::resolution::resolve_model_name(&bot["spec"], false, None)
            else {
                continue;
            };
            if let Some(model) = crate::responses::create::resolution::resolve_model_for_bot(
                &state.mysql,
                &state.entity_resolvers,
                state.redis.as_ref(),
                owner,
                &name,
            )
            .await?
                && let Ok(config) = super::super::execution::model_config(
                    state,
                    &model.json.0["spec"],
                    user_id,
                    &username,
                )
                .await
            {
                return Ok(config);
            }
        }
    }
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_uses_utc_for_naive_legacy_timestamps_and_only_recovers_polling() {
        let now = DateTime::parse_from_rfc3339("2026-10-23T10:00:10Z")
            .unwrap()
            .timestamp_millis();
        assert!(stale(
            &json!({"status":"polling","last_poll_at":"2026-10-23T10:00:00"}),
            now
        ));
        assert!(!stale(
            &json!({"status":"polling","last_poll_at":"2026-10-23T10:00:09Z"}),
            now
        ));
        assert!(stale(
            &json!({"status":"polling","last_poll_at":"bad"}),
            now
        ));
        assert!(!stale(&json!({"status":"completed"}), now));
    }
}
