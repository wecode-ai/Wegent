// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Incoming-event claims, bounded retries and subscription health projection.

use anyhow::{Result, bail};
use brz_mysql::{Json, MysqlTransaction};
use chrono::{Duration, NaiveDateTime, Utc};
use serde_json::{Value, json};

use super::{
    events, sources,
    store::{self, COLUMNS, LIVE, Node, UNSET, iso},
};
use crate::state::AppState;

const MAX_ATTEMPTS: i64 = 5;

fn claim_metadata(event: &Node, now: NaiveDateTime) -> Option<Value> {
    let mut metadata = event.meta();
    let attempts = metadata["attempt_count"].as_i64().unwrap_or(0);
    if matches!(
        event.status.as_str(),
        "processing" | "processed" | "ignored"
    ) || attempts >= MAX_ATTEMPTS
    {
        return None;
    }
    metadata["attempt_count"] = json!(attempts + 1);
    metadata["processing_started_at"] = json!(iso(now));
    Some(metadata)
}

pub(super) fn retry_at(attempts: i64, now: NaiveDateTime) -> Option<NaiveDateTime> {
    (attempts < MAX_ATTEMPTS).then(|| {
        now + Duration::seconds((60 * 2i64.pow((attempts - 1).clamp(0, 20) as u32)).min(3600))
    })
}

pub(super) async fn process(state: &AppState, event_id: &str) -> Result<usize> {
    let claimed = state.mysql.with_transaction(async |tx| {
        let Some(event) = store::locked(tx, "incoming_event", event_id).await? else { return Ok(false) };
        let Some(metadata) = claim_metadata(&event, Utc::now().naive_utc()) else { return Ok(false) };
        tx.execute("UPDATE loop_items SET status='processing', metadata=?, version=version+1, updated_at=UTC_TIMESTAMP(6) WHERE id=?", (Json(metadata), event_id)).await?;
        Ok(true)
    }).await?;
    if claimed {
        process_claimed(state, event_id).await
    } else {
        Ok(0)
    }
}

pub(super) async fn pending(state: &AppState) -> Result<usize> {
    let mut processed = 0;
    let now = Utc::now().naive_utc();
    for _ in 0..100 {
        let claimed = state.mysql.with_transaction(async |tx| {
            let event: Option<Node> = tx.fetch_optional(format!("SELECT {COLUMNS} FROM loop_items WHERE resource_type='incoming_event' AND (status='received' OR (status='failed' AND due_at>'1970-01-02' AND due_at<=?)) AND {LIVE} ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED"), (now,)).await?;
            let Some(event) = event else { return Ok(None) };
            let Some(metadata) = claim_metadata(&event, now) else {
                tx.execute("UPDATE loop_items SET due_at=? WHERE id=?", (UNSET, event.id.as_str())).await?;
                return Ok(Some(String::new()))
            };
            tx.execute("UPDATE loop_items SET status='processing', metadata=?, version=version+1, updated_at=UTC_TIMESTAMP(6) WHERE id=?", (Json(metadata), event.id.as_str())).await?;
            Ok(Some(event.id))
        }).await?;
        let Some(id) = claimed else { break };
        if id.is_empty() {
            continue;
        }
        processed += process_claimed(state, &id).await?;
    }
    Ok(processed)
}

async fn process_claimed(state: &AppState, id: &str) -> Result<usize> {
    let Some(event) = store::get(&state.mysql, "incoming_event", id).await? else {
        return Ok(0);
    };
    if event.status != "processing" {
        return Ok(0);
    }
    match apply(state, &event).await {
        Ok((count, observed)) => {
            if observed {
                health(state, event.parent_id.as_str(), None).await?;
            }
            Ok(count)
        }
        Err(error) => {
            tracing::error!(event_id=id, error=%error, "project incoming event processing failed");
            let error = error.to_string();
            state.mysql.with_transaction(async |tx| {
                let Some(event) = store::locked(tx, "incoming_event", id).await? else { return Ok(()) };
                let mut metadata = event.meta();
                let attempts = metadata["attempt_count"].as_i64().unwrap_or(1);
                metadata["last_error"] = json!(error); metadata["reason"] = json!(error);
                let due_at = retry_at(attempts, Utc::now().naive_utc()).map(|v|v.format("%Y-%m-%d %H:%M:%S%.f").to_string()).unwrap_or(UNSET.into());
                tx.execute("UPDATE loop_items SET status='failed', description=?, due_at=?, metadata=?, version=version+1, updated_at=UTC_TIMESTAMP(6) WHERE id=?", (error.as_str(),due_at,Json(metadata),id)).await?;
                Ok(())
            }).await?;
            health(state, event.parent_id.as_str(), Some(&error)).await?;
            Ok(0)
        }
    }
}

