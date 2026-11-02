// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Each page commits deliveries, receipts and its continuation together.

use super::{
    notifications,
    store::{self, LIVE},
};
use crate::{
    board_snapshot::external_provider as provider, http_compat::FastApiError,
    issue_follow_events as events, state::AppState,
};
use anyhow::{Result, anyhow};
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use chrono::Utc;
use serde_json::json;
use std::collections::HashSet;

#[derive(FromMysqlRow)]
struct Candidate {
    id: String,
}

pub(crate) async fn set_follow(
    state: &AppState,
    issue_id: &str,
    user: i32,
    following: bool,
) -> Result<(), FastApiError> {
    let issue = store::get(&state.mysql, "task", issue_id)
        .await
        .map_err(subscription_error)?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Issue not found"))?;
    let project = store::get(&state.mysql, "project", &issue.cloud_project_id)
        .await
        .map_err(subscription_error)?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Project not found"))?;
    let mut baseline = Vec::new();
    let source = project.metadata.0["task_provider"]
        .as_str()
        .unwrap_or_default();
    if following && matches!(source, "github" | "gitlab") {
        let config: provider::ProviderConfig =
            serde_json::from_value(project.metadata.0["provider_config"].clone())
                .map_err(subscription_error)?;
        let token = super::polling::provider_token(
            &state.auth.jwt_key,
            source,
            &project.metadata.0["provider_config"],
        )
        .map_err(subscription_error)?;
        let repository = provider::provider_repository(&config).map_err(subscription_error)?;
        let number = crate::loop_tasks::assignments::item_number(issue_id)
            .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Issue not found"))?;
        for stream in events::streams(source) {
            let mut page = 1;
            loop {
                let url = format!(
                    "{}{}",
                    provider::api_base(source, &config),
                    events::path(source, &repository, number, stream, page)
                );
                let rows = provider::request_json(&state.attachment_http, &token, source, &url)
                    .await
                    .map_err(|error| error.into_fastapi())?;
                baseline.extend(events::decode(source, stream, &rows).map_err(subscription_error)?);
                if rows
                    .as_array()
                    .is_some_and(|rows| rows.len() < events::PAGE_SIZE)
                {
                    break;
                }
                page += 1;
            }
        }
    }
    crate::loop_tasks::assignments::require_issue_read_as(state, issue_id, user).await?;
    let result = state.mysql.with_transaction(async |tx| {
        let current: Option<store::Node> = tx.fetch_optional(format!("SELECT {} FROM loop_items WHERE id=? AND resource_type='task' AND {LIVE} FOR UPDATE", store::COLUMNS),(issue_id,)).await?;
        let Some(current) = current else {return Ok(None)};
        let current_project: Option<store::Node> = tx.fetch_optional(format!("SELECT {} FROM loop_items WHERE id=? AND resource_type='project' AND {LIVE}", store::COLUMNS),(current.cloud_project_id.as_str(),)).await?;
        let Some(current_project) = current_project else {return Ok(None)};
        if current_project.metadata.0["task_provider"] != project.metadata.0["task_provider"] || current_project.metadata.0["provider_config"] != project.metadata.0["provider_config"] {
            return Ok(Some(false));
        }
        let mut metadata = current.meta();
        let mut followers = metadata["follower_user_ids"].as_array().cloned().unwrap_or_default();
        if following && followers.iter().any(|value| value.as_i64() == Some(i64::from(user))) {
            return Ok(Some(true));
        }
        followers.retain(|value| value.as_i64() != Some(i64::from(user)));
        if !metadata["follower_since"].is_object() {
            metadata["follower_since"] = json!({});
        }
        if !following {
            metadata["follower_since"].as_object_mut().unwrap().remove(&user.to_string());
        } else {
            followers.push(json!(user));
            metadata["follower_since"][user.to_string()] = json!(Utc::now().timestamp_millis());
        }
        metadata["follower_user_ids"] = json!(followers);
        tx.execute("UPDATE loop_items SET metadata=? WHERE id=?",(Json(metadata.clone()),issue_id)).await?;
        if !following { return Ok(Some(true)); }
        let since = chrono::DateTime::from_timestamp_millis(metadata["follower_since"][user.to_string()].as_i64().unwrap()).unwrap().naive_utc();
        for event in &baseline {
            store::insert(tx,"issue_follow_event",json!({"id":notifications::receipt_id(issue_id,user,since,&event.identity),"cloud_project_id":project.id,"loop_item_id":issue_id,"user_id":user})).await?;
        }
        Ok(Some(true))
    }).await.map_err(subscription_error)?;
    match result {
        Some(true) => Ok(()),
        Some(false) => Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Issue source changed; reload and try again",
        )),
        None => Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Issue not found",
        )),
    }
}

