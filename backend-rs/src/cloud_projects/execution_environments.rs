// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/cloud-projects/{project_id}/execution-environments`: the
//! execution-environments free function, injecting the process-lifetime
//! application state.
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql};
use chrono::NaiveDateTime;

use super::{LOOP_ITEMS_COLUMNS, ProjectListRow};
use crate::devices;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use brz_json::{JsonProjection, OpaqueJson};

/// Mirrors `app.api.endpoints.cloud_projects.list_project_execution_environments`
/// -> `cloud_project_service.list_execution_environments`. The source pipeline:
/// 1. `get_current_user_jwt_apikey_tasktoken` — JWT / API-key / task-token
///    authentication with the labeled `users` lookup;
/// 2. `require_cloud_project_role(db, project_id, user_id)` with the default
///    `Viewer` role — the recorded COM_QUERY renders the source's point-form
///    `project_access_query` union with every value inlined (entity id as a
///    quoted string, project snowflake id as an unquoted integer);
/// 3. `workspace_id_for_project` — the approved `resource_members` workspace
///    grant's `entity_id`; an empty result returns `items: []`;
/// 4. the approved `Device` grants joined with `kinds`, ordered by
///    `resource_members.created_at, id`;
/// 5. one Redis `MGET` of the per-device online keys (`device:online:<user>:
///    <route>`, where the route is the `runtime_device_route_id`), which the
///    source computes through `cache_manager.mget`;
/// 6. per device, one labeled `users` lookup (`db.get(User, device.user_id)`)
///    for the `owner_name`; a missing owner renders an empty string.
#[brz_http_server::get("/api/v1/cloud-projects/:project_id/execution-environments")]
async fn list_execution_environments(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] user: crate::loop_tasks::auth::FlexibleUser,
) -> Result<ExecutionEnvironmentListResponse, FastApiError> {
    execution_environments(state, project_id, &user.0).await
}

/// One `WorkspaceExecutionEnvironmentResponse` item, rendered in the source
/// schema field order. Snowflake ids serialize as strings; the numeric
/// `device_id` stays numeric.
#[derive(Debug, serde::Serialize)]
struct ExecutionEnvironmentItem {
    id: String,
    workspace_id: String,
    device_id: i64,
    device_key: String,
    name: String,
    kind: String,
    device_type: String,
    runtime_instance_id: Option<String>,
    capabilities: Vec<String>,
    coding_tools: Vec<String>,
    owner_type: String,
    owner_id: String,
    owner_name: String,
    status: String,
    owner_user_id: Option<i32>,
    added_by_user_id: i32,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, serde::Serialize)]
struct ExecutionEnvironmentListResponse {
    items: Vec<ExecutionEnvironmentItem>,
}

/// `resource_members` grant joined with the `kinds` Device row, selected with
/// the full labeled source column list so the prepared statement matches the
/// recorded exchange. Only the fields consumed by the response are typed.
#[derive(Debug, FromMysqlRow)]
struct ExecutionEnvironmentRow {
    #[mysql(rename = "resource_members_id")]
    #[allow(dead_code, reason = "selected to match source column list")]
    member_id: i32,
    #[mysql(rename = "resource_members_role")]
    #[allow(
        dead_code,
        reason = "Device project grants are always 'Developer'; owner type is user"
    )]
    role: String,
    #[mysql(rename = "resource_members_invited_by_user_id")]
    invited_by_user_id: i32,
    #[mysql(rename = "resource_members_created_at")]
    grant_created_at: Option<NaiveDateTime>,
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[mysql(rename = "kinds_user_id")]
    device_user_id: i32,
    #[mysql(rename = "kinds_name")]
    name: String,
    #[mysql(rename = "kinds_json")]
    json: Json<JsonProjection<DeviceDocumentProjection>>,
    #[mysql(rename = "kinds_updated_at")]
    updated_at: Option<NaiveDateTime>,
}

