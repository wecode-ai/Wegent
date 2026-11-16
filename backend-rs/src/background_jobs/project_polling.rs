// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Durable subscription scans, atomic page persistence and resumable cursors.
#[path = "project_polling_credentials.rs"]
mod credentials;
#[path = "project_polling_github.rs"]
mod github;
#[path = "project_polling_gitlab.rs"]
mod gitlab;
#[path = "project_polling_http.rs"]
mod http;
#[path = "project_polling_inputs.rs"]
mod inputs;
#[cfg(test)]
#[path = "project_polling_tests.rs"]
mod tests;

use super::{
    incoming,
    store::{self, COLUMNS, LIVE, Node, UNSET, iso},
};
use crate::state::AppState;
use anyhow::Result;
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use chrono::{Duration, NaiveDateTime, Utc};
use http::{Input, PollError, object, text};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(FromMysqlRow)]
struct Id {
    id: String,
}

struct Subscription {
    hook: Node,
    lease: String,
}

#[tracing::instrument(name = "project.poll_subscriptions", skip_all)]
pub(super) async fn check(state: &AppState) -> Result<usize> {
    let now = Utc::now().naive_utc();
    let ids: Vec<Id> = state.mysql.fetch_all(
        "SELECT h.id FROM loop_items h JOIN loop_items p ON p.id=h.cloud_project_id AND p.resource_type='project' WHERE p.status='active' AND h.resource_type='incoming_hook' AND h.status='active' AND h.due_at>'1970-01-02' AND h.due_at<=? AND (h.deleted_at IS NULL OR h.deleted_at<='1970-01-02') ORDER BY h.due_at ASC LIMIT 100", (now,)
    ).await?;
    let mut discovered = 0;
    for id in ids {
        if let Some(subscription) = claim(state, &id.id, now).await? {
            discovered += poll(state, subscription).await?;
        }
    }
    Ok(discovered)
}

