// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Current assignment events derived from ordered Issue comments.
use std::collections::{HashMap, HashSet};

use super::loop_repository::{AssignmentMetadata, CommentRow};

const ASSIGNMENT_EVENT_TYPE: &str = "assignment";

/// One active assignment event plus its `(member_type, member_id,
/// workflow_step)` dedupe key.
pub struct ActiveEvent<'a> {
    pub comment: &'a CommentRow,
    pub metadata: &'a AssignmentMetadata,
}

/// Uncancelled `assign` events in activity order, including superseded events
/// for the same member so reassignment can revoke every previous root event.
pub fn uncancelled_events(comments: &[CommentRow]) -> Vec<ActiveEvent<'_>> {
    let cancelled: HashSet<&str> = comments
        .iter()
        .filter_map(|comment| {
            let metadata = comment.assignment()?;
            (metadata.event_type.as_deref() == Some(ASSIGNMENT_EVENT_TYPE)
                && metadata.action.as_deref() == Some("unassign"))
            .then(|| metadata.assignment_event_id.as_deref().unwrap_or(""))
        })
        .collect();
    let mut active = Vec::new();
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
        active.push(ActiveEvent { comment, metadata });
    }
    active
}

/// Reassignment cancels all uncancelled events, including superseded events for
/// the same member. Read projections retain only the newest event per member.
pub fn active_events(comments: &[CommentRow]) -> Vec<ActiveEvent<'_>> {
    let mut active = Vec::new();
    let mut positions = HashMap::new();
    for event in uncancelled_events(comments) {
        let key = member_key(event.metadata);
        match positions.get(&key).copied() {
            Some(index) => {
                active[index] = event;
            }
            None => {
                positions.insert(key.clone(), active.len());
                active.push(event);
            }
        }
    }
    active
}

fn member_key(metadata: &AssignmentMetadata) -> (String, String, String) {
    (
        member_type_key(metadata.target_type.as_deref()).to_string(),
        metadata.target_id.clone().unwrap_or_default(),
        metadata
            .workflow_step
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string(),
    )
}

/// `_member_type`: `user`/`human` normalize to `human`, everything else to
/// `agent`.
pub fn member_type_key(value: Option<&str>) -> &'static str {
    match value {
        Some("user") | Some("human") => "human",
        _ => "agent",
    }
}
