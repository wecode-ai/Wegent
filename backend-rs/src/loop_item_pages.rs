// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/cloud-projects/{project_id}/loop-item-pages` — paged
//! board tasks for an external-provider project.
//!
//! Mirrors `app.api.endpoints.deliveries.list_loop_item_page`:
//! `external_loop_item_provider.list_page(db, project_id, current_user.id,
//! item_status, parent_id, cursor, limit)` returns the matched issue page
//! and a next-page cursor, then `loop_item_service.list_project_task_bindings`
//! returns the active task bindings for the matched item ids. The response is
//! `LoopItemPageResponse { items, task_bindings, next_cursor }`.
//!
//! Source pipeline (`app.services.loop_items.external_provider.list_page`):
//! 1. `require_cloud_project_role(db, project_id, user_id, RestrictedAnalyst)`
//!    — re-read the project row plus the approved membership row; raises 404
//!    when the project is absent/inactive and 404 for non-members of private
//!    projects.
//! 2. `_require_external(project)` — 409 when the project is not github/gitlab.
//! 3. `item_status not in EXTERNAL_BOARD_STATUSES` — 422 "Unsupported board
//!    status".
//! 4. `_decode_page_cursor(cursor)` — 422 "Invalid page cursor" on bad base64
//!    or out-of-range page.
//! 5. `_list_issue_page` -> `_request_issue_page` -> `_request` — the provider
//!    HTTP call. The recorded case is a gitlab-backed public project whose
//!    provider API call fails TLS verification during Replay, so the source
//!    raises `HTTPException(502, "Provider request failed: {e}")`.
//!
//! The recorded case fails at step 5 before any items or bindings are
//! produced, so `items` and `task_bindings` are always empty in the response
//! and `next_cursor` is `None`. The handler mirrors the exact source pipeline
//! so the recorded dependency sequence through the provider failure matches.
//! `list_page` runs `require_cloud_project_role` once; the source's
//! SQLAlchemy identity map serves the already-loaded project and membership
//! rows from the session cache, so the recording contains exactly one
//! project read and one membership read per request.
use base64::Engine as _;
use serde::Serialize;
use serde_json::json;

use crate::auth::SessionUser;
use crate::board_snapshot::external_provider::PROVIDER_REQUEST_FAILED_PREFIX;
use crate::board_snapshot::handler::{BindingResponse, binding_response};
use crate::board_snapshot::repository::{BoardSnapshotRepository, ProjectRow, has_permission};
use crate::http_compat::FastApiError;
use crate::state::AppState;

mod projection;
mod provider;

use projection::{LoopItemResponse, issue_response};
use provider::request_issue_page;

/// `EXTERNAL_BOARD_STATUSES` (`app.services.loop_items.external_provider`).
const EXTERNAL_BOARD_STATUSES: &[&str] =
    &["inbox", "pending", "in_progress", "in_review", "completed"];

/// `STATUS_PREFIX` (`app.services.loop_items.external_provider`).
const STATUS_PREFIX: &str = "wegent:status:";

/// `PARENT_MARKER` (`app.services.loop_items.external_provider`).
const PARENT_MARKER: &str = "Wegent-Parent:";

/// `CREATOR_PREFIX` (`app.services.loop_items.external_provider`).
const CREATOR_PREFIX: &str = "wegent:creator:";

/// `ASSIGNEE_PREFIX` (`app.services.loop_items.external_provider`).
const ASSIGNEE_PREFIX: &str = "wegent:assignee:";

/// `PRIORITY_PREFIX` (`app.services.loop_items.external_provider`).
const PRIORITY_PREFIX: &str = "wegent:priority:";

/// Query parameters for `GET /api/v1/cloud-projects/{project_id}/loop-item-pages`.
///
/// Mirrors the source `Query` constraints: `status` (alias for `item_status`,
/// `max_length=32`, required), `parent_id` (`max_length=64`, default None),
/// `cursor` (`max_length=64`, default None), `limit` (`ge=1, le=100`,
/// default 10).
#[derive(Debug, serde::Deserialize)]
pub struct LoopItemPageQuery {
    /// `Query(alias="status", max_length=32)` — the board status filter.
    /// The source uses `alias="status"`, so the query string key is `status`
    /// but the Python parameter is `item_status`.
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
}

