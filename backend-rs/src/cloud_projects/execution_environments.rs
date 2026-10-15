// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/cloud-projects/{project_id}/execution-environments`: the
//! execution-environments free function, injecting the process-lifetime
//! application state.
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql};
use chrono::NaiveDateTime;

use crate::devices;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use brz_json::{JsonProjection, OpaqueJson};

/// Resolve the project's effective read permission and unique active parent,
/// then expose its bound devices with current space/project consent. Revoked or
/// inactive devices remain in the catalog as unavailable; legacy owner-installed
/// bindings retain only their original project's consent and revocation markers.
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
    app_device_id: Option<String>,
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
    can_use: bool,
    unavailable_reason: Option<&'static str>,
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
    #[mysql(rename = "resource_members_invited_by_user_id")]
    invited_by_user_id: i32,
    #[mysql(rename = "resource_members_created_at")]
    grant_created_at: Option<NaiveDateTime>,
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[mysql(rename = "kinds_is_active")]
    is_active: bool,
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
    #[serde(rename = "appDeviceId")]
    app_device_id: Option<String>,
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

fn internal_execution_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "cloud-projects execution-environments dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
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
                 AND kinds.kind = 'Device' \
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

/// Resolve `owner_values`' `owner_name` for each device owner in order. The
/// authenticated user's instance is held by the request and therefore already
/// in the source session's weak identity map (no query), while every other
/// device issues its own `db.get(User, device.user_id)` — the loaded `User` is
/// not retained, so a repeated owner is re-read per device.
async fn device_owner_names<M: Mysql>(
    mysql: &M,
    owner_user_ids: &[i32],
    current_user_id: i32,
    current_user_name: &str,
) -> Result<Vec<String>, brz_mysql::MysqlError> {
    let mut names = Vec::with_capacity(owner_user_ids.len());
    for &owner_user_id in owner_user_ids {
        if owner_user_id == current_user_id {
            names.push(current_user_name.to_string());
        } else {
            names.push(
                owner_user_row(mysql, owner_user_id)
                    .await?
                    .unwrap_or_default(),
            );
        }
    }
    Ok(names)
}

