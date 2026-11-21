//! Server-visible assistant roster and one-transaction Issue fan-out.

use brz_http_server::StatusCode;
use brz_mysql::Mysql;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::cloud_projects::members::has_permission;
use crate::cloud_projects::{project_access, role_for_priority};
use crate::http_compat::FastApiError;

mod dispatch;
mod roster;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectAssistantRosterEntry {
    pub(super) id: String,
    pub(super) project_id: String,
    pub(super) user_id: i64,
    pub(super) user_name: String,
    pub(super) role_id: String,
    pub(super) endpoint_ref: String,
    pub(super) endpoint_kind: String,
    pub(super) display_name: String,
    pub(super) enabled: bool,
    pub(super) capability_tags: Vec<String>,
    pub(super) autonomy_policy: Value,
    pub(super) availability: String,
    pub(super) version: i64,
}

pub(super) fn endpoint_kind(endpoint_ref: &str) -> Option<&'static str> {
    if endpoint_ref.starts_with("local_wework:") {
        Some("local_wework")
    } else if endpoint_ref.starts_with("cloud_device:") {
        Some("cloud_device")
    } else if endpoint_ref.starts_with("wegent_agent:") {
        Some("wegent_agent")
    } else {
        None
    }
}

pub(super) fn wegent_agent_id(endpoint_ref: &str) -> Option<&str> {
    let mut parts = endpoint_ref.strip_prefix("wegent_agent:")?.split(':');
    let _owner = parts.next()?;
    let agent = parts.next()?;
    let role = parts.next()?;
    (parts.next().is_none() && !agent.is_empty() && !role.is_empty()).then_some(agent)
}

pub(super) fn capability_match(
    entry: &ProjectAssistantRosterEntry,
    goal: &str,
    description: &str,
) -> usize {
    let text = format!("{goal} {description}").to_lowercase();
    entry
        .capability_tags
        .iter()
        .filter(|tag| text.contains(&tag.to_lowercase()))
        .count()
}

pub(super) fn effective_autonomy_policy(
    entry: &ProjectAssistantRosterEntry,
    risk_level: &str,
) -> Value {
    let mut policy = entry.autonomy_policy.clone();
    if risk_level != "low"
        && let Some(policy) = policy.as_object_mut()
    {
        policy.insert("automatic".into(), json!(false));
        policy.insert("ask_before_act".into(), json!(true));
    }
    policy
}

pub(super) fn automatic_for(entry: &ProjectAssistantRosterEntry, risk_level: &str) -> bool {
    let policy = effective_autonomy_policy(entry, risk_level);
    policy["automatic"] == true && policy["ask_before_act"] != true
}

pub(super) fn dispatch_status_for(
    entry: &ProjectAssistantRosterEntry,
    risk_level: &str,
) -> &'static str {
    if entry.availability == "offline" {
        "waiting_device"
    } else if !automatic_for(entry, risk_level) {
        "waiting_confirmation"
    } else {
        "queued"
    }
}
pub(super) async fn authorize_project<M: Mysql>(
    mysql: &M,
    project_id: &str,
    user_id: i32,
    required: &str,
) -> Result<crate::cloud_projects::ProjectAccessRow, FastApiError> {
    let number = crate::cloud_projects::parse_project_id(project_id)?;
    let access = project_access(mysql, number, user_id)
        .await
        .map_err(roster_read_error)?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Cloud project not found"))?;
    let role = role_for_priority(access.1).ok_or_else(invalid_permission_role)?;
    if !has_permission(role, required) {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }
    Ok(crate::cloud_projects::ProjectAccessRow {
        project: access.0,
        priority: access.1,
    })
}