/// Typed projection of the Device `spec` fields consumed by the environment
/// response (`app.services.workspaces.resource_mapping`).
#[derive(Debug, Default, Clone, serde::Deserialize)]
#[serde(default)]
struct DeviceEnvironmentInput {
    #[serde(rename = "deviceType")]
    device_type: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    #[serde(rename = "deviceId")]
    device_id: Option<String>,
    #[serde(rename = "cloudConfig")]
    cloud_config: Option<CloudConfigInput>,
    #[serde(rename = "bindShell")]
    bind_shell: Option<String>,
    capabilities: Option<OpaqueJson>,
    #[serde(rename = "runtimeInstanceId")]
    runtime_instance_id: Option<String>,
}

#[derive(Debug, Default, Clone, serde::Deserialize)]
#[serde(default)]
struct CloudConfigInput {
    #[serde(rename = "deviceId")]
    device_id: Option<String>,
}

/// The device JSON document (`{ spec: {...}, status, metadata, ... }`).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct DeviceDocumentProjection {
    spec: Option<DeviceEnvironmentInput>,
}

/// The source `resource_members`/`kinds` rows decoded into the environment
/// projection.
impl ExecutionEnvironmentRow {
    /// `device.json.spec` parsed into the typed projection.
    fn spec(&self) -> DeviceEnvironmentInput {
        self.json
            .0
            .value
            .as_ref()
            .and_then(|document: &DeviceDocumentProjection| document.spec.clone())
            .unwrap_or_default()
    }
}

/// The source's inline point-form `project_access_query`
/// (`cloud_project_visibility.project_access_query(db, user_id, project_id)`).
///
/// The four `union_all` branches follow the source construction order: the
/// caller's direct `CloudProject` membership (`VALID_CLOUD_PROJECT_MEMBER_ROLES`
/// = Owner/Maintainer/Developer/Viewer with the `case(ROLE_HIERARCHY)`
/// priority), the grant inherited through an active `CollaborationWorkspace` at
/// the `Viewer` priority 4, the `authenticated_users` public grant restricted
/// to Developer/Viewer, and the projects the caller created at `Owner` priority
/// 0. The point form narrows every branch to the requested project, so the
/// outer aggregation keeps at most one row.
///
/// The recorded COM_QUERY inlines every authority value: the caller's user id
/// as a quoted string (`entity_id = '52'`), the project snowflake id as an
/// unquoted integer on the `resource_members.resource_id` branches and as a
/// quoted string on the `loop_items.id` branches, and the caller's user id as
/// an integer on the `created_by_user_id` branch. This differs from the bound
/// projection the board-snapshot repository issues for loop-item-pages, so the
/// execution-environments recording matches only this inline shape.
fn inline_point_access_sql(project_id: &str, user_id: i32) -> String {
    format!(
        "SELECT {LOOP_ITEMS_COLUMNS}, anon_1.priority AS anon_1_priority \n\
         FROM loop_items INNER JOIN (SELECT anon_2.project_id AS project_id, min(anon_2.priority) AS priority \n\
         FROM (SELECT CAST(resource_members.resource_id AS CHAR(64)) AS project_id, CASE resource_members.`role` WHEN 'Owner' THEN 0 WHEN 'Maintainer' THEN 1 WHEN 'Developer' THEN 2 WHEN 'Reporter' THEN 3 WHEN 'Viewer' THEN 4 WHEN 'RestrictedAnalyst' THEN 5 END AS priority \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'CloudProject' AND resource_members.entity_type = 'user' AND resource_members.entity_id = '{user_id}' AND resource_members.status = 'approved' AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Viewer') AND resource_members.resource_id = {project_id} UNION ALL SELECT CAST(resource_members.resource_id AS CHAR(64)) AS project_id, 4 AS priority \n\
         FROM resource_members INNER JOIN (SELECT resource_members.resource_id AS resource_id \n\
         FROM resource_members INNER JOIN kinds ON kinds.id = resource_members.resource_id \n\
         WHERE resource_members.resource_type = 'Workspace' AND resource_members.entity_type = 'user' AND resource_members.entity_id = '{user_id}' AND resource_members.status = 'approved' AND kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Reporter')) AS anon_3 ON CAST(resource_members.entity_id AS SIGNED INTEGER) = anon_3.resource_id \n\
         WHERE resource_members.resource_type = 'CloudProject' AND resource_members.entity_type = 'workspace' AND resource_members.status = 'approved' AND resource_members.resource_id = {project_id} UNION ALL SELECT CAST(resource_members.resource_id AS CHAR(64)) AS project_id, CASE resource_members.`role` WHEN 'Owner' THEN 0 WHEN 'Maintainer' THEN 1 WHEN 'Developer' THEN 2 WHEN 'Reporter' THEN 3 WHEN 'Viewer' THEN 4 WHEN 'RestrictedAnalyst' THEN 5 END AS priority \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'CloudProject' AND resource_members.entity_type = 'authenticated_users' AND resource_members.entity_id = '*' AND resource_members.status = 'approved' AND resource_members.`role` IN ('Developer', 'Viewer') AND resource_members.resource_id = {project_id} UNION ALL SELECT loop_items.id AS project_id, 0 AS priority \n\
         FROM loop_items \n\
         WHERE loop_items.created_by_user_id = {user_id} AND loop_items.status = 'active' AND loop_items.id = '{project_id}' AND loop_items.resource_type IN ('project')) AS anon_2 GROUP BY anon_2.project_id) AS anon_1 ON loop_items.id = anon_1.project_id \n\
         WHERE loop_items.status = 'active' AND loop_items.resource_type IN ('project') \n LIMIT 1",
    )
}

