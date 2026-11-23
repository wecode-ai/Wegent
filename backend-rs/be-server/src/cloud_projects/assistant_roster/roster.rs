use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::SessionUser;
use crate::background_jobs::project::store;
use crate::cloud_projects::members::has_permission;
use crate::cloud_projects::{project_access, role_for_priority};
use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::{
    ProjectAssistantRosterEntry, authorize_project, endpoint_kind, invalid_permission_role,
    roster_id, roster_read_error, roster_write_error, strings, text, text_or, wegent_agent_id,
};

#[derive(Clone, Debug, FromMysqlRow)]
struct RosterRow {
    id: String,
    user_id: i64,
    status: String,
    metadata: Json<Value>,
    version: i64,
}

#[brz_http_server::get("/api/v1/cloud-projects/:project_id/assistant-roster")]
async fn list_project_assistant_roster(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] user: SessionUser,
) -> Result<Vec<ProjectAssistantRosterEntry>, FastApiError> {
    let project = authorize_project(&state.mysql, project_id, user.id, "Viewer").await?;
    roster_entries(state, &project.project.id).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RosterUpsert {
    user_id: i64,
    role_id: String,
    endpoint_ref: String,
    display_name: String,
    enabled: bool,
    #[serde(default)]
    capability_tags: Vec<String>,
    #[serde(default = "default_autonomy_policy")]
    autonomy_policy: Value,
    #[serde(default = "default_availability")]
    availability: String,
    #[serde(default)]
    version: i64,
}

pub(super) fn default_autonomy_policy() -> Value {
    json!({"risk_ceiling":"low","automatic":false,"ask_before_act":true})
}

pub(super) fn default_availability() -> String {
    "unknown".into()
}

fn validate_input(input: &RosterUpsert) -> Result<(), FastApiError> {
    if input.user_id < 1
        || input.role_id.trim().is_empty()
        || input.endpoint_ref.trim().is_empty()
        || input.display_name.trim().is_empty()
        || !input.autonomy_policy.is_object()
        || !matches!(
            input.availability.as_str(),
            "online" | "offline" | "unknown"
        )
        || !valid_endpoint_identity(&input.endpoint_ref, input.user_id, input.role_id.trim())
    {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid project assistant roster entry",
        ));
    }
    Ok(())
}

fn valid_endpoint_identity(endpoint_ref: &str, user_id: i64, role_id: &str) -> bool {
    match endpoint_kind(endpoint_ref) {
        Some("local_wework" | "cloud_device") => {
            let mut parts = endpoint_ref.split(':');
            let _kind = parts.next();
            parts.next().and_then(|value| value.parse::<i64>().ok()) == Some(user_id)
                && parts.next() == Some(role_id)
                && parts.next().is_none()
        }
        Some("wegent_agent") => {
            let mut parts = endpoint_ref.split(':');
            parts.next() == Some("wegent_agent")
                && parts.next().and_then(|value| value.parse::<i64>().ok()) == Some(user_id)
                && parts.next().is_some_and(|agent| !agent.trim().is_empty())
                && parts.next() == Some(role_id)
                && parts.next().is_none()
        }
        _ => false,
    }
}

