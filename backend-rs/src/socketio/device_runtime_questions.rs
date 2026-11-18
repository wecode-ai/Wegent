// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Question delivery shares its durable Redis document and lock with Python IM ingress.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use brz_redis::{Redis, SetExpiration, SetOptions};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::background_jobs::project::notifications::send_text;
use crate::runtime_work_im_notification_sessions::runtime_question_sessions;
use crate::runtime_work_im_notifications::{
    PrivateSession, decode_json, parse_private_session, private_session_key, unix_seconds,
};
use crate::state::AppState;

const RETENTION_SECONDS: u64 = 7 * 24 * 60 * 60;
const STATE_COMMIT: &str = "if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end \
if tonumber(ARGV[3]) > 0 then redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3]) \
else redis.call('set', KEYS[2], ARGV[2]) end return 1";

struct QuestionStateLease<'a> {
    key: &'a str,
    lock: &'a str,
    token: &'a str,
}

pub(super) fn question(payload: &Map<String, Value>) -> Option<&Value> {
    if payload.get("event_type")?.as_str()? != "response.block.created"
        || payload.get("conversationContext").and_then(Value::as_str) == Some("private_discussion")
    {
        return None;
    }
    let block = payload.get("data")?.get("block")?;
    let question = block
        .get("render_payload")
        .or_else(|| block.get("renderPayload"))?;
    if question["kind"] != "request_user_input"
        || [
            "approvalKind",
            "approval_kind",
            "interactionKind",
            "interaction_kind",
            "mode",
            "elicitationId",
        ]
        .iter()
        .any(|key| {
            question
                .get(*key)
                .is_some_and(crate::json_compat::python_truthy)
        })
        || question["interactionScope"]
            .as_str()
            .filter(|v| !v.is_empty())
            .is_none()
        || request_id(question).is_none()
    {
        return None;
    }
    let questions = question["questions"].as_array()?;
    (question["response"].is_null()
        && !matches!(
            question["interactionStatus"].as_str(),
            Some("answered" | "cancelled" | "expired")
        )
        && question["expiresAtUnixMs"]
            .as_f64()
            .is_none_or(|deadline| deadline > unix_seconds() * 1000.0)
        && !questions.is_empty()
        && questions.iter().all(|q| {
            q["id"].as_str().is_some_and(|v| !v.is_empty())
                && q["question"].as_str().is_some_and(|v| !v.is_empty())
        }))
    .then_some(question)
}

fn request_id(question: &Value) -> Option<&Value> {
    ["requestId", "request_id", "itemId", "item_id"]
        .iter()
        .find_map(|key| {
            question
                .get(*key)
                .filter(|v| v.is_number() || v.as_str().is_some_and(|v| !v.is_empty()))
        })
}

pub(super) async fn deliver(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    payload: &Map<String, Value>,
) -> Result<()> {
    retry_delivery(|| deliver_once(state, user_id, device_id, payload)).await
}

async fn retry_delivery<F, Fut>(mut attempt: F) -> Result<()>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    for number in 0..3 {
        match attempt().await {
            Ok(()) => return Ok(()),
            Err(error) if number == 2 => return Err(error),
            Err(error) => {
                tracing::warn!(%error, attempt=number + 1, "Retrying IM question delivery")
            }
        }
        tokio::time::sleep(Duration::from_millis(250 << number)).await;
    }
    unreachable!("The last failed attempt returns its error")
}