/// `require_cloud_project_role`'s first read: the source's point-form
/// `project_access_query` union with inlined authority values, resolving the
/// caller's effective role in one statement. The `Viewer` default never 403s
/// a resolved role, so only the 404 path applies.
async fn project_access_inline<M: Mysql>(
    mysql: &M,
    project_id: &str,
    user_id: i32,
) -> Result<Option<ProjectListRow>, brz_mysql::MysqlError> {
    let row: Option<ProjectListRow> = mysql
        .fetch_optional(inline_point_access_sql(project_id, user_id), ())
        .await?;
    Ok(row)
}
fn internal_execution_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "cloud-projects execution-environments dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

/// `workspace_id_for_project`: the approved `resource_members` workspace
/// grant's `entity_id`; `None` produces `items: []`.
async fn workspace_id_for_project<M: Mysql>(
    mysql: &M,
    project_id: &str,
) -> Result<Option<i64>, brz_mysql::MysqlError> {
    #[derive(Debug, FromMysqlRow)]
    struct WorkspaceIdRow {
        #[mysql(rename = "resource_members_entity_id")]
        entity_id: String,
    }
    let row: Option<WorkspaceIdRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT resource_members.entity_id AS resource_members_entity_id \n\
                 FROM resource_members \n\
                 WHERE resource_members.resource_type = 'CloudProject' AND resource_members.resource_id = {project_id} \
                 AND resource_members.entity_type = 'workspace' AND resource_members.status = 'approved' \n LIMIT 1",
            ),
            (),
        )
        .await?;
    let entity_id = match row {
        Some(row) => row.entity_id.trim().to_string(),
        None => return Ok(None),
    };
    match entity_id.parse::<i64>() {
        Ok(workspace_id) => Ok(Some(workspace_id)),
        Err(_) => Ok(None),
    }
}

/// The approved `Device` grants joined with `kinds`, ordered by
/// `resource_members.created_at, resource_members.id`. The recorded COM_QUERY
/// inlines the snowflake project id as a quoted string (the source passes
/// `str(cloud_project_id)`).
async fn device_env_rows<M: Mysql>(
    mysql: &M,
    project_id: &str,
) -> Result<Vec<ExecutionEnvironmentRow>, brz_mysql::MysqlError> {
    mysql
        .fetch_all(
            &format!(
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
                 kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
                 kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
                 kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
                 kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
                 kinds.updated_at AS kinds_updated_at \n\
                 FROM resource_members INNER JOIN kinds ON kinds.id = resource_members.resource_id \n\
                 WHERE resource_members.resource_type = 'Device' AND resource_members.entity_type = 'project' \
                 AND resource_members.entity_id = '{project_id}' AND resource_members.status = 'approved' \
                 AND kinds.kind = 'Device' AND kinds.is_active IS true \
                 ORDER BY resource_members.created_at, resource_members.id",
            ),
            (),
        )
        .await
}