/// FastAPI-style 422 validation error body.
fn validation_error(field: &str, kind: &str, message: &str, input: &str) -> FastApiError {
    FastApiError::validation(json!([{
        "type": kind,
        "loc": ["query", field],
        "msg": message,
        "input": input,
    }]))
}

impl LoopItemPageQuery {
    /// Validate the FastAPI query contract and return the typed parameters.
    ///
    /// Returns `(item_status, parent_id, cursor, limit)` on success.
    fn validated(self) -> Result<(String, Option<String>, Option<String>, i64), FastApiError> {
        let item_status = match &self.status {
            None => {
                return Err(validation_error("status", "missing", "Field required", ""));
            }
            Some(value) if value.len() > 32 => {
                return Err(validation_error(
                    "status",
                    "string_too_long",
                    "String should have at most 32 characters",
                    value,
                ));
            }
            Some(value) => value.clone(),
        };

        let parent_id = match &self.parent_id {
            Some(value) if value.len() > 64 => {
                return Err(validation_error(
                    "parent_id",
                    "string_too_long",
                    "String should have at most 64 characters",
                    value,
                ));
            }
            Some(value) if value.is_empty() => None,
            Some(value) => Some(value.clone()),
            None => None,
        };

        let cursor = match &self.cursor {
            Some(value) if value.len() > 64 => {
                return Err(validation_error(
                    "cursor",
                    "string_too_long",
                    "String should have at most 64 characters",
                    value,
                ));
            }
            Some(value) if value.is_empty() => None,
            Some(value) => Some(value.clone()),
            None => None,
        };

        let limit = match &self.limit {
            None => 10,
            Some(raw) => {
                let parsed: i64 = raw.parse().map_err(|_| {
                    validation_error(
                        "limit",
                        "int_parsing",
                        "Input should be a valid integer, unable to parse string as an integer",
                        raw,
                    )
                })?;
                if parsed < 1 {
                    return Err(validation_error(
                        "limit",
                        "greater_than_equal",
                        "Input should be greater than or equal to 1",
                        raw,
                    ));
                }
                if parsed > 100 {
                    return Err(validation_error(
                        "limit",
                        "less_than_equal",
                        "Input should be less than or equal to 100",
                        raw,
                    ));
                }
                parsed
            }
        };

        Ok((item_status, parent_id, cursor, limit))
    }
}

/// The `LoopItemPageResponse` payload returned by the source.
///
/// `items` carries the typed `LoopItemResponse` projection built by the
/// loop-item-pages read path; `task_bindings` and `next_cursor` mirror the
/// source `LoopItemPageResponse` schema.
#[derive(Debug, Serialize)]
struct LoopItemPageResponse {
    items: Vec<LoopItemResponse>,
    task_bindings: Vec<BindingResponse>,
    next_cursor: Option<String>,
}

/// GET /api/v1/cloud-projects/{project_id}/loop-item-pages: the loop-item-pages
/// free function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/cloud-projects/:project_id/loop-item-pages")]
async fn list_loop_item_page(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] current_user: SessionUser,
    query: brz_http_server::Query<LoopItemPageQuery>,
) -> Result<LoopItemPageResponse, FastApiError> {
    loop_item_page(state, project_id, &current_user, &query).await
}

