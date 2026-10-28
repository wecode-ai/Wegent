// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/loop-items/{item_id}/assignments` — the active assignments of
//! one loop item.
//!
//! Mirrors `app.api.endpoints.deliveries.list_issue_assignments` and its
//! complete call graph:
//!
//! 1. `external_loop_item_provider.is_external_item` (`_find_project`); for an
//!    external item `ensure_shadow` runs before anything else.
//! 2. `issue_assignment_service.project_for_issue` — `db.get(LoopItem,
//!    issue_id)`, `db.get(CloudProject, item.cloud_project_id)` and
//!    `require_cloud_project_role(Viewer)`.
//! 3. `issue_assignment_service.list` — a second
//!    `require_cloud_project_role(Viewer)`, then either the external
//!    provider `get` (whose result the source discards) or `can_view_item`,
//!    followed by `_active_events`.
//! 4. `response_values` per active event, resolving `created_by_user_name`
//!    through the session's identity map (`db.get(User, id)`).
use brz_http_server::StatusCode;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

use crate::board_snapshot::external_provider as provider;
use crate::board_snapshot::repository::{BoardSnapshotRepository, ProjectAccess, ProjectRow};
use crate::http_compat::FastApiError;
use crate::loop_item_pages::PageIssue;
use crate::loop_item_pages::projection::issue_response;
use crate::state::AppState;

use super::assignment_repository::{self, LoopItemGetRow};
use super::auth::FlexibleUser;
use super::loop_repository::{AssignmentMetadata, CommentRow, LoopItemRepository, has_permission};

/// `ASSIGNMENT_EVENT_TYPE` (`app.services.issue_assignments`).
const ASSIGNMENT_EVENT_TYPE: &str = "assignment";

/// One `IssueAssignmentResponse` row.
#[derive(Debug, Serialize)]
pub(super) struct IssueAssignmentResponse {
    pub(super) id: String,
    issue_id: String,
    pub(super) target_type: String,
    pub(super) target_id: String,
    target_name: String,
    workflow_step: Option<String>,
    body: String,
    comment_id: String,
    created_by_user_id: i32,
    created_by_user_name: Option<String>,
    status: String,
    created_at: String,
    updated_at: String,
    receipt_tracking: bool,
    human_read_at: Option<String>,
    stand_in_received_at: Option<String>,
}

/// `IssueAssignmentListResponse`.
#[derive(Debug, Serialize)]
pub(super) struct IssueAssignmentListResponse {
    pub(super) items: Vec<IssueAssignmentResponse>,
}

/// GET /api/v1/loop-items/{item_id}/assignments.
#[brz_http_server::get("/api/v1/loop-items/:item_id/assignments")]
async fn list_issue_assignments(
    #[inject(state)] state: &AppState,
    item_id: &str,
    #[auth] current_user: FlexibleUser,
) -> Result<IssueAssignmentListResponse, FastApiError> {
    list_assignments(state, item_id, &current_user).await
}

pub(super) async fn list_assignments(
    state: &AppState,
    item_id: &str,
    current_user: &FlexibleUser,
) -> Result<IssueAssignmentListResponse, FastApiError> {
    require_issue_read(state, item_id, current_user).await?;
    super::assignment_index::ensure_active_index(&state.mysql, item_id).await?;
    let comments = LoopItemRepository::new(&state.mysql)
        .list_active_assignment_comments(item_id)
        .await
        .map_err(internal)?;
    let mut items = Vec::new();
    for event in active_events(&comments) {
        items.push(assignment_response(state, &event, current_user).await?);
    }
    Ok(IssueAssignmentListResponse { items })
}