/// The source's `runtime_device_route_id` for the Redis online key. App
/// devices use `app-record-<id>`; every other type keeps its logical id
/// (`spec.deviceId` / `cloudConfig.deviceId` / `name`).
fn runtime_device_route_id(row: &ExecutionEnvironmentRow) -> String {
    let spec = row.spec();
    let device_type = execution_device_type(&spec);
    if device_type == "app" {
        return format!("app-record-{}", row.id);
    }
    spec.device_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            spec.cloud_config
                .as_ref()
                .and_then(|config| config.device_id.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| row.name.clone())
}

/// `device_kind_type` (`app.services.device.identity`): `spec.deviceType` with
/// a `local` default.
fn execution_device_type(spec: &DeviceEnvironmentInput) -> String {
    match spec.device_type.as_deref() {
        Some("local") => "local".to_string(),
        Some("app") => "app".to_string(),
        Some("cloud") => "cloud".to_string(),
        Some("remote") => "remote".to_string(),
        _ => "local".to_string(),
    }
}

/// `execution_environment_kind`: `cloud_host` for cloud/remote, else
/// `local_device`.
fn execution_environment_kind(device_type: &str) -> String {
    if matches!(device_type, "cloud" | "remote") {
        "cloud_host".to_string()
    } else {
        "local_device".to_string()
    }
}

/// `coding_tools` (`app.services.workspaces.resource_mapping`).
fn coding_tools(spec: &DeviceEnvironmentInput) -> Vec<String> {
    let configured: Vec<String> = spec
        .capabilities_values()
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect();
    if !configured.is_empty() {
        return configured;
    }
    match spec
        .bind_shell
        .as_deref()
        .unwrap_or("claudecode")
        .to_lowercase()
        .as_str()
    {
        "openclaw" => vec!["openclaw".to_string()],
        _ => vec!["claude_code".to_string(), "codex".to_string()],
    }
}

impl DeviceEnvironmentInput {
    /// `spec.capabilities` as trimmed strings (`capabilities: []` when a
    /// non-list). We validate the value is a JSON array of strings here so the
    /// response matches the source list projection.
    fn capabilities_values(&self) -> Vec<String> {
        let Some(capabilities) = self.capabilities.as_ref() else {
            return Vec::new();
        };
        match capabilities.to_value() {
            serde_json::Value::Array(items) => items
                .into_iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect(),
            _ => Vec::new(),
        }
    }
}

/// `execution_environment_statuses`: one Redis `MGET` of the per-device online
/// keys; each device resolves to `online` (raw status `online`/`busy`) or
/// `offline` (missing, error, or any other raw status).
async fn execution_environment_statuses(
    state: &AppState,
    rows: &[ExecutionEnvironmentRow],
) -> Vec<(i64, String)> {
    let keys: Vec<String> = rows
        .iter()
        .map(|row| {
            devices::online_key(i64::from(row.device_user_id), &runtime_device_route_id(row))
        })
        .collect();
    let online: Vec<Option<devices::OnlineStateInput>> =
        devices::cache_manager_mget(state, keys).await;
    rows.iter()
        .zip(online)
        .map(|(row, online)| {
            let status = online
                .as_ref()
                .and_then(|info| info.status_value())
                .unwrap_or("offline")
                .to_string();
            (
                row.id,
                if matches!(status.as_str(), "online" | "busy") {
                    "online".to_string()
                } else {
                    "offline".to_string()
                },
            )
        })
        .collect()
}

/// `db.get(User, device.user_id)`: SQLAlchemy renders the ORM primary-key load
/// with the mapped columns unlabeled (`SELECT users.<column>, ...`), unlike the
/// labeled `db.query(User)` projection the authentication dependency issues.
fn owner_user_sql(user_id: i32) -> String {
    format!(
        "SELECT users.id, users.user_name, users.password_hash, users.email, \
         users.git_info, users.is_active, users.`role`, users.auth_source, \
         users.preferences, users.created_at, users.updated_at \
         FROM users WHERE users.id = {user_id}",
    )
}

/// `db.get(User, device.user_id)` — the owner lookup feeding `owner_name`.
async fn owner_user_row<M: Mysql>(
    mysql: &M,
    user_id: i32,
) -> Result<Option<String>, brz_mysql::MysqlError> {
    #[derive(Debug, FromMysqlRow)]
    struct OwnerRow {
        #[mysql(rename = "user_name")]
        user_name: String,
    }
    let row: Option<OwnerRow> = mysql.fetch_optional(owner_user_sql(user_id), ()).await?;
    Ok(row.map(|row| row.user_name))
}