#[brz_http_server::post("/api/v1/cloud-projects/:project_id/assistant-roster")]
async fn upsert_project_assistant_roster(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] user: SessionUser,
    body: Value,
) -> Result<ProjectAssistantRosterEntry, FastApiError> {
    let mut input: RosterUpsert = serde_json::from_value(body).map_err(|_| {
        FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, "Invalid roster body")
    })?;
    input.role_id = input.role_id.trim().to_string();
    input.endpoint_ref = input.endpoint_ref.trim().to_string();
    input.display_name = input.display_name.trim().to_string();
    input.capability_tags = input
        .capability_tags
        .into_iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect();
    validate_input(&input)?;
    let caller = authorize_project(&state.mysql, project_id, user.id, "Developer").await?;
    if input.user_id != i64::from(user.id) {
        return Err(FastApiError::forbidden(
            "Only the member can authorize their own assistant",
        ));
    }
    let target = authorize_project(
        &state.mysql,
        project_id,
        i32::try_from(input.user_id).map_err(|_| FastApiError::validation(json!([])))?,
        "Developer",
    )
    .await?;
    let role = role_for_priority(target.priority).ok_or_else(invalid_permission_role)?;
    if !has_permission(role, "Developer") {
        return Err(FastApiError::forbidden(
            "Assistant owner must be a project developer",
        ));
    }
    if input.enabled
        && let Some(agent_id) = wegent_agent_id(&input.endpoint_ref)
    {
        crate::background_jobs::project::authority::agent(
            &state.mysql,
            &caller.project.id,
            agent_id,
            input.user_id,
            true,
        )
        .await
        .map_err(|_| {
            FastApiError::forbidden(
                "Assistant endpoint is not an authorized project agent for this member",
            )
        })?;
    }
    let id = roster_id(
        &caller.project.id,
        input.user_id,
        &input.role_id,
        &input.endpoint_ref,
    );
    let metadata = roster_metadata(&input);
    let autonomy_policy = metadata["autonomy_policy"].clone();
    let status = if input.enabled { "active" } else { "disabled" };
    let version = state
        .mysql
        .with_transaction(async |tx| {
            let existing = store::locked(tx, "project_assistant_roster", &id).await?;
            if let Some(existing) = existing {
                if input.version != existing.version {
                    return Err(brz_mysql::MysqlError::InvalidQuery {
                        reason: "Assistant roster entry changed before save".into(),
                    });
                }
                let version = existing.version + 1;
                tx.execute(
                    "UPDATE loop_items SET user_id=?,title=?,status=?,metadata=?,version=?,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND resource_type='project_assistant_roster'",
                    (
                        input.user_id,
                        input.display_name.clone(),
                        status,
                        Json(metadata),
                        version,
                        id.as_str(),
                    ),
                )
                .await?;
                Ok(version)
            } else {
                crate::background_jobs::project::store::insert(
                    tx,
                    "project_assistant_roster",
                    json!({
                        "id": id,
                        "cloud_project_id": caller.project.id,
                        "user_id": input.user_id,
                        "title": input.display_name,
                        "status": status,
                        "metadata": metadata,
                    }),
                )
                .await?;
                Ok(1)
            }
        })
        .await
        .map_err(roster_write_error)?;
    let user_name = state
        .user_reader
        .get_entity_by_id(input.user_id)
        .await
        .map_err(|_| FastApiError::internal())?
        .map(|user| user.user_name)
        .unwrap_or_else(|| "未知成员（历史数据）".into());
    Ok(ProjectAssistantRosterEntry {
        id,
        project_id: caller.project.id,
        user_id: input.user_id,
        user_name,
        role_id: input.role_id.trim().to_string(),
        endpoint_ref: input.endpoint_ref.trim().to_string(),
        endpoint_kind: endpoint_kind(&input.endpoint_ref)
            .ok_or_else(|| {
                FastApiError::detail(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "Invalid project assistant roster entry",
                )
            })?
            .into(),
        display_name: input.display_name.trim().to_string(),
        enabled: input.enabled,
        capability_tags: input.capability_tags,
        autonomy_policy,
        availability: input.availability,
        version,
    })
}
pub(super) async fn roster_entries(
    state: &AppState,
    project_id: &str,
) -> Result<Vec<ProjectAssistantRosterEntry>, FastApiError> {
    let rows: Vec<RosterRow> = state
        .mysql
        .fetch_all(
            "SELECT id,COALESCE(user_id,0) AS user_id,COALESCE(status,'') AS status,COALESCE(metadata,JSON_OBJECT()) AS metadata,COALESCE(version,1) AS version FROM loop_items WHERE resource_type='project_assistant_roster' AND cloud_project_id=? AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) ORDER BY id",
            (project_id,),
        )
        .await
        .map_err(roster_read_error)?;
    let mut entries = Vec::new();
    for row in rows {
        if !matches!(row.status.as_str(), "active" | "disabled") {
            continue;
        }
        let Ok(user_id) = i32::try_from(row.user_id) else {
            continue;
        };
        let Some((_, priority)) =
            project_access(&state.mysql, project_id.parse().unwrap_or(0), user_id)
                .await
                .map_err(roster_read_error)?
        else {
            continue;
        };
        let Some(role) = role_for_priority(priority) else {
            continue;
        };
        if !has_permission(role, "Developer") {
            continue;
        }
        let user_name = state
            .user_reader
            .get_entity_by_id(row.user_id)
            .await
            .map_err(|_| FastApiError::internal())?
            .map(|user| user.user_name)
            .unwrap_or_else(|| "未知成员（历史数据）".into());
        let enabled = row.status == "active";
        let mut entry = entry_from_row(project_id, row, user_name, enabled);
        if entry.enabled && entry.endpoint_kind == "wegent_agent" {
            let authorized = match wegent_agent_id(&entry.endpoint_ref) {
                Some(agent_id) => crate::background_jobs::project::authority::agent(
                    &state.mysql,
                    project_id,
                    agent_id,
                    i64::from(user_id),
                    true,
                )
                .await
                .is_ok(),
                None => false,
            };
            if !authorized {
                // Keep the version visible so the owner can disable or repair it.
                entry.enabled = false;
            }
        }
        entries.push(entry);
    }
    Ok(entries)
}