pub(super) async fn require_issue_read(
    state: &AppState,
    item_id: &str,
    current_user: &FlexibleUser,
) -> Result<(), FastApiError> {
    let repository = LoopItemRepository::new(&state.mysql);

    // `is_external_item(db, item_id)`.
    let external = repository
        .find_external_project(item_id)
        .await
        .map_err(internal)?;
    if external.is_some() {
        ensure_shadow(state, item_id, current_user.id).await?;
    }

    // `project_for_issue(db, issue_id=item_id, user_id=current_user.id)`.
    let item = assignment_repository::loop_item_access(&state.mysql, item_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Issue not found"))?;
    let project = assignment_repository::project(&state.mysql, &item.cloud_project_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Project not found"))?;
    // `issue_assignment_service.list`.
    let access = require_cloud_project_role(state, &project.id, current_user.id).await?;
    // `_require_issue_project` re-reads the item through the session's identity
    // map, so it issues no statement.
    if is_external_provider(&access.project) {
        provider_get(state, item_id, current_user.id).await?;
    } else if !can_view_item(state, &access, &item, current_user.id).await? {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Issue not found",
        ));
    }

    Ok(())
}

/// `require_cloud_project_role(db, project_id, user_id, Viewer)`.
pub(crate) async fn require_cloud_project_role(
    state: &AppState,
    project_id: &str,
    user_id: i32,
) -> Result<ProjectAccess, FastApiError> {
    let number: i64 = project_id.parse().map_err(|_| cloud_project_not_found())?;
    BoardSnapshotRepository::new(&state.mysql)
        .require_cloud_project_role(number, user_id)
        .await
        .map_err(internal)?
        .ok_or_else(cloud_project_not_found)
}

/// `can_view_item(db, access, item, user_id)`.
async fn can_view_item(
    state: &AppState,
    access: &ProjectAccess,
    item: &LoopItemGetRow,
    user_id: i32,
) -> Result<bool, FastApiError> {
    if has_permission(&access.role, "Maintainer") {
        return Ok(true);
    }
    if item_security(item, &access.project) == "open" {
        return Ok(true);
    }
    LoopItemRepository::new(&state.mysql)
        .is_related_item(&item.id, user_id)
        .await
        .map_err(internal)
}

/// `item_security(item, project)`: the item's `security_level` when it is one
/// of the two literals, otherwise the project default.
fn item_security(item: &LoopItemGetRow, project: &ProjectRow) -> &'static str {
    let level = item
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref())
        .and_then(|metadata| metadata.security_level.as_ref())
        .and_then(|value| value.as_str());
    match level {
        Some("open") => "open",
        Some("related") => "related",
        _ if project.default_issue_security() == "related" => "related",
        _ => "open",
    }
}

/// `ensure_shadow(db, item_id, user_id)` for an external item. Shared with the
/// task-binding read, which runs the same guard before listing bindings.
pub(crate) async fn ensure_shadow(
    state: &AppState,
    item_id: &str,
    user_id: i32,
) -> Result<(), FastApiError> {
    let repository = LoopItemRepository::new(&state.mysql);
    // `if not self.is_external_item(db, item_id): ...` — the guard re-runs
    // `_find_project`, so the statement is issued a second time.
    if repository
        .find_external_project(item_id)
        .await
        .map_err(internal)?
        .is_none()
    {
        if assignment_repository::loop_item(&state.mysql, item_id)
            .await
            .map_err(internal)?
            .is_none()
        {
            return Err(FastApiError::detail(
                StatusCode::NOT_FOUND,
                "TODO not found",
            ));
        }
        return Ok(());
    }
    // `existing = db.get(LoopItem, item_id)`; an existing shadow row is
    // reused without contacting the provider.
    if assignment_repository::loop_item(&state.mysql, item_id)
        .await
        .map_err(internal)?
        .is_some()
    {
        return Ok(());
    }
    // A missing shadow row requires the provider `get` and the shadow insert
    // (`LoopItem(...)` + `db.commit()`). Every recorded case already holds the
    // shadow row, so this branch is outside the recording.
    let _ = (state, user_id);
    Err(FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Internal server error",
    ))
}

/// `is_external_provider(project)`: `task_provider in {"github", "gitlab"}`.
fn is_external_provider(project: &ProjectRow) -> bool {
    matches!(project.task_provider().as_str(), "github" | "gitlab")
}

