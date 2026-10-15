// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `human_issue_work_service.view` (`app.services.human_issue_work`): the
//! per-item direct-human-assignment view folded into
//! `LoopItemResponse.human_work`.
//!
//! A "direct human" assignment is an active `assignment` comment event that
//! targets a human member and matches the item's current assignee for a local
//! project. The view reports the assignment identity, the reviewer, the stored
//! work state, and the actions the caller may take.
use brz_mysql::FromMysqlRow;
use serde_json::{Value, json};

use super::assignments::{ActiveEvent, active_events};
use super::http_error::HttpError;
use super::item_response::ProjectFacts;
use super::loop_repository::{LoopItemRepository, TaskItemFullRow, has_permission};
use crate::board_snapshot::repository::BoardSnapshotRepository;
use crate::state::AppState;

/// `DIRECT_HUMAN_ROUND_ID` (`app.services.collaboration_human_assignments`).
const DIRECT_HUMAN_ROUND_ID: &str = "direct";
/// Python `bool(value)`: `None` and empty/false scalars are falsy.
use brz_json::adapters::python_truthy as truthy;

/// Python `bool(metadata.get(key))`: an absent key is falsy.
fn truthy_option(value: Option<&Value>) -> bool {
    value.is_some_and(truthy)
}

/// `human_issue_work_service.view(db, item, user_id)`: the direct-human work
/// view, or `None` when the item has no single active direct human assignment.
pub(crate) async fn human_work_view(
    state: &AppState,
    item: &TaskItemFullRow,
    current_user_id: i32,
    project: &ProjectFacts<'_>,
) -> Result<Option<Value>, HttpError> {
    let metadata = item.metadata();
    // `_assignment`: only a local project with no workflow / external markers
    // carries a direct human assignment.
    if !project.provider_is_local {
        return Ok(None);
    }
    if let Some(metadata) = metadata
        && (truthy_option(metadata.workflow.as_ref())
            || truthy_option(metadata.external_index.as_ref())
            || truthy_option(metadata.external_shadow.as_ref()))
    {
        return Ok(None);
    }

    // `issue_assignment_service.active_for_issue(db, item.id)`: the active
    // `assign` events, exactly one of which must target the current assignee.
    let comments = LoopItemRepository::new(&state.mysql)
        .list_item_comments(&item.id)
        .await
        .map_err(HttpError::internal)?;
    let events = active_events(&comments);
    if events.len() != 1 {
        return Ok(None);
    }
    let assignment = &events[0];
    if !direct_human_assignment(assignment, item.assignee_user_id) {
        return Ok(None);
    }

    let work = metadata
        .and_then(|metadata| metadata.human_work.as_ref())
        .and_then(Value::as_object);
    let is_assignee = item.assignee_user_id == Some(current_user_id);
    let reviewer_id = reviewer_id(state, project, assignment, item.assignee_user_id).await?;

    let assignment_matches =
        work.and_then(|work| work.get("assignment_id")) == Some(&json!(assignment.comment.id));
    Ok(Some(json!({
        "assignment_id": assignment.comment.id,
        "ai_task_binding": if is_assignee {
            ai_task_binding(&item.id, &assignment.comment.id)
        } else {
            Value::Null
        },
        "assignee_user_id": item.assignee_user_id,
        "reviewer_user_id": reviewer_id,
        "submission_message_id": work_value(work, "submission_message_id"),
        "submitted_by_user_id": work_value(work, "submitted_by_user_id"),
        "result": work_value(work, "result").unwrap_or_else(|| json!("")),
        "return_reason": work_value(work, "return_reason").unwrap_or_else(|| json!("")),
        "ai_draft_delivery_id": work_value(work, "ai_draft_delivery_id"),
        "state": if assignment_matches {
            work_value(work, "state").unwrap_or_else(|| json!("none"))
        } else {
            json!("none")
        },
        "can_start": is_assignee && can_start(item.status.as_deref(), assignment.comment.id.as_str(), work),
        "can_submit": is_assignee && item.status.as_deref() == Some("in_progress"),
        "can_review": can_review(state, item, assignment, project, reviewer_id, current_user_id).await?,
    })))
}

/// `_assignment`'s post-selection guard: the sole active event must target a
/// `human` member with a real trigger and no workflow step, and its member id
/// must equal the item's assignee.
fn direct_human_assignment(assignment: &ActiveEvent<'_>, assignee_user_id: Option<i32>) -> bool {
    let metadata = assignment.metadata;
    // `AssignmentEvent.member_type` is the raw `target_type`, not the
    // normalized dedupe key: only a literal `human` counts.
    if metadata.target_type.as_deref() != Some("human") {
        return false;
    }
    if metadata.trigger.as_deref() == Some("default") {
        return false;
    }
    if metadata
        .workflow_step
        .as_deref()
        .is_some_and(|step| !step.is_empty())
    {
        return false;
    }
    let member_id = metadata.target_id.clone().unwrap_or_default();
    assignee_user_id
        .map(|id| id.to_string())
        .unwrap_or_default()
        == member_id
}

