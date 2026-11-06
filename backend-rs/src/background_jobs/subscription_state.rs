//! Execution CAS and subscription statistics share one transaction.
use super::model::{self, Execution, Subscription};
use crate::sql_support::StatementArg;
use anyhow::Result;
use brz_mysql::{Json, Mysql, MysqlResult, MysqlRow, MysqlTransaction};
use brz_redis::Redis;
use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::{Value, json};

/// The source's `datetime.now(timezone.utc).replace(tzinfo=None)`
/// (`app/services/subscription/execution.py:851`): a microsecond-resolution
/// naive UTC clock, not the nanosecond precision `Utc::now` reports.
pub(crate) fn now_micros() -> NaiveDateTime {
    let instant = Utc::now();
    DateTime::from_timestamp_micros(instant.timestamp_micros())
        .map_or_else(|| instant.naive_utc(), |value| value.naive_utc())
}

pub(crate) fn valid_transition(from: &str, to: &str) -> bool {
    if from == to {
        return true;
    }
    match from {
        "PENDING" => matches!(to, "RUNNING" | "CANCELLED" | "FAILED"),
        "RUNNING" => matches!(
            to,
            "COMPLETED" | "COMPLETED_SILENT" | "FAILED" | "RETRYING" | "CANCELLED"
        ),
        "RETRYING" => matches!(to, "RUNNING" | "FAILED" | "CANCELLED" | "COMPLETED_SILENT"),
        _ => false,
    }
}

/// The statuses `update_execution_status` stamps `completed_at` for and updates
/// the subscription statistics for. `CANCELLED` is terminal but does neither.
fn completes(status: &str) -> bool {
    matches!(status, "COMPLETED" | "COMPLETED_SILENT" | "FAILED")
}

/// `update_execution_status`'s atomic CAS write
/// (`app/services/subscription/execution.py:876-897`): the `update_values` map
/// rendered in the `BackgroundExecution` mapper's column order, with only the
/// fields the source actually sets.
struct ExecutionUpdate<'a> {
    status: &'a str,
    summary: Option<&'a str>,
    error: Option<&'a str>,
    version: i64,
    started_at: Option<NaiveDateTime>,
    completed_at: Option<NaiveDateTime>,
    updated_at: NaiveDateTime,
}

impl ExecutionUpdate<'_> {
    fn statement(&self) -> String {
        let mut sql = String::from("UPDATE background_executions SET status=?");
        if self.summary.is_some() {
            sql.push_str(", result_summary=?");
        }
        if self.error.is_some() {
            sql.push_str(", error_message=?");
        }
        sql.push_str(", version=?");
        if self.started_at.is_some() {
            sql.push_str(", started_at=?");
        }
        if self.completed_at.is_some() {
            sql.push_str(", completed_at=?");
        }
        sql.push_str(
            ", updated_at=? WHERE background_executions.id = ? \
             AND background_executions.status = ? AND background_executions.version = ?",
        );
        sql
    }

    /// `update_values` first, then the CAS predicate's own arguments.
    fn args(&self, execution: &Execution) -> Vec<StatementArg> {
        let mut args = vec![StatementArg::Str(self.status.to_string())];
        if let Some(summary) = self.summary {
            args.push(StatementArg::Str(summary.to_string()));
        }
        if let Some(error) = self.error {
            args.push(StatementArg::Str(error.to_string()));
        }
        args.push(StatementArg::Int(self.version));
        if let Some(started) = self.started_at {
            args.push(StatementArg::DateTime(started));
        }
        if let Some(completed) = self.completed_at {
            args.push(StatementArg::DateTime(completed));
        }
        args.push(StatementArg::DateTime(self.updated_at));
        args.push(StatementArg::Int(execution.id));
        args.push(StatementArg::Str(execution.status.clone()));
        args.push(StatementArg::Int(execution.version));
        args
    }
}

