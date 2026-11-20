//! Observed collaboration metrics computed from authoritative Issue and run events.
use std::collections::BTreeSet;

use brz_http_server::StatusCode;
#[cfg(test)]
use brz_mysql::MysqlService;
use brz_mysql::{FromMysqlRow, Json, MysqlIsolationLevel, MysqlTransactionOptions};
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use serde_json::{Value, json};

use crate::http_compat::FastApiError;
use crate::loop_tasks::{auth::FlexibleUser, loop_repository::visible_item_filter_sql};
use crate::plugins_marketplace::query::PluginQuery;
use crate::state::AppState;

const LIVE: &str =
    "(deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))";

#[cfg(test)]
#[path = "collaboration_metrics_mysql_tests.rs"]
mod mysql_tests;

#[path = "collaboration_metrics_v2/mod.rs"]
mod v2;

#[derive(Debug, FromMysqlRow)]
struct Issue {
    id: String,
    status: String,
    created_at: NaiveDateTime,
    completed_at: Option<NaiveDateTime>,
    metadata: Json<Value>,
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

fn completion_event(issue: &Issue) -> Option<&Value> {
    history(issue)
        .iter()
        .rev()
        .find(|event| event["to_status"] == "completed")
}

fn completion_time(issue: &Issue) -> Option<NaiveDateTime> {
    completion_event(issue)
        .and_then(|event| timestamp(&event["at"]))
        .filter(|time| valid_time(*time))
        .or_else(|| issue.completed_at.filter(|time| valid_time(*time)))
}

fn completed_in_window(issue: &Issue, as_of: NaiveDateTime) -> bool {
    issue.status == "completed"
        && completion_time(issue)
            .is_some_and(|time| time >= as_of - Duration::days(7) && time < as_of)
}

fn issue_start(issue: &Issue) -> NaiveDateTime {
    history(issue)
        .iter()
        .filter(|event| event["to_status"] == "in_progress")
        .filter_map(|event| timestamp(&event["at"]))
        .min()
        .unwrap_or(issue.created_at)
}

fn candidate_window(as_of: NaiveDateTime) -> (NaiveDateTime, NaiveDateTime) {
    // DATETIME(0) rounds fractional seconds. Exact event times decide membership.
    (
        as_of - Duration::days(7) - Duration::seconds(1),
        as_of + Duration::seconds(1),
    )
}

fn metric_cohort(visibility: &str) -> String {
    format!(
        "cloud_project_id=? AND resource_type='task' AND (parent_id IS NULL OR parent_id='') AND {LIVE} {visibility} \
         AND (status IN ('in_progress','in_review') OR (status='completed' AND \
         ((completed_at >= ? AND completed_at < ?) OR completed_at IS NULL OR completed_at <= '1970-01-01 00:00:01')))"
    )
}

async fn load_issues_on(
    query: &mut impl PluginQuery,
    project_id: &str,
    visibility: &str,
    as_of: NaiveDateTime,
) -> Result<Vec<Issue>, brz_mysql::MysqlError> {
    let (start, end) = candidate_window(as_of);
    let cohort = metric_cohort(visibility);
    query.fetch_all(format!(
        "SELECT id,status,created_at,completed_at,COALESCE(metadata,JSON_OBJECT()) AS metadata FROM loop_items \
         WHERE {cohort}"
    ), (project_id, start, end)).await
}

#[cfg(test)]
async fn load_issues(
    mut mysql: &MysqlService,
    project: &str,
    visibility: &str,
    as_of: NaiveDateTime,
) -> Result<Vec<Issue>, brz_mysql::MysqlError> {
    load_issues_on(&mut mysql, project, visibility, as_of).await
}

struct ProjectData {
    id: String,
    issues: Vec<Issue>,
    facts: Vec<v2::Evidence>,
    unavailable: Vec<v2::Evidence>,
    members: BTreeSet<i32>,
}

async fn project_data_on(
    query: &mut impl PluginQuery,
    project_id: i64,
    user_id: i32,
    window: v2::Window,
) -> Result<ProjectData, FastApiError> {
    let access =
        super::collaboration_access::authorized_projects_on(query, user_id, Some(project_id), None)
            .await
            .map_err(internal)?
            .into_iter()
            .next()
            .ok_or_else(|| {
                FastApiError::detail(StatusCode::NOT_FOUND, "Cloud project not found")
            })?;
    if access.priority > 4 {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }
    let metadata = access
        .project
        .metadata
        .as_ref()
        .and_then(|m| m.0.value.as_ref());
    if metadata
        .and_then(|m| m.task_provider.as_deref())
        .unwrap_or("local")
        != "local"
    {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Metrics require authoritative project Issue history",
        ));
    }
    let members = super::members::list_project_members_on(
        query,
        project_id,
        Some(super::parse_project_id(&access.workspace.id)?),
        metadata.map_or("inherit", |m| m.membership_mode()),
        &metadata
            .map(|m| m.member_capabilities())
            .unwrap_or_default(),
        user_id,
    )
    .await
    .map_err(internal)?
    .into_iter()
    .map(|member| member.user_id)
    .collect();
    let visibility = if access.priority <= 1 {
        String::new()
    } else {
        visible_item_filter_sql(
            user_id,
            metadata
                .and_then(|m| m.default_issue_security.as_deref())
                .filter(|value| matches!(*value, "open" | "related"))
                .unwrap_or("open"),
        )
    };
    let id = project_id.to_string();
    let mut issues = load_issues_on(query, &id, &visibility, window.as_of.naive_utc())
        .await
        .map_err(internal)?;
    for issue in &mut issues {
        issue.created_at = crate::socketio::project_chat_messages::utc_timestamp(issue.created_at);
    }
    let facts = v2::repository::load(query, &id, &visibility, window).await?;
    Ok(ProjectData {
        id,
        issues,
        facts: facts.records,
        unavailable: facts.unavailable,
        members,
    })
}

