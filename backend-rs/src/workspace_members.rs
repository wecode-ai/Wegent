// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/workspaces/{workspace_id}/members` — list the approved human
//! members of a collaboration Workspace
//! (`app.api.endpoints.workspaces.list_workspace_members` ->
//! `workspace_service.list_members`, router prefix `/v1/workspaces` under the
//! app prefix `/api`).
//!
//! Source pipeline:
//!
//! 1. `security.get_current_user_jwt_apikey_tasktoken` — JWT session decode
//!    plus the labeled `users` lookup (the full twelve-column
//!    `users_<column>` projection);
//! 2. `require_workspace_role(db, workspace_id, user_id)` (default
//!    `Reporter`): `get_workspace_kind` reads the active
//!    `CollaborationWorkspace` `kinds` row, then the caller's approved
//!    `resource_members` membership row resolves the effective role. A missing
//!    kind or membership is `404 "Workspace not found"`, an unknown role
//!    string is `403 "Invalid Workspace role"`, and a role below `Reporter` is
//!    `403 "Insufficient permission"`;
//! 3. `list_members` reads the approved user members through the
//!    `resource_members INNER JOIN users` projection ordered by
//!    `resource_members.id`;
//! 4. when the Workspace creator is not among the members, the creator's
//!    `users` row is prepended as `{"id": 0, "role": "Owner"}`.
//!
//! The response is `WorkspaceMemberListResponse` (`{"items": [...]}`) with the
//! schema field order `id`, `user_id`, `user_name`, `email`, `role`.
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Mysql};

use crate::auth::{SessionUser, UserRow};
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::user_reader::USER_BY_ID_QUERY;

/// `kinds` projection rendered by the source `db.query(Kind)` (SQLAlchemy
/// labels every column `kinds_<name>`), matching the recorded
/// `get_workspace_kind` exchange.
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// `resource_members` projection rendered by the source `db.query(ResourceMember)`
/// (SQLAlchemy labels every column `resource_members_<name>`).
const RESOURCE_MEMBER_COLUMNS: &str = "resource_members.id AS resource_members_id, \
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
     resource_members.updated_at AS resource_members_updated_at";

/// `users` projection rendered by the source `db.query(User)` (SQLAlchemy
/// labels every column `users_<name>`), used by the joined member listing.
const USER_COLUMNS: &str = "users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at";

/// The `Reporter` role level from `app.schemas.base_role.ROLE_HIERARCHY`
/// (lower is more privileged); a role above this level cannot read members.
const REPORTER_LEVEL: u8 = 3;

/// The `CollaborationWorkspace` id plus the creator id the response prepend
/// branch compares against (`workspace_from_kind(...).created_by_user_id`).
#[derive(Debug, FromMysqlRow)]
struct WorkspaceKindRow {
    #[mysql(rename = "kinds_user_id")]
    created_by_user_id: i32,
}

/// The caller's approved membership row; only the effective role feeds
/// `BaseRole(role)` and `has_permission`.
#[derive(Debug, FromMysqlRow)]
struct MembershipRow {
    #[mysql(rename = "resource_members_role")]
    role: String,
}

/// One row of the `resource_members INNER JOIN users` member listing.
#[derive(Debug, FromMysqlRow)]
struct MemberJoinRow {
    #[mysql(rename = "resource_members_id")]
    id: i64,
    #[mysql(rename = "resource_members_role")]
    role: String,
    #[mysql(rename = "users_id")]
    user_id: i32,
    #[mysql(rename = "users_user_name")]
    user_name: String,
    #[mysql(rename = "users_email")]
    email: Option<String>,
}

/// `WorkspaceMemberResponse` (`app.schemas.workspace`): `id`, `user_id`,
/// `user_name`, `email`, `role`.
#[derive(Debug, serde::Serialize)]
struct WorkspaceMemberBody {
    id: i64,
    user_id: i32,
    user_name: String,
    email: Option<String>,
    role: String,
}

