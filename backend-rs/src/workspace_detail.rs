// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/workspaces/{workspace_id}` — one collaboration Workspace
//! visible to the current user
//! (`app.api.endpoints.workspaces.get_workspace`, router prefix
//! `/v1/workspaces` under the app prefix `/api`).
//!
//! Source pipeline (the deployed `require_workspace_role` shape, before the
//! space/project permission unification):
//!
//! 1. `security.get_current_user_jwt_apikey_tasktoken` — flexible JWT /
//!    API-key / task-token dependency with the labeled `users` by-name
//!    lookup;
//! 2. `require_workspace_role(db, workspace_id, user_id)` (default
//!    `Reporter`): `get_workspace_kind` reads the active
//!    `CollaborationWorkspace` `kinds` row, then the caller's approved
//!    `resource_members` membership row resolves the effective role. A
//!    missing kind or membership is `404 "Workspace not found"`, an unknown
//!    role string is `403 "Invalid Workspace role"`, and a role above
//!    `Reporter` is `403 "Insufficient permission"`;
//! 3. `_response` recomputes `workspace_service.access(db, workspace_id,
//!    user_id).role` — a second `require_workspace_role` pass that re-reads
//!    both rows — and `workspace_service.summary_counts` resolves
//!    `member_count`/`project_count`/`agent_count`/
//!    `execution_environment_count` through four separate `count(...)`
//!    statements.
//!
//! The response is `WorkspaceResponse` (`app.schemas.workspace`) with the
//! schema field order; `id` serializes as a string (SnowflakeId) and the
//! `execution_environment` renders the shared
//! [`crate::workspace_rendering`] model_dump.
//!
//! The recorded session closes with two implicit `ROLLBACK`s; the driver's
//! read-only-session evidence lets Replay classify them as optional cleanup,
//! so no rollback statements are issued here.

use brz_http_server::StatusCode;
use brz_json::OpaqueJson;
use brz_mysql::{FromMysqlRow, Json, Mysql};
use chrono::NaiveDateTime;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::workspace_rendering::{ExecutionEnvironment, datetime_value, execution_environment};

/// `kinds` projection rendered by the source `db.query(Kind)` (SQLAlchemy
/// labels every column `kinds_<name>`), matching the recorded
/// `get_workspace_kind` exchange.
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// `resource_members` projection rendered by the source
/// `db.query(ResourceMember)` (SQLAlchemy labels every column
/// `resource_members_<name>`).
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

/// The `Reporter` role level from `app.schemas.base_role.ROLE_HIERARCHY`
/// (lower is more privileged); a role above this level cannot read a
/// Workspace.
const REPORTER_LEVEL: u8 = 3;

/// The active `CollaborationWorkspace` `kinds` row, selected with the full
/// labeled source column list so the prepared statement matches the recorded
/// exchange.
#[derive(Debug, FromMysqlRow)]
struct WorkspaceKindRow {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[mysql(rename = "kinds_user_id")]
    user_id: i32,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_kind")]
    kind: String,
    #[mysql(rename = "kinds_name")]
    name: String,
    #[mysql(rename = "kinds_namespace")]
    namespace: String,
    #[mysql(rename = "kinds_json")]
    json: Json<OpaqueJson>,
    #[mysql(rename = "kinds_is_active")]
    is_active: i8,
    #[mysql(rename = "kinds_created_at")]
    created_at: NaiveDateTime,
    #[mysql(rename = "kinds_updated_at")]
    updated_at: NaiveDateTime,
}

/// The caller's approved membership row; only the effective role feeds
/// `BaseRole(role)` and `has_permission`.
#[derive(Debug, FromMysqlRow)]
struct MembershipRow {
    #[mysql(rename = "resource_members_role")]
    role: String,
}