fn snapshot_options() -> MysqlTransactionOptions {
    MysqlTransactionOptions::default().with_isolation_level(MysqlIsolationLevel::RepeatableRead)
}

fn internal(error: impl std::fmt::Display) -> FastApiError {
    tracing::error!(%error,"Collaboration metrics read failed");
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
    let window = v2::Window { as_of: Utc::now() };
    let id = super::parse_project_id(project_id)?;
    let data = state
        .mysql
        .with_transaction_options(snapshot_options(), async |mut tx| {
            Ok(project_data_on(&mut tx, id, user.id, window).await)
        })
        .await
        .map_err(internal)??;
    let mut response = v2::aggregate(&data.issues, &data.facts, &data.members, window, None);
    v2::mark_unavailable(&mut response, &data.unavailable, None);
    response["project_id"] = json!(data.id);
    Ok(response)
}

#[brz_http_server::get("/api/v1/collaboration-metrics/me")]
async fn read_personal_metrics(
    #[inject(state)] state: &AppState,
    #[auth] user: FlexibleUser,
) -> Result<Value, FastApiError> {
    let window = v2::Window { as_of: Utc::now() };
    state
        .mysql
        .with_transaction_options(snapshot_options(), async |mut tx| {
            Ok(personal_metrics_on(&mut tx, user.id, window).await)
        })
        .await
        .map_err(internal)?
}

async fn personal_metrics_on(
    query: &mut impl PluginQuery,
    user_id: i32,
    window: v2::Window,
) -> Result<Value, FastApiError> {
    let projects = super::collaboration_access::authorized_projects_on(query, user_id, None, None)
        .await
        .map_err(internal)?;
    let mut issues = Vec::new();
    let mut facts = Vec::new();
    let mut unavailable = Vec::new();
    let mut breakdown = Vec::new();
    for project in projects {
        let local = project
            .project
            .metadata
            .as_ref()
            .and_then(|m| m.0.value.as_ref())
            .and_then(|m| m.task_provider.as_deref())
            .unwrap_or("local")
            == "local";
        if !local {
            continue;
        }
        let data = project_data_on(
            query,
            super::parse_project_id(&project.project.id)?,
            user_id,
            window,
        )
        .await?;
        let metrics = v2::aggregate(
            &data.issues,
            &data.facts,
            &data.members,
            window,
            Some(user_id),
        );
        breakdown
            .push(json!({"project_id":data.id,"completed":metrics["completion"]["completed"]}));
        issues.extend(data.issues);
        facts.extend(data.facts);
        unavailable.extend(data.unavailable);
    }
    let mut response = v2::aggregate(
        &issues,
        &facts,
        &BTreeSet::from([user_id]),
        window,
        Some(user_id),
    );
    v2::mark_unavailable(&mut response, &unavailable, Some(user_id));
    response["user_id"] = json!(user_id);
    response["projects"] = json!(breakdown);
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn at(hour: i64) -> NaiveDateTime {
        DateTime::from_timestamp(1_800_000_000 + hour * 3600, 0)
            .unwrap()
            .naive_utc()
    }
    #[test]
    fn query_window_never_includes_the_database_candidate_margin() {
        let now = Utc::now();
        let result = v2::Window { as_of: now }.view();
        assert_eq!(
            timestamp(&result["end"]).unwrap() - timestamp(&result["start"]).unwrap(),
            Duration::days(7)
        );
        let (left, right) = candidate_window(now.naive_utc());
        assert_eq!(right - left, Duration::days(7) + Duration::seconds(2));
    }
    #[test]
    fn offsets_are_normalized() {
        assert_eq!(
            timestamp(&json!("2026-11-17T08:00:00+08:00")),
            timestamp(&json!("2026-11-17T00:00:00"))
        );
    }
}