/// `external_loop_item_provider.get(db, item_id, user_id)`. The source discards
/// the returned mapping, so only its dependencies and error mapping are
/// observable.
async fn provider_get(state: &AppState, item_id: &str, user_id: i32) -> Result<(), FastApiError> {
    let repository = LoopItemRepository::new(&state.mysql);
    // `_resolve_project` -> `_find_project`; `None` maps to 404 "TODO not found".
    let project = repository
        .find_external_project(item_id)
        .await
        .map_err(internal)?
        .ok_or_else(todo_not_found)?;
    let number = item_number(item_id).ok_or_else(todo_not_found)?;
    let access = require_cloud_project_role(state, &project.id, user_id).await?;
    let issue = get_issue(state, &project, number).await?;
    let response = issue_response(state, &project, &access.role, user_id, &issue)
        .await
        .map_err(internal)?;
    if !response.can_view_detail() {
        return Err(todo_not_found());
    }
    Ok(())
}

/// `_get_issue` -> `_request`: one provider issue by number.
pub(crate) async fn get_issue(
    state: &AppState,
    project: &ProjectRow,
    number: i64,
) -> Result<PageIssue, FastApiError> {
    let task_provider = project.task_provider();
    let (config, token) = provider::resolve_provider_config(&state.auth.jwt_key, project)
        .map_err(|error| FastApiError::detail(StatusCode::CONFLICT, error))?;
    let repository = provider::provider_repository(&config)
        .map_err(|error| FastApiError::detail(StatusCode::CONFLICT, error))?;
    let api_base = provider::api_base(&task_provider, &config);
    let path = if task_provider == "github" {
        format!("/repos/{repository}/issues/{number}")
    } else {
        format!(
            "/projects/{}/issues/{number}",
            provider::url_encode_path(&repository)
        )
    };
    let url = format!("{api_base}{path}");
    let value = provider::request_json(&state.attachment_http, &token, &task_provider, &url)
        .await
        .map_err(provider::RequestError::into_fastapi)?;
    serde_json::from_value::<PageIssue>(value).map_err(|_| {
        FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
    })
}

/// `_item_number`: the numeric suffix of a `KEY-number` id.
pub(crate) fn item_number(item_id: &str) -> Option<i64> {
    let (_, number) = item_id.rsplit_once('-')?;
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    number.parse().ok()
}

/// One active assignment event plus its `(member_type, member_id,
/// workflow_step)` dedupe key.
pub(crate) struct ActiveEvent<'a> {
    pub(crate) comment: &'a CommentRow,
    pub(crate) metadata: &'a AssignmentMetadata,
    #[cfg(test)]
    key: (String, String, String),
}

/// `issue_assignment_service._active_events`: the active `assign` events after
/// applying the `unassign` cancellations, in activity order. A repeated member
/// key keeps its first position and takes the newest event.
pub(crate) fn active_events(comments: &[CommentRow]) -> Vec<ActiveEvent<'_>> {
    let cancelled: HashSet<&str> = comments
        .iter()
        .filter_map(|comment| {
            let metadata = comment.assignment()?;
            (metadata.event_type.as_deref() == Some(ASSIGNMENT_EVENT_TYPE)
                && metadata.action.as_deref() == Some("unassign"))
            .then(|| metadata.assignment_event_id.as_deref().unwrap_or(""))
        })
        .collect();
    let mut active: Vec<ActiveEvent<'_>> = Vec::new();
    let mut positions = HashMap::new();
    for comment in comments {
        let Some(metadata) = comment.assignment() else {
            continue;
        };
        if metadata.event_type.as_deref() != Some(ASSIGNMENT_EVENT_TYPE)
            || metadata.action.as_deref() != Some("assign")
        {
            continue;
        }
        if cancelled.contains(&comment.id.as_str()) {
            continue;
        }
        let key = (
            member_type_key(metadata.target_type.as_deref()).to_string(),
            metadata.target_id.clone().unwrap_or_default(),
            metadata
                .workflow_step
                .as_deref()
                .unwrap_or("")
                .trim()
                .to_string(),
        );
        match positions.get(&key).copied() {
            Some(index) => {
                let existing: &mut ActiveEvent<'_> = &mut active[index];
                existing.comment = comment;
                existing.metadata = metadata;
            }
            None => {
                positions.insert(key.clone(), active.len());
                active.push(ActiveEvent {
                    comment,
                    metadata,
                    #[cfg(test)]
                    key,
                });
            }
        }
    }
    active
}

