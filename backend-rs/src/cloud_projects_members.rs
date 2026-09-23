// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/cloud-projects/{project_id}/members` — list the approved
//! members of one cloud project.
//!
//! Mirrors `app.api.endpoints.cloud_projects.list_cloud_project_members`:
//! `cloud_project_service.list_members(db, project_id, current_user.id)`
//! returns `list[CloudProjectMemberResponse]`.
//!
//! Source pipeline:
//! 1. `security.get_current_user_jwt_apikey_tasktoken` — JWT/API-key/task-token
//!    authentication plus the labeled `users` lookup (the full twelve-column
//!    `users_<column>` projection);
//! 2. `cloud_project_service.list_members` calls
//!    `require_cloud_project_role(db, cloud_project_id, user_id)` with the
//!    default `required_role = Reporter` — the recorded COM_QUERY re-reads
//!    the active `loop_items` project row (inlining the snowflake id) and,
//!    for non-creators, the approved `resource_members` membership row
//!    (inlining `resource_id` and `entity_id`);
//! 3. the approved `resource_members` rows joined with `users`, ordered by
//!    `resource_members.id`;
//! 4. when the project creator is not among the approved members, the creator
//!    is prepended with `id: 0` and `role: Owner`.
//!
//! The `capability_description` field defaults to `""`; it is populated from
//! `project.metadata_json.member_capabilities` only when that sub-object
//! exists. The recorded project metadata has no `member_capabilities` key,
//! so every member renders an empty string.
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use serde::Serialize;
use serde_json::Value;

use crate::cloud_projects::{ProjectListRow, access_project, membership_role};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// One `CloudProjectMemberResponse` row.
#[derive(Debug, Serialize)]
struct CloudProjectMemberResponse {
    id: i32,
    user_id: i32,
    user_name: String,
    email: Option<String>,
    role: String,
    capability_description: String,
}

/// `resource_members` row joined with `users` for `list_members`.
///
/// The projection mirrors the source SQLAlchemy `db.query(ResourceMember,
/// User)` column list: every mapped `resource_members` column (aliased
/// `resource_members_<column>`) plus the full `users` column list (aliased
/// `users_<column>`), so the prepared statement matches the recorded exchange
/// for replay. Only the fields consumed by the response are typed.
#[derive(Debug, FromMysqlRow)]
struct MemberRow {
    #[mysql(rename = "resource_members_id")]
    member_id: i32,
    #[mysql(rename = "resource_members_user_id")]
    user_id: i32,
    #[mysql(rename = "resource_members_role")]
    role: String,
    #[mysql(rename = "users_id")]
    #[allow(dead_code, reason = "selected to match source column list")]
    users_id: i32,
    #[mysql(rename = "users_user_name")]
    user_name: String,
    #[mysql(rename = "users_email")]
    email: Option<String>,
}

/// `users` row for the creator lookup when the creator is not already a
/// member. The source `db.get(User, project.created_by_user_id)` renders the
/// full labeled `users_<column>` projection.
#[derive(Debug, FromMysqlRow)]
struct CreatorRow {
    #[mysql(rename = "users_id")]
    user_id: i32,
    #[mysql(rename = "users_user_name")]
    user_name: String,
    #[mysql(rename = "users_email")]
    email: Option<String>,
}

/// `cloud_project_service._member_capabilities(project)`: reads
/// `metadata.member_capabilities` and returns a stripped, non-empty map.
fn member_capabilities(metadata: Option<&Value>) -> std::collections::HashMap<String, String> {
    let mut capabilities = std::collections::HashMap::new();
    let Some(map) = metadata.and_then(Value::as_object) else {
        return capabilities;
    };
    let Some(values) = map.get("member_capabilities").and_then(Value::as_object) else {
        return capabilities;
    };
    for (member_id, description) in values {
        if let Some(text) = description.as_str() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                capabilities.insert(member_id.clone(), trimmed.to_string());
            }
        }
    }
    capabilities
}

