// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Notification rows commit with the assignment; live hints and private IM
//! delivery run only after that transaction has committed.

use super::{issues, store::Node};
use crate::state::AppState;
use anyhow::Result;
use brz_mysql::{FromMysqlRow, Json, MysqlResult, MysqlTransaction};
use brz_redis::Redis;
use chrono::Utc;
use serde_json::{Value, json};

#[path = "project_notifications_im.rs"]
mod im;
pub(crate) use im::send_im;

pub(crate) struct Pending {
    notification: Value,
    channels: Channels,
    stored: bool,
}
#[derive(Clone, Copy)]
struct Channels {
    in_app: bool,
    system: bool,
    im: bool,
}

fn channels(preferences: &Value, kind: &str) -> Channels {
    let collaboration = matches!(
        kind,
        "assignment" | "mention" | "execution" | "issue_dispatch_assignment"
    );
    let category = if collaboration {
        "collaboration"
    } else {
        "general"
    };
    let selected = &preferences["wework_notification_preferences"][category];
    Channels {
        in_app: selected["in_app"].as_bool().unwrap_or(true),
        system: if collaboration {
            selected["system"].as_bool().unwrap_or(true)
        } else {
            false
        },
        im: selected["im"].as_bool().unwrap_or(true),
    }
}

pub(crate) fn uuid() -> String {
    let mut bytes = [0; 16];
    getrandom::getrandom(&mut bytes).expect("system randomness");
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn create_on(
    tx: &mut impl MysqlTransaction,
    _state: &AppState,
    user: i64,
    actor: i64,
    kind: &str,
    title: &str,
    body: &str,
    payload: Value,
) -> MysqlResult<Pending> {
    #[derive(FromMysqlRow)]
    struct Preferences {
        preferences: Option<String>,
    }
    let user_preferences: Option<Preferences> = tx
        .fetch_optional("SELECT preferences FROM users WHERE id=?", (user,))
        .await?;
    let preferences = user_preferences
        .and_then(|user| user.preferences)
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .unwrap_or(json!({}));
    let channels = channels(&preferences, kind);
    let now = Utc::now().naive_utc();
    let id = uuid();
    let project = payload["projectId"].as_str().unwrap_or("");
    let issue = payload["itemId"].as_str().unwrap_or("");
    let encode = crate::board_snapshot::external_provider::url_encode_path;
    let url = if project.is_empty() {
        String::new()
    } else if issue.is_empty() {
        format!("wework://boards/{}", encode(project))
    } else {
        format!(
            "wework://boards/{}/issues/{}",
            encode(project),
            encode(issue)
        )
    };
    if channels.in_app {
        tx.execute("INSERT INTO wework_notifications (id,user_id,actor_user_id,kind,title,body,url,payload,created_at,is_read,read_status_changed_at) VALUES (?,?,?,?,?,?,?,?,?,false,?)",(id.as_str(),user,actor,kind,title,body,url.as_str(),Json(payload.clone()),now,now)).await?;
    }
    Ok(Pending {
        notification: json!({"id":id,"user_id":user,"kind":kind,"title":title,"body":body,"url":url,"payload":payload}),
        channels,
        stored: channels.in_app,
    })
}

pub(crate) async fn target(
    state: &AppState,
    project: &Node,
    issue: &Node,
    assignee: i64,
) -> Result<Value> {
    #[derive(FromMysqlRow)]
    struct User {
        user_name: String,
    }
    let name: Option<User> = if assignee == 0 {
        None
    } else {
        state
            .mysql
            .fetch_optional("SELECT user_name FROM users WHERE id=?", (assignee,))
            .await?
    };
    let key = if !issue.name.trim().is_empty() {
        Some(issue.name.trim())
    } else if regex::Regex::new(r"^[A-Za-z0-9]+-\d+$")
        .expect("display key")
        .is_match(issue.id.trim())
    {
        Some(issue.id.trim())
    } else {
        None
    };
    let status = issues::status_name(project, &issue.status);
    let mut payload = json!({"projectId":project.id,"projectName":project.name,"itemId":issue.id,"itemKey":key,"itemTitle":issue.title,"itemStatus":if status.is_empty(){issue.status.as_str()}else{status.as_str()},"itemPriority":issue.priority,"itemDueAt":issue.due_at.filter(|value|value.and_utc().timestamp()>86400).map(|value|value.format("%Y-%m-%dT%H:%M:%S%.f").to_string()),"assigneeName":name.map(|user|user.user_name)});
    payload
        .as_object_mut()
        .unwrap()
        .retain(|_, value| !value.is_null() && value.as_str() != Some(""));
    Ok(payload)
}

fn direct_human_id(issue: &str, assignment: &str) -> String {
    use sha1::{Digest, Sha1};
    let namespace = [
        0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30,
        0xc8,
    ];
    let mut hash = Sha1::new();
    hash.update(namespace);
    hash.update(format!("wegent:direct-human:{issue}:{assignment}").as_bytes());
    let digest = hash.finalize();
    let mut bytes: [u8; 16] = digest[..16].try_into().expect("UUID bytes");
    bytes[6] = (bytes[6] & 15) | 0x50;
    bytes[8] = (bytes[8] & 63) | 0x80;
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn direct_human_on(
    tx: &mut impl MysqlTransaction,
    state: &AppState,
    project: &Node,
    issue: &Node,
    user: i64,
    actor: i64,
    assignee: &str,
    assignment: &str,
) -> MysqlResult<Option<Pending>> {
    let human_id = direct_human_id(&issue.id, assignment);
    let existing:Option<(i64,)>=tx.fetch_optional("SELECT 1 FROM wework_notifications WHERE user_id=? AND kind='issue_dispatch_assignment' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.humanAssignmentId'))=? LIMIT 1",(user,human_id.as_str())).await?;
    if existing.is_some() {
        return Ok(None);
    }
    #[derive(FromMysqlRow)]
    struct User {
        user_name: String,
    }
    let actor_name: Option<User> = tx
        .fetch_optional("SELECT user_name FROM users WHERE id=?", (actor,))
        .await?;
    let mut payload = target(state, project, issue, user).await.map_err(|error| {
        brz_mysql::MysqlError::InvalidQuery {
            reason: error.to_string(),
        }
    })?;
    if let Some(actor) = actor_name {
        payload["actorName"] = json!(actor.user_name);
    }
    let title = issue.title.trim();
    let instructions = if issue.description.trim().is_empty() {
        title
    } else {
        issue.description.trim()
    };
    for (key, value) in [
        ("assigneeName", json!(assignee)),
        ("action", json!("open_issue")),
        ("issueId", json!(issue.id)),
        ("dispatchTaskId", json!(human_id)),
        ("humanAssignmentId", json!(human_id)),
        ("dispatchId", json!(format!("direct-human:{assignment}"))),
        ("roundId", json!("direct")),
        ("assignmentId", json!(assignment)),
        ("taskTitle", json!(title)),
        ("instructions", json!(instructions)),
        ("workflowStageId", Value::Null),
        (
            "idempotencyKey",
            json!(format!("human-assignment:{human_id}")),
        ),
    ] {
        payload[key] = value;
    }
    Ok(Some(
        create_on(
            tx,
            state,
            user,
            actor,
            "issue_dispatch_assignment",
            &format!("新任务：{title}"),
            "这个 Issue 已分配给你。打开后可直接处理，或按需使用 AI 辅助。",
            payload,
        )
        .await?,
    ))
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn execution_on(
    tx: &mut impl MysqlTransaction,
    state: &AppState,
    project: &Node,
    issue: &Node,
    execution_id: i64,
    owner: i64,
    status: &str,
    detail: &str,
) -> MysqlResult<Option<Pending>> {
    let recipient = if issue.assignee_user_id != 0 {
        issue.assignee_user_id
    } else {
        issue.created_by_user_id
    };
    if recipient == 0
        || !matches!(
            status,
            "queued"
                | "claimed"
                | "running"
                | "pending_approval"
                | "waiting_runtime"
                | "completed"
                | "failed"
                | "cancelled"
        )
    {
        return Ok(None);
    }
    let mut payload = target(state, project, issue, issue.assignee_user_id)
        .await
        .map_err(|error| brz_mysql::MysqlError::InvalidQuery {
            reason: error.to_string(),
        })?;
    payload["status"] = json!(status);
    payload["executionId"] = json!(execution_id.to_string());
    let item = if issue.title.is_empty() {
        "任务"
    } else {
        &issue.title
    };
    let tail = execution_tail(status);
    let body = if detail.trim().is_empty() {
        match status {
            "pending_approval" => "机器人任务已进入队列，需要你确认后才会开始执行。".into(),
            "waiting_runtime" => "任务已就绪，选择设备和模型后即可开始执行。".into(),
            "queued" | "claimed" | "running" => format!("{item} 已进入执行，完成后会再次通知你。"),
            "completed" => "任务已完成，请打开任务查看结果。".into(),
            "failed" => "任务执行失败，请打开 Wework 查看原因。".into(),
            _ => "任务已取消。".into(),
        }
    } else {
        detail.trim().into()
    };
    Ok(Some(
        create_on(
            tx,
            state,
            recipient,
            if owner == 0 { recipient } else { owner },
            "execution",
            &format!("「{item}」{tail}"),
            &body,
            payload,
        )
        .await?,
    ))
}

fn execution_tail(status: &str) -> &str {
    match status {
        "pending_approval" => "等待你审批",
        "waiting_runtime" => "需要选择运行设备",
        "failed" | "FAILED" => "执行未成功",
        "cancelled" | "CANCELLED" => "已取消",
        "completed" => "已完成",
        "queued" | "claimed" | "running" => "已开始执行",
        _ => "有新的 AI 回复",
    }
}

pub(crate) async fn deliver(state: &AppState, pending: Pending) {
    let notification = &pending.notification;
    let user = notification["user_id"].as_i64().unwrap_or(0);
    if let Some(redis) = state.redis.as_ref() {
        let mut frames = Vec::new();
        if pending.stored {
            frames.push(
                json!({"event":"wework.notification.created","payload":{"id":notification["id"]}}),
            );
        }
        if pending.channels.system && notification["kind"] == "assignment" {
            frames.push(json!({"event":"project.task.assigned","payload":notification["payload"]}));
        }
        for frame in frames {
            let message = crate::socketio_emit::emit_message(
                "runtime:event",
                &serde_json::to_string(&json!([frame])).expect("JSON value"),
                "/wework-runtime",
                &format!("wework-runtime:user:{user}"),
            );
            if let Err(error) = redis
                .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
                .await
            {
                tracing::error!(%error,"Wework live notification delivery failed");
            }
        }
    }
    if pending.channels.im {
        let mut links = Vec::new();
        if let Some(url) = notification["url"].as_str().filter(|url| !url.is_empty()) {
            links.push(("在 Wework 中打开".into(), url.into()));
        }
        if let (Some(project), Some(issue)) = (
            notification["payload"]["projectId"].as_str(),
            notification["payload"]["itemId"].as_str(),
        ) {
            let base = crate::config::env_or_dotenv("FRONTEND_URL")
                .unwrap_or_else(|| "http://localhost:3000".into());
            let encode = crate::board_snapshot::external_provider::url_encode_path;
            links.push((
                "查看任务".into(),
                format!(
                    "{}/collaboration/{}/issues/{}",
                    base.trim_end_matches('/'),
                    encode(project),
                    encode(issue)
                ),
            ));
        }
        if let Err(error) = send_im(
            state,
            user,
            notification["kind"].as_str().unwrap_or(""),
            notification["title"].as_str().unwrap_or(""),
            notification["body"].as_str().unwrap_or(""),
            &notification["payload"],
            &links,
        )
        .await
        {
            tracing::error!(notification_id=%notification["id"],%error,"Wework IM notification delivery failed");
        }
    }
}

pub(super) fn push_facts(payload: &Value) -> Vec<(String, String)> {
    let status = payload["status"].as_str().map(execution_tail);
    [
        ("任务标题", payload["itemTitle"].as_str()),
        (
            "任务编号",
            payload["itemKey"]
                .as_str()
                .or_else(|| payload["itemId"].as_str()),
        ),
        (
            "任务状态",
            status.or_else(|| payload["itemStatus"].as_str()),
        ),
        ("当前负责人", payload["assigneeName"].as_str()),
        ("看板", payload["projectName"].as_str()),
    ]
    .into_iter()
    .filter_map(|(label, value)| {
        value
            .filter(|value| !value.is_empty())
            .map(|value| (label.into(), value.into()))
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_inbox_does_not_disable_other_channels() {
        let selected = channels(
            &json!({"wework_notification_preferences":{"collaboration":{"in_app":false,"system":true,"im":false}}}),
            "assignment",
        );
        assert!(!selected.in_app);
        assert!(selected.system);
        assert!(!selected.im);
    }
    #[test]
    fn notification_ids_are_uuid4() {
        let id = uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
    }
    #[test]
    fn human_work_identity_matches_the_source_uuid5_and_uses_collaboration_preferences() {
        assert_eq!(
            direct_human_id("issue-1", "assignment-1"),
            "0c1524ed-5607-54bc-b2fe-313d54d26484"
        );
        for kind in [
            "assignment",
            "execution",
            "mention",
            "issue_dispatch_assignment",
        ] {
            let selected = channels(
                &json!({"wework_notification_preferences":{"collaboration":{"in_app":false,"system":false,"im":false},"general":{"in_app":true,"im":true}}}),
                kind,
            );
            assert!(!selected.in_app && !selected.system && !selected.im);
        }
    }
}
