// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/workspaces` — list the collaboration Workspaces accessible to
//! the current user
//! (`app.api.endpoints.workspaces.list_workspaces`, router prefix
//! `/v1/workspaces` under the app prefix `/api`).
//!
//! Source pipeline:
//! 1. `security.get_current_user_jwt_apikey_tasktoken` — JWT session decode
//!    plus the labeled `users` lookup (the full twelve-column
//!    `users_<column>` projection);
//! 2. `workspace_service.list_accessible(db, current_user.id)` —
//!    `cloud_project_visibility.readable_workspace_ids` returns the active
//!    `CollaborationWorkspace` rows where the caller holds an approved
//!    `Owner`/`Maintainer`/`Developer`/`Reporter` membership, ordered by
//!    `updated_at DESC`, then the sequence is re-sorted default-first by
//!    `(not is_default, -updated_at)`;
//! 3. `user_memberships` roles read — one `resource_members` projection of the
//!    effective role string per workspace id (the same five-role set);
//! 4. `_summary_counts` — one `resource_members` union that resolves the
//!    `member_count`/`project_count`/`agent_count`/
//!    `execution_environment_count` counts per workspace.
//!
//! The per-workspace body derives from the `kinds` row plus its `json` CRD
//! (`CollaborationWorkspace`), mirroring
//! `app.services.workspaces.storage.workspace_from_kind` and
//! `app.schemas.workspace.WorkspaceResponse`.

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::workspace_rendering::{ExecutionEnvironment, datetime_value, execution_environment};
use brz_http_server::StatusCode;
use brz_json::OpaqueJson;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use std::collections::HashMap;

/// `kinds` projection rendered by `db.query(Kind)` (SQLAlchemy labels every
/// column `kinds_<name>`).
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// A `CollaborationWorkspace` `kinds` row, selected with the full labeled
/// source column list so the prepared statement matches the recorded exchange.
#[derive(Debug, FromMysqlRow)]
struct WorkspaceRow {
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

/// `list_accessible`: the active `CollaborationWorkspace` rows readable by the
/// caller, newest first, through the `readable_workspace_ids` subquery.
async fn accessible_workspaces<M: Mysql>(
    mysql: &M,
    user_id: i32,
) -> MysqlResult<Vec<WorkspaceRow>> {
    mysql
        .fetch_all(
            format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true AND kinds.id IN (SELECT resource_members.resource_id \nFROM resource_members INNER JOIN kinds ON kinds.id = resource_members.resource_id \nWHERE resource_members.resource_type = 'Workspace' AND resource_members.entity_type = 'user' AND resource_members.entity_id = '{user_id}' AND resource_members.status = 'approved' AND kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Reporter')) ORDER BY kinds.updated_at DESC"
            ),
            (),
        )
        .await
}

/// `user_memberships(user_id, WORKSPACE, project_roles_only=False)`: the
/// effective role string per workspace, filtered to the requested ids.
async fn roles_by_workspace<M: Mysql>(
    mysql: &M,
    user_id: i32,
    ids: &[i64],
) -> MysqlResult<Vec<(i64, String)>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let list = ids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    #[derive(Debug, FromMysqlRow)]
    struct RoleRow {
        resource_id: i64,
        role: String,
    }
    let rows: Vec<RoleRow> = mysql
        .fetch_all(
            format!(
                "SELECT resource_members.resource_id, resource_members.`role` \nFROM resource_members \nWHERE resource_members.resource_type = 'Workspace' AND resource_members.entity_type = 'user' AND resource_members.entity_id = '{user_id}' AND resource_members.status = 'approved' AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Reporter', 'RestrictedAnalyst') AND resource_members.resource_id IN ({list})"
            ),
            (),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| (row.resource_id, row.role))
        .collect())
}

