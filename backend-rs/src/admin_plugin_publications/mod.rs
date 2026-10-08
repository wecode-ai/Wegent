// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/plugins/publication-requests` implementation.
//!
//! Source: `app/api/endpoints/admin/plugin_publications.py`
//! (`list_plugin_publication_requests`) -> `PluginPublicationService.list_requests`
//! -> `PluginPublicationService._summary`. The router prefix
//! `/plugins/publication-requests` is mounted under `/api/admin`.
//!
//! Request order matches the source: the session principal
//! (`get_current_user`) is resolved first, then the `get_admin_user` role
//! check, then FastAPI query validation. A non-admin session is rejected with
//! `403 {"detail": "Permission denied. Admin access required."}`.
//!
//! For the recorded case the query runs `count(*)`, the ordered page, and then
//! per row `plugins`, the current revision, the submitter, and the revision
//! checks; `_summary` projects the response fields from those rows.

mod query;
mod sql;

use chrono::NaiveDateTime;
use serde::Serialize;

use brz_mysql::{Mysql, MysqlResult};

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

use query::ListParams;
pub use query::ListQuery;
use sql::{CheckRow, Filters, PluginRow, RequestRow, RevisionRow, UserRow};

/// Source `EPOCH_TIME` (`app/models/plugin_marketplace.py`).
const EPOCH_TIME: NaiveDateTime = NaiveDateTime::new(
    chrono::NaiveDate::from_ymd_opt(1970, 1, 1).expect("valid epoch date"),
    chrono::NaiveTime::from_hms_opt(0, 0, 0).expect("valid epoch time"),
);

/// `get_admin_user` rejection detail (`app/core/security.py`).
const ADMIN_REQUIRED_DETAIL: &str = "Permission denied. Admin access required.";

/// Source `TERMINAL_PUBLICATION_STATUSES`.
const TERMINAL_PUBLICATION_STATUSES: [&str; 3] = ["published", "withdrawn", "closed"];
/// Source `ADMIN_REVIEW_STATUSES`.
const ADMIN_REVIEW_STATUSES: [&str; 2] = ["awaiting_admin", "admin_review"];
/// Source `CODE_REVIEW_STATUSES`.
const CODE_REVIEW_STATUSES: [&str; 7] = [
    "admin_accepted",
    "materializing",
    "draft_mr_open",
    "ci_running",
    "code_changes_requested",
    "merge_ready",
    "merged",
];

/// GET /api/admin/plugins/publication-requests: the list free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/admin/plugins/publication-requests")]
async fn list_plugin_publication_requests(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    query: brz_http_server::Query<ListQuery>,
) -> Result<ListResponse, FastApiError> {
    list_requests(state, &user, &query).await
}

/// Handler body for `GET /api/admin/plugins/publication-requests`.
async fn list_requests(
    state: &AppState,
    user: &SessionUser,
    query: &ListQuery,
) -> Result<ListResponse, FastApiError> {
    require_admin(&user.role)?;
    let params = query.validated()?;
    match list(&state.mysql, &params).await {
        Ok(response) => Ok(response),
        Err(error) => {
            tracing::error!(%error, "admin plugin publication list failed");
            Err(FastApiError::internal())
        }
    }
}

/// `get_admin_user`: the session principal must carry the `admin` role.
fn require_admin(role: &str) -> Result<(), FastApiError> {
    if role == "admin" {
        Ok(())
    } else {
        Err(FastApiError::forbidden(ADMIN_REQUIRED_DETAIL))
    }
}

/// `list_requests`: count, page, then project each row through `_summary`.
async fn list<M: Mysql>(mysql: &M, params: &ListParams) -> MysqlResult<ListResponse> {
    let filters = resolve_filters(mysql, params).await?;
    let total = sql::count_requests(mysql, params, &filters).await?;
    let rows = sql::select_requests(mysql, params, &filters).await?;
    let mut items = Vec::with_capacity(rows.len());
    let now = chrono::Utc::now().naive_utc();
    for row in &rows {
        items.push(summary(mysql, row, now).await?);
    }
    Ok(ListResponse {
        items,
        total,
        page: params.page,
        limit: params.limit,
    })
}