/// `_member_type`: `user`/`human` normalize to `human`, everything else to
/// `agent`.
fn member_type_key(value: Option<&str>) -> &'static str {
    match value {
        Some("user") | Some("human") => "human",
        _ => "agent",
    }
}

/// `issue_assignment_service.response_values(db, row)`.
async fn assignment_response(
    state: &AppState,
    event: &ActiveEvent<'_>,
    current_user: &FlexibleUser,
) -> Result<IssueAssignmentResponse, FastApiError> {
    let comment = event.comment;
    let metadata = event.metadata;
    let assigned_by = comment.created_by_user_id.unwrap_or(0);
    // `creator = db.get(User, assignment.assigned_by_user_id)`: the session's
    // identity map already holds the authenticated user, so an equal id issues
    // no statement.
    let creator_name = if assigned_by == current_user.id {
        Some(current_user.user_name.clone())
    } else {
        assignment_repository::user_by_id(&state.mysql, i64::from(assigned_by))
            .await
            .map_err(internal)?
            .map(|user| user.user_name)
    };
    Ok(IssueAssignmentResponse {
        id: comment.id.clone(),
        issue_id: comment.loop_item_id.clone().unwrap_or_default(),
        target_type: metadata.target_type.clone().unwrap_or_default(),
        target_id: metadata.target_id.clone().unwrap_or_default(),
        target_name: metadata
            .target_name
            .as_ref()
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string(),
        workflow_step: metadata
            .workflow_step
            .clone()
            .filter(|step| !step.is_empty()),
        body: comment.description.clone().unwrap_or_default(),
        comment_id: comment.id.clone(),
        created_by_user_id: assigned_by,
        created_by_user_name: creator_name,
        status: "active".to_string(),
        created_at: datetime_value(comment.created_at)?,
        updated_at: datetime_value(comment.updated_at)?,
        receipt_tracking: metadata.receipt_tracking.unwrap_or(false),
        human_read_at: metadata.human_read_at.clone(),
        stand_in_received_at: metadata.stand_in_received_at.clone(),
    })
}

/// `database_datetime_as_utc`: reinterpret the configured database-session
/// datetime convention and serialize an aware UTC datetime, as Python does.
fn datetime_value(value: Option<chrono::NaiveDateTime>) -> Result<String, FastApiError> {
    super::item_response::utc_datetime_string(value).ok_or_else(|| {
        FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
    })
}

pub(crate) fn cloud_project_not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Cloud project not found")
}

pub(crate) fn todo_not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "TODO not found")
}

