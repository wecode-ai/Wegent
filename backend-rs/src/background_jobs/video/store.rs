// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Generation-conditional writes keep replaced or cancelled video attempts terminal.

use super::Poll;
use crate::{AppState, task_routing::ByTaskId};
use anyhow::Result;
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use serde_json::{Value, json};

#[derive(FromMysqlRow)]
struct Row {
    result: Option<Json<Value>>,
    status: String,
}

pub async fn claim(state: &AppState, poll: &mut Poll) -> Result<bool> {
    let tables = state.task_store.table_templates();
    let mysql = state.mysql.route(ByTaskId(poll.task_id as u64));
    let claimed=mysql.with_transaction(async |tx|{
        let row:Option<Row>=tx.fetch_optional(format!("SELECT s.result,s.status FROM {} s JOIN {} t ON t.id=s.task_id WHERE s.id=? AND s.task_id=? AND t.user_id=? AND t.is_active=1 AND s.role='ASSISTANT' FOR UPDATE",tables.subtasks,tables.tasks),(poll.subtask_id,poll.task_id,poll.user_id)).await?;
        let Some(row)=row else{return Ok(None)};
        let result=row.result.map(|v|v.0).unwrap_or_else(||json!({}));
        if row.status!="RUNNING"||result.pointer("/video_job/job_id").and_then(Value::as_str).is_some_and(|id|id!=poll.job_id){return Ok(None)}
        // An abandoned delivery can have committed a heartbeat before Redis ACK.
        // Rebase on durable state instead of treating that delivery as completion.
        let count=poll.poll_count.max(result.pointer("/video_job/poll_count").and_then(Value::as_u64).unwrap_or(0).min(u32::MAX as u64) as u32).saturating_add(1);
        let progress=poll.last_progress.max(result.pointer("/video_job/progress").and_then(Value::as_i64).unwrap_or(0));
        let mut next=poll.clone();next.poll_count=count;next.last_progress=progress;
        let result=merge(result,&tracking(&next,"polling",progress),None);
        tx.execute(format!("UPDATE {} SET result=?,updated_at=NOW() WHERE id=? AND status='RUNNING'",tables.subtasks),(Json(result),poll.subtask_id)).await?;
        Ok(Some((count,progress)))
    }).await?;
    if let Some((count, progress)) = claimed {
        poll.poll_count = count;
        poll.last_progress = progress;
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn tracking(poll: &Poll, status: &str, progress: i64) -> Value {
    let mut value = json!({"job_id":poll.job_id,"provider":poll.provider_protocol,"status":status,"progress":progress,"video_block_id":poll.video_block_id,"last_poll_at":chrono::Utc::now().to_rfc3339(),"poll_count":poll.poll_count,"intent_result":poll.intent_result});
    if let Some(card) = &poll.card_context {
        for key in ["query_url", "card_type", "preview_title", "progress_text"] {
            value[key] = card[key].clone();
        }
    }
    value
}

pub async fn save(
    state: &AppState,
    poll: &Poll,
    status: Option<&str>,
    progress: i64,
    block: Option<&Value>,
    terminal_result: Option<&Value>,
    error: Option<&str>,
) -> Result<bool> {
    let tables = state.task_store.table_templates();
    let updated=state.mysql.route(ByTaskId(poll.task_id as u64)).with_transaction(async |tx|{
        let row:Option<Row>=tx.fetch_optional(format!("SELECT s.result,s.status FROM {} s JOIN {} t ON t.id=s.task_id WHERE s.id=? AND s.task_id=? AND t.user_id=? AND s.role='ASSISTANT' FOR UPDATE",tables.subtasks,tables.tasks),(poll.subtask_id,poll.task_id,poll.user_id)).await?;
        let Some(row)=row else{return Ok(false)};
        let current=row.result.map(|v|v.0).unwrap_or_else(||json!({}));
        if !can_write(&row.status,&current,poll){return Ok(false)}
        let job_status=match status {Some("COMPLETED")=>"completed",Some("FAILED")=>"failed",Some("CANCELLED")=>"cancelled",_=>"polling"};
        let result=terminal_result.cloned().unwrap_or_else(||merge(current,&tracking(poll,job_status,progress),block));
        if let Some(status)=status {
            tx.execute(format!("UPDATE {} SET status=?,result=?,error_message=COALESCE(?,error_message),completed_at=NOW(),updated_at=NOW() WHERE id=?",tables.subtasks),(status,Json(result),error,poll.subtask_id)).await?;
        }else{
            tx.execute(format!("UPDATE {} SET result=?,updated_at=NOW() WHERE id=?",tables.subtasks),(Json(result),poll.subtask_id)).await?;
        }
        Ok(true)
    }).await?;
    if updated && status.is_some() {
        let redis = state
            .redis
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("video polling requires Redis"))?;
        let ctx = crate::internal_callback::completion::Completion {
            app: Some(state),
            mysql: &state.mysql,
            redis,
            tables: crate::internal_callback::tables(state),
            executor_manager: &state.executor_manager,
        };
        crate::internal_callback::completion::update_task_status(
            &ctx,
            poll.task_id,
            poll.subtask_id,
        )
        .await;
    }
    Ok(updated)
}

fn can_write(status: &str, result: &Value, poll: &Poll) -> bool {
    status == "RUNNING"
        && result.pointer("/video_job/job_id").and_then(Value::as_str) == Some(&poll.job_id)
        && result
            .pointer("/video_job/poll_count")
            .and_then(Value::as_u64)
            == Some(poll.poll_count as u64)
}

pub fn merge(mut result: Value, job: &Value, block: Option<&Value>) -> Value {
    if !result.is_object() {
        result = json!({});
    }
    let mut merged = result
        .get("video_job")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Some(map) = job.as_object() {
        for (key, value) in map {
            if !value.is_null() {
                merged[key] = value.clone();
            }
        }
    }
    result["video_job"] = merged.clone();
    let Some(id) = merged["video_block_id"].as_str() else {
        return result;
    };
    let mut blocks = result["blocks"].as_array().cloned().unwrap_or_default();
    let existing = blocks
        .iter()
        .position(|block| block["id"].as_str() == Some(id));
    let previous = existing
        .map(|index| blocks[index].clone())
        .unwrap_or_else(|| json!({}));
    // A claim only updates recovery tracking. A card has its own provider
    // payload, which a generic video placeholder would erase before polling it.
    let mut updated = block.cloned().unwrap_or_else(|| {
        if previous["type"] == "card" {
            previous.clone()
        } else {
            super::poll::video_block(
                id,
                merged["progress"].as_i64().unwrap_or(0),
                "streaming",
                true,
            )
        }
    });
    if block.is_some() {
        let mut combined = previous.as_object().cloned().unwrap_or_default();
        if let Some(map) = updated.as_object() {
            combined.extend(map.clone());
        }
        updated = Value::Object(combined);
        if previous["type"] == "card" && updated["type"] == "card" {
            for key in ["card_data", "card_preview_data"] {
                let mut map = previous[key].as_object().cloned().unwrap_or_default();
                map.extend(updated[key].as_object().cloned().unwrap_or_default());
                updated[key] = Value::Object(map);
            }
        }
    }
    if !previous["timestamp"].is_null() {
        updated["timestamp"] = previous["timestamp"].clone();
    }
    if let Some(index) = existing {
        blocks[index] = updated;
    } else {
        blocks.push(updated);
    }
    result["blocks"] = Value::Array(blocks);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn claim_heartbeat_keeps_provider_card_content() {
        let card = json!({"id":"b","type":"card","timestamp":1,"card_data":{"title":"Research","body":"Keep me"},"card_preview_data":{"cover_url":"https://example.test"}});
        let result = merge(
            json!({"blocks":[card.clone()],"video_job":{"job_id":"generation","video_block_id":"b","progress":5}}),
            &json!({"video_block_id":"b","poll_count":2,"progress":10}),
            None,
        );
        assert_eq!(result["blocks"][0], card);
        assert_eq!(result["video_job"]["poll_count"], 2);
        assert_eq!(result["video_job"]["progress"], 10);
    }

    #[test]
    fn card_refresh_preserves_preview_fields_timestamp_and_started_at() {
        let result = merge(
            json!({"video_job":{"started_at":"old"},"blocks":[{"id":"b","type":"card","timestamp":1,"card_data":{"title":"old"},"card_preview_data":{"cover_url":"https://example.test"}}]}),
            &json!({"video_block_id":"b","started_at":null}),
            Some(&json!({"id":"b","type":"card","timestamp":2,"card_data":{"body":"new"}})),
        );
        assert_eq!(result["video_job"]["started_at"], "old");
        assert_eq!(result["blocks"][0]["timestamp"], 1);
        assert_eq!(
            result["blocks"][0]["card_data"],
            json!({"title":"old","body":"new"})
        );
    }
}