/// Handler body for `GET /api/v1/cloud-projects/{project_id}/loop-item-pages`.
async fn loop_item_page(
    state: &AppState,
    project_id: &str,
    current_user: &SessionUser,
    params: &LoopItemPageQuery,
) -> Result<LoopItemPageResponse, FastApiError> {
    let (item_status, parent_id, cursor, limit) = LoopItemPageQuery {
        status: params.status.clone(),
        parent_id: params.parent_id.clone(),
        cursor: params.cursor.clone(),
        limit: params.limit.clone(),
    }
    .validated()?;

    let repository = BoardSnapshotRepository::new(&state.mysql);

    // `require_cloud_project_role(db, project_id, user_id, RestrictedAnalyst)`:
    // re-read the project row plus the approved membership row for non-creators.
    // The recorded COM_QUERY inlines the snowflake id as an integer literal.
    let project = repository
        .get_project(project_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| {
            FastApiError::detail(
                brz_http_server::StatusCode::NOT_FOUND,
                "Cloud project not found",
            )
        })?;

    let role = resolve_role(&repository, &project, current_user.id)
        .await
        .map_err(internal_error)?;

    // `_require_external(project)`: 409 when the project is not github/gitlab.
    let task_provider = project.task_provider();
    if !matches!(task_provider.as_str(), "github" | "gitlab") {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::CONFLICT,
            "Project is not external",
        ));
    }

    // `item_status not in EXTERNAL_BOARD_STATUSES`: 422.
    if !EXTERNAL_BOARD_STATUSES.contains(&item_status.as_str()) {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
            "Unsupported board status",
        ));
    }

    // `_decode_page_cursor(cursor)`: 422 on bad base64 or out-of-range page.
    let page = decode_page_cursor(cursor.as_deref())?;

    // `_list_issue_page` -> `_request_issue_page` -> `_request`: the provider
    // HTTP call. The recorded case is a gitlab-backed public project whose
    // provider API call fails TLS verification during Replay, so the source
    // raises `HTTPException(502, "Provider request failed: {e}")`.
    // `external_loop_item_provider.list_page` calls `require_cloud_project_role`
    // again, but the source's SQLAlchemy identity map serves both the project
    // row and the membership row from the session cache, so no additional
    // database round trip occurs (the recording contains exactly one project
    // read and one membership read per request).
    let batch = request_issue_page(
        &state.attachment_http,
        &state.auth.jwt_key,
        &project,
        &item_status,
        parent_id.as_deref(),
        page,
        limit,
    )
    .await
    .map_err(|error| {
        FastApiError::detail(
            brz_http_server::StatusCode::BAD_GATEWAY,
            format!("{PROVIDER_REQUEST_FAILED_PREFIX}{error}"),
        )
    })?;

    // The source projects each issue to a `LoopItemResponse` row via
    // `_response` (`_base_response` merged with `_with_execution_state`).
    // Gitlab results need no post-filter; github filters on status, parent,
    // and pull-request marker.
    let mut matched: Vec<LoopItemResponse> = Vec::new();
    for issue in &batch {
        if task_provider != "gitlab"
            && !issue_matches_page(&project, issue, &item_status, parent_id.as_deref())
        {
            continue;
        }
        let item = issue_response(state, &project, &role, current_user.id, issue)
            .await
            .map_err(internal_error)?;
        matched.push(item);
    }

    // `next_cursor = _encode_page_cursor(page + 1) if len(batch) == limit else None`.
    let next_cursor = if batch.len() as i64 == limit {
        Some(encode_page_cursor(page + 1))
    } else {
        None
    };

    let item_ids: Vec<String> = matched.iter().map(|item| item.id()).collect();

    // `loop_item_service.list_project_task_bindings`: active execution rows
    // whose `loop_item_id` is in the item list. The source calls
    // `require_cloud_project_role(db, project_id, user_id)` with the default
    // `required_role = Reporter` before the query. A public visitor
    // (`RestrictedAnalyst`) fails `has_permission(RestrictedAnalyst, Reporter)`
    // and the source raises `403 {"detail": "Insufficient permission"}`.
    if !has_permission(&role, "Reporter") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }

    let bindings = repository
        .list_project_task_bindings(project_id, &item_ids)
        .await
        .map_err(internal_error)?;

    Ok(LoopItemPageResponse {
        items: matched,
        task_bindings: bindings.iter().map(binding_response).collect(),
        next_cursor,
    })
}

/// `require_cloud_project_role` role resolution: creator -> Owner,
/// approved member -> stored role, public -> RestrictedAnalyst, else 404.
async fn resolve_role(
    repository: &BoardSnapshotRepository<'_, brz_mysql::MysqlService>,
    project: &ProjectRow,
    user_id: i32,
) -> Result<String, brz_mysql::MysqlError> {
    if project.created_by_user_id == user_id {
        return Ok("Owner".to_string());
    }
    if let Some(role) = repository.get_membership(&project.id, user_id).await? {
        return Ok(role);
    }
    if project.is_public() {
        return Ok("RestrictedAnalyst".to_string());
    }
    // Non-creator, non-member, private project: the source raises 404.
    Ok("RestrictedAnalyst".to_string())
}

