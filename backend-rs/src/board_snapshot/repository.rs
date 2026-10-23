// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Typed `loop_items` / `resource_members` rows for the board-snapshot read.
//!
//! Mirrors the single-table `LoopNode` mapping (`app.models.delivery`). The
//! `loop_items` table holds project (`resource_type='project'`), task
//! (`'task'`), execution (`'execution'`), and chat-agent (`'chat_agent'`)
//! rows. The roster's `resource_members` reads live in
//! [`super::members`].
use brz_json::adapters::python_truthy as truthy;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::Deserialize;

use crate::cloud_projects::{
    LOOP_ITEMS_COLUMNS, project_access_point_statement, role_for_priority,
};

/// Whether a datetime equals the unset sentinel or is NULL
/// (`loop_datetime_value_is_unset`).
pub fn datetime_is_unset(value: Option<NaiveDateTime>) -> bool {
    match value {
        None => true,
        // `_MYSQL_UNSET_DATETIME` sentinel in `app.models.delivery`.
        Some(value) => value.format("%Y-%m-%d %H:%M:%S").to_string() == "1970-01-01 00:00:01",
    }
}

/// Typed metadata for a project row. Only the fields consumed by the
/// board-snapshot read path are typed; the remaining fields are ignored
/// by serde. The `provider_config` sub-object is borrowed as a boxed
/// raw JSON value because the external-provider path parses it into its
/// own typed `ProviderConfig`.
#[derive(Debug, Deserialize)]
pub(crate) struct ProjectMetadata {
    #[serde(default)]
    task_provider: Option<String>,
    #[serde(default)]
    visibility: Option<String>,
    #[serde(default)]
    default_issue_security: Option<String>,
    #[serde(default)]
    provider_config: Option<brz_json::RawJson>,
    /// `CloudProject.membership_mode`: `inherit` (default) or `restricted`.
    /// Inherited workspace grants apply only in `inherit` mode.
    #[serde(default)]
    membership_mode: Option<String>,
    /// `CloudProjectService._member_capabilities`: the per-member
    /// capability descriptions stored inside the project metadata.
    #[serde(default)]
    member_capabilities: Option<serde_json::Map<String, serde_json::Value>>,
}

/// Read a string field from a typed project metadata row.
fn project_metadata_str(metadata: &Option<Json<ProjectMetadata>>, key: &str) -> Option<String> {
    metadata.as_ref().and_then(|json| match key {
        "task_provider" => json.0.task_provider.clone(),
        "visibility" => json.0.visibility.clone(),
        "default_issue_security" => json.0.default_issue_security.clone(),
        _ => None,
    })
}

/// Borrow the metadata `provider_config` sub-object for the external-provider
/// path. The raw JSON value is parsed into the typed `ProviderConfig` by
/// the external provider module.
fn project_provider_config(metadata: &Option<Json<ProjectMetadata>>) -> Option<&brz_json::RawJson> {
    metadata
        .as_ref()
        .and_then(|json| json.0.provider_config.as_ref())
}

/// Typed metadata for a binding row. Only `workflow_node_id`,
/// `model_selection`, `execution_context`, `change_requests`, and the
/// dispatch/assignment ids rendered by `LoopItemTaskBindingResponse` are
/// consumed.
#[derive(Debug, Deserialize)]
pub(crate) struct BindingMetadata {
    #[serde(default)]
    workflow_node_id: Option<String>,
    #[serde(default)]
    model_selection: Option<brz_json::RawJson>,
    #[serde(default)]
    execution_context: Option<brz_json::RawJson>,
    #[serde(default)]
    human_assignment_id: Option<String>,
    #[serde(default)]
    dispatch_id: Option<String>,
    #[serde(default)]
    dispatch_round_id: Option<String>,
    #[serde(default)]
    assignment_id: Option<String>,
    #[serde(default)]
    change_requests: Option<Vec<brz_json::RawJson>>,
}

/// `project_chat.service.bot_config`: the robot configuration stored in the
/// single-table metadata JSON. The source reads untyped keys with defaults, so
/// the metadata is kept as a raw JSON object and each key is coerced with the
/// source's own rules.
pub(crate) struct BotConfig<'a> {
    metadata: Option<&'a serde_json::Map<String, serde_json::Value>>,
}

