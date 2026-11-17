//! Observed collaboration metrics computed from authoritative Issue and run events.
use std::collections::{BTreeMap, BTreeSet};

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json};
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use serde_json::{Value, json};

use crate::board_snapshot::repository::{BoardSnapshotRepository, has_permission};
use crate::http_compat::FastApiError;
use crate::loop_tasks::{auth::FlexibleUser, loop_repository::visible_item_filter_sql};
use crate::state::AppState;

const LIVE: &str =
    "(deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))";

#[derive(Debug, FromMysqlRow)]
struct Issue {
    id: String,
    status: String,
    created_at: NaiveDateTime,
    completed_at: Option<NaiveDateTime>,
    metadata: Json<Value>,
}

#[derive(Debug, FromMysqlRow)]
struct Run {
    loop_item_id: String,
    executor_owner_user_id: i32,
    status: String,
    started_at: NaiveDateTime,
    completed_at: NaiveDateTime,
}

fn timestamp(value: &Value) -> Option<NaiveDateTime> {
    let value = value.as_str()?;
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.naive_utc())
        .or_else(|| NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f").ok())
}

fn valid_time(time: NaiveDateTime) -> bool {
    time.and_utc().timestamp() > 1
}

fn history(issue: &Issue) -> &[Value] {
    issue.metadata.0["status_history"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn completion_owner(issue: &Issue) -> Option<i64> {
    // A snapshot is authoritative; never infer ownership from today's assignee.
    let event = history(issue)
        .iter()
        .rev()
        .find(|event| event["to_status"] == "completed");
    if let Some(event) = event {
        if let Some(owner) = event.get("completion_owner_user_id") {
            return owner.as_i64().filter(|id| *id > 0);
        }
        // Historical human transitions have an actor. Automation initiators are
        // not completion owners, even when the rule was created by a human.
        if matches!(event["trigger"].as_str(), Some("user_update" | "create"))
            && event.get("automation").is_none()
        {
            return event["by_user_id"].as_i64().filter(|id| *id > 0);
        }
        return None;
    }
    issue.metadata.0["completion_owner_user_id"]
        .as_i64()
        .filter(|id| *id > 0)
}

fn issue_start(issue: &Issue) -> NaiveDateTime {
    history(issue)
        .iter()
        .filter(|event| event["to_status"] == "in_progress")
        .filter_map(|event| timestamp(&event["at"]))
        .min()
        .unwrap_or(issue.created_at)
}

fn union_seconds(intervals: &mut [(NaiveDateTime, NaiveDateTime)]) -> f64 {
    intervals.sort_unstable();
    let mut covered = 0_i64;
    let mut current: Option<(NaiveDateTime, NaiveDateTime)> = None;
    for &(start, end) in intervals.iter() {
        match current {
            Some((left, right)) if start <= right => current = Some((left, right.max(end))),
            Some((left, right)) => {
                covered += (right - left).num_milliseconds();
                current = Some((start, end));
            }
            None => current = Some((start, end)),
        }
    }
    if let Some((start, end)) = current {
        covered += (end - start).num_milliseconds();
    }
    covered as f64 / 1000.0
}

fn timing(issue: &Issue, runs: &[&Run], as_of: NaiveDateTime) -> Value {
    let start = issue_start(issue).min(as_of);
    let authoritative_end = issue.completed_at.filter(|time| valid_time(*time));
    let end = if issue.status == "completed" {
        authoritative_end.unwrap_or(as_of)
    } else {
        as_of
    }
    .min(as_of)
    .max(start);
    let wall = (end - start).num_milliseconds() as f64 / 1000.0;
    let mut partial = issue.status != "completed"
        || authoritative_end.is_none()
        || authoritative_end.is_some_and(|end| end < start)
        || issue.created_at > as_of;
    let mut intervals = Vec::new();
    let mut by_owner = BTreeMap::<String, Vec<_>>::new();
    let mut owner_work = BTreeMap::<String, f64>::new();
    let mut run_seconds = 0.0;
    let mut unknown_terminal_runs = 0;
    let mut run_statuses = BTreeMap::<&str, usize>::new();
    for run in runs {
        *run_statuses.entry(&run.status).or_default() += 1;
        if !valid_time(run.started_at) {
            continue;
        }
        let completed = valid_time(run.completed_at);
        if !completed {
            partial = true;
            if matches!(run.status.as_str(), "completed" | "failed" | "cancelled") {
                unknown_terminal_runs += 1;
                continue;
            }
        }
        let left = run.started_at.max(start);
        let right = if completed { run.completed_at } else { as_of }.min(end);
        if right <= left {
            continue;
        }
        run_seconds += (right - left).num_milliseconds() as f64 / 1000.0;
        intervals.push((left, right));
        let owner = if run.executor_owner_user_id > 0 {
            run.executor_owner_user_id.to_string()
        } else {
            "unknown".into()
        };
        *owner_work.entry(owner.clone()).or_default() +=
            (right - left).num_milliseconds() as f64 / 1000.0;
        by_owner.entry(owner).or_default().push((left, right));
    }
    let ai = union_seconds(&mut intervals);
    let owners: BTreeMap<_, _> = by_owner.into_iter().map(|(owner, mut ranges)| {
        let seconds = union_seconds(&mut ranges);
        let work = owner_work.get(&owner).copied().unwrap_or_default();
        (owner, json!({"ai_active_seconds": seconds, "agent_run_seconds":work, "denominator": wall, "share": (wall > 0.0).then(|| seconds / wall)}))
    }).collect();
    json!({
        "issue_id": issue.id, "start": start.and_utc(), "end": end.and_utc(),
        "wall_seconds": wall, "ai_active_seconds": ai, "non_ai_seconds": wall - ai,
        "agent_run_seconds": run_seconds, "observed_ai_share": (wall > 0.0).then(|| ai / wall),
        "per_person": owners, "partial": partial, "unknown_terminal_runs": unknown_terminal_runs,
        "run_statuses":run_statuses,
    })
}

fn completion(issues: &[Issue], member_count: usize, as_of: NaiveDateTime) -> Value {
    let start = as_of - Duration::days(7);
    let mut owners = BTreeMap::<String, usize>::new();
    let mut count = 0;
    for issue in issues {
        if issue.status != "completed"
            || !issue
                .completed_at
                .is_some_and(|time| time >= start && time < as_of)
        {
            continue;
        }
        count += 1;
        let owner = completion_owner(issue)
            .map(|id| id.to_string())
            .unwrap_or_else(|| "unknown".into());
        *owners.entry(owner).or_default() += 1;
    }
    json!({
        "completed": count, "denominator": member_count, "sample": count,
        "per_member": (member_count > 0).then(|| count as f64 / member_count as f64),
        "per_person": owners, "unknown": owners.get("unknown").copied().unwrap_or_default(),
    })
}

async fn project_metrics(
    state: &AppState,
    project_id: i64,
    user_id: i32,
    as_of: NaiveDateTime,
) -> Result<Value, FastApiError> {
    let access = BoardSnapshotRepository::new(&state.mysql)
        .require_cloud_project_role(project_id, user_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Cloud project not found"))?;
    if !has_permission(&access.role, "Viewer") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }
    if access.project.task_provider() != "local" {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Metrics require authoritative project Issue history",
        ));
    }
    let members = super::members::list_project_members(
        &state.mysql,
        project_id,
        access.workspace_id,
        access.project.membership_mode(),
        &access.project.member_capabilities(),
        user_id,
    )
    .await
    .map_err(internal)?;
    let visibility = if has_permission(&access.role, "Maintainer") {
        String::new()
    } else {
        visible_item_filter_sql(user_id, access.project.default_issue_security())
    };
    let id = project_id.to_string();
    let start = as_of - Duration::days(7);
    let cohort = format!(
        "cloud_project_id=? AND resource_type='task' AND parent_id IS NULL AND {LIVE} {visibility} \
         AND (status IN ('in_progress','in_review') OR (status='completed' AND completed_at >= ? AND completed_at < ?))"
    );
    let mut issues: Vec<Issue> = state.mysql.fetch_all(format!(
        "SELECT id,status,created_at,completed_at,COALESCE(metadata,JSON_OBJECT()) AS metadata FROM loop_items \
         WHERE {cohort}"
    ), (id.as_str(),start,as_of)).await.map_err(internal)?;
    // created_at is database-generated in the session timezone; lifecycle and
    // execution timestamps are explicitly persisted as naive UTC by their owners.
    for issue in &mut issues {
        issue.created_at = crate::socketio::project_chat_messages::utc_timestamp(issue.created_at);
    }
    let runs: Vec<Run> = state.mysql.fetch_all(format!(
        "SELECT loop_item_id,executor_owner_user_id,status,started_at,completed_at FROM loop_item_executions \
         WHERE cloud_project_id=? AND loop_item_id IN (SELECT id FROM loop_items WHERE {cohort}) \
         AND started_at > '1970-01-01 00:00:01' AND started_at < ?"),
        (id.as_str(), id.as_str(), start, as_of, as_of),
    ).await.map_err(internal)?;
    let mut grouped = BTreeMap::<&str, Vec<&Run>>::new();
    for run in &runs {
        grouped.entry(&run.loop_item_id).or_default().push(run);
    }
    // Keep the metric cohort explicit: completed in the window or currently active.
    let timings: Vec<_> = issues
        .iter()
        .filter(|issue| {
            matches!(issue.status.as_str(), "in_progress" | "in_review")
                || (issue.status == "completed"
                    && issue
                        .completed_at
                        .is_some_and(|time| time >= start && time < as_of))
        })
        .map(|issue| {
            timing(
                issue,
                grouped
                    .get(issue.id.as_str())
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                as_of,
            )
        })
        .collect();
    let total = |key: &str| {
        timings
            .iter()
            .filter_map(|row| row[key].as_f64())
            .sum::<f64>()
    };
    let wall = total("wall_seconds");
    let ai = total("ai_active_seconds");
    let active_members: BTreeSet<_> = members.iter().map(|member| member.user_id).collect();
    Ok(json!({
        "definition_version": 1, "project_id": id, "as_of": as_of.and_utc(),
        "window": {"start": start.and_utc(), "end": as_of.and_utc(), "days": 7},
        "denominator_definition": "current_effective_members",
        "completion": completion(&issues, active_members.len(), as_of),
        "timing": {"wall_seconds": wall, "ai_active_seconds": ai, "non_ai_seconds": wall-ai,
            "agent_run_seconds": total("agent_run_seconds"), "denominator": wall,
            "observed_ai_share": (wall > 0.0).then(|| ai/wall), "sample": timings.len(),
            "partial": timings.iter().any(|row| row["partial"] == true), "issues": timings},
    }))
}

