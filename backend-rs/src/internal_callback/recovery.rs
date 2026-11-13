// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Redis indexes unfinished work. The writer's task labels decide what to replay.
use std::sync::{Arc, Weak};
use std::time::Duration;

use brz_mysql::{Json, MysqlTransaction};
use brz_redis::{Redis, RedisService};
use serde_json::Value;
use tokio::task::JoinSet;

use crate::state::AppState;

use super::{completion, deliver_terminal_callback, event::ExecutionEvent, tables};

const QUEUE: &str = "wegent:terminal-delivery:pending:rust";
const EVENTS: &str = "{wegent:terminal-delivery:pending:rust}:events";
const RETRY_SECONDS: i64 = 5;
const MAX_RECOVERIES: usize = 8;

pub(super) async fn track(
    redis: &RedisService,
    task_id: i64,
    subtask_id: i64,
    event: Option<&Value>,
) -> brz_redis::RedisResult<()> {
    let member = format!("{task_id}:{subtask_id}");
    let score = next_attempt().to_string();
    if let Some(event) = event {
        redis
            .eval::<_, _, _, i64>(
                "redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
             return redis.call('HSETNX', KEYS[2], ARGV[1], ARGV[3])",
                [QUEUE, EVENTS],
                [member, score, event.to_string()],
            )
            .await?;
    } else {
        redis.zadd(QUEUE, next_attempt() as f64, member).await?;
    }
    Ok(())
}

pub(super) async fn retire(
    redis: &RedisService,
    task_id: i64,
    subtask_id: i64,
) -> brz_redis::RedisResult<()> {
    redis
        .eval::<_, _, _, i64>(
            "redis.call('HDEL', KEYS[2], ARGV[1])
         return redis.call('ZREM', KEYS[1], ARGV[1])",
            [QUEUE, EVENTS],
            [format!("{task_id}:{subtask_id}")],
        )
        .await?;
    Ok(())
}

fn next_attempt() -> i64 {
    chrono::Utc::now().timestamp() + RETRY_SECONDS
}

pub(crate) fn start(app: &Arc<AppState>) {
    if app.redis.is_some() {
        tokio::spawn(run(Arc::downgrade(app)));
    }
}

async fn run(app: Weak<AppState>) {
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut jobs = JoinSet::new();
    loop {
        tokio::select! {
            Some(result) = jobs.join_next(), if !jobs.is_empty() => {
                if let Err(error) = result {
                    tracing::warn!(%error, "terminal recovery worker exited");
                }
            }
            _ = tick.tick(), if jobs.len() < MAX_RECOVERIES => {
                let Some(state) = app.upgrade() else { return };
                let redis = state.redis.as_ref().expect("recovery requires Redis");
                match due(redis, MAX_RECOVERIES - jobs.len()).await {
                    Ok(members) => for member in members {
                        let state = state.clone();
                        jobs.spawn(async move {
                            if let Err(error) = Box::pin(recover(&state, &member)).await {
                                tracing::warn!(%error, member, "terminal recovery will retry");
                            }
                        });
                    },
                    Err(error) => tracing::warn!(%error, "terminal recovery index unavailable"),
                }
            }
        }
    }
}

async fn due(redis: &RedisService, limit: usize) -> brz_redis::RedisResult<Vec<String>> {
    redis
        .eval(
            "local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[3])
         for _, member in ipairs(due) do redis.call('ZADD', KEYS[1], ARGV[2], member) end
         return due",
            [QUEUE],
            [
                chrono::Utc::now().timestamp().to_string(),
                next_attempt().to_string(),
                limit.to_string(),
            ],
        )
        .await
}

async fn recover(state: &AppState, member: &str) -> anyhow::Result<()> {
    let Some((task_id, subtask_id)) = member.split_once(':') else {
        return Ok(());
    };
    let task_id: i64 = task_id.parse()?;
    let subtask_id: i64 = subtask_id.parse()?;
    let redis = state.redis.as_ref().expect("recovery requires Redis");
    let delivery = completion::Delivery::Callback;
    if redis
        .get::<_, String>(completion::delivery_lock_key(subtask_id, delivery))
        .await?
        .is_some()
    {
        return Ok(());
    }
    completion::with_delivery_lock(
        redis,
        subtask_id,
        delivery,
        || anyhow::anyhow!("terminal delivery lease unavailable"),
        recover_locked(state, redis, task_id, subtask_id),
    )
    .await
}

async fn recover_locked(
    state: &AppState,
    redis: &RedisService,
    task_id: i64,
    subtask_id: i64,
) -> anyhow::Result<()> {
    let tables = tables(state);
    let mysql = state
        .mysql
        .route(crate::task_routing::ByTaskId(task_id as u64));
    let task: Option<(Json<Value>,)> = mysql
        .with_transaction(async |tx| {
            tx.fetch_optional(
                format!(
                    "SELECT json FROM {} WHERE id = ? AND is_active IN (1, 2)",
                    tables.tasks
                ),
                (task_id,),
            )
            .await
        })
        .await?;
    let Some((Json(task),)) = task else {
        retire(redis, task_id, subtask_id).await?;
        return Ok(());
    };

    let child = super::pipeline::pending_child(&task, subtask_id);
    if let Some(child) = child
        && redis
            .get::<_, String>(super::pipeline::execution_lease_key(task_id, child))
            .await?
            .is_some()
    {
        return Ok(());
    }
    let label = completion::Delivery::Callback.label(subtask_id);
    let marker = task["metadata"]["labels"][label].as_str();
    let event = marker
        .and_then(|marker| serde_json::from_str::<Value>(marker).ok())
        .and_then(|saved| saved.get("event").map(ExecutionEvent::from_value));
    let (mut event, executor) = match (event, child) {
        (Some(event), _) => (event, (None, None)),
        (None, Some(_)) => (
            ExecutionEvent::new(super::event::EventType::Done, task_id, subtask_id),
            (None, None),
        ),
        _ => {
            let Some(raw) = redis
                .hget::<_, _, String>(EVENTS, format!("{task_id}:{subtask_id}"))
                .await?
            else {
                retire(redis, task_id, subtask_id).await?;
                return Ok(());
            };
            if completion::read_terminal_result(&state.mysql, tables, task_id, subtask_id)
                .await?
                .is_some()
            {
                retire(redis, task_id, subtask_id).await?;
                return Ok(());
            }
            let event = ExecutionEvent::from_value(&serde_json::from_str(&raw)?);
            (event, (Some("inprocess-chat"), Some("standalone")))
        }
    };
    let status = completion::terminal_status(&event.event_type)
        .ok_or_else(|| anyhow::anyhow!("invalid terminal recovery event"))?;
    Box::pin(deliver_terminal_callback(
        state, redis, &mut event, status, executor, false,
    ))
    .await
    .map_err(|_| anyhow::anyhow!("terminal work is still pending"))
}