/// One execution status change on a caller-owned transaction.
///
/// `update_execution_status` (`app/services/subscription/execution.py:782-960`)
/// reads the row, applies the version-guarded CAS, reloads it and writes the
/// subscription statistics, all inside the session its caller opened. Callers
/// that own a wider boundary — the task-completion handler, whose source session
/// also holds `_find_execution_by_task_id` — pass their transaction so the whole
/// recorded block stays inside one boundary; [`transition`] wraps this function
/// for callers that only need the status change.
pub(crate) async fn transition_in<T: MysqlTransaction>(
    tx: &mut T,
    id: i64,
    status: &str,
    summary: Option<&str>,
    error: Option<&str>,
) -> MysqlResult<Option<Execution>> {
    // `datetime.now(timezone.utc)`: the source clock has microsecond
    // resolution, and the statistics it writes carry exactly that precision.
    let now = now_micros();
    // `update_execution_status` reads the row before validating the transition.
    let execution: Option<Execution> = tx
        .fetch_optional(model::execution_status_read(), (id,))
        .await?;
    let Some(execution) = execution else {
        return Ok(None);
    };
    if !valid_transition(&execution.status, status) || model::terminal(&execution.status) {
        return Ok(None);
    }
    let summary = summary.filter(|value| !value.is_empty());
    let error = error.filter(|value| !value.is_empty());
    let update = ExecutionUpdate {
        status,
        summary,
        error,
        version: execution.version + 1,
        started_at: (status == "RUNNING").then_some(now),
        completed_at: completes(status).then_some(now),
        updated_at: now,
    };
    let updated = tx
        .execute(update.statement(), update.args(&execution))
        .await?;
    // `db.refresh(execution)`: the ORM reloads the row after the CAS, whether or
    // not the guarded write matched.
    let refreshed: Option<Execution> = tx.fetch_optional(model::execution_by_id(), (id,)).await?;
    let Some(execution) = refreshed else {
        return Ok(None);
    };
    if updated.rows_affected == 0 {
        return Ok(None);
    }
    if completes(status) {
        // `_update_subscription_statistics`: the statistics write rides the ORM's
        // dirty-attribute flush, so `updated_at` is the mapper's `now()` rather
        // than a bound value.
        let subscription: Option<Subscription> = tx
            .fetch_optional(
                model::subscription_statement(false),
                (execution.subscription_id,),
            )
            .await?;
        if let Some(mut subscription) = subscription {
            write_statistics(
                tx,
                &mut subscription,
                status,
                summary.unwrap_or(""),
                error.unwrap_or(""),
                now,
            )
            .await?;
        }
    }
    Ok(Some(execution))
}

/// `_update_subscription_statistics` (`app/services/subscription/execution.py:
/// 1064-1140`): rewrite the subscription CRD's `status` and `_internal`
/// statistics. The source stores the mutated entity and lets the session's
/// flush render the write, so it lands inside the same transaction as the status
/// CAS — the caller's boundary, before its single commit.
pub(crate) async fn write_statistics<T: MysqlTransaction>(
    tx: &mut T,
    subscription: &mut Subscription,
    status: &str,
    summary: &str,
    error: &str,
    now: NaiveDateTime,
) -> MysqlResult<()> {
    model::statistics(&mut subscription.json.0, status, summary, error, now);
    tx.execute(
        "UPDATE kinds SET json=?, updated_at=now() WHERE kinds.id = ?",
        (Json(&subscription.json.0), subscription.id),
    )
    .await?;
    Ok(())
}

pub(crate) async fn transition<M: Mysql, R: Redis>(
    mysql: &M,
    redis: Option<&R>,
    id: i64,
    status: &str,
    summary: Option<&str>,
    error: Option<&str>,
) -> Result<bool> {
    let changed = mysql
        .with_transaction(async |tx| transition_in(tx, id, status, summary, error).await)
        .await?;
    if let Some(execution) = changed {
        if let Some(redis) = redis
            && let Err(error) = emit(mysql, redis, &execution).await
        {
            tracing::warn!(%error, id, "subscription execution notification failed")
        }
        return Ok(true);
    }
    Ok(false)
}

