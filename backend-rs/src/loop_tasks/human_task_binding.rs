// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Optional human task identity, independent of the Issue's status.
//! Matches `app.services.collaboration_human_assignments.human_task_binding`.
use brz_json::adapters::python_truthy as truthy;
use serde_json::{Value, json};

use super::assignments::{ActiveEvent, active_events};
use super::http_error::HttpError;
use super::item_response::ProjectFacts;
use super::loop_repository::{LoopItemRepository, TaskItemFullRow};
use crate::state::AppState;

pub(crate) async fn human_task_binding(
    state: &AppState,
    item: &TaskItemFullRow,
    current_user_id: i32,
    project: &ProjectFacts<'_>,
) -> Result<Option<Value>, HttpError> {
    if item.assignee_user_id != Some(current_user_id) || !project.provider_is_local {
        return Ok(None);
    }
    if item.metadata().is_some_and(|metadata| {
        [
            &metadata.workflow,
            &metadata.external_index,
            &metadata.external_shadow,
        ]
        .iter()
        .any(|value| value.as_ref().is_some_and(truthy))
    }) {
        return Ok(None);
    }
    let repository = LoopItemRepository::new(&state.mysql);
    let comments = repository
        .list_item_comments(&item.id)
        .await
        .map_err(HttpError::internal)?;
    let events = active_events(&comments);
    if events.len() != 1 || !direct_human_assignment(&events[0], item.assignee_user_id) {
        return Ok(None);
    }
    let assignment = &events[0];
    if assignment.metadata.trigger.as_deref() == Some("collaboration_round") {
        let activities = repository
            .item_activity_metadata(&item.cloud_project_id, &item.id)
            .await
            .map_err(HttpError::internal)?;
        return Ok(round_task_binding(
            activities
                .iter()
                .filter_map(|row| row.metadata.as_ref().map(|json| &json.0)),
            current_user_id,
        ));
    }
    Ok(Some(direct_task_binding(&item.id, &assignment.comment.id)))
}

/// Only the current explicit, non-workflow human assignment carries an identity.
fn direct_human_assignment(assignment: &ActiveEvent<'_>, assignee_user_id: Option<i32>) -> bool {
    let metadata = assignment.metadata;
    metadata.target_type.as_deref() == Some("human")
        && metadata.trigger.as_deref() != Some("default")
        && metadata.workflow_step.as_deref().is_none_or(str::is_empty)
        && assignee_user_id
            .is_some_and(|id| metadata.target_id.as_deref() == Some(id.to_string().as_str()))
}

/// The newest manager assignment is authoritative, including incomplete plans.
fn round_task_binding<'a>(
    activities: impl Iterator<Item = &'a Value>,
    assignee_user_id: i32,
) -> Option<Value> {
    let metadata = activities
        .filter_map(Value::as_object)
        .find(|metadata| metadata.get("activity_type") == Some(&json!("manager_assignment")))?;
    let members = metadata.get("dispatch_assignments")?.as_array()?;
    let member = members.iter().filter_map(Value::as_object).find(|member| {
        member.get("assignee_type") == Some(&json!("human"))
            && member.get("human_user_id").is_some_and(|id| {
                id.as_str() == Some(assignee_user_id.to_string().as_str())
                    || id.as_i64() == Some(i64::from(assignee_user_id))
            })
    })?;
    let binding = json!({
        "humanAssignmentId": member.get("human_assignment_id"),
        "dispatchId": metadata.get("dispatch_id"),
        "dispatchRoundId": metadata.get("coordination_round_id"),
        "assignmentId": member.get("assignment_id"),
    });
    binding.as_object()?.values().all(truthy).then_some(binding)
}

fn direct_task_binding(issue_id: &str, assignment_id: &str) -> Value {
    json!({
        "humanAssignmentId": direct_human_assignment_id(issue_id, assignment_id),
        "dispatchId": format!("direct-human:{assignment_id}"),
        "dispatchRoundId": "direct",
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
#[path = "human_task_binding_tests.rs"]
mod tests;