fn subscription_error(error: impl std::fmt::Display) -> FastApiError {
    tracing::error!(%error, "Issue subscription failed");
    FastApiError::internal()
}

#[tracing::instrument(name = "issue.poll_followed", skip_all)]
pub(super) async fn check(state: &AppState) -> Result<usize> {
    let now = Utc::now().timestamp_millis();
    let candidates: Vec<Candidate> = state.mysql.fetch_all(
        "SELECT i.id FROM loop_items i JOIN loop_items p ON p.id=i.cloud_project_id AND p.resource_type='project' WHERE i.resource_type='task' AND JSON_LENGTH(JSON_EXTRACT(i.metadata,'$.follower_user_ids'))>0 AND (i.deleted_at IS NULL OR i.deleted_at<='1970-01-02') AND (p.deleted_at IS NULL OR p.deleted_at<='1970-01-02') AND JSON_UNQUOTE(JSON_EXTRACT(p.metadata,'$.task_provider')) IN ('github','gitlab') AND COALESCE(JSON_EXTRACT(i.metadata,'$.follow_poll.next_at'),0)<=? GROUP BY i.id ORDER BY COALESCE(JSON_EXTRACT(i.metadata,'$.follow_poll.next_at'),0),i.id LIMIT 100", (now,)
    ).await?;
    let mut count = 0;
    for candidate in candidates {
        match poll(state, &candidate).await {
            Ok(delivered) => count += delivered,
            Err(error) => {
                tracing::warn!(issue_id=%candidate.id,error=%error,"Followed Issue event scan failed");
                state.mysql.execute("UPDATE loop_items SET metadata=JSON_SET(COALESCE(metadata,JSON_OBJECT()),'$.follow_poll.next_at',?) WHERE id=?",(Utc::now().timestamp_millis()+300_000,candidate.id.as_str())).await?;
            }
        }
    }
    Ok(count)
}

// Provider checks may use the application pool and network. Complete them before
// locking Issue rows; project access is checked again inside the write transaction.
async fn external_readers(state: &AppState, issue_id: &str) -> Result<HashSet<i32>> {
    let Some(issue) = store::get(&state.mysql, "task", issue_id).await? else {
        return Ok(HashSet::new());
    };
    let mut readers = HashSet::new();
    for (user_id, _) in issue.followers() {
        match crate::loop_tasks::assignments::provider_get(state, issue_id, user_id).await {
            Ok(()) => {
                readers.insert(user_id);
            }
            Err(error)
                if matches!(
                    error.status(),
                    StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
                ) => {}
            Err(error) => return Err(anyhow!("Issue access check failed: {error:?}")),
        }
    }
    Ok(readers)
}

