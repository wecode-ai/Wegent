// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/cloud-projects/{project_id}/collaboration-groups` — list the
//! collaboration groups attached to one cloud project.
//!
//! Mirrors `app.api.endpoints.project_automations.list_project_collaboration_groups`
//! -> `workspace_service.list_project_collaboration_groups`
//! (`app.services.workspaces.collaboration_groups`); the router prefix is
//! `/v1/cloud-projects` under the app prefix `/api`.
//!
//! Source pipeline:
//! 1. `get_current_user` (`app.core.security`) — JWT session decode plus the
//!    labeled `users` lookup (`db.query(User).filter(user_name == username)`).
//! 2. `require_cloud_project_role(db, project_id, user_id)` with the default
//!    `Viewer` role (`app.services.cloud_projects.access`) — the point-form
//!    `project_access_query` union reduced to one row; no row is a 404
//!    `Cloud project not found`, an insufficient role is a 403
//!    `Insufficient permission`.
//! 3. `_require_project_workspace` -> `workspace_id_for_project` — the
//!    approved `workspace` `resource_members` grant's `entity_id`; a missing
//!    grant is a 422 `Project is not attached to a Workspace`.
//! 4. `list_project_collaboration_groups` — the `CollaborationGroup` `kinds`
//!    rows joined with their approved `project` `resource_members` grant,
//!    ordered by `kinds.name, kinds.id`; every row is rendered through
//!    `_group_values`. An empty result returns `{"items": []}`.

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::Serialize;
use serde_json::{Value, json};

use crate::auth::SessionUser;
use crate::board_snapshot::repository::BoardSnapshotRepository;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use brz_json::OpaqueJson;

/// `workspace_id_for_project` (`app.services.workspaces.storage`): the
/// approved workspace grant's `entity_id` for one cloud project. Trimmed to
/// the single selected column so the prepared statement matches the recorded
/// exchange for replay.
const PROJECT_WORKSPACE_SQL: &str = "\
SELECT resource_members.entity_id AS resource_members_entity_id \n\
FROM resource_members \n\
WHERE resource_members.resource_type = 'CloudProject' AND resource_members.resource_id = ? AND resource_members.entity_type = 'workspace' AND resource_members.status = 'approved' \n\
 LIMIT 1";

/// `list_project_collaboration_groups`: the `Kind`/`ResourceMember` join that
/// lists the collaboration groups attached to one project. The join and filter
/// order mirrors the source SQLAlchemy rendering; the approved member grant
/// carries `entity_type = 'project'` while grouping still resolves the owner
/// workspace for the response.
const COLLABORATION_GROUPS_SQL: &str = "\
SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at \n\
FROM kinds INNER JOIN resource_members ON resource_members.resource_id = kinds.id AND resource_members.resource_type = 'CollaborationGroup' \n\
WHERE kinds.kind = 'CollaborationGroup' AND kinds.is_active IS true AND resource_members.entity_type = 'project' AND resource_members.entity_id = ? AND resource_members.status = 'approved' ORDER BY kinds.name, kinds.id";

/// One `CollaborationGroupResponse` item rendered in the source field order.
/// `SnowflakeId` fields serialize as strings; `created_by_user_id` stays
/// numeric and the timestamps render as pydantic naive datetimes.
#[derive(Debug, Serialize)]
struct CollaborationGroupItem {
    id: String,
    workspace_id: String,
    owner_type: String,
    owner_id: String,
    name: String,
    description: String,
    instructions: String,
    leader: Value,
    members: Vec<Value>,
    coordination_mode: String,
    stages: Vec<Value>,
    execution_requirements: Value,
    version: i64,
    created_by_user_id: i64,
    created_at: String,
    updated_at: String,
}

/// `CollaborationGroupListResponse`: the endpoint's list envelope.
#[derive(Debug, Serialize)]
struct CollaborationGroupListResponse {
    items: Vec<CollaborationGroupItem>,
}

/// A `CollaborationGroup` `kinds` row selected with the full labeled source
/// column list; only the fields consumed by the response are typed.
#[derive(Debug, FromMysqlRow)]
struct CollaborationGroupRow {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[mysql(rename = "kinds_user_id")]
    user_id: i64,
    #[mysql(rename = "kinds_name")]
    name: String,
    #[mysql(rename = "kinds_namespace")]
    namespace: String,
    #[mysql(rename = "kinds_json")]
    json: Option<Json<OpaqueJson>>,
    #[mysql(rename = "kinds_created_at")]
    created_at: NaiveDateTime,
    #[mysql(rename = "kinds_updated_at")]
    updated_at: NaiveDateTime,
}

/// `resource_members_entity_id` scalar from `workspace_id_for_project`.
#[derive(Debug, FromMysqlRow)]
struct WorkspaceIdRow {
    #[mysql(rename = "resource_members_entity_id")]
    entity_id: Option<String>,
}

/// GET /api/v1/cloud-projects/{project_id}/collaboration-groups: the
/// collaboration-groups free function, injecting the process-lifetime
/// application state.
#[brz_http_server::get("/api/v1/cloud-projects/:project_id/collaboration-groups")]
async fn list_project_collaboration_groups(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] current_user: SessionUser,
) -> Result<CollaborationGroupListResponse, FastApiError> {
    collaboration_groups(state, project_id, current_user.0.id).await
}

