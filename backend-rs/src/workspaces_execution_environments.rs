// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/workspaces/{workspace_id}/execution-environments`: the
//! execution-environments free function, injecting the process-lifetime
//! application state.
//!
//! Mirrors `app.api.endpoints.workspaces.list_workspace_execution_environments`
//! (router prefix `/v1/workspaces` under the app prefix `/api`) ->
//! `workspace_service.list_execution_environments`
//! (`app.services.workspaces.execution_environments`).
//!
//! Source pipeline:
//!
//! 1. `get_current_user_jwt_apikey_tasktoken` — the flexible JWT / API-key /
//!    task-token dependency with the labeled `users` by-name lookup;
//! 2. `require_workspace_role(db, workspace_id, user_id)` with the default
//!    `Reporter` role — the active `CollaborationWorkspace` `kinds` row, then
//!    the caller's approved `Workspace`/`user` membership row. A missing kind
//!    or membership is `404 {"detail": "Workspace not found"}`, an unknown
//!    role string is `403 "Invalid Workspace role"`, and a role above
//!    `Reporter` is `403 "Insufficient permission"`;
//! 3. the approved `Device` grants joined with `kinds`, ordered by
//!    `resource_members.created_at, resource_members.id`;
//! 4. `execution_environment_statuses` — one Redis `MGET` of the per-device
//!    online keys (`device:online:<owner>:<route>`, where the route is the
//!    `device_connection_route_id`), with the `matching_online_info`
//!    Runtime-instance check applied to `local`/`app` devices; a device is
//!    `online` when its raw status is `online`/`busy`, else `offline`;
//! 5. per device, `owner_values` — an `Owner` grant resolves the Workspace
//!    through `db.get(Kind, grant.entity_id)`; any other grant resolves the
//!    user owner through `db.get(User, device.user_id)`.
//!
//! The response is `WorkspaceExecutionEnvironmentListResponse` (`{"items":
//! [...]}`) with the source schema field order; snowflake ids serialize as
//! strings while the numeric `device_id` stays numeric.
//!
//! The recorded session closes with two implicit `ROLLBACK`s; the driver's
//! read-only-session evidence lets Replay classify them as optional cleanup,
//! so no rollback statements are issued here.
use brz_http_server::StatusCode;
use brz_json::{JsonProjection, OpaqueJson};
use brz_mysql::{FromMysqlRow, Mysql};
use chrono::NaiveDateTime;