/// Handler body for `GET /api/v1/cloud-projects/{project_id}/execution-environments`.
async fn execution_environments(
    state: &AppState,
    project_id: &str,
    current_user: &crate::loop_tasks::auth::UserRow,
) -> Result<ExecutionEnvironmentListResponse, FastApiError> {
    // `require_cloud_project_role(db, project_id, user_id)` with the default
    // `Viewer` role: the inline point-form `project_access_query` union. A
    // missing access source raises `404 {"detail": "Cloud project not found"}`.
    project_access_inline(&state.mysql, project_id, current_user.id)
        .await
        .map_err(internal_execution_error)?
        .ok_or_else(|| {
            FastApiError::detail(
                brz_http_server::StatusCode::NOT_FOUND,
                "Cloud project not found",
            )
        })?;

    // `workspace_id_for_project`: empty when the project has no approved
    // workspace grant.
    let workspace_id = workspace_id_for_project(&state.mysql, project_id)
        .await
        .map_err(internal_execution_error)?;
    let Some(workspace_id) = workspace_id else {
        return Ok(ExecutionEnvironmentListResponse { items: Vec::new() });
    };
    let workspace_id = workspace_id.to_string();

    // The approved Device grants joined with `kinds`.
    let rows = device_env_rows(&state.mysql, project_id)
        .await
        .map_err(internal_execution_error)?;

    // One Redis `MGET` of the online keys for every device.
    let statuses: std::collections::HashMap<i64, String> =
        execution_environment_statuses(state, &rows)
            .await
            .into_iter()
            .collect();
    let status_map = statuses;

    // `owner_values`: a non-Owner grant resolves the user owner through
    // `db.get(User, device.user_id)`. The source session's identity map already
    // holds the authenticated user, so a device it owns resolves without a
    // query; any other owner is fetched once and cached in the same map.
    let mut owner_names: std::collections::HashMap<i32, String> = std::collections::HashMap::new();
    owner_names.insert(current_user.id, current_user.user_name.clone());

    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let spec = row.spec();
        let device_type = execution_device_type(&spec);
        let name = spec
            .display_name
            .as_deref()
            .map(str::to_string)
            .unwrap_or_else(|| row.name.clone());
        let owner_user_id: i32 = row.device_user_id;
        let owner_name = match owner_names.get(&owner_user_id) {
            Some(name) => name.clone(),
            None => match owner_user_row(&state.mysql, owner_user_id)
                .await
                .map_err(internal_execution_error)?
            {
                Some(name) => {
                    owner_names.insert(owner_user_id, name.clone());
                    name
                }
                None => String::new(),
            },
        };
        let runtime_instance_id = spec
            .runtime_instance_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        items.push(ExecutionEnvironmentItem {
            id: row.id.to_string(),
            workspace_id: workspace_id.clone(),
            device_id: row.id,
            device_key: runtime_device_route_id(row),
            name,
            kind: execution_environment_kind(&device_type),
            device_type,
            runtime_instance_id,
            capabilities: spec.capabilities_values(),
            coding_tools: coding_tools(&spec),
            owner_type: "user".to_string(),
            owner_id: row.device_user_id.to_string(),
            owner_name,
            status: status_map
                .get(&row.id)
                .cloned()
                .unwrap_or_else(|| "offline".to_string()),
            owner_user_id: Some(row.device_user_id),
            added_by_user_id: row.invited_by_user_id,
            created_at: row.grant_created_at.map(datetime_value),
            updated_at: row.updated_at.map(datetime_value),
        });
    }

    Ok(ExecutionEnvironmentListResponse { items })
}