impl<'a> BotConfig<'a> {
    /// Borrow the robot configuration stored in a `ProjectChatAgent.metadata`
    /// JSON object.
    pub(crate) fn from_metadata(
        metadata: Option<&'a serde_json::Map<String, serde_json::Value>>,
    ) -> Self {
        Self { metadata }
    }

    fn raw(&self, key: &str) -> Option<&serde_json::Value> {
        self.metadata.and_then(|metadata| metadata.get(key))
    }

    fn raw_string(&self, key: &str) -> Option<String> {
        self.raw(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    }

    fn raw_array(&self, key: &str) -> Vec<serde_json::Value> {
        self.raw(key)
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default()
    }

    /// `bot_config(row)["runtime"]` (`bot_runtime`): the persisted runtime.
    pub(crate) fn runtime(&self) -> String {
        self.raw_string("runtime")
            .unwrap_or_else(|| "codex".to_string())
    }

    /// `bot_config(row)["visibility"]` with the source default.
    pub(crate) fn visibility(&self) -> String {
        const DEFAULT: &str = "creator_admin";
        self.raw_string("visibility")
            .filter(|value| matches!(value.as_str(), "private" | "creator_admin" | "public"))
            .unwrap_or_else(|| DEFAULT.to_string())
    }

    /// `bot_config(row)["wegent_team_id"]`: an integer id when present.
    pub(crate) fn wegent_team_id(&self) -> Option<i64> {
        self.raw("wegent_team_id")
            .and_then(serde_json::Value::as_i64)
    }

    /// `bot_config(row)["model"]` when it is a string.
    pub(crate) fn model(&self) -> Option<String> {
        self.raw_string("model")
    }

    /// `bot_config(row)["model_type"]` when it is one of the known types.
    pub(crate) fn model_type(&self) -> Option<String> {
        self.raw_string("model_type")
            .filter(|value| matches!(value.as_str(), "public" | "user" | "group" | "runtime"))
    }

    /// `bot_config(row)["model_options"]`: the stored object, else `{}`.
    pub(crate) fn model_options(&self) -> serde_json::Map<String, serde_json::Value> {
        match self.raw("model_options") {
            Some(serde_json::Value::Object(map)) => map.clone(),
            _ => serde_json::Map::new(),
        }
    }

    /// `bot_config(row)["system_prompt"]` when it is a string, else `""`.
    pub(crate) fn system_prompt(&self) -> String {
        self.raw_string("system_prompt").unwrap_or_default()
    }

    /// `bot_config(row)["capability_mode"]` (`follow_device` / `manual`),
    /// defaulting to `manual` when any manual capability is configured.
    pub(crate) fn capability_mode(&self) -> String {
        const DEFAULT: &str = "follow_device";
        if let Some(value) = self.raw_string("capability_mode")
            && matches!(value.as_str(), "follow_device" | "manual")
        {
            return value;
        }
        let has_manual = self.raw("model").is_some_and(truthy)
            || self.raw("plugins").is_some_and(truthy)
            || self.raw("additional_skills").is_some_and(truthy)
            || self.raw("mcp_servers").is_some_and(truthy);
        if has_manual {
            "manual".to_string()
        } else {
            DEFAULT.to_string()
        }
    }

    /// `bot_config(row)["execution_environment"]` with the source default.
    pub(crate) fn execution_environment(&self) -> String {
        self.raw_string("execution_environment")
            .unwrap_or_else(|| "local".to_string())
    }

    /// `bot_config(row)["execution_mode"]` with the source default.
    pub(crate) fn execution_mode(&self) -> String {
        self.raw_string("execution_mode")
            .unwrap_or_else(|| "auto".to_string())
    }

    /// `bot_max_concurrent_executions(row)`: an integer in `1..=20`, else `1`.
    pub(crate) fn max_concurrent_executions(&self) -> i32 {
        self.raw("max_concurrent_executions")
            .and_then(serde_json::Value::as_i64)
            .filter(|value| (1..=20).contains(value))
            .map(|value| value as i32)
            .unwrap_or(1)
    }

    /// `bot_workspace_policy(row)`: `project` / `git_worktree`, else `project`.
    pub(crate) fn workspace_policy(&self) -> String {
        self.raw_string("workspace_policy")
            .filter(|value| matches!(value.as_str(), "project" | "git_worktree"))
            .unwrap_or_else(|| "project".to_string())
    }

    /// `bot_config(row)["default_runtime_profile_id"]`: the stringified id.
    pub(crate) fn default_runtime_profile_id(&self) -> Option<String> {
        self.raw("default_runtime_profile_id")
            .and_then(json_scalar_string)
    }

    /// `bot_config(row)["plugins"]`: the stored list, else `[]`.
    pub(crate) fn plugins(&self) -> Vec<serde_json::Value> {
        self.raw_array("plugins")
    }

    /// `bot_config(row)["additional_skills"]`: the stored list, else `[]`.
    pub(crate) fn additional_skills(&self) -> Vec<serde_json::Value> {
        self.raw_array("additional_skills")
    }

    /// `bot_config(row)["permission_migration_reason"]` when it is a string.
    pub(crate) fn permission_migration_reason(&self) -> Option<String> {
        self.raw_string("permission_migration_reason")
    }

    /// `(metadata or {}).get("authorization_version")`: whether the agent is
    /// an authorization-versioned definition.
    pub(crate) fn has_authorization_version(&self) -> bool {
        self.raw("authorization_version").is_some_and(truthy)
    }

    /// `project_agent_visible`: the raw metadata `visibility` differs from
    /// `private`. An absent or unknown value is visible.
    pub(crate) fn not_private(&self) -> bool {
        !matches!(
            self.raw("visibility").and_then(serde_json::Value::as_str),
            Some("private")
        )
    }

    /// `bot_config(row)["mcp_servers"]`: the stored object, else `{}`.
    pub(crate) fn mcp_servers(&self) -> serde_json::Map<String, serde_json::Value> {
        match self.raw("mcp_servers") {
            Some(serde_json::Value::Object(map)) => map.clone(),
            _ => serde_json::Map::new(),
        }
    }

    /// `bot_config(row)["workspace_binding"]`: the stored binding object.
    pub(crate) fn workspace_binding(&self) -> Option<&serde_json::Map<String, serde_json::Value>> {
        match self.raw("workspace_binding") {
            Some(serde_json::Value::Object(map)) => Some(map),
            _ => None,
        }
    }

    /// `bot_config(row)["execution_policy"]` (`agent_to_view`): the stored
    /// policy object, else `None`.
    pub(crate) fn execution_policy(&self) -> Option<brz_json::RawJson> {
        self.policy("execution_policy")
    }

    /// `bot_config(row)["model_policy"]` (`agent_to_view`): the stored policy
    /// object, else `None`.
    pub(crate) fn model_policy(&self) -> Option<brz_json::RawJson> {
        self.policy("model_policy")
    }

    /// A stored policy object rendered as raw JSON, or `None`.
    fn policy(&self, key: &str) -> Option<brz_json::RawJson> {
        match self.raw(key) {
            Some(value @ serde_json::Value::Object(_)) => Some(brz_json::raw_json(value)),
            _ => None,
        }
    }
}

/// `str(value)` for a non-null JSON scalar, matching the source's
/// `str(config["default_runtime_profile_id"])`.
fn json_scalar_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(value) => Some(value.clone()),
        serde_json::Value::Number(value) => Some(value.to_string()),
        serde_json::Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

/// `loop_items` project row (`CloudProject`, `resource_type='project'`).
/// The labeled projection is shared by the plain active-project read and by
/// the `require_cloud_project_role` access row, so each recorded exchange
/// matches its own statement.
#[allow(dead_code)]
#[derive(Debug, FromMysqlRow)]
pub struct ProjectRow {
    #[mysql(rename = "loop_items_id")]
    pub id: String,
    #[mysql(rename = "loop_items_public_id")]
    pub public_id: Option<String>,
    #[mysql(rename = "loop_items_project_key")]
    pub project_key: Option<String>,
    #[mysql(rename = "loop_items_name")]
    pub name: Option<String>,
    #[mysql(rename = "loop_items_description")]
    pub description: Option<String>,
    #[mysql(rename = "loop_items_created_by_user_id")]
    pub created_by_user_id: i32,
    #[mysql(rename = "loop_items_status")]
    pub status: String,
    #[mysql(rename = "loop_items_version")]
    pub version: i64,
    #[mysql(rename = "loop_items_created_at")]
    pub created_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_updated_at")]
    pub updated_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_metadata")]
    pub metadata: Option<Json<ProjectMetadata>>,
}

impl ProjectRow {
    /// `CloudProject.task_provider`: metadata `task_provider` when it is one
    /// of the known providers, otherwise `local`.
    pub fn task_provider(&self) -> String {
        let known = ["local", "github", "gitlab", "dingtalk_aitable"];
        project_metadata_str(&self.metadata, "task_provider")
            .filter(|provider| known.contains(&provider.as_str()))
            .unwrap_or_else(|| "local".to_string())
    }

