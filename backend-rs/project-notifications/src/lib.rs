// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Notification rows commit with the assignment; live hints and private IM
//! delivery run only after that transaction has committed.

use anyhow::Result;
use brz_mysql::{FromMysqlRow, Json, MysqlResult, MysqlService, MysqlTransaction};
use brz_redis::Redis;
use chrono::Utc;
use serde_json::{Value, json};
use wegent_project_coordination::{
    board_snapshot::external_provider::url_encode_path,
    project_store::{Node, status_name},
};
use wegent_socket_events::socketio_emit;

mod im;
pub use im::{
    DingTalkAccessToken, active_dingtalk_channel_config, dingtalk_access_token, dingtalk_api_base,
    dingtalk_credentials, send_text, telegram_message,
};

pub struct Pending {
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

const STAND_IN_START_FAILED: &str = "stand_in_start_failed";

fn channels(preferences: &Value, kind: &str) -> Channels {
    let collaboration = matches!(
        kind,
        "assignment"
            | "mention"
            | "execution"
            | "issue_dispatch_assignment"
            | "issue_shared"
            | "issue_participation"
    );
    let category = if collaboration {
        "collaboration"
    } else {
        "general"
    };
    let selected = &preferences["wework_notification_preferences"][category];
    let im_only = kind == "issue_participation";
    Channels {
        in_app: !im_only && selected["in_app"].as_bool().unwrap_or(true),
        system: if collaboration && !im_only {
            selected["system"].as_bool().unwrap_or(true)
        } else {
            false
        },
        im: selected["im"].as_bool().unwrap_or(true),
    }
}

pub use wegent_project_coordination::project_store::new_uuid as uuid;

#[allow(clippy::too_many_arguments)]
pub async fn create_on(
    tx: &mut impl MysqlTransaction,
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
    let channels = if payload["action"] == STAND_IN_START_FAILED {
        let selected = &preferences["wework_notification_preferences"]["stand_in"];
        Channels {
            in_app: selected["in_app"].as_bool().unwrap_or(true),
            system: selected["system"].as_bool().unwrap_or(true),
            im: false,
        }
    } else {
        channels(&preferences, kind)
    };
    let now = Utc::now().naive_utc();
    let id = uuid();
    let project = payload["projectId"].as_str().unwrap_or("");
    let issue = payload["itemId"].as_str().unwrap_or("");
    let encode = url_encode_path;
    let mut url = if let Some(id) = payload["personalIssueId"].as_str() {
        format!("wework://personal-issues/{}", encode(id))
    } else if project.is_empty() {
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
    if !issue.is_empty()
        && !url.is_empty()
        && let Some(comment) = payload["commentId"].as_str().filter(|id| !id.is_empty())
    {
        url.push_str("/comments/");
        url.push_str(&encode(comment));
    }
    if channels.in_app {
        tx.execute("INSERT INTO wework_notifications (id,user_id,actor_user_id,kind,title,body,url,payload,created_at,is_read,read_status_changed_at) VALUES (?,?,?,?,?,?,?,?,?,false,?)",(id.as_str(),user,actor,kind,title,body,url.as_str(),Json(payload.clone()),now,now)).await?;
    }
    Ok(Pending {
        notification: json!({"id":id,"user_id":user,"kind":kind,"title":title,"body":body,"url":url,"payload":payload}),
        channels,
        stored: channels.in_app,
    })
}

pub async fn stand_in_start_failure_on(
    tx: &mut impl MysqlTransaction,
    user: i64,
    project: &str,
    issue: &str,
    title: &str,
    code: Option<&str>,
) -> MysqlResult<Pending> {
    let (code, body) = match code {
        Some("workspace_unavailable") => (
            "workspace_unavailable",
            "所选工作目录在执行设备上不可用。请检查助理的运行环境后重试。",
        ),
        Some("workspace_not_git") => (
            "workspace_not_git",
            "所选工作目录不是 Git 仓库。请检查助理的工作区设置后重试。",
        ),
        _ => (
            "stand_in_start_failed",
            "助理未能启动。请检查助理的运行环境后重试。",
        ),
    };
    let notification_title = format!("助理启动失败：{title}")
        .chars()
        .take(256)
        .collect::<String>();
    create_on(
        tx,
        user,
        user,
        "execution",
        &notification_title,
        body,
        json!({"projectId":project,"itemId":issue,"itemTitle":title,
            "action":STAND_IN_START_FAILED,"failureCode":code,"status":"failed"}),
    )
    .await
}

pub async fn target(
    mysql: &MysqlService,
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
        mysql
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
    let status = status_name(project, &issue.status);
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
pub async fn direct_human_on(
    tx: &mut impl MysqlTransaction,
    mysql: &MysqlService,
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
    let mut payload = target(mysql, project, issue, user).await.map_err(|error| {
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
            user,
            actor,
            "issue_dispatch_assignment",
            &format!("新任务：{title}"),
            "这个事项已分配给你。打开后可直接处理，或按需使用 AI 辅助。",
            payload,
        )
        .await?,
    ))
}

#[allow(clippy::too_many_arguments)]
pub async fn execution_on(
    tx: &mut impl MysqlTransaction,
    mysql: &MysqlService,
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
    let mut payload = target(mysql, project, issue, issue.assignee_user_id)
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

#[async_trait::async_trait]
pub trait LocalEmit: Send + Sync {
    async fn emit(&self, event: &str, room: &str, frame: &Value);
}

/// A private recipient identifier scoped to the selected IM channel.
pub struct IssueImRecipient {
    pub channel_id: i64,
    pub recipient_id: String,
}

#[async_trait::async_trait]
pub trait IssueImRecipientResolver: Send + Sync {
    async fn resolve(&self, user_id: i64) -> Result<Option<IssueImRecipient>>;
}

pub async fn deliver(
    mysql: &MysqlService,
    redis: Option<&brz_redis::RedisService>,
    local: &dyn LocalEmit,
    pending: Pending,
) {
    deliver_with_issue_im_recipient(mysql, redis, local, None, pending).await;
}

pub async fn deliver_with_issue_im_recipient(
    mysql: &MysqlService,
    redis: Option<&brz_redis::RedisService>,
    local: &dyn LocalEmit,
    issue_im_recipient: Option<&dyn IssueImRecipientResolver>,
    pending: Pending,
) {
    let notification = &pending.notification;
    let user = notification["user_id"].as_i64().unwrap_or(0);
    if let Some(redis) = redis {
        let mut frames = Vec::new();
        let stand_in_alert =
            pending.channels.system && notification["payload"]["action"] == STAND_IN_START_FAILED;
        if pending.stored || stand_in_alert {
            let mut payload = json!({"id":notification["id"]});
            if !pending.stored {
                payload["stored"] = json!(false);
            }
            if stand_in_alert {
                payload["standInStartFailure"] = json!({
                    "userId":user,"itemTitle":notification["payload"]["itemTitle"],
                    "code":notification["payload"]["failureCode"],"url":notification["url"],
                });
            }
            frames.push(json!({"event":"wework.notification.created","payload":payload}));
        }
        if pending.channels.system && notification["kind"] == "assignment" {
            frames.push(json!({"event":"project.task.assigned","payload":notification["payload"]}));
        }
        if pending.channels.system && notification["kind"] == "issue_shared" {
            frames.push(json!({
                "event":"wework.issue.shared",
                "payload":{
                    "id":notification["id"],"userId":user,"title":notification["title"],
                    "body":notification["body"],"url":notification["url"]
                }
            }));
        }
        let room = format!("wework-runtime:user:{user}");
        for frame in frames {
            local.emit("runtime:event", &room, &frame).await;
            let message = socketio_emit::emit_message(
                "runtime:event",
                &serde_json::to_string(&json!([frame])).expect("JSON value"),
                "/wework-runtime",
                &room,
            );
            if let Err(error) = redis
                .publish(socketio_emit::SOCKETIO_CHANNEL, message)
                .await
            {
                tracing::error!(%error,"Wework live notification delivery failed");
            }
        }
    }
    if pending.channels.im {
        let base = wegent_backend_config::env_or_dotenv("FRONTEND_URL")
            .unwrap_or_else(|| "http://localhost:3000".into());
        let links = im_links(notification, &base);
        if let Err(error) =
            im::send_im(mysql, redis, user, notification, &links, issue_im_recipient).await
        {
            tracing::error!(notification_id=%notification["id"],%error,"Wework IM notification delivery failed");
        }
    }
}

fn im_links(notification: &Value, base: &str) -> Vec<(String, String)> {
    let payload = &notification["payload"];
    let encode = url_encode_path;
    let web_path = if let Some(issue) = payload["personalIssueId"].as_str() {
        let scope = if payload["assigned"] == true {
            "assigned"
        } else {
            "participating"
        };
        Some(format!(
            "/collaboration/{scope}?personalIssueId={}",
            encode(issue)
        ))
    } else {
        payload["projectId"]
            .as_str()
            .zip(payload["itemId"].as_str())
            .map(|(project, issue)| {
                format!(
                    "/collaboration/{}/issues/{}",
                    encode(project),
                    encode(issue)
                )
            })
    };
    let app_link = notification["url"]
        .as_str()
        .filter(|url| !url.is_empty())
        .map(|url| ("在 Wework 中打开".into(), url.into()));
    let shared = notification["kind"] == "issue_shared";
    let mut links = Vec::new();
    if !shared {
        links.extend(app_link.clone());
    }
    if let Some(path) = web_path {
        let label = if shared {
            "在网页中查看事项"
        } else {
            "查看任务"
        };
        links.push((
            label.into(),
            format!("{}{path}", base.trim_end_matches('/')),
        ));
    }
    if shared {
        links.extend(app_link);
    }
    links
}

fn push_facts(payload: &Value) -> Vec<(String, String)> {
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
    fn issue_participation_uses_only_the_collaboration_im_channel() {
        let default = channels(&Value::Null, "issue_participation");
        assert!(!default.in_app && !default.system && default.im);
        let disabled = channels(
            &json!({"wework_notification_preferences":{"collaboration":{"im":false},"general":{"im":true}}}),
            "issue_participation",
        );
        assert!(!disabled.in_app && !disabled.system && !disabled.im);
    }

    #[tokio::test]
    async fn issue_without_a_private_session_resolves_only_enabled_issue_recipients() {
        #[derive(Default)]
        struct Resolver(std::sync::Mutex<Vec<i64>>);
        #[async_trait::async_trait]
        impl IssueImRecipientResolver for Resolver {
            async fn resolve(&self, user_id: i64) -> Result<Option<IssueImRecipient>> {
                self.0.lock().unwrap().push(user_id);
                Ok(None)
            }
        }

        struct NoEmit;
        #[async_trait::async_trait]
        impl LocalEmit for NoEmit {
            async fn emit(&self, _: &str, _: &str, _: &Value) {}
        }

        let unused = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mysql = MysqlService::connect_lazy(&format!(
            "mysql://ci:ci@{}/unused",
            unused.local_addr().unwrap()
        ))
        .unwrap();
        let resolver = Resolver::default();
        let opted_out = json!({
            "wework_notification_preferences":{"collaboration":{"im":false}}
        });
        for (user, kind, preferences) in [
            (10, "issue_shared", &Value::Null),
            (11, "issue_participation", &Value::Null),
            (12, "issue_shared", &opted_out),
            (13, "assignment", &Value::Null),
        ] {
            let pending = Pending {
                notification: json!({"user_id": user, "kind": kind}),
                channels: channels(preferences, kind),
                stored: false,
            };
            deliver_with_issue_im_recipient(&mysql, None, &NoEmit, Some(&resolver), pending).await;
        }
        assert_eq!(*resolver.0.lock().unwrap(), vec![10, 11]);
    }

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
    fn share_messages_open_web_collaboration_for_the_recipient() {
        for (payload, path) in [
            (
                json!({"personalIssueId":"share-1","assigned":true}),
                "/collaboration/assigned?personalIssueId=share-1",
            ),
            (
                json!({"personalIssueId":"share-1","assigned":false}),
                "/collaboration/participating?personalIssueId=share-1",
            ),
            (
                json!({"projectId":"123","itemId":"share-1"}),
                "/collaboration/123/issues/share-1",
            ),
        ] {
            let notification = json!({"kind":"issue_shared","payload":payload,"url":"wework://personal-issues/share-1"});
            assert_eq!(
                im_links(&notification, "https://wegent.example/"),
                vec![
                    (
                        "在网页中查看事项".into(),
                        format!("https://wegent.example{path}")
                    ),
                    (
                        "在 Wework 中打开".into(),
                        "wework://personal-issues/share-1".into()
                    )
                ]
            );
        }
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