async fn apply(state: &AppState, event: &Node) -> Result<(usize, bool)> {
    let hook: Option<Node> = state.mysql.fetch_optional(format!("SELECT {COLUMNS} FROM loop_items WHERE id=? AND resource_type='incoming_hook' AND {LIVE}"), (event.parent_id.as_str(),)).await?;
    let hook = hook.ok_or_else(|| anyhow::anyhow!("Event subscription is unavailable"))?;
    let metadata = event.meta();
    if !metadata["payload"].is_object() {
        bail!("Incoming event payload is unavailable")
    }
    let source = hook.metadata.0["source_type"]
        .as_str()
        .unwrap_or(&hook.source);
    let normalized: Vec<_> = sources::normalize(source, &metadata["payload"], &metadata["headers"])
        .into_iter()
        .filter(|item| {
            hook.metadata.0["resource"].is_object()
                && sources::resource_matches(&hook.metadata.0["resource"], &item.resource)
        })
        .collect();
    if normalized.is_empty() {
        finish(
            state,
            event,
            "ignored",
            &[],
            &[],
            Some("No supported event matched the observed resource"),
        )
        .await?;
        return Ok((0, false));
    }
    let mut runs = Vec::new();
    for item in &normalized {
        let mut payload = item.payload.clone();
        payload["resource"] = item.resource.clone();
        payload["subject"] = item.subject.clone();
        runs.extend(
            events::process(
                state,
                &events::AutomationEvent {
                    event_type: item.event_type.clone(),
                    project_id: event.cloud_project_id.clone(),
                    subject_id: sources::identity(&item.subject["id"]),
                    subject_type: item.subject["type"].as_str().unwrap_or("unknown").into(),
                    source: item.source_type.clone(),
                    actor_user_id: hook.created_by_user_id,
                    payload,
                    event_id: format!("{}:{}", hook.id, item.identity()),
                    subscription_id: hook.id.clone(),
                },
            )
            .await?,
        );
    }
    let ids: Vec<_> = runs.iter().map(|run| run.id.clone()).collect();
    let mut reasons = Vec::new();
    for run in &runs {
        if run.status == "skipped"
            && run.description.to_lowercase().contains("binding")
            && !reasons.contains(&run.description)
        {
            reasons.push(run.description.clone());
        }
    }
    let reason = if !reasons.is_empty() {
        Some(reasons.join("; "))
    } else if ids.is_empty() {
        Some("No automation rule matched".into())
    } else {
        None
    };
    let values:Vec<_> = normalized.iter().map(|item|json!({"event_type":item.event_type,"resource":item.resource,"subject":item.subject})).collect();
    finish(
        state,
        event,
        if reasons.is_empty() {
            "processed"
        } else {
            "unresolved"
        },
        &values,
        &ids,
        reason.as_deref(),
    )
    .await?;
    Ok((ids.len(), true))
}

async fn finish(
    state: &AppState,
    event: &Node,
    status: &str,
    normalized: &[Value],
    runs: &[String],
    reason: Option<&str>,
) -> Result<()> {
    let mut metadata = event.meta();
    metadata["normalized_events"] = json!(normalized);
    metadata["matched_runs"] = json!(runs);
    metadata["reason"] = json!(reason);
    metadata["processed_at"] = json!(iso(Utc::now().naive_utc()));
    metadata.as_object_mut().unwrap().remove("last_error");
    state.mysql.execute("UPDATE loop_items SET status=?, description=?, metadata=?, due_at=?, version=version+1, updated_at=UTC_TIMESTAMP(6) WHERE id=? AND resource_type='incoming_event'",(status,reason.unwrap_or(""),Json(metadata),UNSET,event.id.as_str())).await?;
    Ok(())
}

async fn health(state: &AppState, hook_id: &str, error: Option<&str>) -> Result<()> {
    state.mysql.with_transaction(async |tx| {
        let Some(hook)=store::locked(tx,"incoming_hook",hook_id).await? else {return Ok(())};
        let mut metadata=hook.meta(); let now=iso(Utc::now().naive_utc());
        let mut health=metadata["health"].as_object().cloned().unwrap_or_default();
        health.insert("status".into(),json!(if error.is_some(){"error"}else{"healthy"}));health.insert("checked_at".into(),json!(now));
        if let Some(error)=error {health.insert("last_error".into(),json!(error));} else {health.remove("last_error");}
        metadata["health"]=Value::Object(health);metadata["last_event_at"]=json!(now);
        tx.execute("UPDATE loop_items SET metadata=?, version=version+1, updated_at=UTC_TIMESTAMP(6) WHERE id=?",(Json(metadata),hook_id)).await?;
        Ok(())
    }).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retries_back_off_and_stop_after_the_fifth_attempt() {
        let now =
            NaiveDateTime::parse_from_str("2026-10-23 00:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        assert_eq!(retry_at(1, now), Some(now + Duration::seconds(60)));
        assert_eq!(retry_at(4, now), Some(now + Duration::seconds(480)));
        assert_eq!(retry_at(5, now), None);
    }
}