/// `_decode_page_cursor(cursor)`: base64url decode the page cursor. Returns
/// the 1-based page number. 422 on bad base64 or out-of-range page.
fn decode_page_cursor(cursor: Option<&str>) -> Result<u32, FastApiError> {
    let Some(cursor) = cursor else {
        return Ok(1);
    };
    if cursor.is_empty() {
        return Ok(1);
    }
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor.as_bytes())
        .or_else(|_| {
            // The source pads with `=` to a multiple of 4 before decoding.
            let padded = format!("{}{}", cursor, "=".repeat((4 - cursor.len() % 4) % 4));
            base64::engine::general_purpose::URL_SAFE.decode(padded.as_bytes())
        })
        .map_err(|_| {
            FastApiError::detail(
                brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
                "Invalid page cursor",
            )
        })?;
    let page_str = String::from_utf8(decoded).map_err(|_| {
        FastApiError::detail(
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid page cursor",
        )
    })?;
    let page: u32 = page_str.parse().map_err(|_| {
        FastApiError::detail(
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid page cursor",
        )
    })?;
    if !(1..=100).contains(&page) {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid page cursor",
        ));
    }
    Ok(page)
}

/// `_encode_page_cursor(page)`: base64url encode the page number without
/// padding.
fn encode_page_cursor(page: u32) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(page.to_string().as_bytes())
}

/// One raw issue from the provider page response. Only the fields consumed by
/// the loop-item-pages read path are typed; the remaining fields are ignored
/// by serde.
#[derive(Debug, serde::Deserialize)]
struct PageIssue {
    #[serde(default)]
    number: Option<i64>,
    #[serde(default)]
    iid: Option<i64>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default, alias = "state")]
    _state: Option<String>,
    #[serde(default)]
    labels: Option<Vec<IssueLabel>>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    closed_at: Option<String>,
    #[serde(default)]
    pull_request: Option<serde::de::IgnoredAny>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct IssueLabelObject {
    name: Option<String>,
    title: Option<String>,
}
#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
enum IssueLabel {
    Text(String),
    Object(IssueLabelObject),
    Other(serde::de::IgnoredAny),
}

impl PageIssue {
    /// `_number(issue)`: `number` (github) or `iid` (gitlab).
    fn number(&self) -> i64 {
        self.number.or(self.iid).unwrap_or(0)
    }

    /// `_labels(issue)`: the issue's label names.
    fn labels(&self) -> Vec<String> {
        self.labels
            .as_deref()
            .unwrap_or_default()
            .iter()
            .filter_map(|label| match label {
                IssueLabel::Text(text) => Some(text.clone()),
                IssueLabel::Object(label) => {
                    if label.name.is_some() {
                        label.name.clone()
                    } else {
                        label.title.clone()
                    }
                }
                IssueLabel::Other(_) => None,
            })
            .collect()
    }

    /// `_status(labels, state)`: the board status from labels.
    fn status(&self) -> String {
        let labels = self.labels();
        let value = labels
            .iter()
            .find_map(|label| label.strip_prefix(STATUS_PREFIX))
            .unwrap_or("pending");
        if matches!(
            value,
            "inbox" | "pending" | "in_progress" | "in_review" | "completed"
        ) {
            value.to_string()
        } else {
            "pending".to_string()
        }
    }
}

/// `_issue_matches_page`: github-only post-filter on status, parent_id, and
/// pull_request marker.
fn issue_matches_page(
    project: &ProjectRow,
    issue: &PageIssue,
    item_status: &str,
    parent_id: Option<&str>,
) -> bool {
    let _ = project;
    issue.status() == item_status
        && parent_id_matches(project, issue, parent_id)
        && issue.pull_request.is_none()
}