/// Handler body for
/// `GET /api/v1/cloud-projects/{project_id}/collaboration-groups`.
async fn collaboration_groups(
    state: &AppState,
    project_id: &str,
    user_id: i32,
) -> Result<CollaborationGroupListResponse, FastApiError> {
    // FastAPI declares `project_id: int`; a non-numeric path segment is a 422
    // before the handler runs.
    let numeric_id = project_id.parse::<i64>().map_err(|_| {
        FastApiError::validation(json!([{
            "type": "int_parsing",
            "loc": ["path", "project_id"],
            "msg": "Input should be a valid integer, unable to parse string as an integer",
            "input": project_id,
        }]))
    })?;

    // `require_cloud_project_role(db, project_id, user_id)` with the default
    // `Viewer` role: the shared point-form `project_access_query` union.
    let repository = BoardSnapshotRepository::new(&state.mysql);
    let access = repository
        .require_cloud_project_role(numeric_id, user_id)
        .await
        .map_err(internal_error)?;
    let Some(access) = access else {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Cloud project not found",
        ));
    };
    if !crate::board_snapshot::repository::has_permission(&access.role, "Viewer") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }

    // `_require_project_workspace`: the owner workspace of the project.
    let workspace_id = project_workspace_id(&state.mysql, numeric_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| {
            FastApiError::detail(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Project is not attached to a Workspace",
            )
        })?;

    // `list_project_collaboration_groups`: the approved project grant join.
    let rows = collaboration_group_rows(&state.mysql, project_id)
        .await
        .map_err(internal_error)?;

    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        items.push(group_response(row, workspace_id, project_id)?);
    }
    Ok(CollaborationGroupListResponse { items })
}

/// `workspace_id_for_project`: the approved workspace grant's `entity_id`.
/// The source returns `None` when the row is missing or its entity id is not
/// an integer.
async fn project_workspace_id<M: Mysql>(mysql: &M, project_id: i64) -> MysqlResult<Option<i64>> {
    let row: Option<WorkspaceIdRow> = mysql
        .fetch_optional(PROJECT_WORKSPACE_SQL, (project_id,))
        .await?;
    Ok(row
        .and_then(|row| row.entity_id)
        .and_then(|entity_id| entity_id.parse::<i64>().ok()))
}

/// `list_project_collaboration_groups`: the `kinds`/`resource_members` join.
async fn collaboration_group_rows<M: Mysql>(
    mysql: &M,
    project_id: &str,
) -> MysqlResult<Vec<CollaborationGroupRow>> {
    mysql
        .fetch_all(COLLABORATION_GROUPS_SQL, (project_id,))
        .await
}

/// `_group_values` + `_group_owner`: render one group row. `owner_type` and
/// `owner_id` resolve from the group's namespace, and an unrecognized
/// namespace is the source's 409.
fn group_response(
    row: &CollaborationGroupRow,
    workspace_id: i64,
    project_id: &str,
) -> Result<CollaborationGroupItem, FastApiError> {
    let (owner_type, owner_id) = group_owner(row, project_id)?;
    let payload = row
        .json
        .as_ref()
        .map(|json| json.0.to_value())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let empty = json!({});
    let spec = payload
        .get("spec")
        .filter(|value| value.is_object())
        .or(Some(&empty));
    let status_value = payload
        .get("status")
        .filter(|value| value.is_object())
        .or(Some(&empty));
    let spec_field = |key: &str| spec.and_then(|spec| spec.get(key));
    let status_field = |key: &str| status_value.and_then(|status| status.get(key));

    Ok(CollaborationGroupItem {
        id: row.id.to_string(),
        workspace_id: workspace_id.to_string(),
        owner_type: owner_type.to_string(),
        owner_id: owner_id.to_string(),
        name: row.name.clone(),
        description: text(spec_field("description")),
        instructions: text(spec_field("instructions")),
        leader: spec_field("leader")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({})),
        members: spec_field("members")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        coordination_mode: text_or(spec_field("coordinationMode"), "manager"),
        stages: spec_field("stages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        execution_requirements: spec_field("executionRequirements")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({"required_tags": []})),
        version: status_field("version").and_then(Value::as_i64).unwrap_or(1),
        created_by_user_id: row.user_id,
        created_at: datetime_value(row.created_at),
        updated_at: datetime_value(row.updated_at),
    })
}

/// `_group_owner`: the group's owner scope from its namespace. A project-owned
/// group resolves to the requested project; a workspace group resolves to the
/// workspace encoded in the namespace.
fn group_owner(
    row: &CollaborationGroupRow,
    project_id: &str,
) -> Result<(&'static str, i64), FastApiError> {
    if row.namespace == format!("projects/{project_id}") {
        return Ok(("project", project_id.parse::<i64>().unwrap_or_default()));
    }
    if let Some(workspace) = row.namespace.strip_prefix("workspaces/")
        && let Ok(workspace_id) = workspace.parse::<i64>()
    {
        return Ok(("workspace", workspace_id));
    }
    Err(FastApiError::detail(
        StatusCode::CONFLICT,
        "Collaboration group has an invalid owner namespace",
    ))
}