async fn claim(state: &AppState, id: &str, now: NaiveDateTime) -> Result<Option<Subscription>> {
    Ok(state.mysql.with_transaction(async |tx| {
        let hook: Option<Node> = tx.fetch_optional(format!("SELECT {COLUMNS} FROM loop_items WHERE id=? AND resource_type='incoming_hook' AND status='active' AND due_at>'1970-01-02' AND due_at<=? AND {LIVE} FOR UPDATE SKIP LOCKED"),(id,now)).await?;
        let Some(mut hook)=hook else {return Ok(None)};
        let mut metadata = hook.meta();
        if !matches!(text(&metadata["collection_mode"]),"poll"|"hybrid") {
            tx.execute("UPDATE loop_items SET due_at=? WHERE id=?",(UNSET,id)).await?;
            return Ok(None);
        }
        let lease=iso(now);
        let mut poll=object(&metadata["poll"]); poll["lease_started_at"]=json!(lease);
        metadata["poll"]=poll;
        tx.execute("UPDATE loop_items SET metadata=?,due_at=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(Json(metadata.clone()),now+Duration::seconds(300),id)).await?;
        hook.metadata=Json(metadata);
        Ok(Some(Subscription{hook,lease}))
    }).await?)
}

#[tracing::instrument(name="project.poll_subscription",skip_all,fields(hook_id=%subscription.hook.id))]
async fn poll(state: &AppState, subscription: Subscription) -> Result<usize> {
    let metadata = subscription.hook.meta();
    let source = if text(&metadata["source_type"]).is_empty() {
        subscription.hook.source.as_str()
    } else {
        text(&metadata["source_type"])
    };
    let mut discovered = 0;
    let result: Result<(), PollError> = async {
        let credential = credentials::resolve(state, &subscription.hook).await?;
        let http = http::Http {
            client: &state.decision_http,
            source,
            credential: &credential,
        };
        let mut cursor = object(&metadata["poll"]["cursor"]);
        for _ in 0..20 {
            let page = match source {
                "github" => github::fetch(&http, &metadata["resource"], &cursor).await?,
                "gitlab" => gitlab::fetch(&http, &metadata["resource"], &cursor).await?,
                _ => {
                    return Err(PollError::disabled(format!(
                        "{source} does not provide a polling adapter"
                    )));
                }
            };
            let Some(created) =
                persist_page(state, &subscription, source, &page.inputs, &page.cursor)
                    .await
                    .map_err(|error| {
                        PollError::new(format!(
                            "Concurrent polling input persistence failed: {error}"
                        ))
                    })?
            else {
                return Ok(());
            };
            discovered += created;
            cursor = page.cursor;
            if page.complete {
                if record_success(state, &subscription, discovered)
                    .await
                    .map_err(|error| PollError::new(error.to_string()))?
                    && discovered > 0
                {
                    incoming::pending(state)
                        .await
                        .map_err(|error| PollError::new(error.to_string()))?;
                }
                return Ok(());
            }
        }
        continuation(state, &subscription)
            .await
            .map_err(|error| PollError::new(error.to_string()))?;
        Ok(())
    }
    .await;
    if let Err(error) = result {
        tracing::warn!(hook_id=%subscription.hook.id,source,error=%error,"Project event polling failed");
        record_failure(state, &subscription, &error).await?;
    }
    Ok(discovered)
}

fn owns(hook: &Node, subscription: &Subscription) -> bool {
    hook.status == "active"
        && text(&hook.metadata.0["poll"]["lease_started_at"]) == subscription.lease
}

async fn persist_page(
    state: &AppState,
    subscription: &Subscription,
    source: &str,
    inputs: &[Input],
    cursor: &Value,
) -> Result<Option<usize>> {
    Ok(state.mysql.with_transaction(async |tx| {
        let Some(hook)=store::locked(tx,"incoming_hook",&subscription.hook.id).await? else {return Ok(None)};
        if !owns(&hook,subscription){return Ok(None);}
        let mut created=0;
        for input in inputs {
            let public_id=crate::hex_sha256(format!("{}:{source}:{}",hook.id,input.identity).as_bytes())[..36].to_owned();
            let exists: Option<Id>=tx.fetch_optional("SELECT id FROM loop_items WHERE public_id=?",(public_id.as_str(),)).await?;
            if exists.is_some(){continue;}
            let payload=payload_bytes(&input.payload);
            store::insert(tx,"incoming_event",json!({"public_id":public_id,"cloud_project_id":hook.cloud_project_id,
                "parent_id":hook.id,"title":input.title.chars().take(255).collect::<String>(),"source":source,"status":"received",
                "created_by_user_id":hook.created_by_user_id,"metadata":{"schema_version":1,"collection_mode":"poll","attempt_count":0,
                    "poll_identity":input.identity,"occurred_at":input.occurred_at,"payload":input.payload,
                    "payload_sha256":crate::hex_sha256(&payload),"payload_size":payload.len(),"headers":input.headers}})).await?;
            created+=1;
        }
        let now=Utc::now().naive_utc();
        let mut metadata=hook.meta(); let mut poll=object(&metadata["poll"]);
        poll["cursor"]=cursor.clone(); poll["last_page_at"]=json!(iso(now)); metadata["poll"]=poll;
        // Extend the domain reservation only after this page is durable.
        tx.execute("UPDATE loop_items SET metadata=?,due_at=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(Json(metadata),now+Duration::seconds(300),hook.id.as_str())).await?;
        Ok(Some(created))
    }).await?)
}

pub(super) fn jitter(id: &str, poll: &Value) -> i64 {
    let interval = poll["interval_seconds"]
        .as_i64()
        .or_else(|| text(&poll["interval_seconds"]).parse().ok())
        .filter(|v| *v != 0)
        .unwrap_or(300)
        .max(60);
    let spread = (interval / 10).max(1);
    let stamp = if poll["last_polled_at"].is_null() {
        "None"
    } else {
        text(&poll["last_polled_at"])
    };
    let digest = Sha256::digest(format!("{id}:{stamp}").as_bytes());
    let offset = i64::from(u16::from_be_bytes([digest[0], digest[1]]))
        % (spread.saturating_mul(2).saturating_add(1))
        - spread;
    interval.saturating_add(offset).max(60)
}

// Python hashes compact UTF-8 JSON with sort_keys=True. Explicitly order every
// object because an embedding binary can enable serde_json/preserve_order.
fn payload_bytes(value: &Value) -> Vec<u8> {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let entries = map.iter().collect::<std::collections::BTreeMap<_, _>>();
                Value::Object(
                    entries
                        .into_iter()
                        .map(|(key, value)| (key.clone(), sorted(value)))
                        .collect(),
                )
            }
            Value::Array(values) => Value::Array(values.iter().map(sorted).collect()),
            value => value.clone(),
        }
    }
    serde_json::to_vec(&sorted(value)).expect("JSON values serialize")
}