/// `emit_background_execution_update`
/// (`app/services/subscription/execution.py:1533-1580`): the frontend event for
/// one execution, built from the subscription the execution belongs to and the
/// display name of the Team it references.
pub(crate) async fn emit<M: Mysql, R: Redis>(
    mysql: &M,
    redis: &R,
    execution: &Execution,
) -> Result<()> {
    let mut data = json!({"execution_id":execution.id,"subscription_id":execution.subscription_id,"status":execution.status,"is_silent":execution.status=="COMPLETED_SILENT","task_id":execution.task_id,"prompt":execution.prompt,"result_summary":execution.result_summary,"error_message":execution.error_message,"trigger_reason":execution.trigger_reason,"created_at":model::iso(execution.created_at),"updated_at":model::iso(execution.updated_at)});
    let subscription: Option<Subscription> = mysql
        .fetch_optional(
            model::subscription_statement(false),
            (execution.subscription_id,),
        )
        .await?;
    if let Some(subscription) = subscription {
        data["subscription_name"] = json!(subscription.name);
        if let Some(name) = subscription.json.0["spec"]["displayName"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            data["subscription_display_name"] = json!(name)
        }
        if let Some(kind) = subscription.json.0["spec"]["taskType"].as_str() {
            data["task_type"] = json!(kind)
        }
        let team = &subscription.json.0["spec"]["teamRef"];
        if let (Some(name), Some(namespace)) = (team["name"].as_str(), team["namespace"].as_str()) {
            let row: Option<MysqlRow> = mysql
                .fetch_optional(model::team_by_ref_statement(), (name, namespace))
                .await?;
            if let Some(row) = row
                && let Some(team_name) = row.get::<String>("name")?
            {
                data["team_name"] = json!(team_name);
            }
        }
    }
    redis.publish::<_,_>("socketio",serde_json::to_string(&json!({"method":"emit","event":"background:execution_update","data":[data],"namespace":"/chat","room":format!("user:{}",execution.user_id)}))?).await?;
    Ok(())
}