/// `WorkspaceMemberListResponse`.
#[derive(Debug, serde::Serialize)]
struct WorkspaceMemberListResponse {
    items: Vec<WorkspaceMemberBody>,
}

/// `get_workspace_kind`: the active `CollaborationWorkspace` row for the id.
fn workspace_kind_sql(workspace_id: i64) -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id = {workspace_id} AND kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true \n LIMIT 1"
    )
}

/// `require_workspace_role`'s membership read: the caller's approved
/// `Workspace`/`user` row for the id.
fn membership_sql(workspace_id: i64, user_id: i32) -> String {
    format!(
        "SELECT {RESOURCE_MEMBER_COLUMNS} \nFROM resource_members \nWHERE resource_members.resource_type = 'Workspace' AND resource_members.resource_id = {workspace_id} AND resource_members.entity_type = 'user' AND resource_members.entity_id = '{user_id}' AND resource_members.status = 'approved' \n LIMIT 1"
    )
}

/// `list_members`: the approved user members with their owning `users` row,
/// ordered by `resource_members.id`.
fn members_sql(workspace_id: i64) -> String {
    format!(
        "SELECT {RESOURCE_MEMBER_COLUMNS}, {USER_COLUMNS} \nFROM resource_members INNER JOIN users ON users.id = resource_members.user_id \nWHERE resource_members.resource_type = 'Workspace' AND resource_members.resource_id = {workspace_id} AND resource_members.entity_type = 'user' AND resource_members.status = 'approved' ORDER BY resource_members.id"
    )
}

/// `BaseRole` string -> `ROLE_HIERARCHY` level; an unknown string is `None`,
/// mirroring the source `BaseRole(role)` `ValueError`.
pub(crate) fn role_level(role: &str) -> Option<u8> {
    match role {
        "Owner" => Some(0),
        "Maintainer" => Some(1),
        "Developer" => Some(2),
        "Reporter" => Some(3),
        "Viewer" => Some(4),
        "RestrictedAnalyst" => Some(5),
        _ => None,
    }
}

/// `has_permission(role, Reporter)`.
fn has_reporter_permission(role: &str) -> bool {
    role_level(role).is_some_and(|level| level <= REPORTER_LEVEL)
}

/// `require_workspace_role(...).workspace.created_by_user_id`.
async fn require_workspace_role<M: Mysql>(
    mysql: &M,
    workspace_id: i64,
    user_id: i32,
) -> Result<i32, FastApiError> {
    let kind: Option<WorkspaceKindRow> = mysql
        .fetch_optional(workspace_kind_sql(workspace_id), ())
        .await
        .map_err(internal_error)?;
    let kind = kind.ok_or_else(workspace_not_found)?;
    let membership: Option<MembershipRow> = mysql
        .fetch_optional(membership_sql(workspace_id, user_id), ())
        .await
        .map_err(internal_error)?;
    let membership = membership.ok_or_else(workspace_not_found)?;
    if role_level(&membership.role).is_none() {
        return Err(FastApiError::forbidden("Invalid Workspace role"));
    }
    if !has_reporter_permission(&membership.role) {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }
    Ok(kind.created_by_user_id)
}

fn workspace_not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Workspace not found")
}

fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "workspace members dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

/// GET /api/v1/workspaces/{workspace_id}/members: the free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/workspaces/:workspace_id/members")]
async fn list_workspace_members(
    #[inject(state)] state: &AppState,
    workspace_id: i64,
    #[auth] current_user: SessionUser,
) -> Result<WorkspaceMemberListResponse, FastApiError> {
    members_list(&state.mysql, workspace_id, current_user.0.id).await
}

