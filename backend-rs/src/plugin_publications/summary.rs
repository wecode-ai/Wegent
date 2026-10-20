// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The shared `_summary` projection of one `plugin_publication_requests` row.
//!
//! Source: `PluginPublicationService._summary`
//! (`app/services/plugin_publication_service.py:2100`). Both route variants
//! (`admin` and submitter) project identical response bodies from the same
//! row lookups: `db.get(Plugin, source_plugin_id)`, `_current_revision`,
//! `db.get(User, submitter_user_id)`, and the revision's `_checks`.

use chrono::NaiveDateTime;
use serde::Serialize;

use brz_mysql::{Mysql, MysqlResult};

use super::sql::{CheckRow, PluginRow, RequestRow, RevisionRow, UserRow};
use super::{ADMIN_REVIEW_STATUSES, CODE_REVIEW_STATUSES, TERMINAL_PUBLICATION_STATUSES};

/// `_summary`: plugin, current revision, submitter, and checks for one request.
pub(super) async fn summary<M: Mysql>(
    mysql: &M,
    request: &RequestRow,
    now: NaiveDateTime,
) -> MysqlResult<PluginPublicationRequestSummary> {
    let plugin = super::sql::get_plugin(mysql, request.source_plugin_id).await?;
    let revision =
        super::sql::current_revision(mysql, request.id, request.current_revision_id).await?;
    let submitter = super::sql::get_user(mysql, request.submitter_user_id).await?;
    let checks = match &revision {
        Some(revision) => super::sql::checks_for_revision(mysql, revision.id).await?,
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
pub(super) fn summary_from(
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
    value == super::EPOCH_TIME
}

/// `_waiting_duration_seconds`: seconds since `submitted_at`, using
/// `updated_at` for a terminal status and the current UTC time otherwise.
///
/// `waitingDurationSeconds` is derived from the request-time UTC clock, not a
/// stored column: for a non-terminal status it grows by the elapsed time
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
pub(super) struct PluginPublicationSubmitter {
    id: i64,
    #[serde(rename = "userName")]
    user_name: String,
    email: Option<String>,
}

/// `PluginPublicationRequestSummary`, in pydantic declaration order.
#[derive(Debug, Serialize)]
pub(super) struct PluginPublicationRequestSummary {
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
pub(super) struct ListResponse {
    pub(super) items: Vec<PluginPublicationRequestSummary>,
    pub(super) total: i64,
    pub(super) page: i64,
    pub(super) limit: i64,
}