/// Handler body for `GET /api/v1/cloud-projects/{project_id}/execution-environments`.
async fn execution_environments(
    state: &AppState,
    project_id: &str,
    current_user: &crate::loop_tasks::auth::UserRow,
) -> Result<ExecutionEnvironmentListResponse, FastApiError> {
    let id = super::parse_project_id(project_id)?;
    let access = super::collaboration_access::authorized_projects(
        &state.mysql,
        current_user.id,
        Some(id),
        None,
    )
    .await
    .map_err(internal_execution_error)?
    .into_iter()
    .next()
    .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Cloud project not found"))?;
    let workspace_id = access.workspace.id.clone();
    let metadata = access
        .project
        .metadata
        .as_ref()
        .and_then(|m| m.0.value.as_ref());
    let authorized = super::environment_authorization::authorized_device_ids(
        &state.mysql,
        project_id,
        workspace_id.parse().expect("workspace IDs are numeric"),
        metadata,
    )
    .await
    .map_err(internal_execution_error)?;

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

    // `owner_values`: `db.get(User, device.user_id)` feeds `owner_name`. The
    // source session's identity map is weak and `owner_values` does not retain
    // the loaded `User`, so only the authenticated user's instance stays alive
    // across devices: a device owned by the current user resolves without a
    // query, while every other device issues its own lookup (a repeated owner
    // is re-read for each device).
    let owner_user_ids: Vec<i32> = rows.iter().map(|row| row.device_user_id).collect();
    let owner_names = device_owner_names(
        &state.mysql,
        &owner_user_ids,
        current_user.id,
        &current_user.user_name,
    )
    .await
    .map_err(internal_execution_error)?;

    let mut items = Vec::with_capacity(rows.len());
    for (row, owner_name) in rows.iter().zip(owner_names) {
        let spec = row.spec();
        let device_type = execution_device_type(&spec);
        let name = spec
            .display_name
            .as_deref()
            .map(str::to_string)
            .unwrap_or_else(|| row.name.clone());
        let runtime_instance_id = spec
            .runtime_instance_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        let can_use = row.is_active && authorized.contains(&row.id);
        items.push(ExecutionEnvironmentItem {
            id: row.id.to_string(),
            workspace_id: workspace_id.clone(),
            device_id: row.id,
            device_key: runtime_device_route_id(row),
            app_device_id: spec.app_device_id.clone(),
            name,
            kind: execution_environment_kind(&device_type),
            device_type,
            runtime_instance_id,
            capabilities: spec.capabilities_values(),
            coding_tools: coding_tools(&spec),
            owner_type: "user".to_string(),
            owner_id: row.device_user_id.to_string(),
            owner_name,
            status: if can_use {
                status_map
                    .get(&row.id)
                    .cloned()
                    .unwrap_or_else(|| "offline".to_string())
            } else {
                "error".to_owned()
            },
            can_use,
            unavailable_reason: (!can_use).then_some("resource_authorization_revoked"),
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
    fn owner_sql_is_the_unlabeled_primary_key_lookup() {
        let sql = normalize(&owner_user_sql(52));
        assert!(sql.starts_with("SELECT users.id, users.user_name"));
        assert!(!sql.contains(" AS users_id"), "db.get renders no labels");
        assert!(sql.contains("users.`role`, users.auth_source"));
        assert!(sql.ends_with("FROM users WHERE users.id = 52"));
        assert!(!sql.contains('?'), "the primary-key value is inlined");
    }

    #[tokio::test]
    async fn a_repeated_device_owner_is_read_once_per_device() {
        use crate::sql_test_support::KindQueryCapture;
        // Two devices owned by the same user, neither being the caller. The
        // source's weak identity map does not retain the loaded `User`, so
        // `db.get(User, 86)` runs per device rather than once.
        let mysql = KindQueryCapture::default();
        let names = device_owner_names(&mysql, &[86, 86], 157, "viewer")
            .await
            .unwrap();
        assert_eq!(names.len(), 2);
        let user_reads: Vec<_> = mysql
            .queries()
            .into_iter()
            .filter(|query| query.sql.contains("FROM users WHERE users.id = 86"))
            .collect();
        assert_eq!(user_reads.len(), 2, "each device re-reads its owner");
    }

    #[tokio::test]
    async fn a_device_owned_by_the_caller_resolves_without_a_read() {
        use crate::sql_test_support::KindQueryCapture;
        // The authenticated user's instance is held by the request, so the
        // source identity map satisfies `db.get(User, caller)` with no query.
        let mysql = KindQueryCapture::default();
        let names = device_owner_names(&mysql, &[157, 157], 157, "viewer")
            .await
            .unwrap();
        assert_eq!(names, vec!["viewer".to_string(), "viewer".to_string()]);
        assert!(
            mysql.queries().is_empty(),
            "the identity map holds the caller"
        );
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

    fn sample_item(app_device_id: Option<&str>) -> ExecutionEnvironmentItem {
        ExecutionEnvironmentItem {
            id: "101".to_string(),
            workspace_id: "201".to_string(),
            device_id: 101,
            device_key: "app-record-101".to_string(),
            app_device_id: app_device_id.map(str::to_string),
            name: "EXAMPLE-DEVICE-01".to_string(),
            kind: "local_device".to_string(),
            device_type: "app".to_string(),
            runtime_instance_id: None,
            capabilities: Vec::new(),
            coding_tools: vec!["claude_code".to_string(), "codex".to_string()],
            owner_type: "user".to_string(),
            owner_id: "301".to_string(),
            owner_name: "example-owner".to_string(),
            status: "online".to_string(),
            can_use: true,
            unavailable_reason: None,
            owner_user_id: Some(301),
            added_by_user_id: 301,
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn app_device_id_projects_from_the_spec() {
        let spec: DeviceEnvironmentInput = serde_json::from_str(
            r#"{"deviceType":"app","appDeviceId":"electron-00000000-0000-4000-8000-000000000001"}"#,
        )
        .unwrap();
        assert_eq!(
            spec.app_device_id.as_deref(),
            Some("electron-00000000-0000-4000-8000-000000000001")
        );
        // A spec without `appDeviceId` projects `None`, like `spec.get(...)`.
        let absent: DeviceEnvironmentInput =
            serde_json::from_str(r#"{"deviceType":"local"}"#).unwrap();
        assert_eq!(absent.app_device_id, None);
    }

    #[test]
    fn item_keeps_app_device_id_present_and_null() {
        let value = serde_json::to_value(sample_item(Some("electron-abc"))).unwrap();
        assert_eq!(value["app_device_id"], "electron-abc");
        // The field is always present, `null` when the spec omits it.
        let value = serde_json::to_value(sample_item(None)).unwrap();
        assert!(value.get("app_device_id").is_some());
        assert!(value["app_device_id"].is_null());
    }
}