/// Handler body for `GET /api/v1/workspaces/{workspace_id}/members`.
async fn members_list<M: Mysql>(
    mysql: &M,
    workspace_id: i64,
    user_id: i32,
) -> Result<WorkspaceMemberListResponse, FastApiError> {
    let created_by_user_id = require_workspace_role(mysql, workspace_id, user_id).await?;
    let rows: Vec<MemberJoinRow> = mysql
        .fetch_all(members_sql(workspace_id), ())
        .await
        .map_err(internal_error)?;
    let mut members: Vec<WorkspaceMemberBody> = rows
        .into_iter()
        .map(|row| WorkspaceMemberBody {
            id: row.id,
            user_id: row.user_id,
            user_name: row.user_name,
            email: row.email,
            role: row.role,
        })
        .collect();
    if !members
        .iter()
        .any(|member| member.user_id == created_by_user_id)
    {
        let creator: Option<UserRow> = mysql
            .fetch_optional(USER_BY_ID_QUERY, (i64::from(created_by_user_id),))
            .await
            .map_err(internal_error)?;
        if let Some(creator) = creator {
            members.insert(
                0,
                WorkspaceMemberBody {
                    id: 0,
                    user_id: creator.id,
                    user_name: creator.user_name,
                    email: creator.email,
                    role: "Owner".to_string(),
                },
            );
        }
    }
    Ok(WorkspaceMemberListResponse { items: members })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;

    #[test]
    fn workspace_kind_sql_matches_recorded_shape() {
        let sql = workspace_kind_sql(353932);
        assert!(sql.starts_with("SELECT kinds.id AS kinds_id, "));
        assert!(sql.contains("FROM kinds \nWHERE kinds.id = 353932"));
        assert!(sql.contains("kinds.kind = 'CollaborationWorkspace'"));
        assert!(sql.contains("kinds.is_active IS true \n LIMIT 1"));
    }

    #[test]
    fn membership_sql_binds_string_user_number_workspace() {
        let sql = membership_sql(353932, 157);
        assert!(sql.contains("resource_members.resource_id = 353932"));
        assert!(sql.contains("resource_members.entity_id = '157'"));
        assert!(sql.contains("resource_members.status = 'approved' \n LIMIT 1"));
    }

    #[test]
    fn members_sql_joins_users_and_orders_by_member_id() {
        let sql = members_sql(353932);
        assert!(sql.contains(
            "FROM resource_members INNER JOIN users ON users.id = resource_members.user_id"
        ));
        assert!(sql.contains("ORDER BY resource_members.id"));
        assert!(sql.contains("resource_members.entity_display_name AS"));
        assert!(sql.contains("users.password_hash AS users_password_hash"));
    }

    #[test]
    fn role_level_and_reporter_permission() {
        assert_eq!(role_level("Owner"), Some(0));
        assert_eq!(role_level("RestrictedAnalyst"), Some(5));
        assert_eq!(role_level("Nonsense"), None);
        assert!(has_reporter_permission("Owner"));
        assert!(has_reporter_permission("Reporter"));
        assert!(!has_reporter_permission("Viewer"));
        assert!(!has_reporter_permission("RestrictedAnalyst"));
    }

    #[tokio::test]
    async fn missing_workspace_kind_is_not_found() {
        let mysql = KindQueryCapture::default();
        let error = members_list(&mysql, 353932, 157).await.unwrap_err();
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(error.detail_message(), Some("Workspace not found"));
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains("FROM kinds"));
        assert!(queries[0].sql.contains("CollaborationWorkspace"));
    }

    #[test]
    fn response_serializes_schema_order_with_nullable_email() {
        let response = WorkspaceMemberListResponse {
            items: vec![WorkspaceMemberBody {
                id: 12492,
                user_id: 86,
                user_name: "hongyu9".to_string(),
                email: None,
                role: "Owner".to_string(),
            }],
        };
        let rendered = serde_json::to_value(&response).unwrap();
        let item = &rendered["items"][0];
        assert_eq!(
            item.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["id", "user_id", "user_name", "email", "role"]
        );
        assert_eq!(item["id"], 12492);
        assert_eq!(item["user_id"], 86);
        assert!(item["email"].is_null());
    }
}
