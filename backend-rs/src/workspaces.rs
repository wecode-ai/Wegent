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
//!    `CollaborationWorkspace` rows the caller owns or holds an approved
//!    `Owner`/`Maintainer`/`Developer`/`Viewer`/`Reporter` membership for,
//!    ordered by `updated_at DESC`, then the sequence is re-sorted
//!    default-first by `(not is_default, -updated_at)`;
//! 3. `user_memberships` roles read — one `resource_members` projection of the
//!    effective role string per workspace id (legacy `Owner`/`Reporter`
//!    grants normalize to `Maintainer`/`Viewer`); an owned workspace reports
//!    `Owner` without consulting that map;
//! 4. `_summary_counts` — one `resource_members` union that resolves the
//!    `member_count`/`project_count`/`agent_count`/
//!    `execution_environment_count` counts per workspace (`CloudProject`
//!    counts come from the active `loop_items` project rows linked through the
//!    project/workspace relationship, not from a resource grant).
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

/// `COLLABORATION_ROLE_ALIASES` from `app.schemas.base_role`: retained legacy
/// grants are interpreted on read, never rewritten in the stored row.
const ROLE_ALIAS_CASE: &str = "CASE resource_members.`role` WHEN 'Owner' THEN 'Maintainer' \
     WHEN 'Reporter' THEN 'Viewer' ELSE resource_members.`role` END";

/// `VALID_CLOUD_PROJECT_MEMBER_ROLES` (`app.services.cloud_project_visibility`).
const VALID_MEMBER_ROLES: &str = "('Owner', 'Maintainer', 'Developer', 'Viewer', 'Reporter')";

/// `list_accessible`: the active `CollaborationWorkspace` rows readable by the
/// caller through `readable_workspace_ids`, newest first. The statement mirrors
/// the source rendering: the membership subquery keeps the caller's effective
/// role, and the outer predicate accepts owned workspaces (`kinds.user_id`)
/// even without a membership row.
async fn accessible_workspaces<M: Mysql>(
    mysql: &M,
    user_id: i32,
) -> MysqlResult<Vec<WorkspaceRow>> {
    mysql
        .fetch_all(
            format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true AND kinds.id IN (SELECT kinds.id \nFROM kinds LEFT OUTER JOIN (SELECT resource_members.resource_id AS resource_id, {ROLE_ALIAS_CASE} AS `role` \nFROM resource_members \nWHERE resource_members.resource_type = 'Workspace' AND resource_members.entity_type = 'user' AND resource_members.entity_id = '{user_id}' AND resource_members.status = 'approved' AND resource_members.`role` IN {VALID_MEMBER_ROLES}) AS anon_1 ON anon_1.resource_id = kinds.id \nWHERE kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true AND (kinds.user_id = {user_id} OR anon_1.resource_id IS NOT NULL)) ORDER BY kinds.updated_at DESC"
            ),
            (),
        )
        .await
}