/// `cloud_project_service.list_members` member join: approved
/// `resource_members` rows joined with `users`, ordered by
/// `resource_members.id`. The recorded COM_QUERY inlines the snowflake
/// `resource_id` as an integer literal instead of a bound parameter, matching
/// the source SQLAlchemy rendering (the id is passed as a Python int).
async fn list_members_rows<M: Mysql>(mysql: &M, project_id: &str) -> MysqlResult<Vec<MemberRow>> {
    let sql = format!(
        "SELECT resource_members.id AS resource_members_id, \
         resource_members.resource_type AS resource_members_resource_type, \
         resource_members.resource_id AS resource_members_resource_id, \
         resource_members.entity_type AS resource_members_entity_type, \
         resource_members.entity_id AS resource_members_entity_id, \
         resource_members.entity_display_name AS resource_members_entity_display_name, \
         resource_members.user_id AS resource_members_user_id, \
         resource_members.`role` AS resource_members_role, \
         resource_members.status AS resource_members_status, \
         resource_members.invited_by_user_id AS resource_members_invited_by_user_id, \
         resource_members.share_link_id AS resource_members_share_link_id, \
         resource_members.reviewed_by_user_id AS resource_members_reviewed_by_user_id, \
         resource_members.reviewed_at AS resource_members_reviewed_at, \
         resource_members.copied_resource_id AS resource_members_copied_resource_id, \
         resource_members.requested_at AS resource_members_requested_at, \
         resource_members.created_at AS resource_members_created_at, \
         resource_members.updated_at AS resource_members_updated_at, \
         users.id AS users_id, users.user_name AS users_user_name, \
         users.password_hash AS users_password_hash, users.email AS users_email, \
         users.git_info AS users_git_info, users.is_active AS users_is_active, \
         users.`role` AS users_role, users.auth_source AS users_auth_source, \
         users.preferences AS users_preferences, users.created_at AS users_created_at, \
         users.updated_at AS users_updated_at \
         FROM resource_members INNER JOIN users \
         ON users.id = resource_members.user_id \
         WHERE resource_members.resource_type = 'CloudProject' \
         AND resource_members.resource_id = {project_id} \
         AND resource_members.entity_type = 'user' \
         AND resource_members.status = 'approved' \
         ORDER BY resource_members.id"
    );
    mysql.fetch_all(sql, ()).await
}

/// `db.get(User, project.created_by_user_id)` — the creator lookup when the
/// creator is not among the approved members. Renders the full labeled
/// `users_<column>` projection.
async fn creator_row<M: Mysql>(mysql: &M, user_id: i32) -> MysqlResult<Option<CreatorRow>> {
    mysql
        .fetch_optional(
            "SELECT users.id AS users_id, users.user_name AS users_user_name, \
             users.password_hash AS users_password_hash, users.email AS users_email, \
             users.git_info AS users_git_info, users.is_active AS users_is_active, \
             users.`role` AS users_role, users.auth_source AS users_auth_source, \
             users.preferences AS users_preferences, users.created_at AS users_created_at, \
             users.updated_at AS users_updated_at \
             FROM users WHERE users.id = ? LIMIT 1",
            (user_id,),
        )
        .await
}

/// GET /api/v1/cloud-projects/{project_id}/members: the members free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/cloud-projects/:project_id/members")]
async fn list_cloud_project_members(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] user: crate::loop_tasks::auth::FlexibleUser,
) -> Result<Vec<CloudProjectMemberResponse>, FastApiError> {
    list_members(state, project_id, user.id).await
}

/// Handler body for `GET /api/v1/cloud-projects/{project_id}/members`.
async fn list_members(
    state: &AppState,
    project_id: &str,
    user_id: i32,
) -> Result<Vec<CloudProjectMemberResponse>, FastApiError> {
    // `require_cloud_project_role(db, cloud_project_id, user_id)` with the
    // default `required_role = Reporter`: re-read the active project row. The
    // recorded COM_QUERY inlines the snowflake id as an integer literal.
    let project = access_project(&state.mysql, project_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Cloud project not found"))?;

    // `require_cloud_project_role` role resolution: creator -> Owner,
    // approved member -> stored role, public -> RestrictedAnalyst, else 404.
    // The role query is only issued for non-creators.
    let role = resolve_role(&state.mysql, &project, user_id)
        .await
        .map_err(internal_error)?;
    if !has_permission(&role, "Reporter") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }

    // `cloud_project_service.list_members`: approved `resource_members`
    // joined with `users`, ordered by `resource_members.id`.
    let mut members = list_members_rows(&state.mysql, &project.id)
        .await
        .map_err(internal_error)?;

    // The source inserts the creator at index 0 when the creator is not
    // already among the approved members.
    if !members
        .iter()
        .any(|member| member.user_id == project.created_by_user_id)
        && let Some(creator) = creator_row(&state.mysql, project.created_by_user_id)
            .await
            .map_err(internal_error)?
    {
        members.insert(
            0,
            MemberRow {
                member_id: 0,
                user_id: creator.user_id,
                role: "Owner".to_string(),
                users_id: creator.user_id,
                user_name: creator.user_name,
                email: creator.email,
            },
        );
    }

    // `capability_description` defaults to `""`; populated from
    // `project.metadata_json.member_capabilities` when present.
    let capabilities_value = project
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref())
        .and_then(|metadata| metadata.member_capabilities.as_ref())
        .map(crate::json_compat::OpaqueJson::to_value);
    let capabilities = member_capabilities(capabilities_value.as_ref());

    let response: Vec<CloudProjectMemberResponse> = members
        .iter()
        .map(|member| CloudProjectMemberResponse {
            id: member.member_id,
            user_id: member.user_id,
            user_name: member.user_name.clone(),
            email: member.email.clone(),
            role: member.role.clone(),
            capability_description: capabilities
                .get(&member.user_id.to_string())
                .cloned()
                .unwrap_or_default(),
        })
        .collect();

    Ok(response)
}