/// `_reviewer_id`: the assigner when they are not the assignee and still hold
/// at least `Reporter`; `None` otherwise (the source swallows the 403/404).
async fn reviewer_id(
    state: &AppState,
    project: &ProjectFacts<'_>,
    assignment: &ActiveEvent<'_>,
    assignee_user_id: Option<i32>,
) -> Result<Option<i32>, HttpError> {
    let assigner_id = assignment.comment.created_by_user_id.unwrap_or(0);
    if Some(assigner_id) == assignee_user_id {
        return Ok(None);
    }
    let access = BoardSnapshotRepository::new(&state.mysql)
        .require_cloud_project_role(project.number, assigner_id)
        .await
        .map_err(HttpError::internal)?;
    Ok(access
        .filter(|access| has_permission(&access.role, "Reporter"))
        .map(|_| assigner_id))
}

/// `_can_start`: an unstarted issue, or a reassignment that has not been
/// started under the current assignment.
fn can_start(
    status: Option<&str>,
    assignment_id: &str,
    work: Option<&serde_json::Map<String, Value>>,
) -> bool {
    match status {
        Some("inbox") | Some("pending") => true,
        Some("in_review") | Some("completed") => {
            let work_assignment = work.and_then(|work| work.get("assignment_id"));
            work_assignment != Some(&json!(assignment_id))
                || work
                    .and_then(|work| work.get("state"))
                    .map(|state| state == "none")
                    .unwrap_or(true)
        }
        _ => false,
    }
}

/// `can_review`: a submitted issue under the current assignment that the
/// caller may review as the resolved reviewer, or as an owner/maintainer when
/// no explicit reviewer exists.
async fn can_review(
    state: &AppState,
    item: &TaskItemFullRow,
    assignment: &ActiveEvent<'_>,
    project: &ProjectFacts<'_>,
    reviewer_id: Option<i32>,
    current_user_id: i32,
) -> Result<bool, HttpError> {
    if item.status.as_deref() != Some("in_review") {
        return Ok(false);
    }
    let metadata = item.metadata();
    let work = metadata
        .and_then(|metadata| metadata.human_work.as_ref())
        .and_then(Value::as_object);
    if work.and_then(|work| work.get("state")) != Some(&json!("submitted"))
        || work.and_then(|work| work.get("assignment_id")) != Some(&json!(assignment.comment.id))
    {
        return Ok(false);
    }
    match reviewer_id {
        Some(reviewer_id) => Ok(reviewer_id == current_user_id),
        None => fallback_reviewer_ids(state, project)
            .await
            .map(|ids| ids.contains(&current_user_id)),
    }
}

/// `_fallback_reviewer_ids`: the project creator plus every owner/maintainer
/// member of the item's project.
async fn fallback_reviewer_ids(
    state: &AppState,
    project: &ProjectFacts<'_>,
) -> Result<Vec<i32>, HttpError> {
    #[derive(Debug, FromMysqlRow)]
    struct MemberIdRow {
        #[mysql(rename = "resource_members_entity_id")]
        entity_id: String,
        #[mysql(rename = "resource_members_role")]
        role: String,
    }
    let project_id = project.number;
    let rows: Vec<MemberIdRow> = state
        .mysql
        .fetch_all(
            format!(
                "SELECT resource_members.entity_id AS resource_members_entity_id, \
                 resource_members.`role` AS resource_members_role \n\
                 FROM resource_members \n\
                 WHERE resource_members.resource_type = 'CloudProject' \
                 AND resource_members.resource_id = {project_id} \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.status = 'approved'",
            ),
            (),
        )
        .await
        .map_err(HttpError::internal)?;
    let mut ids = vec![project.created_by_user_id];
    for row in rows {
        if matches!(row.role.as_str(), "Owner" | "Maintainer")
            && let Ok(id) = row.entity_id.parse::<i32>()
        {
            ids.push(id);
        }
    }
    Ok(ids)
}

/// One `work` field as JSON, or `None` when the metadata is absent.
fn work_value(work: Option<&serde_json::Map<String, Value>>, key: &str) -> Option<Value> {
    match work.and_then(|work| work.get(key)) {
        Some(Value::Null) => Some(Value::Null),
        Some(value) => Some(value.clone()),
        None => None,
    }
}

/// `_ai_task_binding`: the stable direct-human identity
/// (`app.services.collaboration_human_assignments`).
fn ai_task_binding(issue_id: &str, assignment_id: &str) -> Value {
    json!({
        "humanAssignmentId": direct_human_assignment_id(issue_id, assignment_id),
        "dispatchId": format!("direct-human:{assignment_id}"),
        "dispatchRoundId": DIRECT_HUMAN_ROUND_ID,
        "assignmentId": assignment_id,
    })
}

/// `direct_human_assignment_id`: `uuid5(NAMESPACE_URL, ...)`.
fn direct_human_assignment_id(issue_id: &str, assignment_id: &str) -> String {
    uuid5_url(&format!("wegent:direct-human:{issue_id}:{assignment_id}"))
}

/// `uuid.uuid5(uuid.NAMESPACE_URL, name)`: the RFC 4122 v5 (SHA-1) name-based
/// UUID over the URL namespace.
fn uuid5_url(name: &str) -> String {
    /// `uuid.NAMESPACE_URL`.
    const NAMESPACE_URL: [u8; 16] = [
        0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30,
        0xc8,
    ];
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(NAMESPACE_URL);
    hasher.update(name.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let mut out = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
#[path = "human_work_tests.rs"]
mod tests;