use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `kinds` projection rendered by the source `db.query(Kind)` (SQLAlchemy
/// labels every column `kinds_<name>`).
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// `resource_members` projection rendered by the source
/// `db.query(ResourceMember)`.
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
/// (lower is more privileged); a role above this level cannot list
/// environments.
const REPORTER_LEVEL: u8 = 3;

/// `WorkspaceExecutionEnvironmentResponse` (`app.schemas.workspace`), rendered
/// in the source schema field order. Snowflake ids serialize as strings; the
/// numeric `device_id` stays numeric.
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

/// One `resource_members` Device grant joined with its `kinds` row, selected
/// with the full labeled source column list so the statement matches the
/// recorded exchange. Only the fields consumed by the response are typed.
#[derive(Debug, FromMysqlRow)]
struct EnvironmentGrantRow {
    #[mysql(rename = "resource_members_role")]
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
    json: brz_mysql::Json<JsonProjection<DeviceDocumentProjection>>,
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
    #[serde(rename = "codingTools")]
    coding_tools: Option<Vec<OpaqueJson>>,
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

impl EnvironmentGrantRow {
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

impl DeviceEnvironmentInput {
    /// `device_kind_type` (`app.services.device.identity`): `spec.deviceType`
    /// with a `local` default; an unknown value also falls back to `local`.
    fn kind_type(&self) -> DeviceKindType {
        match self.device_type.as_deref() {
            Some("cloud") => DeviceKindType::Cloud,
            Some("app") => DeviceKindType::App,
            Some("remote") => DeviceKindType::Remote,
            _ => DeviceKindType::Local,
        }
    }

    /// `spec.deviceId` / `cloudConfig.deviceId` as a non-empty trimmed
    /// string.
    fn logical_device_id(&self) -> Option<&str> {
        self.device_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                self.cloud_config
                    .as_ref()
                    .and_then(|config| config.device_id.as_deref())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
    }

    /// `spec.runtimeInstanceId` as a non-empty string, else `None`.
    fn runtime_instance_id(&self) -> Option<String> {
        self.runtime_instance_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    /// `execution_environment_values`'s `capabilities`: a JSON list of
    /// strings; any other shape renders `[]`.
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

    /// `coding_tools` (`app.services.workspaces.resource_mapping`): the
    /// configured `codingTools` list with blank entries dropped, else the
    /// `openclaw` shell, else the `claude_code`/`codex` pair.
    fn coding_tools(&self) -> Vec<String> {
        if let Some(configured) = self
            .coding_tools
            .as_ref()
            .map(|tools| {
                tools
                    .iter()
                    .map(|tool| tool.to_value())
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .filter(|tool| !tool.trim().is_empty())
                    .collect::<Vec<String>>()
            })
            .filter(|tools| !tools.is_empty())
        {
            return configured;
        }
        match self
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
}

/// The persisted device types (`app.schemas.device.DeviceType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeviceKindType {
    Cloud,
    Local,
    App,
    Remote,
}

/// `get_workspace_kind`: the active `CollaborationWorkspace` row for the id.
fn workspace_kind_sql(workspace_id: i64) -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id = {workspace_id} AND kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true \n LIMIT 1"
    )
}

/// The caller's approved `Workspace`/`user` membership row for the id.
fn membership_sql(workspace_id: i64, user_id: i32) -> String {
    format!(
        "SELECT {RESOURCE_MEMBER_COLUMNS} \nFROM resource_members \nWHERE resource_members.resource_type = 'Workspace' AND resource_members.resource_id = {workspace_id} AND resource_members.entity_type = 'user' AND resource_members.entity_id = '{user_id}' AND resource_members.status = 'approved' \n LIMIT 1"
    )
}

/// The approved `Device` grants joined with `kinds`, ordered by
/// `resource_members.created_at, resource_members.id`.
fn environment_grants_sql(workspace_id: i64) -> String {
    format!(
        "SELECT {RESOURCE_MEMBER_COLUMNS}, {KIND_COLUMNS} \nFROM resource_members INNER JOIN kinds ON kinds.id = resource_members.resource_id \nWHERE resource_members.resource_type = 'Device' AND resource_members.entity_type = 'workspace' AND resource_members.entity_id = '{workspace_id}' AND resource_members.status = 'approved' AND kinds.kind = 'Device' AND kinds.is_active IS true ORDER BY resource_members.created_at, resource_members.id"
    )
}

/// `db.get(Kind, int(grant.entity_id))`: SQLAlchemy renders the ORM
/// primary-key load with the mapped columns unlabeled.
fn workspace_entity_sql(workspace_id: i64) -> String {
    format!(
        "SELECT kinds.id, kinds.user_id, kinds.kind, kinds.name, kinds.namespace, \
         kinds.json, kinds.is_active, kinds.created_at, kinds.updated_at \
         FROM kinds WHERE kinds.id = {workspace_id}",
    )
}

/// `db.get(User, device.user_id)`: the unlabeled `users` primary-key load.
fn owner_user_sql(user_id: i32) -> String {
    format!(
        "SELECT users.id, users.user_name, users.password_hash, users.email, \
         users.git_info, users.is_active, users.`role`, users.auth_source, \
         users.preferences, users.created_at, users.updated_at \
         FROM users WHERE users.id = {user_id}",
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

/// `execution_environment_kind`: `cloud_host` for cloud/remote, else
/// `local_device`.
fn execution_environment_kind(device_type: &str) -> String {
    if matches!(device_type, "cloud" | "remote") {
        "cloud_host".to_string()
    } else {
        "local_device".to_string()
    }
}

/// `runtime_device_route_id` (`app.services.device.runtime_route`): App
/// devices use `app-record-<id>`; every other type keeps
/// `spec.deviceId` / `cloudConfig.deviceId` / `name`.
fn runtime_device_route_id(row: &EnvironmentGrantRow) -> String {
    let spec = row.spec();
    if spec.kind_type() == DeviceKindType::App {
        return format!("app-record-{}", row.id);
    }
    spec.logical_device_id()
        .map(str::to_string)
        .unwrap_or_else(|| row.name.clone())
}

/// `device_connection_route_id` (`app.services.device.identity`): cloud
/// devices connect under `spec.deviceId` / `cloudConfig.deviceId` / `name`;
/// every other type connects under its record route (App devices
/// `app-record-<id>`, others the Kind `name`).
fn connection_route_id(row: &EnvironmentGrantRow) -> String {
    let spec = row.spec();
    match spec.kind_type() {
        DeviceKindType::Cloud => spec
            .logical_device_id()
            .map(str::to_string)
            .unwrap_or_else(|| row.name.clone()),
        DeviceKindType::App => format!("app-record-{}", row.id),
        _ => row.name.clone(),
    }
}

/// `matching_online_info` (`app.services.device.identity`): a shared Redis
/// key is not proof that this database Runtime is online. A missing document
/// never matches; `app` devices without a persisted `runtimeInstanceId`
/// never match; a device whose persisted id differs from the observed one
/// (or that persisted one while the document reports another) does not
/// match.
fn matching_online_info<'a>(
    spec: &DeviceEnvironmentInput,
    online: Option<&'a serde_json::Value>,
) -> Option<&'a serde_json::Value> {
    let online = online?;
    let persisted = spec.runtime_instance_id().map(serde_json::Value::String);
    let observed = online.get("runtime_instance_id").cloned();
    let is_app = spec.kind_type() == DeviceKindType::App;
    if is_app && persisted.is_none() {
        return None;
    }
    if persisted != observed && (persisted.is_some() || is_app) {
        return None;
    }
    Some(online)
}

/// `online_info.get("status", "online") if online_info else "offline"`: the
/// raw status a device's online-state document reports, defaulting to
/// `online` only when the document exists but omits the field. A missing
/// document (Redis nil) is offline.
fn raw_status(online: Option<&serde_json::Value>) -> &str {
    match online {
        Some(info) => info
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("online"),
        None => "offline",
    }
}

/// `require_workspace_role(db, workspace_id, user_id)` with the default
/// `Reporter` role. Both reads keep the recorded statement shapes; the kind
/// row proves existence and the membership row resolves the effective role.
async fn require_workspace_role<M: Mysql>(
    mysql: &M,
    workspace_id: i64,
    user_id: i32,
) -> Result<(), FastApiError> {
    #[derive(Debug, FromMysqlRow)]
    struct KindRow {
        #[mysql(rename = "kinds_id")]
        #[allow(dead_code, reason = "existence proves the Workspace")]
        id: i64,
    }
    #[derive(Debug, FromMysqlRow)]
    struct MembershipRow {
        #[mysql(rename = "resource_members_role")]
        role: String,
    }
    let kind: Option<KindRow> = mysql
        .fetch_optional(workspace_kind_sql(workspace_id), ())
        .await
        .map_err(internal_error)?;
    kind.ok_or_else(workspace_not_found)?;
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
    Ok(())
}

fn workspace_not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Workspace not found")
}

fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "workspace execution-environments dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

/// `execution_environment_statuses` (
/// `app.services.workspaces.environment_status`): one Redis `MGET` of the
/// per-device online keys; `local`/`app` devices additionally require the
/// `matching_online_info` Runtime-instance check. Each device resolves to
/// `online` (raw status `online`/`busy`, defaulting to `online` when the
/// document omits the field) or `offline`.
async fn execution_environment_statuses(
    state: &AppState,
    rows: &[EnvironmentGrantRow],
) -> std::collections::HashMap<i64, String> {
    let keys: Vec<String> = rows
        .iter()
        .map(|row| {
            crate::devices::online_key(i64::from(row.device_user_id), &connection_route_id(row))
        })
        .collect();
    let online: Vec<Option<serde_json::Value>> =
        crate::devices::cache_manager_mget(state, keys).await;
    rows.iter()
        .zip(online)
        .map(|(row, online)| {
            let spec = row.spec();
            let online = if matches!(
                spec.kind_type(),
                DeviceKindType::Local | DeviceKindType::App
            ) {
                matching_online_info(&spec, online.as_ref())
            } else {
                online.as_ref()
            };
            // `online_info.get("status", "online") if online_info else
            // "offline"`: a missing document is offline, while a present
            // document without the field defaults to online.
            let raw_status = raw_status(online);
            (
                row.id,
                if matches!(raw_status, "online" | "busy") {
                    "online".to_string()
                } else {
                    "offline".to_string()
                },
            )
        })
        .collect()
}

/// `owner_values` (`app.services.workspaces.resource_mapping`): an `Owner`
/// grant resolves the Workspace through `db.get(Kind, grant.entity_id)`; any
/// other grant resolves the user owner through `db.get(User,
/// resource.user_id)`. Returns the owner quadruple.
async fn owner_values<M: Mysql>(
    mysql: &M,
    owner_names: &mut std::collections::HashMap<i32, String>,
    row: &EnvironmentGrantRow,
    workspace_id: i64,
) -> Result<(String, String, String, Option<i32>), FastApiError> {
    if row.role == "Owner" {
        #[derive(Debug, FromMysqlRow)]
        struct KindNameRow {
            name: String,
        }
        let kind: Option<KindNameRow> = mysql
            .fetch_optional(workspace_entity_sql(workspace_id), ())
            .await
            .map_err(internal_error)?;
        return Ok((
            "workspace".to_string(),
            workspace_id.to_string(),
            kind.map(|kind| kind.name).unwrap_or_default(),
            None,
        ));
    }
    let owner_user_id = row.device_user_id;
    let owner_name = match owner_names.get(&owner_user_id) {
        Some(name) => name.clone(),
        None => {
            #[derive(Debug, FromMysqlRow)]
            struct OwnerRow {
                user_name: String,
            }
            let owner: Option<OwnerRow> = mysql
                .fetch_optional(owner_user_sql(owner_user_id), ())
                .await
                .map_err(internal_error)?;
            let name = owner.map(|owner| owner.user_name).unwrap_or_default();
            owner_names.insert(owner_user_id, name.clone());
            name
        }
    };
    Ok((
        "user".to_string(),
        owner_user_id.to_string(),
        owner_name,
        Some(owner_user_id),
    ))
}

/// GET /api/v1/workspaces/{workspace_id}/execution-environments: the endpoint
/// free function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/workspaces/:workspace_id/execution-environments")]
async fn list_workspace_execution_environments(
    #[inject(state)] state: &AppState,
    workspace_id: &str,
    #[auth] user: crate::loop_tasks::auth::FlexibleUser,
) -> Result<ExecutionEnvironmentListResponse, FastApiError> {
    // FastAPI parses `workspace_id` as `int`; any other text is a 422
    // `int_parsing` validation error.
    let workspace_id: i64 = workspace_id
        .parse()
        .map_err(|_| path_int_error(workspace_id))?;
    execution_environments(state, workspace_id, user.id, &user.user_name).await
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

/// Handler body for
/// `GET /api/v1/workspaces/{workspace_id}/execution-environments`.
///
/// The `user_name` argument feeds the owner cache: the source session's
/// identity map already holds the authenticated user, so a device they own
/// resolves its owner name without a query.
async fn execution_environments(
    state: &AppState,
    workspace_id: i64,
    user_id: i32,
    user_name: &str,
) -> Result<ExecutionEnvironmentListResponse, FastApiError> {
    require_workspace_role(&state.mysql, workspace_id, user_id).await?;

    let rows: Vec<EnvironmentGrantRow> = state
        .mysql
        .fetch_all(environment_grants_sql(workspace_id), ())
        .await
        .map_err(internal_error)?;

    // One Redis `MGET` of the online keys for every device.
    let statuses = execution_environment_statuses(state, &rows).await;

    // `owner_values`: the authenticated user's name seeds the owner cache,
    // matching the session identity map the source reuses.
    let mut owner_names: std::collections::HashMap<i32, String> = std::collections::HashMap::new();
    owner_names.insert(user_id, user_name.to_string());

    let workspace_id_text = workspace_id.to_string();
    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let spec = row.spec();
        let device_type = spec.kind_type().as_str().to_string();
        let (owner_type, owner_id, owner_name, owner_user_id) =
            owner_values(&state.mysql, &mut owner_names, row, workspace_id).await?;
        items.push(ExecutionEnvironmentItem {
            id: row.id.to_string(),
            workspace_id: workspace_id_text.clone(),
            device_id: row.id,
            device_key: runtime_device_route_id(row),
            name: spec
                .display_name
                .clone()
                .unwrap_or_else(|| row.name.clone()),
            kind: execution_environment_kind(&device_type),
            device_type,
            runtime_instance_id: spec.runtime_instance_id(),
            capabilities: spec.capabilities_values(),
            coding_tools: spec.coding_tools(),
            owner_type,
            owner_id,
            owner_name,
            status: statuses
                .get(&row.id)
                .cloned()
                .unwrap_or_else(|| "offline".to_string()),
            owner_user_id,
            added_by_user_id: row.invited_by_user_id,
            created_at: row.grant_created_at.map(datetime_value),
            updated_at: row.updated_at.map(datetime_value),
        });
    }

    Ok(ExecutionEnvironmentListResponse { items })
}

impl DeviceKindType {
    /// The persisted `spec.deviceType` string.
    fn as_str(self) -> &'static str {
        match self {
            DeviceKindType::Cloud => "cloud",
            DeviceKindType::Local => "local",
            DeviceKindType::App => "app",
            DeviceKindType::Remote => "remote",
        }
    }
}