/// `user_memberships(user_id, WORKSPACE).where(resource_id.in_(ids))`: the
/// effective role string per workspace.
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
                "SELECT resource_members.resource_id, {ROLE_ALIAS_CASE} AS `role` \nFROM resource_members \nWHERE resource_members.resource_type = 'Workspace' AND resource_members.entity_type = 'user' AND resource_members.entity_id = '{user_id}' AND resource_members.status = 'approved' AND resource_members.`role` IN {VALID_MEMBER_ROLES} AND resource_members.resource_id IN ({list})"
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
///
/// The branches mirror the source `union_all`:
/// 1. approved human memberships of the workspace (`member_count`);
/// 2. approved `Team`/`Device` grants whose entity is the workspace
///    (`agent_count`/`execution_environment_count`);
/// 3. active project rows linked to the workspace through the single-parent
///    project/workspace relationship (`project_count`).
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
                "SELECT resource_members.resource_id, 'Workspace' AS anon_1, count(resource_members.id) AS count_1 \nFROM resource_members \nWHERE resource_members.resource_type = 'Workspace' AND resource_members.entity_type = 'user' AND resource_members.status = 'approved' AND resource_members.resource_id IN ({numeric_list}) GROUP BY resource_members.resource_id UNION ALL SELECT CAST(resource_members.entity_id AS SIGNED INTEGER) AS entity_id, resource_members.resource_type, count(resource_members.id) AS count_2 \nFROM resource_members \nWHERE resource_members.resource_type IN ('Team', 'Device') AND resource_members.entity_type = 'workspace' AND resource_members.status = 'approved' AND resource_members.entity_id IN ({string_list}) GROUP BY resource_members.entity_id, resource_members.resource_type UNION ALL SELECT anon_2.workspace_id, 'CloudProject' AS anon_3, count(loop_items.id) AS count_3 \nFROM (SELECT resource_members.resource_id AS project_id, CAST(min(resource_members.entity_id) AS SIGNED INTEGER) AS workspace_id \nFROM resource_members \nWHERE resource_members.resource_type = 'CloudProject' AND resource_members.entity_type = 'workspace' AND resource_members.status = 'approved' GROUP BY resource_members.resource_id \nHAVING count(distinct(resource_members.entity_id)) = 1) AS anon_2 INNER JOIN loop_items ON CAST(loop_items.id AS SIGNED INTEGER) = anon_2.project_id AND loop_items.resource_type IN ('project') \nWHERE anon_2.workspace_id IN ({numeric_list}) AND loop_items.status = 'active' GROUP BY anon_2.workspace_id"
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
    owner_user_id: i32,
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

/// `str(value)` over a stored CRD scalar, treating the Python falsy values
/// (absent, `null`, `""`) as absent so `or` fallbacks still apply.
fn crd_scalar_text(value: Option<&serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::String(text) if !text.is_empty() => Some(text.clone()),
        serde_json::Value::Number(number) if number.as_f64() != Some(0.0) => {
            Some(number.to_string())
        }
        _ => None,
    }
}

/// `int(value)` over a stored CRD scalar, treating falsy values as absent.
fn crd_scalar_int(value: Option<&serde_json::Value>) -> Option<i64> {
    let parsed = match value? {
        serde_json::Value::Number(number) => number.as_i64(),
        serde_json::Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    };
    parsed.filter(|value| *value != 0)
}

/// `bool(value)` over a stored CRD scalar: only `None`, `false`, `0`, `""`,
/// `[]`, and `{}` are falsy.
fn crd_truthy(value: Option<&serde_json::Value>) -> bool {
    match value {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Bool(value)) => *value,
        Some(serde_json::Value::Number(number)) => number.as_f64() != Some(0.0),
        Some(serde_json::Value::String(text)) => !text.is_empty(),
        Some(serde_json::Value::Array(items)) => !items.is_empty(),
        Some(serde_json::Value::Object(map)) => !map.is_empty(),
    }
}

/// One CRD object field, borrowed from the stored JSON document.
fn crd_field<'a>(
    object: Option<&'a serde_json::Map<String, serde_json::Value>>,
    key: &str,
) -> Option<&'a serde_json::Value> {
    object.and_then(|object| object.get(key))
}

/// `workspace_from_kind` over one `kinds` row.
fn workspace_crd(json: &serde_json::Value) -> WorkspaceCrdView {
    let spec = json.get("spec").and_then(serde_json::Value::as_object);
    let metadata = json.get("metadata").and_then(serde_json::Value::as_object);
    let status = json.get("status").and_then(serde_json::Value::as_object);
    WorkspaceCrdView {
        description: crd_scalar_text(crd_field(spec, "description")).unwrap_or_default(),
        is_default: crd_truthy(crd_field(spec, "isDefault")),
        public_id: crd_scalar_text(crd_field(metadata, "publicId")),
        created_by_user_id: crd_scalar_int(crd_field(metadata, "createdByUserId"))
            .map(|value| value as i32),
        version: crd_scalar_int(crd_field(status, "version")).unwrap_or(1),
    }
}