async fn deliver_once(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    payload: &Map<String, Value>,
) -> Result<()> {
    let Some(question) = question(payload) else {
        return Ok(());
    };
    let task = payload
        .get("taskId")
        .or_else(|| payload.get("localTaskId"))
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .context("Question has no task")?;
    let address = json!({"deviceId":device_id,"taskId":task});
    let sessions = recipients(state, user_id, &address, payload.get("source")).await?;
    if sessions.is_empty() {
        return Ok(());
    }
    let redis = state.redis.as_ref().context("Redis is unavailable")?;
    let key = format!("channel:runtime_questions:{user_id}");
    let lock = format!("{key}:lock");
    let token = crate::device_identity_lock::lock_token();
    let options = SetOptions::default()
        .with_expiration(SetExpiration::Seconds(300))
        .if_absent();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while !redis
        .set_with(lock.as_str(), token.as_str(), options)
        .await?
    {
        if tokio::time::Instant::now() >= deadline {
            bail!("IM question state is busy");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let lease = QuestionStateLease {
        key: &key,
        lock: &lock,
        token: &token,
    };
    let result = tokio::time::timeout(
        Duration::from_secs(240),
        deliver_locked(state, redis, &lease, &address, payload, question, &sessions),
    )
    .await
    .context("IM question delivery timed out")
    .and_then(|result| result);
    let released: Result<i64, _> = redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        [lock.as_str()], [token.as_str()],
    ).await;
    if let Err(error) = released {
        tracing::warn!(%error, "IM question lock release failed");
    }
    result
}

async fn recipients(
    state: &AppState,
    user_id: i64,
    address: &Value,
    source: Option<&Value>,
) -> Result<Vec<PrivateSession>> {
    let Some(source) = source.filter(|source| source["source"] == "im") else {
        return Ok(runtime_question_sessions(state, user_id, address).await?);
    };
    let key = source["external_id"]
        .as_str()
        .or_else(|| source["session_key"].as_str())
        .unwrap_or_default();
    // Group-channel tasks have no private-session address. Owner questions use
    // the configured personal recipient rather than exposing them to the group.
    if key.is_empty() {
        return Ok(runtime_question_sessions(state, user_id, address).await?);
    }
    let redis = state.redis.as_ref().context("Redis is unavailable")?;
    let cached: Option<String> = redis.get(private_session_key(key)).await?;
    let cached = cached
        .map(|value| decode_json(value.as_bytes()).context("Invalid private IM session cache"))
        .transpose()?;
    let Some(session) = parse_private_session(cached.as_ref())
        .filter(|session| owns_source(session, user_id, source))
    else {
        return Ok(Vec::new());
    };
    Ok(vec![session])
}

fn owns_source(session: &PrivateSession, user_id: i64, source: &Value) -> bool {
    session.user_id == user_id
        && source["channel_type"] == session.channel_type
        && source["channel_id"].as_i64() == Some(session.channel_id)
        && source["conversation_id"] == session.conversation_id
        && source["sender_id"] == session.sender_id
}

fn new_entry(address: &Value, payload: &Map<String, Value>, question: &Value) -> Value {
    let title = payload
        .get("taskTitle")
        .or_else(|| payload.get("task_title"))
        .and_then(Value::as_str)
        .unwrap_or(address["taskId"].as_str().unwrap_or("任务"));
    let texts: Map<String, Value> = question["questions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|q| {
            (
                q["id"].as_str().unwrap().to_owned(),
                json!(question_text(title, q, question["delivery"] == "async")),
            )
        })
        .collect();
    json!({"address":address,"payload":question,"source":payload.get("source"),"answers":{},"deliveries":{},
        "status":"pending","created_at":unix_seconds(),"title":title,"texts":texts})
}

fn question_text(title: &str, question: &Value, asynchronous: bool) -> String {
    let mut lines = vec![
        format!("待你回答 · 任务：{title}"),
        if asynchronous {
            "其他工作继续进行".into()
        } else {
            "正在等待你的回答".into()
        },
        question["question"].as_str().unwrap().to_owned(),
    ];
    for (index, option) in question["options"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        lines.push(format!(
            "{}. {}",
            index + 1,
            option["label"].as_str().unwrap_or_default()
        ));
        if let Some(description) = option["description"].as_str().filter(|v| !v.is_empty()) {
            lines.push(description.to_owned());
        }
    }
    lines.push(
        "引用这条问题消息回复，可直接交给原任务；也可以直接发消息告诉助理，由助理结合上下文处理。"
            .into(),
    );
    lines.join("\n\n")
}

