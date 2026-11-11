// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use anyhow::{Context, Result};
use brz_redis::{Redis, SetExpiration, SetOptions};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::NotificationPlan;
use crate::background_jobs::project::notifications::send_text;
use crate::runtime_work_im_notification_sessions::{
    runtime_notification_sessions, runtime_task_notification_key,
};
use crate::runtime_work_im_notifications::PrivateSession;
use crate::state::AppState;

pub(super) async fn deliver(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    payload: &Map<String, Value>,
    plan: &NotificationPlan,
) -> Result<()> {
    let mut address = json!({"deviceId": device_id, "localTaskId": plan.local_task_id});
    let selection = payload
        .get("modelSelection")
        .filter(|value| !value.is_null())
        .or_else(|| payload.get("model_selection"));
    if let Ok(Some(selection)) = crate::runtime_work_projection::optional_model_selection(selection)
    {
        address["modelSelection"] = serde_json::to_value(selection)?;
    }
    let sessions = runtime_notification_sessions(state, user_id, &address).await?;
    if sessions.is_empty() {
        return Ok(());
    }
    let redis = state.redis.as_ref().context("Redis is unavailable")?;
    let task_key = runtime_task_notification_key(&address).context("Invalid Runtime address")?;
    let status = if plan.waiting_for_user_input {
        "waiting_user_input"
    } else {
        plan.status
    };
    let notification = notification_id(payload, status);
    let title = [
        payload.get("taskTitle"),
        payload.get("task_title"),
        payload.get("data").and_then(|data| data.get("title")),
    ]
    .into_iter()
    .flatten()
    .find(|value| crate::json_compat::python_truthy(value))
    .map(crate::json_compat::python_str)
    .unwrap_or_default();
    let title = if title.trim().is_empty() {
        &plan.local_task_id
    } else {
        title.trim()
    };
    let message = message(title, status, &plan.content);
    let mut sent = 0;
    for session in sessions {
        let receipt = notification
            .as_deref()
            .map(|id| receipt_key(user_id, &task_key, &session.session_key, id));
        match send_session(
            state,
            redis,
            &session,
            &address,
            &message,
            receipt.as_deref(),
        )
        .await
        {
            Ok(true) => sent += 1,
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(%error, user_id, channel_id = session.channel_id, "Runtime event IM session delivery failed")
            }
        }
    }
    tracing::info!(
        user_id,
        device_id,
        local_task_id = plan.local_task_id,
        sent,
        "Runtime event dispatched"
    );
    Ok(())
}

async fn send_session(
    state: &AppState,
    redis: &impl Redis,
    session: &PrivateSession,
    address: &Value,
    message: &str,
    receipt: Option<&str>,
) -> Result<bool> {
    let Some(receipt) = receipt else {
        return send_and_save_reply(state, redis, session, address, message, None).await;
    };
    let key = format!("{receipt}:lock");
    let token = crate::device_identity_lock::lock_token();
    let options = SetOptions::default()
        .with_expiration(SetExpiration::Seconds(120))
        .if_absent();
    if !redis
        .set_with(key.as_str(), token.as_str(), options)
        .await?
    {
        return Ok(false);
    }
    let result = async {
        // A receipt written by the previous lock owner must be read on the
        // writer even when the deployment routes ordinary GETs to replicas.
        let exists: i64 = redis
            .eval(
                "return redis.call('exists', KEYS[1])",
                [receipt],
                [] as [&str; 0],
            )
            .await?;
        if exists != 0 {
            return Ok(false);
        }
        send_and_save_reply(state, redis, session, address, message, Some(receipt)).await
    }
    .await;
    let release: Result<i64, _> = redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        [key.as_str()], [token.as_str()],
    ).await;
    if let Err(error) = release {
        tracing::warn!(%error, "Runtime notification lock release failed");
    }
    result
}

async fn send_and_save_reply(
    state: &AppState,
    redis: &impl Redis,
    session: &PrivateSession,
    address: &Value,
    message: &str,
    receipt: Option<&str>,
) -> Result<bool> {
    let message = if session.channel_type == "dingtalk" {
        format!("{message}\n\n引用本通知回复，即可继续该任务。")
    } else {
        message.to_owned()
    };
    let sent = send_text(state, &serde_json::to_value(session)?, &message).await?;
    if let Some(receipt) = receipt {
        redis.set(receipt, "sent").await?;
    }
    if let Some(reference) = reply_reference(&sent) {
        let key = format!(
            "channel:runtime_task_reply_target:{}:{reference}",
            session.session_key
        );
        redis
            .set_with(
                key,
                address.to_string(),
                SetOptions::default().with_expiration(SetExpiration::Seconds(7 * 24 * 60 * 60)),
            )
            .await?;
    }
    Ok(true)
}