fn internal(error: impl std::fmt::Display) -> FastApiError {
    tracing::error!(%error, "Collaboration metrics read failed");
    FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Collaboration metrics unavailable",
    )
}

#[brz_http_server::get("/api/v1/cloud-projects/:project_id/collaboration-metrics")]
async fn read_project_metrics(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] user: FlexibleUser,
) -> Result<Value, FastApiError> {
    project_metrics(
        state,
        super::parse_project_id(project_id)?,
        user.id,
        Utc::now().naive_utc(),
    )
    .await
}

#[brz_http_server::get("/api/v1/collaboration-metrics/me")]
async fn read_personal_metrics(
    #[inject(state)] state: &AppState,
    #[auth] user: FlexibleUser,
) -> Result<Value, FastApiError> {
    let as_of = Utc::now().naive_utc();
    let projects =
        super::collaboration_access::authorized_projects(&state.mysql, user.id, None, None)
            .await
            .map_err(internal)?;
    let mut rows = Vec::new();
    let mut wall = 0.0;
    let mut ai = 0.0;
    let mut work = 0.0;
    let mut sample = 0;
    let mut partial = false;
    let owner = user.id.to_string();
    for project in projects {
        // External-provider Issues are not authoritative local events.
        let local = project
            .project
            .metadata
            .as_ref()
            .and_then(|value| value.0.value.as_ref())
            .and_then(|metadata| metadata.task_provider.as_deref())
            .unwrap_or("local")
            == "local";
        if !local {
            continue;
        }
        let metrics = project_metrics(
            state,
            super::parse_project_id(&project.project.id)?,
            user.id,
            as_of,
        )
        .await?;
        let completed = metrics["completion"]["per_person"][&owner]
            .as_u64()
            .unwrap_or_default();
        for issue in metrics["timing"]["issues"].as_array().into_iter().flatten() {
            if let Some(person) = issue["per_person"].get(&owner) {
                wall += person["denominator"].as_f64().unwrap_or_default();
                ai += person["ai_active_seconds"].as_f64().unwrap_or_default();
                work += person["agent_run_seconds"].as_f64().unwrap_or_default();
                sample += 1;
                partial |= issue["partial"] == true;
            }
        }
        rows.push(json!({"project_id": project.project.id, "completed": completed}));
    }
    let completed: u64 = rows
        .iter()
        .filter_map(|row| row["completed"].as_u64())
        .sum();
    Ok(json!({"definition_version":1, "user_id":user.id,
        "completion":{"completed":completed,"sample":completed,"denominator":1,"per_member":completed,
            "unknown":0,"per_person":{owner:completed}},
        "timing":{"wall_seconds":wall,"ai_active_seconds":ai,"non_ai_seconds":wall-ai,
            "agent_run_seconds":work,"denominator":wall,"sample":sample,"partial":partial,
            "observed_ai_share":(wall > 0.0).then(|| ai/wall)},
        "as_of":as_of.and_utc(),
        "window":{"start":(as_of-Duration::days(7)).and_utc(),"end":as_of.and_utc(),"days":7}, "projects":rows}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn at(hour: i64) -> NaiveDateTime {
        DateTime::from_timestamp(1_800_000_000 + hour * 3600, 0)
            .unwrap()
            .naive_utc()
    }
    fn issue() -> Issue {
        Issue {
            id: "one".into(),
            status: "completed".into(),
            created_at: at(0),
            completed_at: Some(at(2)),
            metadata: Json(
                json!({"status_history":[{"to_status":"completed","trigger":"user_update","by_user_id":7}]}),
            ),
        }
    }
    fn run(owner: i32, start: i64, end: i64) -> Run {
        Run {
            loop_item_id: "one".into(),
            executor_owner_user_id: owner,
            status: "completed".into(),
            started_at: at(start),
            completed_at: at(end),
        }
    }
    #[test]
    fn overlapping_runs_use_union_and_keep_serial_work_and_people_separate() {
        let runs = [run(7, -1, 2), run(8, 1, 3)];
        let result = timing(&issue(), &runs.iter().collect::<Vec<_>>(), at(4));
        assert_eq!(result["wall_seconds"], 7200.0);
        assert_eq!(result["ai_active_seconds"], 7200.0);
        assert_eq!(result["agent_run_seconds"], 10800.0);
        assert_eq!(result["per_person"]["7"]["share"], 1.0);
        assert_eq!(result["per_person"]["8"]["share"], 0.5);
    }
    #[test]
    fn rolling_window_is_half_open_and_reopened_issues_do_not_count() {
        let mut issues = vec![issue(), issue(), issue(), issue()];
        issues[0].completed_at = Some(at(0));
        issues[1].completed_at = Some(at(168));
        issues[2].status = "in_progress".into();
        issues[3].metadata = Json(json!({}));
        let result = completion(&issues, 5, at(168));
        assert_eq!(result["completed"], 2);
        assert_eq!(result["per_member"], 0.4);
        assert_eq!(result["unknown"], 1);
        assert!(completion(&issues, 0, at(168))["per_member"].is_null());
    }
    #[test]
    fn missing_terminal_end_is_unknown_and_running_end_is_clipped() {
        let mut issue = issue();
        issue.status = "in_progress".into();
        issue.completed_at = None;
        let mut running = run(7, 0, 1);
        running.completed_at = at(-500_000);
        running.status = "running".into();
        let mut failed = run(8, 0, 1);
        failed.completed_at = running.completed_at;
        failed.status = "failed".into();
        let result = timing(&issue, &[&running, &failed], at(2));
        assert_eq!(result["partial"], true);
        assert_eq!(result["ai_active_seconds"], 7200.0);
        assert_eq!(result["unknown_terminal_runs"], 1);
    }
    #[test]
    fn failed_and_cancelled_intervals_stop_at_their_end_and_never_count_waiting() {
        let mut failed = run(0, 0, 1);
        failed.status = "failed".into();
        let mut cancelled = run(8, 0, 1);
        cancelled.status = "cancelled".into();
        let result = timing(&issue(), &[&failed, &cancelled], at(4));
        assert_eq!(result["ai_active_seconds"], 3600.0);
        assert_eq!(result["non_ai_seconds"], 3600.0);
        assert_eq!(result["per_person"]["unknown"]["ai_active_seconds"], 3600.0);
    }

    #[test]
    fn explicit_unknown_completion_owner_never_falls_back_to_the_actor() {
        let mut issue = issue();
        issue.metadata = Json(json!({"completion_owner_user_id":9,"status_history":[
            {"to_status":"completed","trigger":"user_update","by_user_id":7,"completion_owner_user_id":null}
        ]}));
        assert_eq!(completion_owner(&issue), None);
        issue.metadata = Json(json!({"status_history":[
            {"to_status":"completed","trigger":"automation","by_user_id":7},
            {"to_status":"completed","trigger":"assistant_publication","by_user_id":9,"completion_owner_user_id":9}
        ]}));
        assert_eq!(completion_owner(&issue), Some(9));
    }

    #[test]
    fn zero_duration_has_no_share_and_history_offsets_are_normalized() {
        let mut issue = issue();
        issue.completed_at = Some(issue.created_at);
        let result = timing(&issue, &[], at(4));
        assert_eq!(result["wall_seconds"], 0.0);
        assert!(result["observed_ai_share"].is_null());
        assert_eq!(
            timestamp(&json!("2026-11-17T08:00:00+08:00")),
            timestamp(&json!("2026-11-17T00:00:00"))
        );
    }
}
