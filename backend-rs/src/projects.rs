// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/projects` — the current user's project list with tasks
//! (`app.api.endpoints.projects.list_projects` ->
//! `app.services.project_service.list_projects`).
//!
//! Source pipeline (recorded case `api-projects/deaea280`, JWT bearer
//! session for a sample user, `include_tasks=true`):
//!
//! 1. `security.get_current_user` — the user row by `user_name`;
//! 2. the `projects` query: owned or approved-shared
//!    (`resource_members` EXISTS with `resource_type='Project'`,
//!    `entity_type='user'`, `entity_id='<uid>'`, `status='approved'`),
//!    `is_active`, `client_origin` (query value, default `frontend`),
//!    ordered `sort_order ASC`;
//! 3. per project, `task_store.list_active_project_tasks` reads the
//!    configured task repository. The public repository reads the base
//!    `tasks` table once; the private deployment enables the migration
//!    repository, which reads the base table (legacy rows), probes the owner's
//!    shard table for migrated legacy ids, then reads the owner's shard table,
//!    and finally merges both halves with id deduplication.
//! 4. `ProjectWithTasksResponse` per project with `task_count=len(tasks)`
//!    and the `_get_project_tasks` projection (`task_title` from
//!    `spec.title or task.name or "Task #{id}"`, `task_status` from
//!    `status.phase` defaulting `PENDING`, workspace fields trimmed from
//!    `spec.execution.workspace.{source,path}`).
//!
//! The response is the `ProjectListResponse` (`total`, `items`).
use std::sync::Arc;

use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult, MysqlRow};
use chrono::NaiveDateTime;
use serde::Deserialize;
use serde_json::json;

use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::task_routing::ByUserId;

/// `projects` columns as rendered by `db.query(Project)` (labeled
/// `projects_<column>`).
const PROJECT_COLUMNS: &str = "projects.id AS projects_id, \
     projects.user_id AS projects_user_id, projects.name AS projects_name, \
     projects.description AS projects_description, \
     projects.color AS projects_color, \
     projects.client_origin AS projects_client_origin, \
     projects.config AS projects_config, \
     projects.sort_order AS projects_sort_order, \
     projects.is_expanded AS projects_is_expanded, \
     projects.is_active AS projects_is_active, \
     projects.created_at AS projects_created_at, \
     projects.updated_at AS projects_updated_at";

/// The `projects` row (the full labeled projection so the prepared
/// statement matches the recorded exchange; `is_active` is filtered in
/// SQL and not consumed).
#[derive(Debug, FromMysqlRow)]
struct ProjectRow {
    projects_id: i64,
    projects_user_id: i64,
    projects_name: String,
    projects_description: Option<String>,
    projects_color: Option<String>,
    projects_client_origin: String,
    projects_config: Option<Json<NullableConfig>>,
    projects_sort_order: i64,
    projects_is_expanded: i8,
    projects_created_at: NaiveDateTime,
    projects_updated_at: NaiveDateTime,
}

/// The stored `projects.config` JSON column. The DB stores JSON `null`
/// (not SQL `NULL`), so `Option<Json<...>>` alone would fail: SQL `NULL`
/// maps to `None`, but JSON `null` is a non-NULL value that serde cannot
/// deserialize as a struct. This wrapper treats JSON `null` as `Null`
/// (which serializes as `null` in the response, matching the source's
/// `Optional[ProjectConfig]` with `config=None`).
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum NullableConfig {
    Null,
    Config(Box<StoredProjectConfig>),
}

impl serde::Serialize for NullableConfig {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            NullableConfig::Null => serializer.serialize_none(),
            NullableConfig::Config(config) => config.serialize(serializer),
        }
    }
}

/// The stored `projects.config` JSON column, validated and re-serialized
/// as `ProjectConfig` (`app.schemas.project.ProjectConfig`,
/// `extra="forbid"`). `None` renders `null` in the response; a present
/// config re-serializes with every optional field materialized.
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct StoredProjectConfig {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    execution: Option<ProjectExecutionConfig>,
    #[serde(default)]
    team: Option<ProjectTeamConfig>,
    #[serde(default)]
    workspace: Option<ProjectWorkspaceConfig>,
    #[serde(default)]
    git: Option<ProjectGitConfig>,
    #[serde(default, rename = "modelSelection")]
    model_selection: Option<ProjectModelSelection>,
}