/// One `_grant_count` result.
#[derive(Debug, FromMysqlRow)]
struct CountRow {
    count_1: i64,
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

/// `_grant_count` with `resource_side` filters by the numeric
/// `resource_id`; otherwise by the string `entity_id`.
fn grant_count_sql(resource_type: &str, workspace_id: i64, resource_side: bool) -> String {
    let scope = if resource_side {
        format!("resource_members.resource_id = {workspace_id}")
    } else {
        format!("resource_members.entity_id = '{workspace_id}'")
    };
    format!(
        "SELECT count(resource_members.id) AS count_1 \nFROM resource_members \nWHERE resource_members.resource_type = '{resource_type}' AND resource_members.entity_type = '{}' AND resource_members.status = 'approved' AND {scope}",
        if resource_side { "user" } else { "workspace" }
    )
}

/// `BaseRole` string -> `ROLE_HIERARCHY` level; an unknown string is `None`,
/// mirroring the source `BaseRole(role)` `ValueError`.
fn role_level(role: &str) -> Option<u8> {
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

/// `WorkspaceResponse` (`app.schemas.workspace`), rendered in the source
/// schema field order. Snowflake `id` serializes as a string.
#[derive(Debug, serde::Serialize)]
struct WorkspaceBody {
    #[serde(rename = "id")]
    id: String,
    public_id: String,
    name: String,
    description: String,
    namespace: String,
    created_by_user_id: i32,
    access_role: String,
    member_count: i64,
    project_count: i64,
    agent_count: i64,
    execution_environment_count: i64,
    execution_environment: ExecutionEnvironment,
    is_default: bool,
    status: &'static str,
    version: i64,
    created_at: String,
    updated_at: String,
}

/// `WorkspaceAccess`: the `get_workspace_kind` row and the effective role
/// resolved from the caller's membership row.
struct WorkspaceAccess {
    kind: WorkspaceKindRow,
    role: String,
}

/// `require_workspace_role(db, workspace_id, user_id)`: reads the kind row and
/// the membership row, then applies the `Reporter` permission check.
async fn require_workspace_role<M: Mysql>(
    mysql: &M,
    workspace_id: i64,
    user_id: i32,
) -> Result<WorkspaceAccess, FastApiError> {
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
    let level = role_level(&membership.role)
        .ok_or_else(|| FastApiError::forbidden("Invalid Workspace role"))?;
    if level > REPORTER_LEVEL {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }
    Ok(WorkspaceAccess {
        kind,
        role: membership.role,
    })
}

/// `workspace_service.summary_counts` (`_grant_count` per field), in the
/// source statement order: members, projects, agents, devices.
async fn summary_counts<M: Mysql>(mysql: &M, workspace_id: i64) -> Result<[i64; 4], FastApiError> {
    let queries = [
        grant_count_sql("Workspace", workspace_id, true),
        grant_count_sql("CloudProject", workspace_id, false),
        grant_count_sql("Team", workspace_id, false),
        grant_count_sql("Device", workspace_id, false),
    ];
    let mut counts = [0; 4];
    for (slot, sql) in queries.into_iter().enumerate() {
        let row: Option<CountRow> = mysql
            .fetch_optional(sql, ())
            .await
            .map_err(internal_error)?;
        counts[slot] = row.map(|row| row.count_1).unwrap_or(0);
    }
    Ok(counts)
}

fn workspace_not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Workspace not found")
}

fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "workspace point read dependency failure");
    FastApiError::unhandled()
}

/// GET /api/v1/workspaces/{workspace_id}: the single-workspace free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/workspaces/:workspace_id")]
async fn get_workspace(
    #[inject(state)] state: &AppState,
    workspace_id: &str,
    #[auth] current_user: SessionUser,
) -> Result<WorkspaceBody, FastApiError> {
    // FastAPI parses `workspace_id` as `int`; any other text is a 422
    // `int_parsing` validation error.
    let workspace_id: i64 = workspace_id
        .parse()
        .map_err(|_| path_int_error(workspace_id))?;
    workspace_body(&state.mysql, workspace_id, current_user.0.id).await
}

/// FastAPI `422` body for a path parameter that is not an integer.
fn path_int_error(input: &str) -> FastApiError {
    FastApiError::validation(serde_json::json!([{
        "type": "int_parsing",
        "loc": ["path", "workspace_id"],
        "msg": "Input should be a valid integer, unable to parse string as an integer",
        "input": input,
    }]))
}