    /// `CloudProject.visibility` raw value (defaults to `private`), used as the
    /// `ProjectFacts.visibility` the item projection compares against
    /// `public_restricted`.
    pub fn visibility(&self) -> String {
        project_metadata_str(&self.metadata, "visibility").unwrap_or_else(|| "private".to_string())
    }

    /// `default_issue_security(project)`: `related` only when the project
    /// metadata sets it, otherwise `open`.
    pub fn default_issue_security(&self) -> &'static str {
        let value = self
            .metadata
            .as_ref()
            .and_then(|json| json.0.default_issue_security.as_deref());
        if value == Some("related") {
            "related"
        } else {
            "open"
        }
    }

    /// The metadata `provider_config` object when present, as a borrowed
    /// raw JSON value. The external-provider path parses it into its own
    /// typed `ProviderConfig`.
    pub fn provider_config(&self) -> Option<&brz_json::RawJson> {
        project_provider_config(&self.metadata)
    }

    /// `CloudProject.membership_mode`: `inherit` when the metadata omits it.
    pub fn membership_mode(&self) -> &str {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.membership_mode.as_deref())
            .unwrap_or("inherit")
    }

    /// `CloudProjectService._member_capabilities(project)`: the metadata
    /// `member_capabilities` object reduced to trimmed, non-empty string
    /// descriptions keyed by member id.
    pub fn member_capabilities(&self) -> std::collections::HashMap<String, String> {
        let Some(values) = self
            .metadata
            .as_ref()
            .and_then(|json| json.0.member_capabilities.as_ref())
        else {
            return std::collections::HashMap::new();
        };
        values
            .iter()
            .filter_map(|(member_id, description)| {
                let description = description.as_str()?.trim();
                (!description.is_empty()).then(|| (member_id.clone(), description.to_string()))
            })
            .collect()
    }
}

