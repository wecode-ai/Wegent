use super::{
    model::{self, EXECUTION_COLUMNS, Execution, SUBSCRIPTION_COLUMNS, Subscription},
    state,
};
use crate::AppState;
use anyhow::Result;
use brz_mysql::{Json, MysqlTransaction};
use chrono::{NaiveDateTime, TimeZone, Utc};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

pub(super) async fn scan(app: Arc<AppState>, ctx: brz_schedule::JobContext) -> Result<Value> {
    if !model::enabled("SUBSCRIPTION_SCHEDULER_ENABLED", true) {
        return Ok(json!({"status":"skipped","reason":"scheduler_disabled"}));
    }
    super::super::with_lock_watchdog(
        &app.background_jobs,
        &ctx,
        "wegent:lock:check_due_subscriptions",
        Duration::from_secs(120),
        async { scan_inner(&app).await },
    )
    .await
    .map(|v| {
        v.unwrap_or_else(|| json!({"status":"skipped","reason":"lock_held_by_another_instance"}))
    })
}
async fn scan_inner(app: &AppState) -> Result<Value> {
    let recovered = recover(app).await?;
    let cleaned = cleanup(app).await?;
    let now = Utc::now().naive_utc();
    let mut cursor = 0i64;
    let (mut due, mut dispatched, mut invalid) = (0, 0, 0);
    loop {
        let rows:Vec<Subscription>=app.mysql.fetch_all(format!("SELECT {SUBSCRIPTION_COLUMNS} FROM kinds WHERE kind='Subscription' AND is_active=1 AND id>? ORDER BY id LIMIT 100"),(cursor,)).await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            cursor = row.id;
            let internal = &row.json.0["_internal"];
            if internal["enabled"] == false {
                continue;
            }
            if let Some(expiry) = model::datetime(&internal["expires_at"])
                && expiry <= now
            {
                app.mysql.with_transaction(async|tx|{tx.execute("UPDATE kinds SET json=JSON_SET(json,'$._internal.enabled',false),updated_at=? WHERE id=? AND kind='Subscription'",(now,row.id)).await?;Ok(())}).await?;
                continue;
            }
            let kind = internal["trigger_type"].as_str().unwrap_or("");
            if !matches!(kind, "cron" | "interval" | "one_time") {
                continue;
            }
            if !model::valid_trigger(&row.json.0) {
                invalid += 1;
                continue;
            }
            if model::datetime(&internal["next_execution_time"]).is_none_or(|next| next > now) {
                continue;
            }
            due += 1;
            match create_due(app, &row, now).await {
                Ok(Some((row, id))) => match dispatch(app, &row, id).await {
                    Ok(()) => dispatched += 1,
                    Err(error) => {
                        state::transition(&app.mysql,app.redis.as_ref(),id,"FAILED",None,Some(&format!("Execution was not dispatched because dispatch failed after scheduler advanced next_execution_time: {error}"))).await?;
                    }
                },
                Ok(None) => {}
                Err(error) => {
                    tracing::error!(subscription_id=row.id,%error,"subscription schedule failed")
                }
            }
        }
    }
    Ok(
        json!({"status":"success","due_count":due,"dispatched":dispatched,"recovered":recovered,"cleaned_running":cleaned,"skipped_invalid":invalid}),
    )
}
async fn create_due(
    app: &AppState,
    snapshot: &Subscription,
    now: NaiveDateTime,
) -> Result<Option<(Subscription, i64)>> {
    // Resolve rental prompt before taking the scheduler row lock.
    let source = if snapshot.json.0["_internal"]["is_rental"] == true {
        if let Some(id) = snapshot.json.0["_internal"]["source_subscription_id"].as_i64() {
            model::subscription(&app.mysql, id, true).await?
        } else {
            None
        }
    } else {
        None
    };
    let prompt_source = source.as_ref().unwrap_or(snapshot);
    let prompt = model::prompt(
        prompt_source.json.0["spec"]["promptTemplate"]
            .as_str()
            .unwrap_or(""),
        snapshot.json.0["spec"]["displayName"]
            .as_str()
            .unwrap_or(""),
        chrono::Local::now(),
    )?;
    Ok(app.mysql.with_transaction(async|tx|{
        let row:Option<Subscription>=tx.fetch_optional(format!("SELECT {SUBSCRIPTION_COLUMNS} FROM kinds WHERE id=? AND kind='Subscription' AND is_active=1 FOR UPDATE"),(snapshot.id,)).await?;
        let Some(mut row)=row else{return Ok(None)};if row.json.0["_internal"]["enabled"]==false||model::datetime(&row.json.0["_internal"]["next_execution_time"]).is_none_or(|next|next>now){return Ok(None)}
        let kind=row.json.0["_internal"]["trigger_type"].as_str().unwrap_or("").to_owned();let reason=model::reason(&row,&kind);
        let inserted=tx.execute("INSERT INTO background_executions (user_id,subscription_id,task_id,inbox_message_id,trigger_type,trigger_reason,prompt,status,result_summary,error_message,retry_attempt,version,started_at,completed_at,created_at,updated_at) VALUES (?,?,0,0,?,?,?,'PENDING','','',0,0,?,?,?,?)",(row.user_id,row.id,kind.clone(),reason,prompt.clone(),now,now,now,now)).await?;let id=inserted.last_insert_id as i64;
        advance(&mut row,now);tx.execute("UPDATE kinds SET json=?,updated_at=? WHERE id=?",(Json(&row.json.0),now,row.id)).await?;Ok(Some((row,id)))
    }).await?)
}
pub(super) fn advance(row: &mut Subscription, now: NaiveDateTime) {
    let kind = row.json.0["_internal"]["trigger_type"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    if model::code_wiki_id(row).is_some() {
        let schedule = &row.json.0["_internal"]["schedule"];
        let days = schedule["interval_days"].as_i64().unwrap_or(7).max(1);
        let zone = schedule["timezone"]
            .as_str()
            .unwrap_or("UTC")
            .parse::<chrono_tz::Tz>()
            .unwrap_or(chrono_tz::UTC);
        if let Some(stored) = model::datetime(&row.json.0["_internal"]["next_execution_time"]) {
            let mut local = Utc
                .from_utc_datetime(&stored)
                .with_timezone(&zone)
                .naive_local();
            let mut utc = stored;
            while utc <= now {
                local += chrono::Duration::days(days);
                utc = zone
                    .from_local_datetime(&local)
                    .earliest()
                    .map(|v| v.with_timezone(&Utc).naive_utc())
                    .unwrap_or(utc + chrono::Duration::days(days));
            }
            row.json.0["_internal"]["next_execution_time"] = json!(model::iso(utc));
        }
        return;
    }
    if kind == "one_time" {
        row.json.0["_internal"]["enabled"] = json!(false);
        row.json.0["_internal"]["next_execution_time"] = Value::Null;
        return;
    }
    let config = model::trigger_config(&row.json.0);
    let next = crate::subscriptions_item::calculate_next_execution_time(&kind, &config, now);
    row.json.0["_internal"]["next_execution_time"] = next
        .map(model::iso)
        .map(Value::String)
        .unwrap_or(Value::Null);
}
pub(super) async fn dispatch(app: &AppState, row: &Subscription, id: i64) -> Result<()> {
    dispatch_with_key(app, row, id, format!("subscription_execution_{id}")).await
}
fn execution_kind(row: &Subscription) -> &'static str {
    if model::code_wiki_id(row).is_some() {
        super::CODE_WIKI
    } else {
        super::EXECUTE
    }
}
async fn dispatch_with_key(app: &AppState, row: &Subscription, id: i64, key: String) -> Result<()> {
    app.background_jobs.submit(execution_kind(row),json!({"subscription_id":row.id,"execution_id":id,"timeout_seconds":row.json.0["spec"]["timeoutSeconds"].as_u64().unwrap_or(model::setting("FLOW_DEFAULT_TIMEOUT_SECONDS",600))}),None,Some(key)).await?;
    Ok(())
}
fn recovery_key(id: i64, version: i64, status: Option<&brz_schedule::JobStatus>) -> Option<String> {
    let base = format!("subscription_execution_{id}");
    match status {
        Some(status) if !status.is_terminal() => None,
        Some(_) => Some(format!("{base}:recovery_{}", version + 1)),
        None => Some(base),
    }
}
async fn recover(app: &AppState) -> Result<usize> {
    let cutoff = Utc::now().naive_utc()
        - chrono::Duration::hours(model::setting("FLOW_STALE_PENDING_HOURS", 2) as i64);
    let rows:Vec<Execution>=app.mysql.fetch_all(format!("SELECT {EXECUTION_COLUMNS} FROM background_executions WHERE status='PENDING' AND created_at<? AND task_id=0 ORDER BY id LIMIT 50"),(cutoff,)).await?;
    let mut recovered = 0;
    for execution in rows {
        let Some(subscription) =
            model::subscription(&app.mysql, execution.subscription_id, true).await?
        else {
            state::transition(
                &app.mysql,
                app.redis.as_ref(),
                execution.id,
                "CANCELLED",
                None,
                Some("Subscription was deleted while execution was pending"),
            )
            .await?;
            continue;
        };
        let base = format!("subscription_execution_{}", execution.id);
        let record = app
            .background_jobs
            .snapshot(execution_kind(&subscription), &base)
            .await?;
        let Some(key) = recovery_key(
            execution.id,
            execution.version,
            record.as_ref().map(|record| &record.status),
        ) else {
            continue;
        };
        // A retained queue terminal must not prevent business-driven recovery.
        // Publish durably first so a provider failure leaves this row eligible.
        dispatch_with_key(app, &subscription, execution.id, key).await?;
        if state::transition(
            &app.mysql,
            app.redis.as_ref(),
            execution.id,
            "RUNNING",
            None,
            None,
        )
        .await?
        {
            recovered += 1
        }
    }
    Ok(recovered)
}
async fn cleanup(app: &AppState) -> Result<usize> {
    let now = Utc::now().naive_utc();
    let fallback = model::setting("FLOW_STALE_RUNNING_HOURS", 3) * 3600;
    let rows:Vec<Execution>=app.mysql.fetch_all(format!("SELECT {EXECUTION_COLUMNS} FROM background_executions WHERE status='RUNNING' AND started_at<? ORDER BY started_at LIMIT 50"),(now-chrono::Duration::seconds(fallback as i64),)).await?;
    let mut count = 0;
    for execution in rows {
        let subscription = model::subscription(&app.mysql, execution.subscription_id, true).await?;
        let timeout = subscription
            .as_ref()
            .and_then(|s| s.json.0["spec"]["timeoutSeconds"].as_u64())
            .unwrap_or(fallback);
        let hours = (now - execution.started_at).num_seconds() as f64 / 3600.;
        if (now - execution.started_at).num_seconds() <= timeout as i64 {
            continue;
        }
        let message = format!(
            "Execution timed out after {hours:.1} hour(s) (stuck in RUNNING state, exceeded subscription timeout {:.1}h)",
            timeout as f64 / 3600.
        );
        if !state::transition(
            &app.mysql,
            app.redis.as_ref(),
            execution.id,
            "FAILED",
            None,
            Some(&message),
        )
        .await?
        {
            continue;
        }
        count += 1;
        if subscription
            .as_ref()
            .is_some_and(|s| model::code_wiki_id(s).is_some())
            && execution.task_id > 0
        {
            let generation: Option<brz_mysql::MysqlRow> = app
                .mysql
                .fetch_optional(
                    "SELECT user_id FROM wiki_generations WHERE task_id=? ORDER BY id DESC LIMIT 1",
                    (execution.task_id,),
                )
                .await?;
            let runner = generation
                .map(|g| g.get_at::<i64>(0))
                .transpose()?
                .unwrap_or(execution.user_id);
            if let Err(error) = super::execution::cancel_task(app, execution.task_id, runner).await
            {
                tracing::warn!(%error,"timed-out Code Wiki task cancellation failed");
            }
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_preserves_active_jobs_but_a_queue_terminal_does_not_finish_business_work() {
        use brz_schedule::JobStatus::*;
        assert_eq!(
            recovery_key(7, 3, None).as_deref(),
            Some("subscription_execution_7")
        );
        for active in [Queued, Running] {
            assert!(recovery_key(7, 3, Some(&active)).is_none());
        }
        for terminal in [Succeeded, Failed, Cancelled] {
            assert_eq!(
                recovery_key(7, 3, Some(&terminal)).as_deref(),
                Some("subscription_execution_7:recovery_4")
            );
        }
    }
    #[test]
    fn code_wiki_advances_local_calendar_across_dst() {
        let mut row = Subscription {
            id: 1,
            user_id: 1,
            name: "wiki".into(),
            is_active: 1,
            json: Json(
                json!({"spec":{"codeWikiRef":{"id":2}},"_internal":{"trigger_type":"interval","next_execution_time":"2026-03-07T14:00:00","schedule":{"timezone":"America/New_York","interval_days":1}}}),
            ),
        };
        advance(
            &mut row,
            model::datetime(&json!("2026-03-07T15:00:00")).unwrap(),
        );
        assert_eq!(
            row.json.0["_internal"]["next_execution_time"],
            "2026-03-08T13:00:00"
        );
    }
}