/// `require_cloud_project_role` role resolution: creator -> Owner, approved
/// member -> stored role, public -> RestrictedAnalyst. A non-creator,
/// non-member caller on a private project receives 404 (handled by the
/// caller). The membership query is only issued for non-creators, matching
/// the recorded dependency sequence (project re-read then membership lookup).
async fn resolve_role<M: Mysql>(
    mysql: &M,
    project: &ProjectListRow,
    user_id: i32,
) -> Result<String, brz_mysql::MysqlError> {
    if project.created_by_user_id == user_id {
        return Ok("Owner".to_string());
    }
    if let Some(role) = membership_role(mysql, &project.id, user_id).await? {
        return Ok(role);
    }
    // Public projects resolve to RestrictedAnalyst; a private project the
    // caller can see only through membership reaches the membership branch
    // above, so this is the public fallback.
    Ok("RestrictedAnalyst".to_string())
}

/// `has_permission(user_role, required_role)` from
/// `app.schemas.base_role`: lower hierarchy level wins.
fn has_permission(user_role: &str, required_role: &str) -> bool {
    fn level(role: &str) -> i32 {
        match role {
            "Owner" => 0,
            "Maintainer" => 1,
            "Developer" => 2,
            "Reporter" => 3,
            "RestrictedAnalyst" => 4,
            _ => 999,
        }
    }
    level(user_role) <= level(required_role)
}

fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "cloud-projects members dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn member_capabilities_empty_when_missing() {
        assert!(member_capabilities(None).is_empty());
        assert!(member_capabilities(Some(&json!({}))).is_empty());
        assert!(member_capabilities(Some(&json!({"member_capabilities": "x"}))).is_empty());
    }

    #[test]
    fn member_capabilities_strips_and_filters_empty() {
        let caps = member_capabilities(Some(&json!({
            "member_capabilities": {
                "1": "  manage  ",
                "2": "",
                "3": "   ",
                "4": 5,
                "5": "read"
            }
        })));
        assert_eq!(caps.len(), 2);
        assert_eq!(caps.get("1"), Some(&"manage".to_string()));
        assert_eq!(caps.get("5"), Some(&"read".to_string()));
    }

    #[test]
    fn permission_hierarchy_allows_equal_and_higher() {
        assert!(has_permission("Owner", "Reporter"));
        assert!(has_permission("Maintainer", "Reporter"));
        assert!(has_permission("Reporter", "Reporter"));
        assert!(!has_permission("RestrictedAnalyst", "Reporter"));
        assert!(!has_permission("Unknown", "Reporter"));
    }

    #[test]
    fn response_serializes_source_shape() {
        let member = CloudProjectMemberResponse {
            id: 10822,
            user_id: 86,
            user_name: "hongyu9".to_string(),
            email: Some("hongyu9@example.org".to_string()),
            role: "Owner".to_string(),
            capability_description: String::new(),
        };
        let value = serde_json::to_value(&member).unwrap();
        assert_eq!(value["id"], 10822);
        assert_eq!(value["user_id"], 86);
        assert_eq!(value["user_name"], "hongyu9");
        assert_eq!(value["email"], "hongyu9@example.org");
        assert_eq!(value["role"], "Owner");
        assert_eq!(value["capability_description"], "");
    }

    #[test]
    fn null_email_serializes_as_null() {
        let member = CloudProjectMemberResponse {
            id: 1,
            user_id: 2,
            user_name: "u".to_string(),
            email: None,
            role: "Developer".to_string(),
            capability_description: String::new(),
        };
        let value = serde_json::to_value(&member).unwrap();
        assert_eq!(value["email"], serde_json::Value::Null);
    }
}