/// `loop_items` execution/binding row (`LoopItemTaskBinding`,
/// `resource_type='execution'`), selected with the source's full labeled
/// `loop_items` projection so the statement matches the recorded exchange.
#[derive(Debug, FromMysqlRow)]
pub struct BindingRow {
    #[mysql(rename = "loop_items_id")]
    pub id: String,
    #[mysql(rename = "loop_items_cloud_project_id")]
    pub cloud_project_id: String,
    #[mysql(rename = "loop_items_loop_item_id")]
    pub loop_item_id: Option<String>,
    #[mysql(rename = "loop_items_task_user_id")]
    pub task_user_id: i32,
    #[mysql(rename = "loop_items_device_id")]
    pub device_id: String,
    #[mysql(rename = "loop_items_task_id")]
    pub task_id: String,
    #[mysql(rename = "loop_items_task_title")]
    pub task_title: Option<String>,
    #[mysql(rename = "loop_items_backend_task_id")]
    pub backend_task_id: Option<i64>,
    #[mysql(rename = "loop_items_linked_by_user_id")]
    pub linked_by_user_id: i32,
    #[mysql(rename = "loop_items_linked_at")]
    pub linked_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_unlinked_at")]
    pub unlinked_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_metadata")]
    pub metadata: Option<Json<BindingMetadata>>,
}

impl BindingRow {
    /// `LoopItemTaskBinding._metadata_text(key)`: the metadata value when it
    /// is a non-empty string, otherwise `None`.
    fn metadata_text(value: Option<String>) -> Option<String> {
        value.filter(|value| !value.is_empty())
    }