/// Resolve the `submitter` and `query` text filters into id lists, in the
/// source order (`users` lookup, then `plugins` lookup).
async fn resolve_filters<M: Mysql>(mysql: &M, params: &ListParams) -> MysqlResult<Filters> {
    let submitter_ids = match &params.submitter {
        Some(value) => Some(sql::user_ids_like(mysql, &like_pattern(value)).await?),
        None => None,
    };
    let plugin_ids = match &params.query {
        Some(value) => Some(sql::plugin_ids_like(mysql, &like_pattern(value)).await?),
        None => None,
    };
    Ok(Filters {
        submitter_ids,
        plugin_ids,
    })
}

/// `f"%{value.strip()}%"`.
fn like_pattern(value: &str) -> String {
    format!("%{}%", value.trim())
}

/// `_summary`: plugin, current revision, submitter, and checks for one request.
async fn summary<M: Mysql>(
    mysql: &M,
    request: &RequestRow,
    now: NaiveDateTime,
) -> MysqlResult<PluginPublicationRequestSummary> {
    let plugin = sql::get_plugin(mysql, request.source_plugin_id).await?;
    let revision = sql::current_revision(mysql, request.id, request.current_revision_id).await?;
    let submitter = sql::get_user(mysql, request.submitter_user_id).await?;
    let checks = match &revision {
        Some(revision) => sql::checks_for_revision(mysql, revision.id).await?,
        None => Vec::new(),
    };
    Ok(summary_from(
        request,
        plugin.as_ref(),
        revision.as_ref(),
        submitter.as_ref(),
        &checks,
        now,
    ))
}

/// Build one `PluginPublicationRequestSummary` (pure projection).
fn summary_from(
    request: &RequestRow,
    plugin: Option<&PluginRow>,
    revision: Option<&RevisionRow>,
    submitter: Option<&UserRow>,
    checks: &[CheckRow],
    now: NaiveDateTime,
) -> PluginPublicationRequestSummary {
    let submitted_at = if unset_datetime(request.submitted_at) {
        request.created_at
    } else {
        request.submitted_at
    };
    let blocker_count = checks
        .iter()
        .filter(|check| {
            check.severity == "blocker" && (check.status == "blocked" || check.status == "failed")
        })
        .count() as i64;
    let warning_count = checks
        .iter()
        .filter(|check| check.status == "warning")
        .count() as i64;
    PluginPublicationRequestSummary {
        id: request.id,
        plugin_id: request.source_plugin_id,
        plugin_name: plugin
            .map(|plugin| {
                if plugin.display_name.is_empty() {
                    plugin.name.clone()
                } else {
                    plugin.display_name.clone()
                }
            })
            .unwrap_or_default(),
        plugin_slug: plugin.map(|plugin| plugin.slug.clone()).unwrap_or_default(),
        requested_version: revision
            .map(|revision| revision.requested_version.clone())
            .unwrap_or_default(),
        submitter: PluginPublicationSubmitter {
            id: request.submitter_user_id,
            user_name: submitter
                .map(|user| user.user_name.clone())
                .unwrap_or_default(),
            email: submitter.and_then(|user| user.email.clone()),
        },
        current_revision: request.current_revision,
        stage: stage(&request.aggregate_status).to_string(),
        status: request.aggregate_status.clone(),
        risk_level: request.risk_level.clone(),
        blocker_count,
        warning_count,
        gitlab_status: revision.and_then(gitlab_status),
        waiting_duration_seconds: waiting_duration_seconds(request, submitted_at, now),
        submitted_at: iso_datetime(submitted_at),
        updated_at: iso_datetime(request.updated_at),
    }
}