/// `ProjectExecutionConfig` (`extra="forbid"`).
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ProjectExecutionConfig {
    #[serde(rename = "targetType")]
    target_type: String,
    #[serde(default, rename = "deviceId")]
    device_id: Option<String>,
}

/// `ProjectTeamConfig` (`extra="forbid"`, `namespace` default `"default"`).
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ProjectTeamConfig {
    #[serde(default)]
    id: Option<i64>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default = "default_namespace")]
    namespace: String,
}

fn default_namespace() -> String {
    "default".to_string()
}

/// `ProjectWorkspaceConfig` (`extra="forbid"`).
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ProjectWorkspaceConfig {
    source: String,
    #[serde(default, rename = "localPath")]
    local_path: Option<String>,
    #[serde(default, rename = "checkoutPath")]
    checkout_path: Option<String>,
    #[serde(default, rename = "devicePath")]
    device_path: Option<String>,
    #[serde(default, rename = "workspaceRef")]
    workspace_ref: Option<ProjectWorkspaceRef>,
}

/// `ProjectWorkspaceRef` (`extra="forbid"`, `namespace` default `"default"`).
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ProjectWorkspaceRef {
    name: String,
    #[serde(default = "default_namespace")]
    namespace: String,
}

/// `ProjectGitConfig` (`extra="forbid"`, `branch` default `"main"`).
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ProjectGitConfig {
    url: String,
    #[serde(default)]
    repo: Option<String>,
    #[serde(default, rename = "repoId")]
    repo_id: Option<i64>,
    #[serde(default)]
    domain: Option<String>,
    #[serde(default = "default_branch")]
    branch: String,
}

fn default_branch() -> String {
    "main".to_string()
}

/// `ProjectModelSelection` (`extra="forbid"`, `options` default `{}`).
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ProjectModelSelection {
    #[serde(rename = "modelName")]
    model_name: String,
    #[serde(default, rename = "modelType")]
    model_type: Option<String>,
    #[serde(default = "default_options_map")]
    options: OptionsMap,
}

/// The `options` dict (`default_factory=dict`); dynamic string keys echo
/// verbatim through `raw_value` without a materialized dynamic value.
#[derive(Debug, Clone, Default, serde::Serialize)]
struct OptionsMap(Option<Box<serde_json::value::RawValue>>);

impl<'de> Deserialize<'de> for OptionsMap {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Option::<Box<serde_json::value::RawValue>>::deserialize(deserializer).map(OptionsMap)
    }
}

fn default_options_map() -> OptionsMap {
    OptionsMap(Some(
        serde_json::value::RawValue::from_string("{}".to_string()).expect("valid JSON"),
    ))
}

/// One `tasks`/`tasks_{:04}` row of the per-project task query, decoded by
/// its `{table}_*` aliases (the shard table name is dynamic).
#[derive(Debug)]
struct ProjectTaskRow {
    id: i64,
    name: String,
    crd: TaskCrd,
    updated_at: NaiveDateTime,
}

/// The task CRD (`task.json`) with only the fields the projection reads.
/// Unknown keys are ignored (the source guards with `isinstance(..., dict)`).
/// A non-object `json` column (null, string, number, array) deserializes
/// to `TaskCrd::default()`, mirroring the source's
/// `if not isinstance(task_json, dict): return {}` guard.
#[derive(Debug, Clone, Default)]
struct TaskCrd {
    spec: Option<TaskSpec>,
    status: Option<TaskStatus>,
}

impl<'de> Deserialize<'de> for TaskCrd {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TaskCrdVisitor;
        impl<'de> serde::de::Visitor<'de> for TaskCrdVisitor {
            type Value = TaskCrd;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a task CRD object or any JSON value")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Self::Value, A::Error> {
                let mut spec = None;
                let mut status = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "spec" => spec = map.next_value()?,
                        "status" => status = map.next_value()?,
                        _ => {
                            let _: serde::de::IgnoredAny = map.next_value()?;
                        }
                    }
                }
                Ok(TaskCrd { spec, status })
            }
            fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(TaskCrd::default())
            }
            fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(TaskCrd::default())
            }
            fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(TaskCrd::default())
            }
            fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(TaskCrd::default())
            }
            fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(TaskCrd::default())
            }
            fn visit_string<E: serde::de::Error>(self, _: String) -> Result<Self::Value, E> {
                Ok(TaskCrd::default())
            }
            fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(TaskCrd::default())
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(TaskCrd::default())
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Self::Value, A::Error> {
                while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                Ok(TaskCrd::default())
            }
        }
        deserializer.deserialize_any(TaskCrdVisitor)
    }
}

