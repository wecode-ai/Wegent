// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/cloud-projects/{project_id}/members` — list the approved
//! members of one cloud project.
//!
//! Mirrors `app.api.endpoints.cloud_projects.list_cloud_project_members` ->
//! `cloud_project_service.list_members(db, project_id, current_user.id)`
//! returning `list[CloudProjectMemberResponse]`.
//!
//! Source pipeline:
//! 1. `security.get_current_user_jwt_apikey_tasktoken` — JWT/API-key/task-token
//!    authentication plus the labeled `users` lookup (the full twelve-column
//!    `users_<column>` projection);
//! 2. `require_cloud_project_role(db, cloud_project_id, user_id)` with the
//!    default `required_role = Viewer`: one `project_access_query` point
//!    statement that unions the direct, workspace-inherited, public
//!    (`authenticated_users`) and owned grants, reduces each project to
//!    `min(priority)`, and joins the active `loop_items` project row. The
//!    aggregated `anon_1.priority` is the caller's effective role;
//! 3. `explicit_project_member_ids(db, project)` — the creator plus the
//!    approved direct member entity ids — gates whether the caller may see
//!    member email addresses;
//! 4. the approved `resource_members` rows joined with `users`, ordered by
//!    `resource_members.id`;
//! 5. when the project creator is not among the approved members, the creator
//!    is prepended with `id: 0` and `role: Owner`.
//!
//! `capability_description` defaults to `""`; it is populated from
//! `project.metadata_json.member_capabilities` only when that sub-object
//! exists and holds a non-empty string per member id. The recorded project
//! metadata has no `member_capabilities` key, so every member renders an
//! empty string.
//!
//! The `project_access_query` point statement comes from the shared
//! [`crate::cloud_projects::project_access_point_statement`] renderer, which
//! reproduces the recorded COM_QUERY with the caller and project ids inline.
//! The shared `cloud_projects::response` projection is not reused because the
//! members route decodes its own response shape.
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult, MysqlRow};
use serde::Serialize;
use serde_json::{Value, json};

use crate::cloud_projects::{ProjectListRow, project_access_point_statement};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// One `CloudProjectMemberResponse` row, rendered in source schema order.
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

/// `require_cloud_project_role` project+role read: the accessible active
/// project row and the aggregated role priority, or `None` when no permission
/// source grants the caller access (the source raises `404`).
pub(crate) async fn access_project<M: Mysql>(
    mysql: &M,
    project_id: i64,
    user_id: i32,
) -> MysqlResult<Option<(ProjectListRow, i64)>> {
    let row: Option<MysqlRow> = mysql
        .fetch_optional(project_access_point_statement(user_id, project_id), ())
        .await?;
    row.map(|row| {
        // The joined aggregate supplies the caller's role priority; read it
        // before the typed project projection consumes the row.
        let priority: i64 = row.get_required("anon_1_priority")?;
        ProjectListRow::from_mysql_row(row).map(|project| (project, priority))
    })
    .transpose()
}

/// `cloud_project_visibility.ROLES_BY_PRIORITY`: the role a `min(priority)`
/// value stands for (`ROLE_HIERARCHY` inverted).
fn role_by_priority(priority: i64) -> &'static str {
    match priority {
        0 => "Owner",
        1 => "Maintainer",
        2 => "Developer",
        3 => "Reporter",
        4 => "Viewer",
        5 => "RestrictedAnalyst",
        // The union's `CASE`/literal priorities only emit 0-5; the source
        // indexes `ROLES_BY_PRIORITY[priority]` and would raise on any other
        // value, but an aggregate cannot produce one.
        _ => "RestrictedAnalyst",
    }
}

/// `cloud_project_visibility.explicit_project_member_ids`: returns whether the
/// caller is the creator or an approved direct member, which decides whether
/// member email addresses are visible.
///
/// The source adds the creator id and every approved direct member's
/// `entity_id` (roles `Owner`/`Maintainer`/`Developer`/`Viewer`) to a set and
/// tests membership. The recorded COM_QUERY selects only `entity_id`.
async fn can_view_emails<M: Mysql>(
    mysql: &M,
    project_id: i64,
    created_by_user_id: i32,
    user_id: i32,
) -> MysqlResult<bool> {
    #[derive(Debug, FromMysqlRow)]
    struct EntityRow {
        #[mysql(rename = "resource_members_entity_id")]
        entity_id: Option<String>,
    }
    let sql = format!(
        "SELECT resource_members.entity_id AS resource_members_entity_id \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'CloudProject' AND resource_members.resource_id = '{project_id}' AND resource_members.entity_type = 'user' AND resource_members.status = 'approved' AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Viewer')"
    );
    // The source always issues this read; the creator id is added to the set
    // in Python regardless of the query result.
    let rows: Vec<EntityRow> = mysql.fetch_all(sql, ()).await?;
    if created_by_user_id == user_id {
        return Ok(true);
    }
    Ok(rows
        .iter()
        .filter_map(|row| row.entity_id.as_deref())
        .filter_map(|entity_id| entity_id.parse::<i64>().ok())
        .any(|entity_id| entity_id == i64::from(user_id)))
}