/// Handler body for `GET /api/v1/workspaces/{workspace_id}`.
///
/// `_response` runs `workspace_service.access` after `workspace_service.get`,
/// so the kind and membership rows are each read twice, exactly like the
/// recorded dependency sequence.
async fn workspace_body<M: Mysql>(
    mysql: &M,
    workspace_id: i64,
    user_id: i32,
) -> Result<WorkspaceBody, FastApiError> {
    let WorkspaceAccess { kind, .. } = require_workspace_role(mysql, workspace_id, user_id).await?;
    // `workspace_service.access(...).role` recomputes `require_workspace_role`,
    // so the kind and membership rows are each read again; only its role
    // reaches the response.
    let WorkspaceAccess { role, .. } = require_workspace_role(mysql, workspace_id, user_id).await?;
    let [
        member_count,
        project_count,
        agent_count,
        execution_environment_count,
    ] = summary_counts(mysql, workspace_id).await?;

    let json = kind.json.0.to_value();
    let metadata = json.get("metadata").and_then(serde_json::Value::as_object);
    let spec = json.get("spec").and_then(serde_json::Value::as_object);
    let status = json.get("status").and_then(serde_json::Value::as_object);
    let description = spec
        .and_then(|object| object.get("description"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    let is_default = spec
        .and_then(|object| object.get("isDefault"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let public_id = metadata
        .and_then(|object| object.get("publicId"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| kind.id.to_string());
    let version = status
        .and_then(|object| object.get("version"))
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(1);

    Ok(WorkspaceBody {
        id: kind.id.to_string(),
        public_id,
        name: kind.name,
        description,
        namespace: kind.namespace,
        created_by_user_id: kind.user_id,
        access_role: role,
        member_count,
        project_count,
        agent_count,
        execution_environment_count,
        execution_environment: execution_environment(&json)?,
        is_default,
        status: if kind.is_active != 0 {
            "active"
        } else {
            "archived"
        },
        version,
        created_at: datetime_value(kind.created_at),
        updated_at: datetime_value(kind.updated_at),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;

    fn normalize(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn workspace_kind_sql_matches_recorded_shape() {
        let sql = workspace_kind_sql(1805582);
        assert!(sql.starts_with("SELECT kinds.id AS kinds_id, "));
        assert!(sql.contains("FROM kinds \nWHERE kinds.id = 1805582"));
        assert!(sql.contains("kinds.kind = 'CollaborationWorkspace'"));
        assert!(sql.contains("kinds.is_active IS true \n LIMIT 1"));
    }

    #[test]
    fn membership_sql_binds_string_user_number_workspace() {
        let sql = membership_sql(1805582, 6177);
        assert!(sql.contains("resource_members.resource_id = 1805582"));
        assert!(sql.contains("resource_members.entity_id = '6177'"));
        assert!(sql.contains("resource_members.status = 'approved' \n LIMIT 1"));
        assert!(sql.contains("resource_members.entity_display_name AS"));
    }

    #[test]
    fn grant_count_sql_matches_recorded_scopes() {
        let member = grant_count_sql("Workspace", 1805582, true);
        assert_eq!(
            normalize(&member),
            normalize(
                "SELECT count(resource_members.id) AS count_1 \nFROM resource_members \n\
                 WHERE resource_members.resource_type = 'Workspace' AND \
                 resource_members.entity_type = 'user' AND \
                 resource_members.status = 'approved' AND \
                 resource_members.resource_id = 1805582"
            )
        );
        let device = grant_count_sql("Device", 1805582, false);
        assert!(device.contains("resource_members.entity_type = 'workspace'"));
        assert!(device.contains("resource_members.entity_id = '1805582'"));
    }

    #[test]
    fn role_level_covers_source_hierarchy() {
        assert_eq!(role_level("Owner"), Some(0));
        assert_eq!(role_level("Reporter"), Some(REPORTER_LEVEL));
        assert_eq!(role_level("Viewer"), Some(4));
        assert_eq!(role_level("Nonsense"), None);
    }

    #[tokio::test]
    async fn missing_workspace_kind_is_not_found_after_one_query() {
        let mysql = KindQueryCapture::default();
        let error = workspace_body(&mysql, 1805582, 6177).await.unwrap_err();
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(error.detail_message(), Some("Workspace not found"));
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains("FROM kinds"));
        assert!(queries[0].sql.contains("CollaborationWorkspace"));
    }

    #[test]
    fn path_int_error_renders_fastapi_validation_body() {
        let error = path_int_error("abc");
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = error.validation_detail();
        assert!(body.contains("int_parsing"), "body: {body}");
        assert!(body.contains("workspace_id"), "body: {body}");
    }

    #[test]
    fn response_serializes_schema_order() {
        let response = WorkspaceBody {
            id: "1805582".to_string(),
            public_id: "c592c1fa-634e-4f5c-ae61-25b24d0d14b6".to_string(),
            name: "test123".to_string(),
            description: String::new(),
            namespace: "default".to_string(),
            created_by_user_id: 6177,
            access_role: "Owner".to_string(),
            member_count: 1,
            project_count: 1,
            agent_count: 0,
            execution_environment_count: 2,
            execution_environment: crate::workspace_rendering::ExecutionEnvironment {
                workspace_policy: "git_worktree",
                repositories: Vec::new(),
                setup_steps: Vec::new(),
                fingerprint: String::new(),
                devices: serde_json::Map::new(),
            },
            is_default: false,
            status: "active",
            version: 1,
            created_at: "2026-10-14T03:31:30".to_string(),
            updated_at: "2026-10-14T03:31:30".to_string(),
        };
        let rendered = crate::json_contract_tests::serialized(&response).unwrap();
        let keys: Vec<&str> = rendered
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "id",
                "public_id",
                "name",
                "description",
                "namespace",
                "created_by_user_id",
                "access_role",
                "member_count",
                "project_count",
                "agent_count",
                "execution_environment_count",
                "execution_environment",
                "is_default",
                "status",
                "version",
                "created_at",
                "updated_at"
            ]
        );
        assert_eq!(rendered["id"], "1805582");
        assert_eq!(rendered["execution_environment_count"], 2);
    }
}