impl TaskCrd {
    fn spec(&self) -> Option<&TaskSpec> {
        self.spec.as_ref()
    }

    fn status_phase(&self) -> Option<&str> {
        self.status.as_ref().and_then(|s| s.phase.as_deref())
    }
}

/// `spec` fields consumed by `_task_spec` and `_get_project_tasks`.
#[derive(Debug, Clone, Default, Deserialize)]
struct TaskSpec {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    is_group_chat: Option<bool>,
    #[serde(default)]
    execution: Option<TaskExecution>,
}

/// `spec.execution.workspace.{source,path}` (trimmed non-empty strings).
#[derive(Debug, Clone, Default, Deserialize)]
struct TaskExecution {
    #[serde(default)]
    workspace: Option<TaskWorkspace>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct TaskWorkspace {
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

/// `status.phase` (defaults `"PENDING"` when absent or non-dict).
#[derive(Debug, Clone, Default, Deserialize)]
struct TaskStatus {
    #[serde(default)]
    phase: Option<String>,
}

/// Decode one task row by its unqualified column names.
///
/// The `json` column is decoded as `Json<TaskCrd>`; the `#[serde(untagged)]`
/// enum falls back to `TaskCrd::NonObject` for non-object JSON, mirroring the
/// source's `_task_json` guard
/// (`task.json or {}; if not isinstance(task_json, dict): return {}`).
fn decode_task_row(row: &MysqlRow) -> MysqlResult<ProjectTaskRow> {
    Ok(ProjectTaskRow {
        id: row.get_required("id")?,
        name: row.get_required("name")?,
        crd: row.get_required::<Json<TaskCrd>>("json")?.0,
        updated_at: row.get_required("updated_at")?,
    })
}

/// The task projection (`ProjectTaskResponse`), in the pydantic model's
/// field order.
#[derive(Debug, serde::Serialize)]
struct ProjectTaskItem {
    task_id: i64,
    task_title: String,
    task_status: String,
    device_id: Option<String>,
    execution_workspace_source: Option<String>,
    execution_workspace_path: Option<String>,
    is_group_chat: bool,
    project_id: i64,
    updated_at: String,
}

/// One `ProjectWithTasksResponse` item, in the pydantic model's field
/// order (`ProjectBase` fields first, then `ProjectResponse`, then
/// `tasks`).
#[derive(Debug, serde::Serialize)]
struct ProjectItem {
    name: String,
    description: String,
    color: Option<String>,
    client_origin: String,
    config: Option<NullableConfig>,
    id: i64,
    user_id: i64,
    sort_order: i64,
    is_expanded: bool,
    task_count: i64,
    created_at: String,
    updated_at: String,
    tasks: Vec<ProjectTaskItem>,
}

/// `ProjectListResponse`. The source declares it as the endpoint's
/// `response_model`, so FastAPI renders the response body as
/// `application/json`; returning the typed model keeps that media type
/// (a raw binary body renders `application/octet-stream`).
#[derive(Debug, serde::Serialize)]
struct ProjectListResponse {
    total: i64,
    items: Vec<ProjectItem>,
}

/// Validated `include_tasks` / `client_origin` query parameters (the
/// source `Query` constraints: boolean parse for `include_tasks`, default
/// `true`; pattern `^(frontend|wework)$` for `client_origin`, default
/// `frontend`).
struct ListProjectsParams {
    include_tasks: bool,
    client_origin: String,
}

/// Parse `include_tasks` with pydantic's boolean rules: `true`, `false`,
/// `1`, `0`, `yes`, `no`, `on`, `off` (case-insensitive) — anything else
/// is a 422 `bool_parsing` error.
fn parse_include_tasks(raw: Option<&str>) -> Result<bool, FastApiError> {
    let Some(raw) = raw else {
        return Ok(true);
    };
    match raw.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Ok(true),
        "false" | "0" | "no" | "off" => Ok(false),
        _ => Err(validation_error(
            "include_tasks",
            "bool_parsing",
            "Input should be a valid boolean, unable to interpret input",
            raw,
        )),
    }
}

/// Parse `client_origin` against the source `Query` pattern
/// `^(frontend|wework)$`.
fn parse_client_origin(raw: Option<&str>) -> Result<String, FastApiError> {
    let Some(raw) = raw else {
        return Ok("frontend".to_string());
    };
    if matches!(raw, "frontend" | "wework") {
        Ok(raw.to_string())
    } else {
        Err(validation_error(
            "client_origin",
            "string_pattern_mismatch",
            "String should match pattern '^(frontend|wework)$'",
            raw,
        ))
    }
}

/// FastAPI's 422 validation-error array body for one query parameter.
fn validation_error(field: &str, kind: &str, message: &str, input: &str) -> FastApiError {
    FastApiError::validation(json!([
        {
            "type": kind,
            "loc": ["query", field],
            "msg": message,
            "input": input,
        }
    ]))
}

/// `list_projects`: the owned-or-shared active project rows ordered
/// `sort_order ASC`. The EXISTS subquery and the `is_active`/origin
/// predicates mirror the recorded SQLAlchemy rendering (the parameters
/// bind in the recorded literal's token kinds: the owner id as an
/// integer, the EXISTS entity id as a string, the origin as a string).
async fn query_projects<M: Mysql>(
    mysql: &M,
    user_id: i64,
    client_origin: &str,
) -> MysqlResult<Vec<ProjectRow>> {
    let sql = format!(
        "SELECT {PROJECT_COLUMNS} \nFROM projects \n\
         WHERE (projects.user_id = ? OR (EXISTS (SELECT * \nFROM resource_members \n\
         WHERE resource_members.resource_type = 'Project' \
         AND resource_members.resource_id = projects.id \
         AND resource_members.entity_type = 'user' \
         AND resource_members.entity_id = ? \
         AND resource_members.status = 'approved'))) \
         AND projects.is_active = true \
         AND projects.client_origin = ? \
         ORDER BY projects.sort_order ASC"
    );
    mysql
        .fetch_all(sql.as_str(), (user_id, user_id.to_string(), client_origin))
        .await
}

/// The legacy per-project read over the **base** `tasks` table
/// (`SqlAlchemyTaskStore.list_active_project_tasks`): `ORDER BY
/// tasks.updated_at DESC`; the owner and origin filters mirror the recorded
/// rendering (the project id and owner bind as integers, the origin binds as
/// a string).
///
/// Legacy rows live in the base table, so the read passes the zero routing key
/// — the explicit base-table contract already used by the migration-free
/// repository — rather than the owner's routing key, which resolves to the
/// owner's shard. Both task-store policies use this read: the migration-free
/// store on its own, and the migration store as the legacy half of its merge,
/// whose shard half is [`query_shard_project_tasks`].
async fn query_base_project_tasks<M: Mysql>(
    mysql: &M,
    project_id: i64,
    owner_user_id: i64,
    client_origin: Option<&str>,
) -> MysqlResult<Vec<ProjectTaskRow>> {
    let mut sql = String::from(
        "SELECT id, user_id, kind, name, namespace, json, is_active,
                created_at, updated_at, project_id, client_origin, is_group_chat
         FROM {{tasks}}
         WHERE project_id = ? AND kind = 'Task' AND is_active = 1 AND user_id = ?",
    );
    if client_origin.is_some() {
        sql.push_str(" AND client_origin = ?");
    }
    sql.push_str(" ORDER BY updated_at DESC");
    let mysql = mysql.route(ByUserId(0));
    let rows: Vec<MysqlRow> = match client_origin {
        Some(origin) => {
            mysql
                .fetch_all(&sql, (project_id, owner_user_id, origin))
                .await?
        }
        None => mysql.fetch_all(&sql, (project_id, owner_user_id)).await?,
    };
    rows.iter().map(decode_task_row).collect()
}

/// The owner's shard-table per-project query (`ShardedTaskStore`'s second
/// half of `list_active_project_tasks`): same filters, no ORDER BY (the
/// Python merge sorts in memory). Uses `{{tasks}}` routed by the owner's
/// user id.
async fn query_shard_project_tasks<M: Mysql>(
    mysql: &M,
    project_id: i64,
    owner_user_id: i64,
    client_origin: Option<&str>,
) -> MysqlResult<Vec<ProjectTaskRow>> {
    let mut sql = String::from(
        "SELECT id, user_id, kind, name, namespace, json, is_active,
                created_at, updated_at, project_id, client_origin, is_group_chat
         FROM {{tasks}}
         WHERE project_id = ? AND user_id = ? AND kind = 'Task' AND is_active = 1",
    );
    if client_origin.is_some() {
        sql.push_str(" AND client_origin = ?");
    }
    let mysql = mysql.route(ByUserId(owner_user_id as u64));
    let rows: Vec<MysqlRow> = match client_origin {
        Some(origin) => {
            mysql
                .fetch_all(&sql, (project_id, owner_user_id, origin))
                .await?
        }
        None => mysql.fetch_all(&sql, (project_id, owner_user_id)).await?,
    };
    rows.iter().map(decode_task_row).collect()
}

/// `ShardedTaskStore._exclude_migrated_legacy_index_rows`: drop legacy
/// rows whose id is already migrated into the owner's shard table. Returns
/// the input unchanged when the legacy result is empty (the source
/// early-out, as in the recorded case). Probes `{{tasks}}` routed by the
/// owner's user id, because the migrated ids are indexed in that shard.
async fn exclude_migrated_legacy_rows<M: Mysql>(
    mysql: &M,
    owner_user_id: i64,
    legacy: Vec<ProjectTaskRow>,
) -> MysqlResult<Vec<ProjectTaskRow>> {
    if legacy.is_empty() {
        return Ok(legacy);
    }
    let ids: Vec<i64> = legacy.iter().map(|row| row.id).collect();
    let mut sql = String::from("SELECT id FROM {{tasks}} WHERE id IN (");
    sql.push_str(&vec!["?"; ids.len()].join(", "));
    sql.push(')');
    let rows: Vec<MysqlRow> = mysql
        .route(ByUserId(owner_user_id as u64))
        .fetch_all(&sql, ids)
        .await?;
    let migrated: Vec<i64> = rows
        .iter()
        .map(|row| row.get_required::<i64>("id"))
        .collect::<MysqlResult<_>>()?;
    Ok(legacy
        .into_iter()
        .filter(|row| !migrated.contains(&row.id))
        .collect())
}

/// `list_active_project_tasks`'s merge: shard rows first, first-wins
/// dedup by id, then sorted `updated_at DESC`.
fn merge_project_tasks(
    shard: Vec<ProjectTaskRow>,
    legacy: Vec<ProjectTaskRow>,
) -> Vec<ProjectTaskRow> {
    let mut merged: Vec<ProjectTaskRow> = Vec::with_capacity(shard.len() + legacy.len());
    for row in shard.into_iter().chain(legacy) {
        if !merged.iter().any(|existing| existing.id == row.id) {
            merged.push(row);
        }
    }
    merged.sort_by_key(|row| std::cmp::Reverse(row.updated_at));
    merged
}

/// The migration task store's `list_active_project_tasks`
/// (`ShardedTaskStore`): the legacy base-table read, then the migrated-index
/// probe, then the owner's shard read, then the merge. The source performs
/// exactly these calls in this order, and the probe only filters the legacy
/// rows, so the merge itself is order-independent.
async fn query_migrated_project_tasks<M: Mysql>(
    mysql: &M,
    project_id: i64,
    owner_user_id: i64,
    client_origin: Option<&str>,
) -> MysqlResult<Vec<ProjectTaskRow>> {
    let legacy = query_base_project_tasks(mysql, project_id, owner_user_id, client_origin).await?;
    let legacy = exclude_migrated_legacy_rows(mysql, owner_user_id, legacy).await?;
    let shard = query_shard_project_tasks(mysql, project_id, owner_user_id, client_origin).await?;
    Ok(merge_project_tasks(shard, legacy))
}

/// The `_get_project_tasks` projection for one task row.
fn task_item(task: &ProjectTaskRow, project_id: i64) -> ProjectTaskItem {
    let spec = task.crd.spec();
    // `str(spec.get("title") or task.name or f"Task #{task.id}")`.
    let task_title = spec
        .and_then(|spec| spec.title.as_deref())
        .filter(|title| !title.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if task.name.is_empty() {
                format!("Task #{}", task.id)
            } else {
                task.name.clone()
            }
        });
    // `str(status.get("phase") or "PENDING")` over a non-dict guard.
    let task_status = task
        .crd
        .status_phase()
        .filter(|phase| !phase.is_empty())
        .unwrap_or("PENDING")
        .to_string();
    // `task_execution_workspace_{source,path}`: trimmed non-empty strings.
    let workspace = |key: &str| {
        spec.and_then(|spec| spec.execution.as_ref())
            .and_then(|execution| execution.workspace.as_ref())
            .and_then(|workspace| match key {
                "source" => workspace.source.as_deref(),
                "path" => workspace.path.as_deref(),
                _ => None,
            })
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    ProjectTaskItem {
        task_id: task.id,
        task_title,
        task_status,
        device_id: spec.and_then(|spec| spec.device_id.clone()),
        execution_workspace_source: workspace("source"),
        execution_workspace_path: workspace("path"),
        is_group_chat: spec.and_then(|spec| spec.is_group_chat).unwrap_or(false),
        project_id,
        updated_at: pydantic_datetime(task.updated_at),
    }
}

/// pydantic datetime serialization for a DB row timestamp:
/// `YYYY-MM-DDTHH:MM:SS`.
fn pydantic_datetime(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// GET /api/projects: the projects free function, injecting the process-lifetime
/// application state.
#[brz_http_server::get("/api/projects")]
async fn list_projects(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] current_user: crate::auth::SessionUser,
    include_tasks: Option<String>,
    client_origin: Option<String>,
) -> Result<ProjectListResponse, FastApiError> {
    // FastAPI validates the query parameters before the endpoint body
    // runs; invalid values surface as 422 without any dependency
    // traffic.
    let params = ListProjectsParams {
        include_tasks: parse_include_tasks(include_tasks.as_deref())?,
        client_origin: parse_client_origin(client_origin.as_deref())?,
    };
    projects_list(state, &current_user, &params).await
}

/// Handler body for `GET /api/projects`.
async fn projects_list(
    state: &Arc<AppState>,
    user: &crate::auth::SessionUser,
    params: &ListProjectsParams,
) -> Result<ProjectListResponse, FastApiError> {
    let user_id = i64::from(user.id);

    let projects = query_projects(&state.mysql, user_id, &params.client_origin)
        .await
        .map_err(dependency_error)?;

    let mut items = Vec::with_capacity(projects.len());
    for project in &projects {
        // `include_tasks=false` keeps `tasks` empty. The source endpoint
        // does not issue a task-count query in this branch, so the count
        // remains zero as in the recorded implementation.
        let (tasks, task_count) = if params.include_tasks {
            let merged = if state.task_policy.resolve_migrated_legacy {
                query_migrated_project_tasks(
                    &state.mysql,
                    project.projects_id,
                    project.projects_user_id,
                    Some(&params.client_origin),
                )
                .await
                .map_err(dependency_error)?
            } else {
                query_base_project_tasks(
                    &state.mysql,
                    project.projects_id,
                    project.projects_user_id,
                    Some(&params.client_origin),
                )
                .await
                .map_err(dependency_error)?
            };
            let count = merged.len() as i64;
            let items = merged
                .iter()
                .map(|task| task_item(task, project.projects_id))
                .collect();
            (items, count)
        } else {
            (Vec::new(), 0)
        };

        items.push(ProjectItem {
            name: project.projects_name.clone(),
            description: project.projects_description.clone().unwrap_or_default(),
            color: project.projects_color.clone(),
            client_origin: project.projects_client_origin.clone(),
            config: project
                .projects_config
                .as_ref()
                .map(|config| config.0.clone()),
            id: project.projects_id,
            user_id: project.projects_user_id,
            sort_order: project.projects_sort_order,
            is_expanded: project.projects_is_expanded != 0,
            task_count,
            created_at: pydantic_datetime(project.projects_created_at),
            updated_at: pydantic_datetime(project.projects_updated_at),
            tasks,
        });
    }

    Ok(ProjectListResponse {
        total: items.len() as i64,
        items,
    })
}

/// Dependency failure mapped to the source 500 response.
fn dependency_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "projects database dependency failure");
    FastApiError::internal()
}

#[cfg(test)]
#[path = "projects_tests.rs"]
mod tests;