pub(super) fn text(metadata: &Value, key: &str) -> String {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

pub(super) fn text_or(metadata: &Value, key: &str, fallback: &str) -> String {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

pub(super) fn strings(metadata: &Value, key: &str) -> Vec<String> {
    metadata
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

pub(super) fn roster_id(project: &str, user: i64, role: &str, endpoint: &str) -> String {
    digest(&[
        "assistant-roster",
        project,
        &user.to_string(),
        role,
        endpoint,
    ])
}

pub(super) fn digest(parts: &[&str]) -> String {
    format!("{:x}", Sha256::digest(parts.join("\0").as_bytes()))
}

pub(super) fn invalid_permission_role() -> FastApiError {
    FastApiError::detail(StatusCode::FORBIDDEN, "Invalid project permission")
}

pub(super) fn roster_read_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "assistant roster read failed");
    FastApiError::internal()
}

pub(super) fn roster_write_error(error: brz_mysql::MysqlError) -> FastApiError {
    if matches!(error, brz_mysql::MysqlError::InvalidQuery { .. }) {
        return FastApiError::detail(StatusCode::CONFLICT, "Assistant roster entry changed");
    }
    tracing::error!(%error, "assistant roster write failed");
    FastApiError::internal()
}

pub(super) fn dispatch_write_error(error: brz_mysql::MysqlError) -> FastApiError {
    if let brz_mysql::MysqlError::InvalidQuery { reason } = &error
        && reason.contains("intent id")
    {
        return FastApiError::detail(
            StatusCode::CONFLICT,
            "Dispatch intent already has different content",
        );
    }
    if let brz_mysql::MysqlError::InvalidQuery { reason } = &error
        && reason.contains("assistant roster changed")
    {
        return FastApiError::detail(
            StatusCode::CONFLICT,
            "Assistant roster changed; review and confirm the assignment again",
        );
    }
    tracing::error!(%error, "assistant dispatch transaction failed");
    FastApiError::internal()
}

#[cfg(test)]
mod tests {
    use super::dispatch::dispatch_from_metadata;
    use super::roster::default_autonomy_policy;
    use super::*;

    #[test]
    fn roster_identity_is_stable_across_runtime_devices() {
        let id = roster_id("project", 7, "review", "local_wework:7:review");
        assert_eq!(
            id,
            roster_id("project", 7, "review", "local_wework:7:review")
        );
        assert_ne!(
            id,
            roster_id("project", 8, "review", "local_wework:7:review")
        );
    }

    #[test]
    fn endpoint_kind_is_derived_by_the_server() {
        assert_eq!(endpoint_kind("local_wework:7:review"), Some("local_wework"));
        assert_eq!(endpoint_kind("cloud_device:7:review"), Some("cloud_device"));
        assert_eq!(
            endpoint_kind("wegent_agent:7:agent-1:review"),
            Some("wegent_agent")
        );
        assert_eq!(endpoint_kind("unregistered:7:review"), None);
    }

    #[test]
    fn wegent_endpoint_resolves_the_project_agent_id() {
        assert_eq!(
            wegent_agent_id("wegent_agent:7:agent-1:review"),
            Some("agent-1")
        );
        assert_eq!(wegent_agent_id("wegent_agent:agent-1"), None);
        assert_eq!(wegent_agent_id("wegent_agent:7:agent-1"), None);
        assert_eq!(wegent_agent_id("local_wework:7:review"), None);
    }

    #[test]
    fn coordinator_selection_matches_declared_capabilities() {
        let entry = ProjectAssistantRosterEntry {
            id: "roster".into(),
            project_id: "project".into(),
            user_id: 7,
            user_name: "jiangyang7".into(),
            role_id: "review".into(),
            endpoint_ref: "local_wework:7:review".into(),
            endpoint_kind: "local_wework".into(),
            display_name: "Reviewer".into(),
            enabled: true,
            capability_tags: vec!["review".into(), "security".into()],
            autonomy_policy: default_autonomy_policy(),
            availability: "online".into(),
            version: 1,
        };
        assert_eq!(capability_match(&entry, "Review security", ""), 2);
        assert_eq!(capability_match(&entry, "Implement UI", ""), 0);
    }

    #[test]
    fn dispatch_state_waits_for_member_authorization_before_automatic_execution() {
        let mut entry = ProjectAssistantRosterEntry {
            id: "roster".into(),
            project_id: "project".into(),
            user_id: 7,
            user_name: "jiangyang7".into(),
            role_id: "review".into(),
            endpoint_ref: "cloud_device:7:review".into(),
            endpoint_kind: "cloud_device".into(),
            display_name: "Reviewer".into(),
            enabled: true,
            capability_tags: Vec::new(),
            autonomy_policy: json!({"automatic":false}),
            availability: "online".into(),
            version: 1,
        };
        assert_eq!(dispatch_status_for(&entry, "low"), "waiting_confirmation");
        entry.autonomy_policy = json!({"automatic":true});
        assert_eq!(dispatch_status_for(&entry, "low"), "queued");
        entry.autonomy_policy = json!({"automatic":true,"ask_before_act":true});
        assert_eq!(dispatch_status_for(&entry, "low"), "waiting_confirmation");
        entry.autonomy_policy = json!({"automatic":true,"ask_before_act":false});
        assert_eq!(dispatch_status_for(&entry, "high"), "waiting_confirmation");
        assert_eq!(dispatch_status_for(&entry, "low"), "queued");
        entry.availability = "offline".into();
        assert_eq!(dispatch_status_for(&entry, "low"), "waiting_device");
    }

    #[test]
    fn dispatch_recovery_returns_the_original_root_and_children() {
        let result = dispatch_from_metadata(
            "dispatch",
            "intent",
            json!({
                "root_issue_id":"ISSUE-1",
                "manager_user_id":7,
                "children":[{"issueId":"ISSUE-2","userId":7,"rosterEntryId":"roster","status":"queued"}]
            }),
            true,
        );
        assert_eq!(result.root_issue_id, "ISSUE-1");
        assert_eq!(result.children[0].issue_id, "ISSUE-2");
        assert!(result.replayed);
    }
}