/// `_summary_counts`: one union resolving the member/entity-resource counts per
/// workspace id.
async fn summary_counts<M: Mysql>(
    mysql: &M,
    ids: &[i64],
) -> MysqlResult<HashMap<i64, HashMap<&'static str, i64>>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    /// The `union_all` result columns come from the first `SELECT`, so the
    /// driver exposes them as `resource_id`, the SQLAlchemy anonymous label
    /// `anon_1` (the `'Workspace'` literal), and `count_1` (the first
    /// `count(...)`), matching the recorded exchange. Decode against those
    /// exact names rather than the semantic field names.
    #[derive(Debug, FromMysqlRow)]
    struct CountRow {
        #[mysql(rename = "resource_id")]
        workspace: i64,
        #[mysql(rename = "anon_1")]
        resource_type: String,
        #[mysql(rename = "count_1")]
        count: i64,
    }
    let numeric_list = ids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let string_list = ids
        .iter()
        .map(|id| format!("'{id}'"))
        .collect::<Vec<_>>()
        .join(", ");
    let rows: Vec<CountRow> = mysql
        .fetch_all(
            format!(
                "SELECT resource_members.resource_id, 'Workspace' AS anon_1, count(resource_members.id) AS count_1 \nFROM resource_members \nWHERE resource_members.resource_type = 'Workspace' AND resource_members.entity_type = 'user' AND resource_members.status = 'approved' AND resource_members.resource_id IN ({numeric_list}) GROUP BY resource_members.resource_id UNION ALL SELECT CAST(resource_members.entity_id AS SIGNED INTEGER) AS entity_id, resource_members.resource_type, count(resource_members.id) AS count_2 \nFROM resource_members \nWHERE resource_members.resource_type IN ('CloudProject', 'Team', 'Device') AND resource_members.entity_type = 'workspace' AND resource_members.status = 'approved' AND resource_members.entity_id IN ({string_list}) GROUP BY resource_members.entity_id, resource_members.resource_type"
            ),
            (),
        )
        .await?;
    let mut output: HashMap<i64, HashMap<&'static str, i64>> = HashMap::new();
    for row in rows {
        let key = match row.resource_type.as_str() {
            "Workspace" => "member_count",
            "CloudProject" => "project_count",
            "Team" => "agent_count",
            "Device" => "execution_environment_count",
            _ => continue,
        };
        output
            .entry(row.workspace)
            .or_default()
            .insert(key, row.count);
    }
    Ok(output)
}

/// The `WorkspaceResponse` body, mirroring the schema field order.
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

/// `WorkspaceListResponse`.
#[derive(Debug, serde::Serialize)]
struct WorkspaceListResponse {
    items: Vec<WorkspaceBody>,
}

/// `workspace_from_kind` over one `kinds` row.
fn workspace_crd(json: &serde_json::Value) -> WorkspaceCrdView {
    let spec = json.get("spec").and_then(serde_json::Value::as_object);
    let metadata = json.get("metadata").and_then(serde_json::Value::as_object);
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
        .map(str::to_string);
    let version = status
        .and_then(|object| object.get("version"))
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(1);
    WorkspaceCrdView {
        description,
        is_default,
        public_id,
        version,
    }
}

/// The subset of the `CollaborationWorkspace` CRD the response reads.
struct WorkspaceCrdView {
    description: String,
    is_default: bool,
    public_id: Option<String>,
    version: i64,
}

/// GET /api/v1/workspaces: the workspaces free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/v1/workspaces")]
async fn list_workspaces(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
) -> Result<WorkspaceListResponse, FastApiError> {
    workspaces_list(&state.mysql, current_user.0.id).await
}