    /// `LoopItemTaskBinding.workflow_node_id`: the metadata value when it is
    /// a non-empty string, otherwise `None`.
    pub fn workflow_node_id(&self) -> Option<String> {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.workflow_node_id.clone())
            .filter(|value| !value.is_empty())
    }

    /// `LoopItemTaskBinding.human_assignment_id`.
    pub fn human_assignment_id(&self) -> Option<String> {
        Self::metadata_text(
            self.metadata
                .as_ref()
                .and_then(|json| json.0.human_assignment_id.clone()),
        )
    }

    /// `LoopItemTaskBinding.dispatch_id`.
    pub fn dispatch_id(&self) -> Option<String> {
        Self::metadata_text(
            self.metadata
                .as_ref()
                .and_then(|json| json.0.dispatch_id.clone()),
        )
    }

    /// `LoopItemTaskBinding.dispatch_round_id`.
    pub fn dispatch_round_id(&self) -> Option<String> {
        Self::metadata_text(
            self.metadata
                .as_ref()
                .and_then(|json| json.0.dispatch_round_id.clone()),
        )
    }

    /// `LoopItemTaskBinding.assignment_id`.
    pub fn assignment_id(&self) -> Option<String> {
        Self::metadata_text(
            self.metadata
                .as_ref()
                .and_then(|json| json.0.assignment_id.clone()),
        )
    }

    /// `LoopItemTaskBinding.model_selection`: the metadata value when it is
    /// a JSON object, otherwise `None`.
    pub fn model_selection(&self) -> Option<brz_json::RawJson> {
        let value: Option<serde_json::Value> = self
            .metadata
            .as_ref()
            .and_then(|json| json.0.model_selection.as_ref())
            .and_then(|raw| serde_json::from_str(raw.get()).ok());
        value
            .filter(|value: &serde_json::Value| value.is_object())
            .as_ref()
            .map(brz_json::raw_json)
    }

    /// `LoopItemTaskBinding.execution_context`: the metadata value when it is
    /// a JSON object, otherwise `None`.
    pub fn execution_context(&self) -> Option<brz_json::RawJson> {
        let value: Option<serde_json::Value> = self
            .metadata
            .as_ref()
            .and_then(|json| json.0.execution_context.as_ref())
            .and_then(|raw| serde_json::from_str(raw.get()).ok());
        value
            .filter(|value: &serde_json::Value| value.is_object())
            .as_ref()
            .map(brz_json::raw_json)
    }

    /// `LoopItemTaskBinding.change_requests`: the metadata list entries that
    /// are JSON objects, in stored order.
    pub fn change_requests(&self) -> Vec<brz_json::RawJson> {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.change_requests.as_deref())
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|raw| serde_json::from_str(raw.get()).ok())
                    .filter(|value: &serde_json::Value| value.is_object())
                    .map(|value| brz_json::raw_json(&value))
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// `loop_items` chat-agent row (`ProjectChatAgent`, `resource_type='chat_agent'`).
/// Reuses the full `LOOP_ITEMS_COLUMNS` projection so the recorded
/// `project_chat_service.list_agents` exchange matches for replay.
#[derive(Debug, FromMysqlRow)]
pub struct AgentRow {
    #[mysql(rename = "loop_items_id")]
    pub id: String,
    #[mysql(rename = "loop_items_cloud_project_id")]
    #[allow(dead_code, reason = "selected to match source column list")]
    pub cloud_project_id: String,
    #[mysql(rename = "loop_items_title")]
    pub title: Option<String>,
    #[mysql(rename = "loop_items_name")]
    pub name: Option<String>,
    #[mysql(rename = "loop_items_description")]
    pub description: Option<String>,
    #[mysql(rename = "loop_items_status")]
    #[allow(dead_code, reason = "selected to match source column list")]
    pub status: Option<String>,
    #[mysql(rename = "loop_items_created_by_user_id")]
    pub created_by_user_id: Option<i32>,
    #[mysql(rename = "loop_items_device_id")]
    pub device_id: Option<String>,
    #[mysql(rename = "loop_items_local_project_id")]
    pub local_project_id: Option<i32>,
    #[mysql(rename = "loop_items_created_at")]
    pub created_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_updated_at")]
    pub updated_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_deleted_at")]
    #[allow(dead_code, reason = "selected to match source column list")]
    pub deleted_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_version")]
    pub version: Option<i32>,
    #[mysql(rename = "loop_items_metadata")]
    pub metadata: Option<Json<serde_json::Value>>,
}

impl AgentRow {
    /// `project_chat.service.bot_config(row)`: the metadata JSON object.
    pub fn bot_config(&self) -> BotConfig<'_> {
        BotConfig {
            metadata: self.metadata.as_ref().and_then(|json| json.0.as_object()),
        }
    }
}