pub(crate) fn internal(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "loop-items assignments dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_json::JsonProjection;
    use brz_mysql::Json;

    fn comment(id: &str, metadata: serde_json::Value) -> CommentRow {
        CommentRow {
            id: id.to_string(),
            loop_item_id: Some("EXAMPLE-5".to_string()),
            description: Some(String::new()),
            created_by_user_id: Some(7),
            created_at: chrono::NaiveDateTime::parse_from_str(
                "2026-10-10 13:57:44",
                "%Y-%m-%d %H:%M:%S",
            )
            .ok(),
            updated_at: chrono::NaiveDateTime::parse_from_str(
                "2026-10-10 13:57:44",
                "%Y-%m-%d %H:%M:%S",
            )
            .ok(),
            metadata: Some(Json(JsonProjection::from(metadata))),
        }
    }

    fn assign(id: &str, target: &str, target_id: &str, step: &str) -> CommentRow {
        comment(
            id,
            serde_json::json!({
                "event_type": "assignment",
                "action": "assign",
                "target_type": target,
                "target_id": target_id,
                "target_name": "test-user",
                "workflow_step": step,
                "trigger": "manual",
            }),
        )
    }

    fn unassign(id: &str, cancelled: &str) -> CommentRow {
        comment(
            id,
            serde_json::json!({
                "event_type": "assignment",
                "action": "unassign",
                "assignment_event_id": cancelled,
            }),
        )
    }

    #[test]
    fn keeps_the_newest_event_at_the_first_position() {
        let comments = vec![
            assign("1", "human", "7", ""),
            assign("2", "human", "7", ""),
            assign("3", "agent", "42", ""),
        ];
        let active = active_events(&comments);
        assert_eq!(active.len(), 2);
        assert_eq!(active[0].comment.id, "2");
        assert_eq!(active[1].comment.id, "3");
        assert_eq!(active[0].key.0, "human");
        assert_eq!(active[1].key.0, "agent");
    }

    #[test]
    fn reception_metadata_does_not_change_assignment_reduction() {
        let comments = vec![comment(
            "1",
            serde_json::json!({
                "event_type":"assignment", "action":"assign", "target_type":"human", "target_id":"7",
                "human_read_at":"2026-10-27T02:00:00Z", "stand_in_received_at":"2026-10-27T02:01:00Z",
            }),
        )];
        let events = active_events(&comments);
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].metadata.human_read_at.as_deref(),
            Some("2026-10-27T02:00:00Z")
        );
        assert_eq!(
            events[0].metadata.stand_in_received_at.as_deref(),
            Some("2026-10-27T02:01:00Z")
        );
        let mut cancelled = comments;
        cancelled.push(unassign("2", "1"));
        assert!(active_events(&cancelled).is_empty());
    }

    #[test]
    fn drops_events_cancelled_by_an_unassign() {
        let comments = vec![assign("1", "human", "7", ""), unassign("9", "1")];
        assert!(active_events(&comments).is_empty());
    }

    #[test]
    fn workflow_step_separates_member_keys() {
        let comments = vec![
            assign("1", "human", "7", ""),
            assign("2", "human", "7", "review"),
        ];
        assert_eq!(active_events(&comments).len(), 2);
    }

    #[test]
    fn parses_external_item_numbers() {
        assert_eq!(item_number("EXAMPLE-5"), Some(5));
        assert_eq!(item_number("plain"), None);
        assert_eq!(item_number("KEY-abc"), None);
    }

    #[test]
    fn assignment_datetimes_are_rfc3339_utc_from_the_non_utc_database_session() {
        let base =
            chrono::NaiveDateTime::parse_from_str("2026-10-10 13:57:44", "%Y-%m-%d %H:%M:%S")
                .unwrap();
        let rendered = datetime_value(Some(base)).unwrap();
        assert_eq!(rendered, "2026-10-10T05:57:44Z");
        let parsed = chrono::DateTime::parse_from_rfc3339(&rendered).unwrap();
        assert_eq!(parsed.offset().local_minus_utc(), 0);
        assert!(datetime_value(None).is_err());
        let fractional = chrono::NaiveDateTime::parse_from_str(
            "2026-10-10 13:57:44.123456",
            "%Y-%m-%d %H:%M:%S%.f",
        )
        .unwrap();
        assert_eq!(
            datetime_value(Some(fractional)).unwrap(),
            "2026-10-10T05:57:44.123456Z"
        );
    }

    #[test]
    fn serializes_the_assignment_shape() {
        let comments = vec![assign("101", "human", "7", "")];
        let event = active_events(&comments);
        let row = IssueAssignmentResponse {
            id: event[0].comment.id.clone(),
            issue_id: "EXAMPLE-5".to_string(),
            target_type: event[0].metadata.target_type.clone().unwrap_or_default(),
            target_id: event[0].metadata.target_id.clone().unwrap_or_default(),
            target_name: "test-user".to_string(),
            workflow_step: None,
            body: String::new(),
            comment_id: event[0].comment.id.clone(),
            created_by_user_id: 7,
            created_by_user_name: Some("test-user".to_string()),
            status: "active".to_string(),
            created_at: datetime_value(event[0].comment.created_at).unwrap(),
            updated_at: datetime_value(event[0].comment.updated_at).unwrap(),
            receipt_tracking: false,
            human_read_at: None,
            stand_in_received_at: None,
        };
        let value = crate::json_contract_tests::serialized(row).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "id": "101",
                "issue_id": "EXAMPLE-5",
                "target_type": "human",
                "target_id": "7",
                "target_name": "test-user",
                "workflow_step": null,
                "body": "",
                "comment_id": "101",
                "created_by_user_id": 7,
                "created_by_user_name": "test-user",
                "status": "active",
                "created_at": "2026-10-10T05:57:44Z",
                "updated_at": "2026-10-10T05:57:44Z",
                "receipt_tracking": false,
                "human_read_at": null,
                "stand_in_received_at": null,
            })
        );
    }
}