fn entry_from_row(
    project_id: &str,
    row: RosterRow,
    user_name: String,
    enabled: bool,
) -> ProjectAssistantRosterEntry {
    let metadata = row.metadata.0;
    ProjectAssistantRosterEntry {
        id: row.id,
        project_id: project_id.into(),
        user_id: row.user_id,
        user_name,
        role_id: text(&metadata, "role_id"),
        endpoint_ref: text(&metadata, "endpoint_ref"),
        endpoint_kind: text(&metadata, "endpoint_kind"),
        display_name: text(&metadata, "display_name"),
        enabled,
        capability_tags: strings(&metadata, "capability_tags"),
        autonomy_policy: metadata
            .get("autonomy_policy")
            .cloned()
            .unwrap_or_else(default_autonomy_policy),
        availability: text_or(&metadata, "availability", "unknown"),
        version: row.version,
    }
}

fn roster_metadata(input: &RosterUpsert) -> Value {
    let mut autonomy_policy = input.autonomy_policy.clone();
    if let Some(policy) = autonomy_policy.as_object_mut() {
        if !policy.contains_key("ask_before_act")
            && let Some(ask_before_act) = policy.remove("askBeforeAct")
        {
            policy.insert("ask_before_act".into(), ask_before_act);
        }
        if !policy.contains_key("risk_ceiling")
            && let Some(risk_ceiling) = policy.remove("riskCeiling")
        {
            policy.insert("risk_ceiling".into(), risk_ceiling);
        }
        policy.entry("risk_ceiling").or_insert_with(|| json!("low"));
        policy.entry("automatic").or_insert_with(|| json!(false));
        policy
            .entry("ask_before_act")
            .or_insert_with(|| json!(true));
    }
    json!({
        "role_id": input.role_id.trim(),
        "endpoint_ref": input.endpoint_ref.trim(),
        "endpoint_kind": endpoint_kind(&input.endpoint_ref).unwrap_or_default(),
        "display_name": input.display_name.trim(),
        "capability_tags": input.capability_tags.iter().map(|tag| tag.trim()).filter(|tag| !tag.is_empty()).collect::<Vec<_>>(),
        "autonomy_policy": autonomy_policy,
        "availability": input.availability,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_endpoint_must_belong_to_the_authorizing_member_and_role() {
        assert!(valid_endpoint_identity(
            "local_wework:7:review",
            7,
            "review"
        ));
        assert!(!valid_endpoint_identity(
            "local_wework:8:review",
            7,
            "review"
        ));
        assert!(!valid_endpoint_identity(
            "cloud_device:7:other",
            7,
            "review"
        ));
        assert!(!valid_endpoint_identity(
            "unregistered:7:review",
            7,
            "review"
        ));
        assert!(valid_endpoint_identity(
            "wegent_agent:7:agent-1:review",
            7,
            "review"
        ));
        assert!(!valid_endpoint_identity(
            "wegent_agent:8:agent-1:review",
            7,
            "review"
        ));
        assert!(!valid_endpoint_identity(
            "wegent_agent:7:agent-1:other",
            7,
            "review"
        ));
    }

    #[test]
    fn autonomy_policy_is_normalized_to_the_server_contract() {
        let input = RosterUpsert {
            user_id: 7,
            role_id: "review".into(),
            endpoint_ref: "local_wework:7:review".into(),
            display_name: "Reviewer".into(),
            enabled: true,
            capability_tags: Vec::new(),
            autonomy_policy: json!({"automatic":true,"askBeforeAct":false}),
            availability: "online".into(),
            version: 0,
        };
        let metadata = roster_metadata(&input);
        assert_eq!(metadata["autonomy_policy"]["ask_before_act"], false);
        assert_eq!(metadata["autonomy_policy"]["risk_ceiling"], "low");
    }
}