/// `ROLE_HIERARCHY` (`app.schemas.base_role`) inverted into `ROLES_BY_PRIORITY`
/// (`app.services.cloud_project_visibility`): the role a
/// `project_access_query` priority stands for.
fn role_by_priority(priority: i64) -> MysqlResult<String> {
    // The aggregated `CASE` only emits the five mapped priorities; the source
    // indexes `ROLES_BY_PRIORITY[priority]` and fails the request on any other
    // value.
    role_for_priority(priority)
        .map(str::to_string)
        .ok_or(brz_mysql::MysqlError::Decode {
            column: "anon_1_priority".to_string(),
            expected: "a ROLE_HIERARCHY priority",
        })
}

/// Raw `project_access_query` row: the labeled `loop_items` projection, the
/// project's parent workspace id (the `CloudProject.workspace_id` column
/// property), and the aggregated role priority. The projection is re-declared
/// here because [`ProjectRow`] serves the plain project reads of the other
/// board routes and its rows do not carry `anon_1`/`anon_3_priority`.
#[derive(Debug, FromMysqlRow)]
struct ProjectAccessRecord {
    #[mysql(rename = "loop_items_id")]
    id: String,
    #[mysql(rename = "loop_items_public_id")]
    public_id: Option<String>,
    #[mysql(rename = "loop_items_project_key")]
    project_key: Option<String>,
    #[mysql(rename = "loop_items_name")]
    name: Option<String>,
    #[mysql(rename = "loop_items_description")]
    description: Option<String>,
    #[mysql(rename = "loop_items_created_by_user_id")]
    created_by_user_id: i32,
    #[mysql(rename = "loop_items_status")]
    status: String,
    #[mysql(rename = "loop_items_version")]
    version: i64,
    #[mysql(rename = "loop_items_created_at")]
    created_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_updated_at")]
    updated_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_metadata")]
    metadata: Option<Json<ProjectMetadata>>,
    /// The leading scalar subquery column property (the single approved
    /// `workspace` parent), or NULL when the project has no unique parent.
    #[mysql(rename = "anon_1")]
    workspace_id: Option<i64>,
    #[mysql(rename = "anon_3_priority")]
    priority: i64,
}

/// The `require_cloud_project_role` result: the accessible active project row,
/// the caller's effective role, and the project's parent workspace id.
pub struct ProjectAccess {
    pub project: ProjectRow,
    pub role: String,
    pub workspace_id: Option<i64>,
}

impl ProjectAccessRecord {
    fn into_access(self) -> MysqlResult<ProjectAccess> {
        Ok(ProjectAccess {
            project: ProjectRow {
                id: self.id,
                public_id: self.public_id,
                project_key: self.project_key,
                name: self.name,
                description: self.description,
                created_by_user_id: self.created_by_user_id,
                status: self.status,
                version: self.version,
                created_at: self.created_at,
                updated_at: self.updated_at,
                metadata: self.metadata,
            },
            role: role_by_priority(self.priority)?,
            workspace_id: self.workspace_id,
        })
    }
}

pub(crate) use super::permissions::{
    ProjectEntityRow, WorkspaceKindRow, project_agent_grant, project_entity,
    record_project_sources, team_binding_exists, team_bound_agents, team_grant, workspace_kind,
};

/// Board-snapshot repositories for the read path.
pub struct BoardSnapshotRepository<'a, M> {
    mysql: &'a M,
}

impl<'a, M: Mysql> BoardSnapshotRepository<'a, M> {
    pub fn new(mysql: &'a M) -> Self {
        Self { mysql }
    }

    /// `require_cloud_project_role(db, project_id, user_id, required_role)`
    /// (`app.services.cloud_projects.access`): resolve the caller's effective
    /// role for one active project through the set-based
    /// `project_access_query`. The project row, its parent workspace id, and
    /// the caller's role come from the single statement. A caller without a
    /// direct grant only reaches the project through an inherited workspace
    /// grant or the public (`authenticated_users`) grant.
    ///
    /// Returns `None` when no permission source grants the caller access to
    /// an active project with that id; the source raises
    /// `404 "Cloud project not found"`. The caller compares the returned role
    /// against its `required_role` with [`has_permission`] and raises
    /// `403 "Insufficient permission"` when it falls short.
    pub async fn require_cloud_project_role(
        &self,
        project_id: i64,
        user_id: i32,
    ) -> MysqlResult<Option<ProjectAccess>> {
        self.require_cloud_project_role_as(project_id, user_id, user_id)
            .await
    }