/// Source `unset_datetime(value) is None`: the 1970-01-01 sentinel maps to unset.
fn unset_datetime(value: NaiveDateTime) -> bool {
    value == EPOCH_TIME
}

/// `_waiting_duration_seconds`: seconds since `submitted_at`, using
/// `updated_at` for a terminal status and the current UTC time otherwise.
///
/// `waitingDurationSeconds` is derived from the request-time UTC clock, not a
/// stored column: for the `awaiting_admin` status it grows by the elapsed time
/// between two replays of the same recording. It is therefore not reproducible
/// from stored state and is covered by a response `duration` rule (unit
/// seconds) on `/items/*/waitingDurationSeconds` at replay time; no stored
/// field or target-side workaround should be used to pin it.
fn waiting_duration_seconds(
    request: &RequestRow,
    submitted_at: NaiveDateTime,
    now: NaiveDateTime,
) -> i64 {
    let end = if TERMINAL_PUBLICATION_STATUSES.contains(&request.aggregate_status.as_str()) {
        request.updated_at
    } else {
        now
    };
    (end - submitted_at).num_seconds().max(0)
}

/// `_stage`.
fn stage(status: &str) -> &'static str {
    match status {
        "uploading" | "submitted" => "submit_request",
        "automatic_checking" | "automatic_check_failed" => "automated_checks",
        "changes_requested" | "admin_accepted" => "administrator_review",
        _ if ADMIN_REVIEW_STATUSES.contains(&status) => "administrator_review",
        _ if CODE_REVIEW_STATUSES.contains(&status) => "code_review",
        _ => "release",
    }
}

/// `_gitlab_status`.
fn gitlab_status(revision: &RevisionRow) -> Option<String> {
    if revision.merge_request_status == "merged" || revision.merge_request_status == "closed" {
        return Some(revision.merge_request_status.clone());
    }
    non_empty(&revision.pipeline_status).or_else(|| non_empty(&revision.merge_request_status))
}

/// `value or None` for a stored empty string.
fn non_empty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_string())
}

/// Pydantic's naive-datetime rendering: microseconds only when nonzero.
fn iso_datetime(value: NaiveDateTime) -> String {
    let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
    let micros = value.and_utc().timestamp_subsec_micros();
    if micros == 0 {
        base
    } else {
        format!("{base}.{micros:06}")
    }
}

/// `PluginPublicationSubmitter` (`app/schemas/plugin_publication.py`).
#[derive(Debug, Serialize)]
struct PluginPublicationSubmitter {
    id: i64,
    #[serde(rename = "userName")]
    user_name: String,
    email: Option<String>,
}

/// `PluginPublicationRequestSummary`, in pydantic declaration order.
#[derive(Debug, Serialize)]
struct PluginPublicationRequestSummary {
    id: i64,
    #[serde(rename = "pluginId")]
    plugin_id: i64,
    #[serde(rename = "pluginName")]
    plugin_name: String,
    #[serde(rename = "pluginSlug")]
    plugin_slug: String,
    #[serde(rename = "requestedVersion")]
    requested_version: String,
    submitter: PluginPublicationSubmitter,
    #[serde(rename = "currentRevision")]
    current_revision: i64,
    stage: String,
    status: String,
    #[serde(rename = "riskLevel")]
    risk_level: String,
    #[serde(rename = "blockerCount")]
    blocker_count: i64,
    #[serde(rename = "warningCount")]
    warning_count: i64,
    #[serde(rename = "gitlabStatus")]
    gitlab_status: Option<String>,
    #[serde(rename = "waitingDurationSeconds")]
    waiting_duration_seconds: i64,
    #[serde(rename = "submittedAt")]
    submitted_at: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

/// `PluginPublicationRequestListResponse`.
#[derive(Debug, Serialize)]
struct ListResponse {
    items: Vec<PluginPublicationRequestSummary>,
    total: i64,
    page: i64,
    limit: i64,
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