pub(crate) fn result_summary(result: Option<&Value>) -> Option<String> {
    result?
        .get("value")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalize(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    fn execution() -> Execution {
        let clock = NaiveDateTime::default();
        Execution {
            id: 2_539_501,
            user_id: 3650,
            subscription_id: 264_564,
            task_id: 501_652_180_355_339,
            inbox_message_id: 0,
            trigger_reason: String::new(),
            prompt: String::new(),
            status: "RUNNING".to_string(),
            result_summary: String::new(),
            error_message: String::new(),
            version: 0,
            started_at: clock,
            completed_at: clock,
            created_at: clock,
            updated_at: clock,
        }
    }

    fn update(
        status: &'static str,
        summary: Option<&'static str>,
        error: Option<&'static str>,
    ) -> ExecutionUpdate<'static> {
        let now = NaiveDateTime::default();
        ExecutionUpdate {
            status,
            summary,
            error,
            version: 1,
            started_at: (status == "RUNNING").then_some(now),
            completed_at: completes(status).then_some(now),
            updated_at: now,
        }
    }

    #[test]
    fn terminal_states_never_revive() {
        for terminal in ["COMPLETED", "FAILED", "CANCELLED", "COMPLETED_SILENT"] {
            assert!(!valid_transition(terminal, "RUNNING"));
        }
        assert!(valid_transition("PENDING", "RUNNING"));
        assert!(!valid_transition("PENDING", "COMPLETED"));
        assert!(valid_transition("RUNNING", "COMPLETED_SILENT"));
    }

    /// `datetime.now(timezone.utc)` has microsecond resolution, and the
    /// statistics the source writes render it with `isoformat()`, which prints
    /// six fractional digits at most.
    #[test]
    fn the_clock_matches_the_sources_microsecond_resolution() {
        let now = now_micros();
        assert_eq!(now.and_utc().timestamp_subsec_nanos() % 1_000, 0);
        let rendered = model::iso(now);
        let fraction = rendered
            .split_once('.')
            .map(|(_, fraction)| fraction)
            .unwrap_or("");
        assert!(fraction.len() <= 6, "{rendered}");
    }

    /// `update_execution_status` builds `update_values` from the target status
    /// and reports only those fields: `status`, `updated_at`, `version`, then
    /// `started_at`/`completed_at`, then the optional summary and error, in the
    /// mapper's column order. Recorded case `f742360f-b080-4725-b980-6af764719500`
    /// renders `SET status=…, result_summary=…, version=…, completed_at=…,
    /// updated_at=… WHERE background_executions.id = … AND status = … AND version = …`.
    #[test]
    fn the_status_write_sets_only_the_source_update_values() {
        let statement = update("COMPLETED", Some("done"), None).statement();
        assert_eq!(
            normalize(&statement),
            "UPDATE background_executions SET status=?, result_summary=?, version=?, \
             completed_at=?, updated_at=? WHERE background_executions.id = ? \
             AND background_executions.status = ? AND background_executions.version = ?"
        );
        assert_eq!(
            update("COMPLETED", Some("done"), None)
                .args(&execution())
                .len(),
            8
        );
    }

    #[test]
    fn a_failed_completion_orders_the_error_before_the_version() {
        assert_eq!(
            normalize(&update("FAILED", None, Some("boom")).statement()),
            "UPDATE background_executions SET status=?, error_message=?, version=?, \
             completed_at=?, updated_at=? WHERE background_executions.id = ? \
             AND background_executions.status = ? AND background_executions.version = ?"
        );
    }

    #[test]
    fn a_running_transition_stamps_started_at_instead_of_completed_at() {
        assert_eq!(
            normalize(&update("RUNNING", None, None).statement()),
            "UPDATE background_executions SET status=?, version=?, started_at=?, updated_at=? \
             WHERE background_executions.id = ? AND background_executions.status = ? \
             AND background_executions.version = ?"
        );
    }

    /// `CANCELLED` is terminal but the source neither stamps `completed_at` nor
    /// updates statistics for it.
    #[test]
    fn a_cancelled_transition_sets_neither_timestamp() {
        assert_eq!(
            normalize(&update("CANCELLED", None, None).statement()),
            "UPDATE background_executions SET status=?, version=?, updated_at=? \
             WHERE background_executions.id = ? AND background_executions.status = ? \
             AND background_executions.version = ?"
        );
        assert!(!completes("CANCELLED"));
        assert!(completes("COMPLETED") && completes("COMPLETED_SILENT") && completes("FAILED"));
    }

    /// The statistics read and the notification builder both read the full
    /// `kinds` entity: `db.query(Kind)` labels every mapped column, and `.first()`
    /// ends the statement with `LIMIT 1`.
    #[test]
    fn the_subscription_read_keeps_the_entity_projection() {
        let statement = normalize(&model::subscription_statement(false));
        assert_eq!(
            statement,
            normalize(&format!(
                "SELECT {} FROM kinds WHERE kinds.id = ? AND kinds.kind = 'Subscription' LIMIT 1",
                model::KIND_COLUMNS
            ))
        );
        assert_eq!(
            normalize(&model::subscription_statement(true)),
            normalize(&format!(
                "SELECT {} FROM kinds WHERE kinds.id = ? AND kinds.kind = 'Subscription' \
                 AND kinds.is_active = true LIMIT 1",
                model::KIND_COLUMNS
            ))
        );
    }

    /// `_is_code_wiki_scheduled_update` loads the subscription with `db.get`, so
    /// the statement is the entity projection by primary key: no kind filter and
    /// no `LIMIT` (recorded query sequence 14 on the notification connection).
    #[test]
    fn the_code_wiki_read_is_the_primary_key_load() {
        assert_eq!(
            normalize(&model::kind_by_id_statement()),
            normalize(&format!(
                "SELECT {} FROM kinds WHERE kinds.id = ?",
                model::KIND_COLUMNS
            ))
        );
    }

    /// `_dispatch_notifications` filters the Team by name, namespace, kind and
    /// `is_active`, `.first()` ending it with `LIMIT 1`
    /// (`task_completion_handler.py:552-562`).
    #[test]
    fn the_notification_team_read_keeps_the_source_filters() {
        assert_eq!(
            normalize(&model::team_display_statement()),
            normalize(&format!(
                "SELECT {} FROM kinds WHERE kinds.name = ? AND kinds.namespace = ? \
                 AND kinds.kind = 'Team' AND kinds.is_active = true LIMIT 1",
                model::KIND_COLUMNS
            ))
        );
    }

    /// `_execution_to_in_db` resolves the team by kind, name and namespace only;
    /// the port's extra owner filter had no recorded counterpart.
    #[test]
    fn the_team_read_has_no_owner_filter() {
        let statement = normalize(&model::team_by_ref_statement());
        assert_eq!(
            statement,
            normalize(&format!(
                "SELECT {} FROM kinds WHERE kinds.kind = 'Team' \
                 AND kinds.name = ? AND kinds.namespace = ? LIMIT 1",
                model::KIND_COLUMNS
            ))
        );
        let predicate = statement.split("WHERE").nth(1).unwrap_or_default();
        assert!(!predicate.contains("user_id"), "{predicate}");
    }

    /// `dispatch_execution_notifications` reads the accepted followers as a
    /// `subscription_follows` entity, not a two-column projection.
    #[test]
    fn the_follower_read_keeps_the_entity_projection() {
        let statement = normalize(&model::accepted_followers_statement());
        assert!(
            statement.contains("subscription_follows.config "),
            "{statement}"
        );
        assert!(
            statement.contains("subscription_follows.follower_user_id, "),
            "{statement}"
        );
        assert!(statement.ends_with(
            "FROM subscription_follows WHERE subscription_follows.subscription_id = ? \
             AND subscription_follows.invitation_status = 'accepted'"
        ));
    }
}