    /// `require_cloud_project_role` for a subject other than the
    /// authenticated caller (the source's direct-human reviewer check). The
    /// caller's `users` row is already loaded, every other subject is read.
    pub async fn require_cloud_project_role_as(
        &self,
        project_id: i64,
        user_id: i32,
        authenticated_user_id: i32,
    ) -> MysqlResult<Option<ProjectAccess>> {
        // The source inlines the user and project ids into the statement, so it
        // carries no bind parameters. This is the recorded
        // `project_access_query` point form: the direct, workspace-inherited,
        // and public (`authenticated_users`) grants reduced to
        // `min(priority)`, joined to the active project row and its active
        // parent workspace.
        let statement = project_access_point_statement(user_id, project_id);
        let record: Option<ProjectAccessRecord> = self.mysql.fetch_optional(statement, ()).await?;
        let Some(record) = record else {
            return Ok(None);
        };
        let access = record.into_access()?;
        // `check` resolves provenance after the role query; those reads are
        // request-owned even when the caller ignores the returned sources.
        record_project_sources(
            self.mysql,
            project_id,
            user_id,
            access.workspace_id,
            authenticated_user_id,
        )
        .await?;
        Ok(Some(access))
    }

    /// `db.get(CloudProject, str(project_id))` inside the access helper.
    pub async fn project_entity(&self, project_id: i64) -> MysqlResult<Option<ProjectEntityRow>> {
        project_entity(self.mysql, project_id).await
    }

    /// `loop_item_service.list_project_task_bindings`: active execution
    /// rows whose `loop_item_id` is in `item_ids`. Source orders by
    /// `loop_item_id.asc(), linked_at.desc(), id.desc()`. Returns an empty
    /// list when `item_ids` is empty (matching the source short-circuit). The
    /// recorded COM_QUERY inlines every id literal.
    pub async fn list_project_task_bindings(
        &self,
        project_id: &str,
        item_ids: &[String],
    ) -> MysqlResult<Vec<BindingRow>> {
        if item_ids.is_empty() {
            return Ok(Vec::new());
        }
        let quoted = item_ids
            .iter()
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
             WHERE loop_items.cloud_project_id = {project_id} \
             AND loop_items.loop_item_id IN ({quoted}) \
             AND (loop_items.unlinked_at IS NULL OR loop_items.unlinked_at IN \
                 ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
             AND loop_items.resource_type IN ('execution') \
             ORDER BY loop_items.loop_item_id ASC, loop_items.linked_at DESC, loop_items.id DESC",
        );
        self.mysql.fetch_all(sql, ()).await
    }

    /// `project_chat_service.list_agents`: chat-agent rows for the project,
    /// ordered by `created_at ASC`. The recorded COM_QUERY selects the full
    /// `LOOP_ITEMS_COLUMNS` projection (all mapped `loop_items` columns
    /// labeled `loop_items_<column>`) with `cloud_project_id` inlined as a
    /// string literal, matching SQLAlchemy's query rendering for replay.
    /// `include_archived` adds `archived` to the status filter.
    pub async fn list_agents(
        &self,
        project_id: &str,
        include_archived: bool,
    ) -> MysqlResult<Vec<AgentRow>> {
        // `ProjectChatAgent.status.in_(["active"])` renders an `IN` list, not
        // an equality predicate, so the statement only matches the recorded
        // exchange with `status IN ('active')`. `include_archived` renders
        // `status IN ('active', 'archived')`.
        let statuses = if include_archived {
            "('active', 'archived')"
        } else {
            "('active')"
        };
        let sql = format!(
            "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
             WHERE loop_items.cloud_project_id = '{project_id}' \
             AND loop_items.status IN {statuses} \
             AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
                 ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
             AND loop_items.resource_type IN ('chat_agent') \
             ORDER BY loop_items.created_at ASC",
        );
        self.mysql.fetch_all(sql, ()).await
    }
}

/// Base role hierarchy (`app.schemas.base_role`); lower is more privileged.
pub(crate) fn role_level(role: &str) -> i32 {
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

/// `has_permission`.
#[allow(dead_code)]
pub fn has_permission(user_role: &str, required_role: &str) -> bool {
    role_level(user_role) <= role_level(required_role)
}

#[cfg(test)]
#[path = "repository_tests.rs"]
mod tests;