/// `cloud_project_service.list_members` member join: approved
/// `resource_members` rows joined with `users`, ordered by
/// `resource_members.id`. The recorded COM_QUERY inlines the snowflake
/// `resource_id` as an integer literal, matching the source SQLAlchemy
/// rendering (the id is passed as a Python int).
async fn list_members_rows<M: Mysql>(mysql: &M, project_id: i64) -> MysqlResult<Vec<MemberRow>> {
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
         users.updated_at AS users_updated_at \n\
         FROM resource_members INNER JOIN users ON users.id = resource_members.user_id \n\
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
    // FastAPI parses `project_id` as `int`; a non-integer path segment is a
    // 422 validation error.
    let project_id_num: i64 = project_id.parse().map_err(|_| path_int_error(project_id))?;

    // `require_cloud_project_role(db, cloud_project_id, user_id)` with the
    // default `required_role = Viewer`.
    let access = access_project(&state.mysql, project_id_num, user_id)
        .await
        .map_err(internal_error)?;
    let (project, priority) = access
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Cloud project not found"))?;
    let role = role_by_priority(priority);
    if !has_permission(role, "Viewer") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }

    // `explicit_project_member_ids(db, project)` gates email visibility.
    let can_view_emails = can_view_emails(
        &state.mysql,
        project_id_num,
        project.created_by_user_id,
        user_id,
    )
    .await
    .map_err(internal_error)?;

    // `list_members`: approved `resource_members` joined with `users`.
    let mut members = list_members_rows(&state.mysql, project_id_num)
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
        .map(brz_json::OpaqueJson::to_value);
    let capabilities = member_capabilities(capabilities_value.as_ref());

    let response: Vec<CloudProjectMemberResponse> = members
        .iter()
        .map(|member| CloudProjectMemberResponse {
            id: member.member_id,
            user_id: member.user_id,
            user_name: member.user_name.clone(),
            email: if can_view_emails {
                member.email.clone()
            } else {
                None
            },
            role: member.role.clone(),
            capability_description: capabilities
                .get(&member.user_id.to_string())
                .cloned()
                .unwrap_or_default(),
        })
        .collect();

    Ok(response)
}

/// `app.schemas.base_role.has_permission`: lower hierarchy level wins. The
/// hierarchy is `Owner`, `Maintainer`, `Developer`, `Reporter`, `Viewer`,
/// `RestrictedAnalyst`.
fn has_permission(user_role: &str, required_role: &str) -> bool {
    fn level(role: &str) -> i32 {
        match role {
            "Owner" => 0,
            "Maintainer" => 1,
            "Developer" => 2,
            "Reporter" => 3,
            "Viewer" => 4,
            "RestrictedAnalyst" => 5,
            _ => 999,
        }
    }
    level(user_role) <= level(required_role)
}

/// FastAPI `422` body for a path parameter that is not an integer.
fn path_int_error(input: &str) -> FastApiError {
    FastApiError::validation(json!([{
        "type": "int_parsing",
        "loc": ["path", "project_id"],
        "msg": "Input should be a valid integer, unable to parse string as an integer",
        "input": input,
    }]))
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
        assert!(has_permission("Viewer", "Viewer"));
        assert!(has_permission("Reporter", "Viewer"));
        assert!(!has_permission("RestrictedAnalyst", "Viewer"));
        assert!(!has_permission("Unknown", "Reporter"));
    }

    #[test]
    fn role_priorities_map_to_the_role_hierarchy() {
        assert_eq!(role_by_priority(0), "Owner");
        assert_eq!(role_by_priority(1), "Maintainer");
        assert_eq!(role_by_priority(2), "Developer");
        assert_eq!(role_by_priority(3), "Reporter");
        assert_eq!(role_by_priority(4), "Viewer");
        assert_eq!(role_by_priority(5), "RestrictedAnalyst");
    }

    #[test]
    fn point_statement_inlines_caller_and_project() {
        let sql = project_access_point_statement(6177, 1712605396200092385);
        assert!(sql.contains("resource_members.entity_id = '6177'"));
        assert!(sql.contains("resource_members.resource_id = 1712605396200092385"));
        assert!(sql.contains("loop_items.created_by_user_id = 6177"));
        assert!(sql.contains("loop_items.id = '1712605396200092385'"));
        assert!(sql.contains("AND loop_items.resource_type IN ('project') \n LIMIT 1"));
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