/// Python `str(value or "")`.
fn text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

/// Python `str(value or default)`: an empty string is falsy, so the default
/// applies for an empty or missing value.
fn text_or(value: Option<&Value>, default: &str) -> String {
    match value {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        Some(Value::Null) | None | Some(Value::String(_)) => default.to_string(),
        Some(other) => other.to_string(),
    }
}

/// Naive-datetime rendering matching pydantic's output: `YYYY-MM-DDTHH:MM:SS`
/// plus fractional seconds when nonzero.
fn datetime_value(value: NaiveDateTime) -> String {
    let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        base
    } else {
        format!("{base}.{:06}", value.and_utc().timestamp_subsec_micros())
    }
}

fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "cloud-projects collaboration-groups dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalize(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn group_query_matches_the_source_join() {
        let sql = normalize(COLLABORATION_GROUPS_SQL);
        assert!(sql.starts_with("SELECT kinds.id AS kinds_id,"));
        assert!(sql.contains(
            "INNER JOIN resource_members ON resource_members.resource_id = kinds.id \
             AND resource_members.resource_type = 'CollaborationGroup'"
        ));
        assert!(sql.contains("kinds.kind = 'CollaborationGroup' AND kinds.is_active IS true"));
        assert!(sql.contains("resource_members.entity_type = 'project'"));
        assert!(sql.contains("resource_members.entity_id = ?"));
        assert!(sql.ends_with("ORDER BY kinds.name, kinds.id"));
    }

    #[test]
    fn workspace_lookup_selects_the_grant_entity_id() {
        let sql = normalize(PROJECT_WORKSPACE_SQL);
        assert!(sql.starts_with(
            "SELECT resource_members.entity_id AS resource_members_entity_id FROM resource_members"
        ));
        assert!(sql.contains("resource_members.resource_type = 'CloudProject'"));
        assert!(sql.contains("resource_members.entity_type = 'workspace'"));
        assert!(sql.contains("resource_members.status = 'approved'"));
        assert!(sql.ends_with("LIMIT 1"));
    }

    fn row(namespace: &str, payload: Value) -> CollaborationGroupRow {
        CollaborationGroupRow {
            id: 8300000000000000001,
            user_id: 86,
            name: "group".to_string(),
            namespace: namespace.to_string(),
            json: Some(Json(OpaqueJson::from(payload))),
            created_at: chrono::DateTime::from_timestamp(0, 0)
                .expect("epoch is valid")
                .naive_utc(),
            updated_at: chrono::DateTime::from_timestamp(0, 0)
                .expect("epoch is valid")
                .naive_utc(),
        }
    }

    #[test]
    fn project_owned_group_renders_the_source_fields() {
        let item = group_response(
            &row(
                "projects/8308220868516891581",
                json!({
                    "spec": {
                        "description": "d",
                        "instructions": "i",
                        "coordinationMode": "manager",
                        "members": [{"kind": "human", "id": "1", "responsibility": ""}],
                        "stages": [],
                        "executionRequirements": {"required_tags": ["t"]}
                    },
                    "status": {"state": "active", "version": 3}
                }),
            ),
            353932,
            "8308220868516891581",
        )
        .unwrap();
        assert_eq!(item.owner_type, "project");
        assert_eq!(item.owner_id, "8308220868516891581");
        assert_eq!(item.id, "8300000000000000001");
        assert_eq!(item.workspace_id, "353932");
        assert_eq!(item.description, "d");
        assert_eq!(item.coordination_mode, "manager");
        assert_eq!(item.members.len(), 1);
        assert_eq!(item.version, 3);
        assert_eq!(item.created_by_user_id, 86);
        assert_eq!(item.created_at, "1970-01-01T00:00:00");
    }

    #[test]
    fn workspace_owned_group_resolves_its_namespace() {
        let item = group_response(
            &row("workspaces/353932", json!({"spec": {}})),
            353932,
            "8308220868516891581",
        )
        .unwrap();
        assert_eq!(item.owner_type, "workspace");
        assert_eq!(item.owner_id, "353932");
        // Missing spec fields fall back to the source defaults.
        assert_eq!(item.coordination_mode, "manager");
        assert_eq!(item.execution_requirements, json!({"required_tags": []}));
        assert_eq!(item.version, 1);
    }

    #[test]
    fn invalid_owner_namespace_is_a_conflict() {
        let error = group_response(
            &row("elsewhere/1", json!({"spec": {}})),
            1,
            "8308220868516891581",
        )
        .unwrap_err();
        assert_eq!(error.status(), StatusCode::CONFLICT);
    }

    #[test]
    fn text_or_applies_the_default_for_empty_and_missing() {
        assert_eq!(text_or(None, "manager"), "manager");
        assert_eq!(text_or(Some(&json!(null)), "manager"), "manager");
        assert_eq!(text_or(Some(&json!("")), "manager"), "manager");
        assert_eq!(text_or(Some(&json!("manager")), "manager"), "manager");
    }
}