async fn deliver_locked(
    state: &AppState,
    redis: &impl Redis,
    lease: &QuestionStateLease<'_>,
    address: &Value,
    payload: &Map<String, Value>,
    question: &Value,
    sessions: &[PrivateSession],
) -> Result<()> {
    // Read on the writer: Python may have just accepted an answer under this lock.
    let cached: Option<String> = redis
        .eval(
            "return redis.call('get', KEYS[1])",
            [lease.key],
            [] as [&str; 0],
        )
        .await?;
    let mut document: Map<String, Value> = cached
        .map(|v| serde_json::from_str(&v))
        .transpose()?
        .unwrap_or_default();
    document.retain(|_, value| {
        value["status"] == "pending"
            || value
                .get("settled_at")
                .unwrap_or(&value["created_at"])
                .as_f64()
                .unwrap_or_default()
                > unix_seconds() - RETENTION_SECONDS as f64
    });
    let identity = json!([address, question["interactionScope"], request_id(question)]);
    let id = format!("{:x}", Sha256::digest(identity.to_string()));
    document
        .entry(id.clone())
        .or_insert_with(|| new_entry(address, payload, question));
    // A reply can arrive as soon as the provider accepts the message. Publish
    // the pending document first so Python waits on this same delivery lock.
    save_document(redis, lease, &document).await?;
    let entry = &document[&id];
    if entry["status"] != "pending" {
        return Ok(());
    }
    let next = entry["payload"]["questions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|q| entry["answers"].get(q["id"].as_str().unwrap()).is_none())
        .and_then(|q| q["id"].as_str())
        .map(str::to_owned);
    let Some(qid) = next else {
        return Ok(());
    };
    let text = entry["texts"][&qid].as_str().unwrap().to_owned();
    let mut failure = None;
    for session in sessions {
        if document[&id]["deliveries"][&session.session_key]
            .get(&qid)
            .is_some()
        {
            continue;
        }
        match send_text(state, &serde_json::to_value(session)?, &text).await {
            Ok(sent) => {
                let entry = document.get_mut(&id).expect("Question entry was inserted");
                if !entry["deliveries"][&session.session_key].is_object() {
                    entry["deliveries"][&session.session_key] = json!({});
                }
                entry["deliveries"][&session.session_key][&qid] =
                    json!(super::runtime_im_notification::reply_reference(&sent));
                save_document(redis, lease, &document).await?;
            }
            Err(error) => {
                tracing::warn!(%error, user_id=session.user_id, "IM question delivery failed");
                failure = Some(error);
            }
        }
    }
    failure.map_or(Ok(()), Err)
}

async fn save_document(
    redis: &impl Redis,
    lease: &QuestionStateLease<'_>,
    document: &Map<String, Value>,
) -> Result<()> {
    let document_json = serde_json::to_string(document)?;
    let ttl = if document.values().any(|entry| entry["status"] == "pending") {
        0
    } else {
        RETENTION_SECONDS
    }
    .to_string();
    let committed: i64 = redis
        .eval(
            STATE_COMMIT,
            [lease.lock, lease.key],
            [lease.token, document_json.as_str(), ttl.as_str()],
        )
        .await?;
    if committed != 1 {
        bail!("IM question lock ownership was lost");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn transient_failures_retry_and_exhausted_failures_are_reported() {
        let attempts = std::sync::atomic::AtomicUsize::new(0);
        retry_delivery(|| async {
            let number = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if number == 0 {
                bail!("provider temporarily unavailable");
            }
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
        attempts.store(0, std::sync::atomic::Ordering::SeqCst);
        let error = retry_delivery(|| async {
            attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            bail!("provider still unavailable")
        })
        .await
        .unwrap_err();
        assert!(error.to_string().contains("provider still unavailable"));
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    fn event() -> Value {
        json!({"taskId":"task","event_type":"response.block.created","data":{"block":{
            "render_payload":{"kind":"request_user_input","requestId":42,
                "interactionScope":"turn","questions":[{"id":"q","question":"范围？",
                    "options":[{"label":"全部","description":"包括所有任务"}]}]}
        }}})
    }

    #[test]
    fn sync_and_async_questions_preserve_the_answer_contract() {
        for asynchronous in [false, true] {
            let mut event = event();
            if asynchronous {
                let q = &mut event["data"]["block"]["render_payload"];
                q.as_object_mut().unwrap().remove("requestId");
                q["itemId"] = json!("async-question");
                q["delivery"] = json!("async");
            }
            let event = event.as_object().unwrap();
            let q = question(event).unwrap();
            let entry = new_entry(&json!({"deviceId":"mac","taskId":"task"}), event, q);
            assert_eq!(entry["payload"], *q);
            assert_eq!(entry["status"], "pending");
            assert_eq!(entry["answers"], json!({}));
            assert_eq!(entry["deliveries"], json!({}));
            let text = entry["texts"]["q"].as_str().unwrap();
            assert!(text.contains("范围？"));
            assert!(text.contains("1. 全部"));
            assert!(text.contains("包括所有任务"));
            assert!(text.contains("待你回答"));
            assert!(text.contains("引用这条问题消息回复"));
            assert!(text.contains(if asynchronous {
                "其他工作继续进行"
            } else {
                "正在等待你的回答"
            }));
        }
    }

    #[test]
    fn approvals_authentication_and_private_discussions_are_not_im_questions() {
        for marker in ["approvalKind", "interactionKind", "mode", "elicitationId"] {
            let mut event = event();
            event["data"]["block"]["render_payload"][marker] = json!("native");
            assert!(question(event.as_object().unwrap()).is_none());
        }
        let mut private = event();
        private["conversationContext"] = json!("private_discussion");
        assert!(question(private.as_object().unwrap()).is_none());
        let mut unscoped = event();
        unscoped["data"]["block"]["render_payload"]
            .as_object_mut()
            .unwrap()
            .remove("interactionScope");
        assert!(question(unscoped.as_object().unwrap()).is_none());
    }

    #[test]
    fn an_im_question_targets_only_its_authenticated_owner_and_source_conversation() {
        let source = json!({"channel_type":"dingtalk","channel_id":3,
            "conversation_id":"chat","sender_id":"sender"});
        let session: PrivateSession = serde_json::from_value(json!({
            "session_key":"session","user_id":7,"channel_type":"dingtalk",
            "channel_id":3,"conversation_id":"chat","sender_id":"sender"
        }))
        .unwrap();
        assert!(owns_source(&session, 7, &source));
        assert!(!owns_source(&session, 8, &source));
        for field in ["channel_type", "channel_id", "conversation_id", "sender_id"] {
            let mut wrong = source.clone();
            wrong[field] = json!("another-source");
            assert!(!owns_source(&session, 7, &wrong));
        }
    }
}