fn reply_reference(result: &Value) -> Option<String> {
    ["processQueryKey", "messageId", "message_id", "id"]
        .into_iter()
        .find_map(|key| {
            let value = &result[key];
            if let Some(text) = value
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                Some(text.to_owned())
            } else {
                value
                    .as_u64()
                    .filter(|number| *number > 0)
                    .map(|number| number.to_string())
            }
        })
}

fn receipt_key(user_id: i64, task_key: &str, session_key: &str, notification: &str) -> String {
    let value = json!([user_id, task_key, session_key, notification]);
    let canonical = crate::subscriptions_item::python_json_dumps(&value);
    format!(
        "channel:runtime_notification_receipt:{:x}",
        Sha256::digest(canonical)
    )
}

fn notification_id(payload: &Map<String, Value>, status: &str) -> Option<String> {
    let data = payload.get("data").unwrap_or(&Value::Null);
    let turn = [
        data.get("turnId"),
        data.get("turn_id"),
        payload.get("turnId"),
        payload.get("turn_id"),
        payload.get("subtaskId"),
        payload.get("subtask_id"),
        data.get("response").and_then(|value| value.get("id")),
    ]
    .into_iter()
    .flatten()
    .find(|value| crate::json_compat::python_truthy(value));
    let updated = [payload.get("updatedAt"), payload.get("updated_at")]
        .into_iter()
        .flatten()
        .find(|value| crate::json_compat::python_truthy(value));
    let (kind, identity) = turn
        .map(|value| ("turn", value))
        .or_else(|| updated.map(|value| ("updated", value)))?;
    Some(format!(
        "{kind}:{}:{}",
        crate::json_compat::python_str(identity),
        status.to_ascii_lowercase()
    ))
}

fn message(title: &str, status: &str, content: &str) -> String {
    let (label, detail_label, default) = match status {
        "FAILED" => (
            "执行未成功",
            "失败原因",
            "任务执行失败，请打开 Wework 查看原因。",
        ),
        "CANCELLED" => ("已取消", "取消原因", "任务已取消。"),
        "waiting_user_input" => (
            "需要你确认",
            "最新回复",
            "任务已暂停，等待你的输入或确认后继续。",
        ),
        _ => (
            "有新的 AI 回复",
            "最新回复",
            "任务有新的更新，请打开 Wework 查看完整对话。",
        ),
    };
    let content = if content.trim().is_empty() {
        default
    } else {
        content.trim()
    };
    format!(
        "你的任务{label}\n\n任务标题：{title}\n\n任务状态：{label}\n\n{detail_label}：{content}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipts_are_scoped_to_recipient_and_turn() {
        let first = json!({"data":{"turnId":"turn-1"}, "eventSeq":1});
        let replay = json!({"data":{"turnId":"turn-1"}, "eventSeq":2});
        let first = notification_id(first.as_object().unwrap(), "COMPLETED").unwrap();
        let replay = notification_id(replay.as_object().unwrap(), "COMPLETED").unwrap();
        assert_eq!(first, "turn:turn-1:completed");
        assert_eq!(first, replay);
        assert_ne!(
            receipt_key(1, "d:t", "a", &first),
            receipt_key(1, "d:t", "b", &replay)
        );
        assert!(notification_id(&Map::new(), "COMPLETED").is_none());
    }

    #[test]
    fn reply_targets_use_channel_specific_response_ids() {
        assert_eq!(
            reply_reference(&json!({"processQueryKey":"ding-1"})).as_deref(),
            Some("ding-1")
        );
        assert_eq!(
            reply_reference(&json!({"message_id":34})).as_deref(),
            Some("34")
        );
        assert_eq!(
            reply_reference(&json!({"id":"discord-1"})).as_deref(),
            Some("discord-1")
        );
        assert_eq!(reply_reference(&json!({"message_id":0})), None);
    }
}