/// Handler body for `GET /api/v1/workspaces`.
async fn workspaces_list<M: Mysql>(
    mysql: &M,
    user_id: i32,
) -> Result<WorkspaceListResponse, FastApiError> {
    let mut workspaces = accessible_workspaces(mysql, user_id)
        .await
        .map_err(list_internal_error)?;
    // `sorted(workspaces, key=lambda item: (not item.is_default, -item.updated_at.timestamp()))`
    workspaces.sort_by(|left, right| {
        let key = |workspace: &WorkspaceRow| {
            let is_default = workspace
                .json
                .0
                .to_value()
                .get("spec")
                .and_then(|spec| spec.get("isDefault"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let updated_at = workspace.updated_at.and_utc().timestamp();
            (!is_default, -updated_at)
        };
        let (l_default, l_at) = key(left);
        let (r_default, r_at) = key(right);
        l_default.cmp(&r_default).then(l_at.cmp(&r_at))
    });

    let ids: Vec<i64> = workspaces.iter().map(|workspace| workspace.id).collect();
    let roles = roles_by_workspace(mysql, user_id, &ids)
        .await
        .map_err(list_internal_error)?;
    let roles: HashMap<i64, String> = roles.into_iter().collect();
    let counts = summary_counts(mysql, &ids)
        .await
        .map_err(list_internal_error)?;

    let items = workspaces
        .into_iter()
        .map(|workspace| -> Result<WorkspaceBody, FastApiError> {
            let json = workspace.json.0.to_value();
            let crd = workspace_crd(&json);
            let counts = counts.get(&workspace.id).cloned().unwrap_or_default();
            let access_role = roles.get(&workspace.id).map(String::as_str).unwrap_or("");
            Ok(WorkspaceBody {
                id: workspace.id.to_string(),
                public_id: crd.public_id.unwrap_or_else(|| workspace.id.to_string()),
                name: workspace.name,
                description: crd.description,
                namespace: workspace.namespace,
                created_by_user_id: workspace.user_id,
                access_role: access_role.to_string(),
                member_count: counts.get("member_count").copied().unwrap_or(0),
                project_count: counts.get("project_count").copied().unwrap_or(0),
                agent_count: counts.get("agent_count").copied().unwrap_or(0),
                execution_environment_count: counts
                    .get("execution_environment_count")
                    .copied()
                    .unwrap_or(0),
                execution_environment: execution_environment(&json)?,
                is_default: crd.is_default,
                status: if workspace.is_active != 0 {
                    "active"
                } else {
                    "archived"
                },
                version: crd.version,
                created_at: datetime_value(workspace.created_at),
                updated_at: datetime_value(workspace.updated_at),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(WorkspaceListResponse { items })
}

/// The list read's MySQL failure: `500 {"detail": "Internal server error"}`.
fn list_internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "workspaces dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;

    #[tokio::test]
    async fn empty_list_issues_no_roles_or_counts() {
        let mysql = KindQueryCapture::default();
        let response = workspaces_list(&mysql, 157).await.unwrap();
        assert_eq!(response.items.len(), 0);
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains("FROM kinds"));
        assert!(queries[0].sql.contains("CollaborationWorkspace"));
        assert!(queries[0].sql.contains(
            "resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Reporter')"
        ));
        assert!(!queries[0].sql.contains("RestrictedAnalyst"));
    }

    #[test]
    fn execution_environment_renders_schema_order() {
        let json = serde_json::json!({
            "spec": {"executionEnvironment": {"devices": {}, "fingerprint": "abc",
                "setup_steps": [], "repositories": []}}
        });
        let rendered =
            crate::json_contract_tests::serialized(execution_environment(&json).unwrap()).unwrap();
        let keys: Vec<&str> = rendered
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "workspace_policy",
                "repositories",
                "setup_steps",
                "fingerprint",
                "devices"
            ]
        );
        assert_eq!(rendered["workspace_policy"], "git_worktree");
        assert_eq!(rendered["fingerprint"], "abc");
    }

    #[test]
    fn naive_datetime_renders_second_precision() {
        let value =
            NaiveDateTime::parse_from_str("2026-09-14 06:39:15", "%Y-%m-%d %H:%M:%S").unwrap();
        assert_eq!(datetime_value(value), "2026-09-14T06:39:15");
    }
}
