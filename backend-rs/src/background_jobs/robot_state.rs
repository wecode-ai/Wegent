//! Conditional lifecycle writes preserve process liveness and the winning outcome.

use anyhow::Result;
use brz_mysql::{FromMysqlRow, MysqlTransaction};
use chrono::Utc;
use serde_json::json;

use super::projection::Effects;
use super::{
    model::{COLUMNS, Execution, unset},
    projection,
};
use crate::AppState;

pub(super) async fn cancel(
    state: &AppState,
    row: &Execution,
    note: &str,
) -> Result<Option<Execution>> {
    if row.terminal() {
        return Ok(None);
    }
    let (changed,messages)=state.mysql.with_transaction(async|tx|{
        let now=Utc::now().naive_utc();
        if row.can_cancel_without_runtime() {
            let result=tx.execute("UPDATE loop_item_executions SET status='cancelled',completed_at=?,lease_expires_at='1970-01-01 00:00:01',observed_state='cancelled',observed_at=?,sync_state='in_sync',termination_reason='cancelled_before_start',error_message='',execution_note=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND status=? AND version=?",(now,now,note,row.id,row.status.as_str(),row.version)).await?;
            if result.rows_affected==0{return Ok((false,Effects::default()));}
            Ok((true,projection::terminal_on(tx,state,row,"cancelled",note,note,now,true).await?))
        } else {
            let result=tx.execute("UPDATE loop_item_executions SET status='cancel_requested',cancel_requested_at=?,sync_state='pending',execution_note=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND status IN ('claimed','running') AND version=?",(now,note,row.id,row.version)).await?;
            Ok((result.rows_affected>0,Effects::default()))
        }
    }).await?;
    projection::publish(state, messages).await?;
    if !changed {
        return Ok(None);
    }
    Ok(state
        .mysql
        .fetch_optional(
            format!("SELECT {COLUMNS} FROM loop_item_executions WHERE id=?"),
            (row.id,),
        )
        .await?)
}

pub(super) async fn fail_preparation(state: &AppState, row: &Execution, error: &str) -> Result<()> {
    let detail: String = error.chars().take(2000).collect();
    let messages=state.mysql.with_transaction(async|tx|{
        let now=Utc::now().naive_utc();
        let result=tx.execute("UPDATE loop_item_executions SET status='failed',completed_at=?,lease_expires_at='1970-01-01 00:00:01',observed_state='failed',observed_at=?,sync_state='in_sync',termination_reason='runtime_failed',error_message=?,execution_note='execution_configuration_unavailable',version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND status='queued' AND version=?",(now,now,detail.as_str(),row.id,row.version)).await?;
        if result.rows_affected==0{return Ok(Effects::default());}
        projection::terminal_on(tx,state,row,"failed",&detail,"execution_configuration_unavailable",now,true).await
    }).await?;
    projection::publish(state, messages).await
}

pub(super) async fn recover(state: &AppState) -> Result<(usize, usize)> {
    projection::repair_terminal(state).await?;
    let threshold = Utc::now().naive_utc() - chrono::Duration::seconds(60);
    let rows:Vec<Execution>=state.mysql.fetch_all(format!("SELECT {COLUMNS} FROM loop_item_executions WHERE status IN ('claimed','running','cancel_requested') AND lease_expires_at>'1970-01-01 00:00:01' AND lease_expires_at<?"),(threshold,)).await?;
    let (mut requeued, mut unknown) = (0, 0);
    for row in rows {
        let requeue = row.status == "claimed" && unset(row.start_requested_at);
        let (changed,messages)=state.mysql.with_transaction(async|tx|{
            let result=if requeue {
                tx.execute("UPDATE loop_item_executions SET status='queued',queued_at=UTC_TIMESTAMP(6),lease_expires_at='1970-01-01 00:00:01',start_requested_at='1970-01-01 00:00:01',observed_state='unconfirmed',observed_at='1970-01-01 00:00:01',sync_state='pending',termination_reason='',error_message='Claim lease expired before Runtime dispatch',execution_note='claim_lease_expired_before_start',version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND status='claimed' AND version=? AND (start_requested_at IS NULL OR start_requested_at<='1970-01-01 00:00:01')",(row.id,row.version)).await?
            }else{
                tx.execute("UPDATE loop_item_executions SET sync_state='stale',error_message='Runtime state must be reconciled after lease expiry',termination_reason='start_confirmation_timeout',version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND status IN ('claimed','running','cancel_requested') AND version=?",(row.id,row.version)).await?
            };
            if result.rows_affected==0{return Ok((false,Effects::default()));}
            let messages=if requeue{Effects::from(projection::requeued_on(tx,&row).await?)}else{Effects::default()};
            Ok((true,messages))
        }).await?;
        projection::publish(state, messages).await?;
        if changed {
            if requeue {
                requeued += 1;
            } else {
                unknown += 1;
            }
        }
    }
    Ok((requeued, unknown))
}