/// `from_project`-style naive-datetime rendering: `YYYY-MM-DDTHH:MM:SS` plus
/// fractional seconds when nonzero, matching pydantic naive-datetime output.
fn datetime_value(value: NaiveDateTime) -> String {
    let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        base
    } else {
        format!("{base}.{:06}", value.and_utc().timestamp_subsec_micros())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalize(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn inline_point_access_sql_inlines_all_authority_values() {
        let sql = inline_point_access_sql("4232277347815150821", 157);
        let normalized = normalize(&sql);
        assert!(normalized.contains("'157'"), "entity_id is a quoted string");
        assert!(
            normalized.contains("created_by_user_id = 157"),
            "owner branch is an integer"
        );
        assert!(normalized.contains("resource_members.resource_id = 4232277347815150821"));
        assert!(normalized.contains("loop_items.id = '4232277347815150821'"));
        assert!(!sql.contains('?'), "no bound markers in the recorded shape");
        assert!(normalized.ends_with("LIMIT 1"), "point form keeps one row");
    }

    #[test]
    fn inline_point_access_sql_matches_the_source_union_branches() {
        let sql = inline_point_access_sql("4232277347815150821", 157);
        let normalized = normalize(&sql);
        // The direct grant keeps the Viewer role and the ROLE_HIERARCHY case.
        assert!(normalized.contains(
            "`role` IN ('Owner', 'Maintainer', 'Developer', 'Viewer') AND \
             resource_members.resource_id = 4232277347815150821"
        ));
        assert!(normalized.contains(
            "WHEN 'Reporter' THEN 3 WHEN 'Viewer' THEN 4 WHEN 'RestrictedAnalyst' THEN 5 END"
        ));
        // The inherited workspace grant sits at the Viewer priority.
        assert!(normalized.contains(
            "project_id, 4 AS priority FROM resource_members INNER JOIN (SELECT \
             resource_members.resource_id AS resource_id"
        ));
        assert!(normalized.contains("`role` IN ('Owner', 'Maintainer', 'Developer', 'Reporter')"));
        // The public grant is the `authenticated_users` entity, not visibility.
        assert!(
            normalized.contains(
                "entity_type = 'authenticated_users' AND resource_members.entity_id = '*'"
            )
        );
        assert!(normalized.contains("`role` IN ('Developer', 'Viewer')"));
        assert!(!normalized.contains("visibility"));
    }

    #[test]
    fn owner_sql_is_the_unlabeled_primary_key_lookup() {
        let sql = normalize(&owner_user_sql(52));
        assert!(sql.starts_with("SELECT users.id, users.user_name"));
        assert!(!sql.contains(" AS users_id"), "db.get renders no labels");
        assert!(sql.contains("users.`role`, users.auth_source"));
        assert!(sql.ends_with("FROM users WHERE users.id = 52"));
        assert!(!sql.contains('?'), "the primary-key value is inlined");
    }

    #[test]
    fn execution_environment_kind_maps_cloud_and_remote_to_cloud_host() {
        assert_eq!(execution_environment_kind("cloud"), "cloud_host");
        assert_eq!(execution_environment_kind("remote"), "cloud_host");
        assert_eq!(execution_environment_kind("local"), "local_device");
        assert_eq!(execution_environment_kind("app"), "local_device");
    }

    #[test]
    fn coding_tools_defaults_to_claude_and_codex() {
        let spec = DeviceEnvironmentInput::default();
        assert_eq!(coding_tools(&spec), vec!["claude_code", "codex"]);
    }

    #[test]
    fn coding_tools_uses_openclaw_shell() {
        let spec = DeviceEnvironmentInput {
            bind_shell: Some("openclaw".to_string()),
            ..DeviceEnvironmentInput::default()
        };
        assert_eq!(coding_tools(&spec), vec!["openclaw"]);
    }

    #[test]
    fn datetime_value_renders_naive_and_fractional() {
        let plain =
            NaiveDateTime::parse_from_str("2026-09-14 14:42:36", "%Y-%m-%d %H:%M:%S").unwrap();
        assert_eq!(datetime_value(plain), "2026-09-14T14:42:36");
        let fractional =
            NaiveDateTime::parse_from_str("2026-09-14 14:42:36.123456", "%Y-%m-%d %H:%M:%S%.f")
                .unwrap();
        assert_eq!(datetime_value(fractional), "2026-09-14T14:42:36.123456");
    }

    #[test]
    fn device_type_defaults_to_local() {
        let spec = DeviceEnvironmentInput::default();
        assert_eq!(execution_device_type(&spec), "local");
        let remote = DeviceEnvironmentInput {
            device_type: Some("remote".to_string()),
            ..DeviceEnvironmentInput::default()
        };
        assert_eq!(execution_device_type(&remote), "remote");
    }
}