fn success_metadata(metadata: &Value, now: NaiveDateTime, discovered: usize) -> Value {
    let mut metadata = object(metadata);
    let mut poll = object(&metadata["poll"]);
    poll["failure_count"] = json!(0);
    poll["last_polled_at"] = json!(iso(now));
    poll.as_object_mut().unwrap().remove("lease_started_at");
    metadata["poll"] = poll;
    let mut health = object(&metadata["health"]);
    health["status"] = json!("healthy");
    health["checked_at"] = json!(iso(now));
    health.as_object_mut().unwrap().remove("last_error");
    metadata["health"] = health;
    if discovered > 0 {
        metadata["last_event_at"] = json!(iso(now));
    }
    metadata
}

async fn record_success(
    state: &AppState,
    subscription: &Subscription,
    discovered: usize,
) -> Result<bool> {
    Ok(state.mysql.with_transaction(async |tx| {
        let Some(hook)=store::locked(tx,"incoming_hook",&subscription.hook.id).await? else{return Ok(false)};
        if !owns(&hook,subscription){return Ok(false);}
        let now=Utc::now().naive_utc();
        let metadata=success_metadata(&hook.meta(),now,discovered);
        let due=now+Duration::seconds(jitter(&hook.id,&metadata["poll"]));
        tx.execute("UPDATE loop_items SET metadata=?,due_at=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(Json(metadata),due,hook.id.as_str())).await?;
        Ok(true)
    }).await?)
}

async fn continuation(state: &AppState, subscription: &Subscription) -> Result<()> {
    state.mysql.with_transaction(async |tx| {
        let Some(hook)=store::locked(tx,"incoming_hook",&subscription.hook.id).await? else{return Ok(())};
        if !owns(&hook,subscription){return Ok(());}
        let mut metadata=hook.meta(); let mut poll=object(&metadata["poll"]);
        poll.as_object_mut().unwrap().remove("lease_started_at"); metadata["poll"]=poll;
        tx.execute("UPDATE loop_items SET metadata=?,due_at=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(Json(metadata),Utc::now().naive_utc()+Duration::seconds(5),hook.id.as_str())).await?;
        Ok(())
    }).await?;
    Ok(())
}

fn failure_metadata(metadata: &Value, error: &PollError, now: NaiveDateTime) -> (Value, i64) {
    let mut metadata = object(metadata);
    let mut poll = object(&metadata["poll"]);
    let failures = poll["failure_count"]
        .as_i64()
        .unwrap_or(0)
        .saturating_add(1);
    poll["failure_count"] = json!(failures);
    poll["last_failure_at"] = json!(iso(now));
    poll.as_object_mut().unwrap().remove("lease_started_at");
    metadata["poll"] = poll;
    let mut health = object(&metadata["health"]);
    health["status"] = json!("error");
    health["checked_at"] = json!(iso(now));
    health["last_error"] = json!(error.message);
    metadata["health"] = health;
    let delay = error
        .retry_after
        .filter(|n| *n != 0)
        .unwrap_or_else(|| (60 * 2i64.pow((failures - 1).clamp(0, 20) as u32)).min(3600));
    (metadata, delay)
}

async fn record_failure(
    state: &AppState,
    subscription: &Subscription,
    error: &PollError,
) -> Result<()> {
    state.mysql.with_transaction(async |tx| {
        let Some(hook)=store::locked(tx,"incoming_hook",&subscription.hook.id).await? else{return Ok(())};
        if !owns(&hook,subscription){return Ok(());}
        let now=Utc::now().naive_utc(); let (metadata,delay)=failure_metadata(&hook.meta(),error,now);
        let due=if error.disable{UNSET.into()}else{(now+Duration::seconds(delay)).format("%Y-%m-%d %H:%M:%S%.f").to_string()};
        let status=if error.disable{"disabled"}else{hook.status.as_str()};
        tx.execute("UPDATE loop_items SET metadata=?,status=?,due_at=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(Json(metadata),status,due,hook.id.as_str())).await?;
        Ok(())
    }).await?;
    Ok(())
}