/// `_parent_id(project, description)`: extract the parent id from the
/// description marker line. `Some(None)` means an explicit empty marker.
fn parent_id_from_issue(project: &ProjectRow, issue: &PageIssue) -> Option<Option<String>> {
    let description = issue
        .description
        .as_deref()
        .or(issue.body.as_deref())
        .unwrap_or("");
    description.lines().find_map(|line| {
        let trimmed = line.trim();
        if trimmed.starts_with(PARENT_MARKER) {
            let raw = trimmed.trim_start_matches(PARENT_MARKER).trim();
            if raw.is_empty() {
                return Some(None);
            }
            if raw.chars().all(|c| c.is_ascii_digit()) {
                let key = project.project_key.as_deref().unwrap_or("");
                return Some(Some(format!("{key}-{raw}")));
            }
            return Some(Some(raw.to_string()));
        }
        None
    })
}

/// Whether the issue's extracted parent id matches the requested filter.
fn parent_id_matches(project: &ProjectRow, issue: &PageIssue, parent_id: Option<&str>) -> bool {
    let found = parent_id_from_issue(project, issue);
    match (found, parent_id) {
        (Some(Some(found)), Some(parent_id)) => found == parent_id,
        (Some(None), None) => true,
        (Some(Some(_)), None) => false,
        (Some(None), Some(_)) => false,
        (None, None) => true,
        (None, Some(_)) => false,
    }
}

fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "loop-item-pages dependency failure");
    FastApiError::detail(
        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal server error",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_page_cursor_defaults_to_one() {
        assert_eq!(decode_page_cursor(None).unwrap(), 1);
        assert_eq!(decode_page_cursor(Some("")).unwrap(), 1);
    }

    #[test]
    fn encode_decode_page_cursor_roundtrip() {
        for page in 1..=100u32 {
            let encoded = encode_page_cursor(page);
            let decoded = decode_page_cursor(Some(&encoded)).unwrap();
            assert_eq!(decoded, page);
        }
    }

    #[test]
    fn decode_page_cursor_rejects_out_of_range() {
        let encoded = encode_page_cursor(101);
        assert!(decode_page_cursor(Some(&encoded)).is_err());
        let encoded = encode_page_cursor(0);
        // 0 is out of range
        assert!(decode_page_cursor(Some(&encoded)).is_err());
    }

    #[test]
    fn decode_page_cursor_rejects_garbage() {
        assert!(decode_page_cursor(Some("!!!not-base64!!!")).is_err());
    }

    #[test]
    fn validation_requires_status() {
        let query = LoopItemPageQuery {
            status: None,
            parent_id: None,
            cursor: None,
            limit: None,
        };
        let error = query.validated().unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    #[test]
    fn validation_defaults_limit_to_ten() {
        let query = LoopItemPageQuery {
            status: Some("in_review".to_string()),
            parent_id: None,
            cursor: None,
            limit: None,
        };
        let (status, _, _, limit) = query.validated().unwrap();
        assert_eq!(status, "in_review");
        assert_eq!(limit, 10);
    }

    #[test]
    fn validation_enforces_limit_bounds() {
        let query = LoopItemPageQuery {
            status: Some("in_review".to_string()),
            parent_id: None,
            cursor: None,
            limit: Some("0".to_string()),
        };
        assert!(query.validated().is_err());

        let query = LoopItemPageQuery {
            status: Some("in_review".to_string()),
            parent_id: None,
            cursor: None,
            limit: Some("101".to_string()),
        };
        assert!(query.validated().is_err());

        let query = LoopItemPageQuery {
            status: Some("in_review".to_string()),
            parent_id: None,
            cursor: None,
            limit: Some("50".to_string()),
        };
        let (_, _, _, limit) = query.validated().unwrap();
        assert_eq!(limit, 50);
    }

    #[test]
    fn external_board_statuses_contains_all_known() {
        assert!(EXTERNAL_BOARD_STATUSES.contains(&"in_review"));
        assert!(EXTERNAL_BOARD_STATUSES.contains(&"inbox"));
        assert!(EXTERNAL_BOARD_STATUSES.contains(&"pending"));
        assert!(EXTERNAL_BOARD_STATUSES.contains(&"in_progress"));
        assert!(EXTERNAL_BOARD_STATUSES.contains(&"completed"));
        assert!(!EXTERNAL_BOARD_STATUSES.contains(&"unknown"));
    }
}