async fn poll(state: &AppState, candidate: &Candidate) -> Result<usize> {
    let Some(mut issue) = store::get(&state.mysql, "task", &candidate.id).await? else {
        return Ok(0);
    };
    let project = store::get(&state.mysql, "project", &issue.cloud_project_id)
        .await?
        .ok_or_else(|| anyhow!("Project removed"))?;
    let source = project.metadata.0["task_provider"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let config: provider::ProviderConfig =
        serde_json::from_value(project.metadata.0["provider_config"].clone())?;
    let token = super::polling::provider_token(
        &state.auth.jwt_key,
        &source,
        &project.metadata.0["provider_config"],
    )
    .map_err(|error| anyhow!("{error}"))?;
    let repository = provider::provider_repository(&config).map_err(anyhow::Error::msg)?;
    let number = crate::loop_tasks::assignments::item_number(&issue.id)
        .ok_or_else(|| anyhow!("Invalid external Issue identity"))?;
    let base = provider::api_base(&source, &config);
    let mut delivered = 0;
    for _ in 0..8 {
        let cursor = issue.metadata.0["follow_poll"].clone();
        let index = cursor["stream"].as_u64().unwrap_or(0) as usize;
        let stream = events::streams(&source)
            .get(index)
            .ok_or_else(|| anyhow!("Invalid event continuation"))?;
        let page = cursor["page"].as_u64().unwrap_or(1);
        let url = format!(
            "{base}{}",
            events::path(&source, &repository, number, stream, page)
        );
        let rows = provider::request_json(&state.attachment_http, &token, &source, &url)
            .await
            .map_err(|error| anyhow!("{:?}", error.into_fastapi()))?;
        let decoded = events::decode(&source, stream, &rows).map_err(anyhow::Error::msg)?;
        let last_page = rows
            .as_array()
            .is_some_and(|rows| rows.len() < events::PAGE_SIZE);
        let next_stream = if last_page { index + 1 } else { index };
        let finished = next_stream == events::streams(&source).len();
        let next = json!({"stream":if finished {0}else{next_stream},"page":if last_page {1}else{page+1},"next_at":Utc::now().timestamp_millis()+if finished {300_000}else{0}});
        let readers = if decoded.is_empty() {
            HashSet::new()
        } else {
            external_readers(state, &issue.id).await?
        };
        let result = state
            .mysql
            .with_transaction(async |tx| {
                let current: Option<store::Node> = tx.fetch_optional(format!("SELECT {} FROM loop_items WHERE id=? AND resource_type='task' AND {LIVE} FOR UPDATE",store::COLUMNS),(issue.id.as_str(),)).await?;
                let Some(current) = current else {
                    return Ok(None);
                };
                if current.metadata.0["follow_poll"] != cursor {
                    return Ok(None);
                }
                let live_project: Option<store::Node> = tx
                    .fetch_optional(
                        format!("SELECT {} FROM loop_items WHERE id=? AND resource_type='project' AND {LIVE}",store::COLUMNS),
                        (project.id.as_str(),),
                    )
                    .await?;
                let Some(live_project) = live_project else {return Ok(None)};
                if live_project.metadata.0["task_provider"] != project.metadata.0["task_provider"] || live_project.metadata.0["provider_config"] != project.metadata.0["provider_config"] {
                    return Ok(None);
                }
                let mut pending = Vec::new();
                for event in &decoded {
                    pending.extend(
                        notifications::followers_for_event_on(
                            tx,
                            state,
                            &project,
                            &current,
                            0,
                            &event.kind,
                            Some(notifications::ExternalFollowEvent {
                                event,
                                authorized_readers: &readers,
                            }),
                        )
                        .await?,
                    );
                }
                let mut metadata = current.meta();
                metadata["follow_poll"] = next.clone();
                tx.execute(
                    "UPDATE loop_items SET metadata=? WHERE id=?",
                    (Json(metadata), issue.id.as_str()),
                )
                .await?;
                Ok(Some(pending))
            })
            .await?;
        let Some(pending) = result else { break };
        delivered += pending.len();
        for notification in pending {
            notifications::deliver(state, notification).await;
        }
        issue.metadata.0["follow_poll"] = next;
        if finished {
            break;
        }
    }
    Ok(delivered)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscription_receipts_keep_the_persisted_json_precision() {
        let milliseconds = Utc::now().timestamp_millis();
        let since = chrono::DateTime::from_timestamp_millis(milliseconds)
            .unwrap()
            .naive_utc();
        let encoded = serde_json::to_string(&json!({"17": milliseconds})).unwrap();
        let metadata: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        let persisted = chrono::DateTime::from_timestamp_millis(metadata["17"].as_i64().unwrap())
            .unwrap()
            .naive_utc();
        assert_eq!(
            notifications::receipt_id("issue", 17, since, "event"),
            notifications::receipt_id("issue", 17, persisted, "event")
        );
    }
}