/// The subset of the `CollaborationWorkspace` CRD the response reads.
struct WorkspaceCrdView {
    description: String,
    is_default: bool,
    public_id: Option<String>,
    created_by_user_id: Option<i32>,
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
            let json = workspace.json.0.to_value();
            let is_default = crd_truthy(json.get("spec").and_then(|spec| spec.get("isDefault")));
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
            let access_role = workspace_access_role(&workspace, user_id, &roles)?;
            Ok(WorkspaceBody {
                id: workspace.id.to_string(),
                public_id: crd.public_id.unwrap_or_else(|| workspace.id.to_string()),
                name: workspace.name,
                description: crd.description,
                namespace: workspace.namespace,
                created_by_user_id: crd.created_by_user_id.unwrap_or(workspace.user_id),
                owner_user_id: workspace.user_id,
                access_role,
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

/// `access_role`: the owner always reports `Owner`; every other caller reports
/// the effective membership role. A missing membership is an internal error,
/// because `readable_workspace_ids` admits only owners and approved members.
fn workspace_access_role(
    workspace: &WorkspaceRow,
    user_id: i32,
    roles: &HashMap<i64, String>,
) -> Result<String, FastApiError> {
    if workspace.user_id == user_id {
        return Ok("Owner".to_string());
    }
    roles.get(&workspace.id).cloned().ok_or_else(|| {
        tracing::error!(
            workspace_id = workspace.id,
            user_id,
            "workspace member has no effective role"
        );
        FastApiError::unhandled()
    })
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
        assert!(queries[0].sql.contains(ROLE_ALIAS_CASE));
        assert!(
            queries[0]
                .sql
                .contains(&format!("resource_members.`role` IN {VALID_MEMBER_ROLES}"))
        );
        assert!(!queries[0].sql.contains("RestrictedAnalyst"));
    }

    /// The recorded `readable_workspace_ids` statement keeps the caller's
    /// membership subquery and accepts owned workspaces without a grant.
    #[tokio::test]
    async fn accessible_statement_matches_the_recorded_rendering() {
        /// The source `readable_workspace_ids` statement for user 33, as the
        /// recording captured it (whitespace-normalized).
        const RECORDED: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at FROM kinds WHERE kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true AND kinds.id IN (SELECT kinds.id FROM kinds LEFT OUTER JOIN (SELECT resource_members.resource_id AS resource_id, CASE resource_members.`role` WHEN 'Owner' THEN 'Maintainer' WHEN 'Reporter' THEN 'Viewer' ELSE resource_members.`role` END AS `role` FROM resource_members WHERE resource_members.resource_type = 'Workspace' AND resource_members.entity_type = 'user' AND resource_members.entity_id = '33' AND resource_members.status = 'approved' AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Viewer', 'Reporter')) AS anon_1 ON anon_1.resource_id = kinds.id WHERE kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true AND (kinds.user_id = 33 OR anon_1.resource_id IS NOT NULL)) ORDER BY kinds.updated_at DESC";
        let mysql = KindQueryCapture::default();
        let _ = workspaces_list(&mysql, 33).await.unwrap();
        assert_eq!(mysql.queries()[0].sql, RECORDED);
    }

    /// `_summary_counts` unions human memberships, Team/Device grants and
    /// active project rows; a `CloudProject` grant is not a project count.
    #[tokio::test]
    async fn summary_counts_unions_grants_and_active_projects() {
        let mysql = KindQueryCapture::default();
        summary_counts(&mysql, &[7, 8]).await.unwrap();
        let sql = &mysql.queries()[0].sql;
        assert!(sql.contains("resource_members.resource_type = 'Workspace'"));
        assert!(sql.contains("resource_members.resource_type IN ('Team', 'Device')"));
        assert!(sql.contains(
            "JOIN loop_items ON CAST(loop_items.id AS SIGNED INTEGER) = anon_2.project_id"
        ));
        assert!(sql.contains("loop_items.status = 'active'"));
        assert!(sql.contains("loop_items.resource_type IN ('project')"));
        assert!(!sql.contains("resource_members.resource_type IN ('CloudProject'"));
        assert!(sql.contains("resource_members.entity_id IN ('7', '8')"));
    }

    /// The `_summary_counts` union renders exactly the SQLAlchemy statement:
    /// the parent subquery selects `project_id` before `workspace_id`, uses
    /// `count(distinct(...))`, and keeps the `CloudProject` discriminator in the
    /// join's `ON` clause. A prepared statement that differs in any of these
    /// places cannot match the recorded exchange.
    #[tokio::test]
    async fn summary_counts_statement_matches_the_source_rendering() {
        /// `_summary_counts` for ids `[7, 8]` as SQLAlchemy renders it,
        /// whitespace-normalized like `KindQueryCapture`.
        const EXPECTED: &str = "SELECT resource_members.resource_id, 'Workspace' AS anon_1, count(resource_members.id) AS count_1 FROM resource_members WHERE resource_members.resource_type = 'Workspace' AND resource_members.entity_type = 'user' AND resource_members.status = 'approved' AND resource_members.resource_id IN (7, 8) GROUP BY resource_members.resource_id UNION ALL SELECT CAST(resource_members.entity_id AS SIGNED INTEGER) AS entity_id, resource_members.resource_type, count(resource_members.id) AS count_2 FROM resource_members WHERE resource_members.resource_type IN ('Team', 'Device') AND resource_members.entity_type = 'workspace' AND resource_members.status = 'approved' AND resource_members.entity_id IN ('7', '8') GROUP BY resource_members.entity_id, resource_members.resource_type UNION ALL SELECT anon_2.workspace_id, 'CloudProject' AS anon_3, count(loop_items.id) AS count_3 FROM (SELECT resource_members.resource_id AS project_id, CAST(min(resource_members.entity_id) AS SIGNED INTEGER) AS workspace_id FROM resource_members WHERE resource_members.resource_type = 'CloudProject' AND resource_members.entity_type = 'workspace' AND resource_members.status = 'approved' GROUP BY resource_members.resource_id HAVING count(distinct(resource_members.entity_id)) = 1) AS anon_2 INNER JOIN loop_items ON CAST(loop_items.id AS SIGNED INTEGER) = anon_2.project_id AND loop_items.resource_type IN ('project') WHERE anon_2.workspace_id IN (7, 8) AND loop_items.status = 'active' GROUP BY anon_2.workspace_id";
        let mysql = KindQueryCapture::default();
        summary_counts(&mysql, &[7, 8]).await.unwrap();
        assert_eq!(mysql.queries()[0].sql, EXPECTED);
    }

    /// `user_memberships` normalizes legacy grants; the role read keeps the
    /// same five-role filter as the visibility subquery.
    #[tokio::test]
    async fn role_read_normalizes_legacy_roles() {
        let mysql = KindQueryCapture::default();
        let roles = roles_by_workspace(&mysql, 33, &[7]).await.unwrap();
        assert!(roles.is_empty());
        let sql = &mysql.queries()[0].sql;
        assert!(sql.contains("CASE resource_members.`role` WHEN 'Owner' THEN 'Maintainer'"));
        assert!(sql.contains(&format!("resource_members.`role` IN {VALID_MEMBER_ROLES}")));
        assert!(sql.contains("resource_members.resource_id IN (7)"));
    }

    #[test]
    fn crd_view_applies_source_fallbacks() {
        let view = workspace_crd(&serde_json::json!({
            "metadata": {"publicId": "c592c1fa", "createdByUserId": 6177},
            "spec": {"description": "team space", "isDefault": true},
            "status": {"version": 4},
        }));
        assert_eq!(view.public_id.as_deref(), Some("c592c1fa"));
        assert_eq!(view.created_by_user_id, Some(6177));
        assert_eq!(view.description, "team space");
        assert!(view.is_default);
        assert_eq!(view.version, 4);

        let empty = workspace_crd(&serde_json::json!({}));
        assert_eq!(empty.public_id, None);
        assert_eq!(empty.created_by_user_id, None);
        assert_eq!(empty.description, "");
        assert!(!empty.is_default);
        assert_eq!(empty.version, 1);
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
            owner_user_id: 6177,
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
                "owner_user_id",
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
        assert_eq!(rendered["owner_user_id"], 6177);
    }

    /// The cutover is real only when the route table selects the pattern the
    /// handler registers.
    #[test]
    fn route_table_selects_the_registered_handler() {
        const PATH: &str = "/api/v1/workspaces";
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).expect("routes file loads");
        let table = crate::RouteTable::compile(config).expect("routes compile");
        assert!(table.matches(&http::Method::GET, PATH));
        assert!(!table.matches(&http::Method::POST, PATH));

        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
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