pub(super) async fn stalled(state: &AppState) -> Result<Vec<Execution>> {
    let threshold = Utc::now().naive_utc() - chrono::Duration::minutes(20);
    let rows:Vec<Execution>=state.mysql.fetch_all(format!("SELECT {COLUMNS} FROM loop_item_executions WHERE status='running' AND started_at IS NOT NULL AND started_at<?"),(threshold,)).await?;
    let mut stalled = Vec::new();
    for row in rows {
        let Some(produced) = has_text(state, &row).await? else {
            continue;
        };
        if produced {
            continue;
        }
        if let Some(cancelled) = cancel(
            state,
            &row,
            "AI 执行超过 20 分钟未产生任何输出，已自动停止（疑似卡死）",
        )
        .await?
        {
            stalled.push(cancelled);
        }
    }
    Ok(stalled)
}

async fn has_text(state: &AppState, row: &Execution) -> Result<Option<bool>> {
    use crate::sql_support::StatementArg;
    #[derive(FromMysqlRow)]
    struct Found {
        id: i64,
    }
    let (identity, mut args) =
        if !row.runtime_device_id.is_empty() && !row.runtime_task_id.is_empty() {
            (
                "runtime_device_id=? AND runtime_task_id=?",
                vec![
                    StatementArg::Str(row.runtime_device_id.clone()),
                    StatementArg::Str(row.conversation_id()),
                ],
            )
        } else if !row.agent_id.is_empty() {
            (
                "task_id=? AND agent_id=?",
                vec![
                    StatementArg::Str(row.loop_item_id.clone()),
                    StatementArg::Str(row.agent_id.clone()),
                ],
            )
        } else {
            return Ok(None);
        };
    let trigger = row.context()["comment_trigger_message_id"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    let extra = if trigger.is_empty() {
        ""
    } else {
        args.push(StatementArg::Str(trigger));
        " AND trigger_message_id=?"
    };
    let found:Option<Found>=state.mysql.fetch_optional(format!("SELECT id FROM project_chat_messages WHERE {identity}{extra} AND sender_type='agent' AND (deleted_at IS NULL OR deleted_at<='1970-01-02') AND LENGTH(TRIM(content))>0 LIMIT 1"),args).await?;
    Ok(Some(found.is_some_and(|row| row.id != 0)))
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn prepared_on(
    tx: &mut impl MysqlTransaction,
    app: &AppState,
    row: &Execution,
    status: &str,
    payload: &serde_json::Value,
    owner: i64,
    team: i64,
    environment: &str,
    device: &str,
) -> brz_mysql::MysqlResult<Effects> {
    let note = if status == "waiting_runtime" {
        "Select a model or workspace before this execution can start"
    } else {
        row.execution_note.as_str()
    };
    let result=tx.execute("UPDATE loop_item_executions SET executor_owner_user_id=?,team_id=?,execution_environment=?,execution_device_id=?,runtime_device_id=?,execution_payload=?,status=?,approval_status=CASE WHEN ?='pending_approval' THEN 'pending' ELSE approval_status END,execution_note=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND status='queued' AND version=?",(owner,team,environment,device,row.runtime_device_id.as_str(),payload.to_string(),status,status,note,row.id,row.version)).await?;
    if result.rows_affected == 0 {
        return Ok(Effects::default());
    }
    let mut effects = Effects::default();
    if let Some(mut message) = projection::linked(tx, row).await? {
        if !message.metadata.0.is_object() {
            message.metadata.0 = json!({});
        }
        message.metadata.0["run_status"] = json!(status);
        tx.execute("UPDATE project_chat_messages SET runtime_device_id=?,runtime_task_id=?,metadata=?,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(row.runtime_device_id.as_str(),row.runtime_task_id.as_str(),brz_mysql::Json(&message.metadata.0),message.id)).await?;
        effects.messages.push(message);
    }
    if matches!(status, "pending_approval" | "waiting_runtime")
        && let Some(notice) = projection::notify_on(tx, app, row, status, "").await?
    {
        effects.notices.push(notice);
    }
    Ok(effects)
}