/// Pydantic naive-datetime rendering: `YYYY-MM-DDTHH:MM:SS` plus fractional
/// seconds when nonzero.
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
    fn workspace_kind_sql_matches_recorded_shape() {
        let sql = workspace_kind_sql(201);
        assert!(sql.starts_with("SELECT kinds.id AS kinds_id, "));
        assert!(sql.contains("FROM kinds \nWHERE kinds.id = 201"));
        assert!(sql.contains("kinds.kind = 'CollaborationWorkspace'"));
        assert!(sql.contains("kinds.is_active IS true \n LIMIT 1"));
    }

    #[test]
    fn membership_sql_binds_string_user_number_workspace() {
        let sql = membership_sql(201, 301);
        assert!(sql.contains("resource_members.resource_id = 201"));
        assert!(sql.contains("resource_members.entity_id = '301'"));
        assert!(sql.contains("resource_members.status = 'approved' \n LIMIT 1"));
    }

    #[test]
    fn environment_grants_sql_orders_by_grant_creation() {
        let sql = environment_grants_sql(201);
        assert!(sql.contains(
            "FROM resource_members INNER JOIN kinds ON kinds.id = resource_members.resource_id"
        ));
        assert!(sql.contains("resource_members.entity_type = 'workspace'"));
        assert!(sql.contains("resource_members.entity_id = '201'"));
        assert!(sql.contains("ORDER BY resource_members.created_at, resource_members.id"));
        assert!(sql.contains("kinds.is_active IS true"));
    }

    #[test]
    fn workspace_entity_sql_is_the_unlabeled_primary_key_lookup() {
        let sql = normalize(&workspace_entity_sql(201));
        assert!(sql.starts_with("SELECT kinds.id, kinds.user_id"));
        assert!(!sql.contains(" AS kinds_id"), "db.get renders no labels");
        assert!(sql.ends_with("FROM kinds WHERE kinds.id = 201"));
    }

    #[test]
    fn owner_user_sql_is_the_unlabeled_primary_key_lookup() {
        let sql = normalize(&owner_user_sql(301));
        assert!(sql.starts_with("SELECT users.id, users.user_name"));
        assert!(!sql.contains(" AS users_id"), "db.get renders no labels");
        assert!(sql.ends_with("FROM users WHERE users.id = 301"));
    }

    #[test]
    fn role_level_and_reporter_permission() {
        assert_eq!(role_level("Owner"), Some(0));
        assert_eq!(role_level("RestrictedAnalyst"), Some(5));
        assert_eq!(role_level("Nonsense"), None);
    }

    #[test]
    fn execution_environment_kind_maps_cloud_and_remote_to_cloud_host() {
        assert_eq!(execution_environment_kind("cloud"), "cloud_host");
        assert_eq!(execution_environment_kind("remote"), "cloud_host");
        assert_eq!(execution_environment_kind("local"), "local_device");
        assert_eq!(execution_environment_kind("app"), "local_device");
    }

    #[test]
    fn coding_tools_default_to_claude_and_codex() {
        let spec = DeviceEnvironmentInput::default();
        assert_eq!(spec.coding_tools(), vec!["claude_code", "codex"]);
    }

    #[test]
    fn coding_tools_use_openclaw_shell() {
        let spec = DeviceEnvironmentInput {
            bind_shell: Some("openclaw".to_string()),
            ..DeviceEnvironmentInput::default()
        };
        assert_eq!(spec.coding_tools(), vec!["openclaw"]);
    }

    #[test]
    fn coding_tools_prefer_the_configured_list() {
        let spec = DeviceEnvironmentInput {
            coding_tools: Some(vec![
                OpaqueJson::from(serde_json::json!("claude_code")),
                OpaqueJson::from(serde_json::json!(" ")),
            ]),
            ..DeviceEnvironmentInput::default()
        };
        assert_eq!(spec.coding_tools(), vec!["claude_code"]);
    }

    #[test]
    fn capabilities_render_empty_for_non_list_values() {
        let spec = DeviceEnvironmentInput {
            capabilities: Some(OpaqueJson::from(serde_json::json!(null))),
            ..DeviceEnvironmentInput::default()
        };
        assert!(spec.capabilities_values().is_empty());
        let spec = DeviceEnvironmentInput {
            capabilities: Some(OpaqueJson::from(serde_json::json!(["a", 1]))),
            ..DeviceEnvironmentInput::default()
        };
        assert_eq!(spec.capabilities_values(), vec!["a".to_string()]);
    }

    #[test]
    fn matching_online_info_enforces_runtime_instance_identity() {
        let spec = DeviceEnvironmentInput {
            runtime_instance_id: Some("runtime-1".to_string()),
            ..DeviceEnvironmentInput::default()
        };
        let matching = serde_json::json!({"status": "online", "runtime_instance_id": "runtime-1"});
        assert!(matching_online_info(&spec, Some(&matching)).is_some());
        let stale = serde_json::json!({"status": "online", "runtime_instance_id": "runtime-2"});
        assert!(matching_online_info(&spec, Some(&stale)).is_none());
        assert!(matching_online_info(&spec, None).is_none());
        // A device without a persisted id accepts any observed value.
        let unpinned = DeviceEnvironmentInput::default();
        let any_runtime = serde_json::json!({"status": "online", "runtime_instance_id": "x"});
        assert!(matching_online_info(&unpinned, Some(&any_runtime)).is_some());
        // An app device without a persisted id never matches.
        let app = DeviceEnvironmentInput {
            device_type: Some("app".to_string()),
            ..DeviceEnvironmentInput::default()
        };
        assert!(matching_online_info(&app, Some(&any_runtime)).is_none());
    }

    /// `raw_status = online_info.get("status", "online") if online_info else
    /// "offline"`: a missing Redis document renders offline, while a present
    /// document without the status field defaults to online. The failing
    /// recorded cases carry a Redis nil for the online key.
    #[test]
    fn a_missing_online_document_is_offline() {
        assert_eq!(raw_status(None), "offline");
        assert_eq!(raw_status(Some(&serde_json::json!({}))), "online");
        assert_eq!(
            raw_status(Some(&serde_json::json!({"status": "busy"}))),
            "busy"
        );
    }

    #[test]
    fn datetime_value_renders_naive_and_fractional() {
        let plain =
            NaiveDateTime::parse_from_str("2026-10-10 17:28:06", "%Y-%m-%d %H:%M:%S").unwrap();
        assert_eq!(datetime_value(plain), "2026-10-10T17:28:06");
        let fractional =
            NaiveDateTime::parse_from_str("2026-09-14 14:42:36.123456", "%Y-%m-%d %H:%M:%S%.f")
                .unwrap();
        assert_eq!(datetime_value(fractional), "2026-09-14T14:42:36.123456");
    }

    #[test]
    fn response_serializes_schema_order() {
        let response = ExecutionEnvironmentListResponse {
            items: vec![ExecutionEnvironmentItem {
                id: "101".to_string(),
                workspace_id: "201".to_string(),
                device_id: 101,
                device_key: "00000000-0000-4000-8000-000000000002".to_string(),
                name: "example-env-v1".to_string(),
                kind: "cloud_host".to_string(),
                device_type: "remote".to_string(),
                runtime_instance_id: Some("runtime-000000000000000000000001".to_string()),
                capabilities: Vec::new(),
                coding_tools: vec!["claude_code".to_string(), "codex".to_string()],
                owner_type: "user".to_string(),
                owner_id: "301".to_string(),
                owner_name: "example-owner".to_string(),
                status: "online".to_string(),
                owner_user_id: Some(301),
                added_by_user_id: 301,
                created_at: Some("2026-10-10T17:28:06".to_string()),
                updated_at: Some("2026-10-10T10:41:34".to_string()),
            }],
        };
        let rendered = serde_json::to_value(&response).unwrap();
        let item = &rendered["items"][0];
        assert_eq!(
            item.as_object().unwrap().keys().collect::<Vec<_>>(),
            [
                "id",
                "workspace_id",
                "device_id",
                "device_key",
                "name",
                "kind",
                "device_type",
                "runtime_instance_id",
                "capabilities",
                "coding_tools",
                "owner_type",
                "owner_id",
                "owner_name",
                "status",
                "owner_user_id",
                "added_by_user_id",
                "created_at",
                "updated_at"
            ]
        );
        assert_eq!(item["id"], "101");
        assert_eq!(item["device_id"], 101);
        assert_eq!(item["capabilities"], serde_json::json!([]));
    }
}
