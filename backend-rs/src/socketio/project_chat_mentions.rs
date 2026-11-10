// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::project_chat_events::{ScopeError, ack_error, require_scope};
use super::project_chat_messages::load_agent;
use crate::board_snapshot::{
    members::list_project_members,
    repository::{ProjectAccess, has_permission},
};
use crate::state::AppState;

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Mention {
    #[serde(rename = "type")]
    kind: MentionKind,
    id: String,
    label: String,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum MentionKind {
    User,
    Agent,
}

impl Mention {
    pub(super) fn user(id: i64, label: String) -> Self {
        Self {
            kind: MentionKind::User,
            id: id.to_string(),
            label,
        }
    }

    pub(super) fn parse(value: Option<&Value>) -> Result<Vec<Self>, String> {
        let Some(value) = value else {
            return Ok(Vec::new());
        };
        let mentions: Vec<Self> = serde_json::from_value(value.clone())
            .map_err(|_| "mentions: Invalid mention".to_owned())?;
        if mentions.len() > 64
            || mentions.iter().any(|mention| {
                !(1..=128).contains(&mention.id.chars().count())
                    || !(1..=255).contains(&mention.label.chars().count())
            })
        {
            return Err("mentions: Invalid mention".to_owned());
        }
        Ok(mentions)
    }

    pub(super) fn is_user(&self) -> bool {
        self.kind == MentionKind::User
    }
}

pub(super) async fn validate_agents(
    state: &AppState,
    project_id: &str,
    mentions: &[Mention],
) -> Result<(), Value> {
    for mention in mentions.iter().filter(|mention| !mention.is_user()) {
        if !load_agent(state, &mention.id).await.is_ok_and(|agent| {
            agent.cloud_project_id.as_deref() == Some(project_id)
                && agent.status.as_deref() == Some("active")
                && crate::board_snapshot::repository::datetime_is_unset(agent.deleted_at)
        }) {
            return Err(ack_error(
                "MESSAGE_CONFLICT",
                "Mentioned AI is not a member of this project chat",
            ));
        }
    }
    Ok(())
}

pub(super) async fn recipients(
    state: &AppState,
    actor: i64,
    access: &ProjectAccess,
    task: Option<&str>,
    mentions: &[Mention],
) -> Result<(Vec<i64>, Value), Value> {
    let project = &access.project;
    let mut target = json!({"projectId": project.id});
    if let Some(name) = project.name.as_deref().filter(|name| !name.is_empty()) {
        target["projectName"] = json!(name);
    }
    if !mentions.iter().any(Mention::is_user) {
        return Ok((Vec::new(), target));
    }
    let project_id = project
        .id
        .parse()
        .map_err(|_| ack_error("INVALID_MESSAGE", "invalid project id"))?;
    let members: HashSet<i64> = list_project_members(
        &state.mysql,
        project,
        project_id,
        access.workspace_id,
        actor as i32,
    )
    .await
    .map_err(|_| ack_error("INVALID_MESSAGE", "could not load project roster"))?
    .into_iter()
    .filter(|member| has_permission(&member.role, "Viewer"))
    .map(|member| i64::from(member.user_id))
    .collect();
    let mut seen = HashSet::new();
    let mut recipients = Vec::new();
    for mention in mentions.iter().filter(|mention| mention.is_user()) {
        let user = mention
            .id
            .trim()
            .parse::<i64>()
            .map_err(|_| ack_error("INVALID_MESSAGE", "Mentioned user is invalid"))?;
        if !members.contains(&user) {
            return Err(ack_error(
                "INVALID_MESSAGE",
                "Mentioned user is not a project member",
            ));
        }
        if !seen.insert(user) {
            continue;
        }
        if let Some(task) = task {
            let (_, issue) = require_scope(state, user, &project.id, Some(task), false)
                .await
                .map_err(|error| match error {
                    ScopeError::NotFound(_) | ScopeError::Forbidden(_) => {
                        ack_error("INVALID_MESSAGE", "Mentioned user cannot view this issue")
                    }
                    _ => error.ack(),
                })?;
            target["itemId"] = json!(task);
            target["itemKey"] = json!(task);
            if let Some(issue) = issue {
                target["itemTitle"] = json!(issue.title().unwrap_or(task));
            } else if let Some(item) =
                crate::loop_tasks::loop_repository::LoopItemRepository::new(&state.mysql)
                    .get_task_item_entity(task)
                    .await
                    .map_err(|_| ack_error("INVALID_MESSAGE", "could not load issue"))?
            {
                target["itemTitle"] = json!(item.title.unwrap_or_default());
                if let Some(status) = item.status.filter(|status| !status.is_empty()) {
                    target["itemStatus"] = json!(status);
                }
                if let Some(priority) = item.priority.filter(|priority| priority != "none") {
                    target["itemPriority"] = json!(priority);
                }
            }
        }
        recipients.push(user);
    }
    recipients.sort_unstable();
    Ok((recipients, target))
}

pub(super) fn preview(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= 200 {
        return collapsed;
    }
    collapsed
        .chars()
        .take(199)
        .chain(std::iter::once('…'))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mentions_preserve_user_and_agent_labels_and_reject_unknown_types() {
        let input = json!([
            {"type": "user", "id": "12", "label": "Reader"},
            {"type": "agent", "id": "agent", "label": "Assistant"}
        ]);
        let mentions = Mention::parse(Some(&input)).unwrap();
        assert!(mentions[0].is_user());
        assert!(!mentions[1].is_user());
        assert_eq!(json!(mentions), input);
        assert!(
            Mention::parse(Some(&json!([
                {"type": "group", "id": "12", "label": "Readers"}
            ])))
            .is_err()
        );
    }

    #[test]
    fn notification_preview_collapses_space_and_bounds_unicode_characters() {
        assert_eq!(preview("  hello\n world "), "hello world");
        let long = preview(&"测".repeat(201));
        assert_eq!(long.chars().count(), 200);
        assert!(long.ends_with('…'));
    }
}
