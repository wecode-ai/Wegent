// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Typed `loop_items` / `resource_members` rows for the board-snapshot read.
//!
//! Mirrors the single-table `LoopNode` mapping (`app.models.delivery`) and
//! the `resource_members` membership row used by
//! `cloud_project_service.list_members`. The `loop_items` table holds
//! project (`resource_type='project'`), task (`'task'`), execution
//! (`'execution'`), and chat-agent (`'chat_agent'`) rows.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::Deserialize;

use crate::cloud_projects::{
    LOOP_ITEMS_COLUMNS, ProjectAccessMode, project_access_statement, role_for_priority,
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
    provider_config: Option<Box<serde_json::value::RawValue>>,
}

/// Read a string field from a typed project metadata row.
fn project_metadata_str(metadata: &Option<Json<ProjectMetadata>>, key: &str) -> Option<String> {
    metadata.as_ref().and_then(|json| match key {
        "task_provider" => json.0.task_provider.clone(),
        "visibility" => json.0.visibility.clone(),
        _ => None,
    })
}

/// Borrow the metadata `provider_config` sub-object for the external-provider
/// path. The raw JSON value is parsed into the typed `ProviderConfig` by
/// the external provider module.
fn project_provider_config(
    metadata: &Option<Json<ProjectMetadata>>,
) -> Option<&serde_json::value::RawValue> {
    metadata
        .as_ref()
        .and_then(|json| json.0.provider_config.as_deref())
}

/// Typed metadata for a binding row. Only `workflow_node_id`,
/// `model_selection`, and `change_requests` are consumed.
#[derive(Debug, Deserialize)]
pub(crate) struct BindingMetadata {
    #[serde(default)]
    workflow_node_id: Option<String>,
    #[serde(default)]
    model_selection: Option<Box<serde_json::value::RawValue>>,
    #[serde(default)]
    change_requests: Option<Vec<Box<serde_json::value::RawValue>>>,
}

/// Typed metadata for an agent row. Only `visibility` and `runtime` are
/// consumed.
#[derive(Debug, Deserialize, Default)]
pub(crate) struct AgentMetadata {
    #[serde(default)]
    visibility: Option<String>,
    #[serde(default)]
    runtime: Option<String>,
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

    /// `CloudProject.visibility`: `public` only when metadata says so.
    pub fn is_public(&self) -> bool {
        project_metadata_str(&self.metadata, "visibility").as_deref() == Some("public")
    }

    /// The metadata `provider_config` object when present, as a borrowed
    /// raw JSON value. The external-provider path parses it into its own
    /// typed `ProviderConfig`.
    pub fn provider_config(&self) -> Option<&serde_json::value::RawValue> {
        project_provider_config(&self.metadata)
    }
}

/// `resource_members` row joined with `users` for `list_members`.
#[derive(Debug, FromMysqlRow)]
pub struct MemberRow {
    #[mysql(rename = "resource_members_id")]
    pub member_id: i32,
    #[mysql(rename = "users_id")]
    pub user_id: i32,
    #[mysql(rename = "users_user_name")]
    pub user_name: String,
    #[mysql(rename = "users_email")]
    pub email: Option<String>,
    #[mysql(rename = "resource_members_role")]
    pub role: String,
}

/// `loop_items` execution/binding row (`LoopItemTaskBinding`,
/// `resource_type='execution'`). Mirrors the loop-tasks binding row.
#[derive(Debug, FromMysqlRow)]
pub struct BindingRow {
    pub id: String,
    pub cloud_project_id: String,
    pub loop_item_id: Option<String>,
    pub task_user_id: i32,
    pub device_id: String,
    pub task_id: String,
    pub task_title: Option<String>,
    pub backend_task_id: i64,
    pub linked_by_user_id: i32,
    pub linked_at: Option<NaiveDateTime>,
    pub unlinked_at: Option<NaiveDateTime>,
    pub metadata: Option<Json<BindingMetadata>>,
}

impl BindingRow {
    /// `LoopItemTaskBinding.workflow_node_id`: the metadata value when it is
    /// a non-empty string, otherwise `None`.
    pub fn workflow_node_id(&self) -> Option<String> {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.workflow_node_id.clone())
            .filter(|value| !value.is_empty())
    }

    /// `LoopItemTaskBinding.model_selection`: the metadata value when it is
    /// a JSON object, otherwise `None`.
    pub fn model_selection(&self) -> Option<Box<serde_json::value::RawValue>> {
        let value: Option<serde_json::Value> = self
            .metadata
            .as_ref()
            .and_then(|json| json.0.model_selection.as_deref())
            .and_then(|raw| serde_json::from_str(raw.get()).ok());
        value
            .filter(|value: &serde_json::Value| value.is_object())
            .as_ref()
            .map(crate::json_compat::raw_json)
    }

    /// `LoopItemTaskBinding.change_requests`: the metadata list entries that
    /// are JSON objects, in stored order.
    pub fn change_requests(&self) -> Vec<Box<serde_json::value::RawValue>> {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.change_requests.as_deref())
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|raw| serde_json::from_str(raw.get()).ok())
                    .filter(|value: &serde_json::Value| value.is_object())
                    .map(|value| crate::json_compat::raw_json(&value))
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
    pub metadata: Option<Json<AgentMetadata>>,
}

impl AgentRow {
    /// `bot_config(row).get("visibility")` with the default
    /// (`creator_admin`).
    pub fn visibility(&self) -> String {
        const DEFAULT: &str = "creator_admin";
        self.metadata
            .as_ref()
            .and_then(|json| json.0.visibility.clone())
            .filter(|value| matches!(value.as_str(), "private" | "creator_admin" | "public"))
            .unwrap_or_else(|| DEFAULT.to_string())
    }

    /// `bot_config(row).get("runtime")` with the default (`codex`).
    pub fn runtime(&self) -> String {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.runtime.clone())
            .unwrap_or_else(|| "codex".to_string())
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

/// Raw `project_access_query` row: the labeled `loop_items` projection plus
/// the aggregated role priority. The projection is re-declared here because
/// [`ProjectRow`] serves the plain project reads of the other board routes
/// and its rows do not carry `anon_1_priority`.
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
    #[mysql(rename = "anon_1_priority")]
    priority: i64,
}

/// The `require_cloud_project_role` result: the accessible active project row
/// and the caller's effective role.
pub struct ProjectAccess {
    pub project: ProjectRow,
    pub role: String,
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
        })
    }
}

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
    /// `project_access_query`. The project row and the caller's role come
    /// from the single statement, so a caller that is not the creator and not
    /// an approved member only reaches the project when the public-visibility
    /// or workspace-inherited grant applies.
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
        let user_id_text = user_id.to_string();
        let project_id_text = project_id.to_string();
        let record: Option<ProjectAccessRecord> = self
            .mysql
            .fetch_optional(
                project_access_statement(ProjectAccessMode::Point),
                (
                    user_id_text.clone(),
                    project_id,
                    user_id_text,
                    project_id,
                    project_id_text.as_str(),
                    user_id,
                    project_id_text.as_str(),
                ),
            )
            .await?;
        match record {
            None => Ok(None),
            Some(record) => record.into_access().map(Some),
        }
    }

    /// The board-snapshot handler's plain active-project read: the recorded
    /// COM_QUERY inlines the snowflake id as an integer literal instead of a
    /// bound parameter. Returns the active project row.
    ///
    /// Authorization for a migrated read path comes from
    /// [`Self::require_cloud_project_role`]; this read resolves no role.
    pub async fn get_project(&self, project_id: &str) -> MysqlResult<Option<ProjectRow>> {
        let sql = format!(
            "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
             WHERE loop_items.id = {project_id} AND loop_items.status = 'active' \
             AND loop_items.resource_type IN ('project') \n LIMIT 1",
        );
        self.mysql.fetch_optional(sql, ()).await
    }

    /// The board-snapshot handler's membership lookup for a non-creator user.
    /// The recorded COM_QUERY inlines `resource_id` (snowflake) and
    /// `entity_id` (user id) as literals.
    ///
    /// The source resolves the project row and the membership in one
    /// `project_access_query` statement; see
    /// [`Self::require_cloud_project_role`] for the migrated read path.
    pub async fn get_membership(
        &self,
        project_id: &str,
        user_id: i32,
    ) -> MysqlResult<Option<String>> {
        #[derive(Debug, FromMysqlRow)]
        struct RoleRow {
            #[mysql(rename = "resource_members_role")]
            role: String,
        }
        let sql = format!(
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
             resource_members.updated_at AS resource_members_updated_at \n\
             FROM resource_members \n\
             WHERE resource_members.resource_type = 'CloudProject' \
             AND resource_members.resource_id = {project_id} \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = '{user_id}' \
             AND resource_members.status = 'approved' \n LIMIT 1",
        );
        let row: Option<RoleRow> = self.mysql.fetch_optional(sql, ()).await?;
        Ok(row.map(|row| row.role))
    }

    /// `cloud_project_service.list_members`: approved `resource_members`
    /// joined with `users`, ordered by `resource_members.id`.
    pub async fn list_members(&self, project_id: &str) -> MysqlResult<Vec<MemberRow>> {
        self.mysql
            .fetch_all(
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
                 users.id AS users_id, users.user_name AS users_user_name, \
                 users.email AS users_email \
                 FROM resource_members INNER JOIN users \
                 ON users.id = resource_members.user_id \
                 WHERE resource_members.resource_type = 'CloudProject' \
                 AND resource_members.resource_id = ? \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.status = 'approved' \
                 ORDER BY resource_members.id",
                (project_id,),
            )
            .await
    }

    /// `loop_item_service.list_project_task_bindings`: active execution
    /// rows whose `loop_item_id` is in `item_ids`. Source orders by
    /// `loop_item_id.asc(), linked_at.desc(), id.desc()`. Returns an empty
    /// list when `item_ids` is empty (matching the source short-circuit).
    pub async fn list_project_task_bindings(
        &self,
        project_id: &str,
        item_ids: &[String],
    ) -> MysqlResult<Vec<BindingRow>> {
        if item_ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = item_ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let sql = format!(
            "SELECT id, cloud_project_id, loop_item_id, task_user_id, \
             device_id, task_id, task_title, backend_task_id, \
             linked_by_user_id, linked_at, unlinked_at, metadata \
             FROM loop_items \
             WHERE cloud_project_id = ? \
             AND loop_item_id IN ({placeholders}) \
             AND (unlinked_at IS NULL OR unlinked_at IN \
                 ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
             AND resource_type IN ('execution') \
             ORDER BY loop_item_id ASC, linked_at DESC, id DESC",
        );
        let mut params: Vec<String> = Vec::with_capacity(item_ids.len() + 1);
        params.push(project_id.to_string());
        for id in item_ids {
            params.push(id.clone());
        }
        self.mysql.fetch_all(sql, params).await
    }

    /// `project_chat_service.list_agents`: active chat-agent rows for the
    /// project, ordered by `created_at ASC`. The recorded COM_QUERY selects
    /// the full `LOOP_ITEMS_COLUMNS` projection (all mapped `loop_items`
    /// columns labeled `loop_items_<column>`) with `cloud_project_id` inlined
    /// as a string literal, matching SQLAlchemy's query rendering for replay.
    pub async fn list_agents(&self, project_id: &str) -> MysqlResult<Vec<AgentRow>> {
        let sql = format!(
            "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
             WHERE loop_items.cloud_project_id = '{project_id}' \
             AND loop_items.status = 'active' \
             AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
                 ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
             AND loop_items.resource_type IN ('chat_agent') \
             ORDER BY loop_items.created_at ASC",
        );
        self.mysql.fetch_all(sql, ()).await
    }
}

/// Base role hierarchy (`app.schemas.base_role`); lower is more privileged.
#[allow(dead_code)]
fn role_level(role: &str) -> i32 {
    match role {
        "Owner" => 0,
        "Maintainer" => 1,
        "Developer" => 2,
        "Reporter" => 3,
        "RestrictedAnalyst" => 4,
        _ => 999,
    }
}

/// `has_permission`.
#[allow(dead_code)]
pub fn has_permission(user_role: &str, required_role: &str) -> bool {
    role_level(user_role) <= role_level(required_role)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Whitespace-insensitive SQL comparison: Replay matches the statement
    /// structure, not the source's line breaks.
    fn normalize(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    /// The source rendering of `project_access_query(db, 3060, 1712605396200092385)`:
    /// `direct`, `inherited`, `public` and `owned` unioned in source order,
    /// aggregated by `min(priority)`, and joined back to the active project
    /// row. `?` stands where the source's driver inlines a bound value.
    fn expected_project_access_sql() -> String {
        normalize(&format!(
            r#"SELECT {LOOP_ITEMS_COLUMNS}, anon_1.priority AS anon_1_priority
FROM loop_items INNER JOIN (SELECT anon_2.project_id AS project_id, min(anon_2.priority) AS priority
FROM (SELECT CAST(resource_members.resource_id AS CHAR(64)) AS project_id, CASE resource_members.`role` WHEN 'Owner' THEN 0 WHEN 'Maintainer' THEN 1 WHEN 'Developer' THEN 2 WHEN 'Reporter' THEN 3 WHEN 'RestrictedAnalyst' THEN 4 END AS priority
FROM resource_members
WHERE resource_members.resource_type = 'CloudProject' AND resource_members.entity_type = 'user' AND resource_members.entity_id = ? AND resource_members.status = 'approved' AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Reporter', 'RestrictedAnalyst') AND resource_members.resource_id = ?
UNION ALL SELECT CAST(resource_members.resource_id AS CHAR(64)) AS project_id, 3 AS priority
FROM resource_members INNER JOIN (SELECT resource_members.resource_id AS resource_id
FROM resource_members INNER JOIN kinds ON kinds.id = resource_members.resource_id
WHERE resource_members.resource_type = 'Workspace' AND resource_members.entity_type = 'user' AND resource_members.entity_id = ? AND resource_members.status = 'approved' AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Reporter', 'RestrictedAnalyst') AND kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true AND resource_members.`role` != 'RestrictedAnalyst') AS anon_3 ON CAST(resource_members.entity_id AS SIGNED INTEGER) = anon_3.resource_id
WHERE resource_members.resource_type = 'CloudProject' AND resource_members.entity_type = 'workspace' AND resource_members.status = 'approved' AND resource_members.resource_id = ?
UNION ALL SELECT loop_items.id AS project_id, 4 AS priority
FROM loop_items
WHERE loop_items.status = 'active' AND CASE JSON_EXTRACT(loop_items.metadata, '$.\"visibility\"') WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata, '$.\"visibility\"')) END IN ('public_restricted', 'public') AND loop_items.id = ? AND loop_items.resource_type IN ('project')
UNION ALL SELECT loop_items.id AS project_id, 0 AS priority
FROM loop_items
WHERE loop_items.created_by_user_id = ? AND loop_items.status = 'active' AND loop_items.id = ? AND loop_items.resource_type IN ('project')) AS anon_2 GROUP BY anon_2.project_id) AS anon_1 ON loop_items.id = anon_1.project_id
WHERE loop_items.status = 'active' AND loop_items.resource_type IN ('project')
 LIMIT 1"#
        ))
    }

    /// `require_cloud_project_role` issues the source's single
    /// `project_access_query` statement, with the seven source-inlined values
    /// bound in textual order.
    #[tokio::test]
    async fn require_cloud_project_role_runs_the_source_access_query() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let repository = BoardSnapshotRepository::new(&mysql);
        let access = repository
            .require_cloud_project_role(1712605396200092385, 3060)
            .await
            .expect("access query is captured");
        assert!(access.is_none());

        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(normalize(&queries[0].sql), expected_project_access_sql());
        assert_eq!(queries[0].args, 7);
        // The first placeholder is `entity_id`, which the source passes as
        // `str(user_id)`; an integer binding there would not match.
        assert_eq!(queries[0].first_integer, None);
    }

    /// `require_cloud_project_role` maps the aggregated priority back to the
    /// role hierarchy and rejects a value the query cannot produce.
    #[test]
    fn role_priorities_map_to_the_role_hierarchy() {
        assert_eq!(role_by_priority(0).unwrap(), "Owner");
        assert_eq!(role_by_priority(1).unwrap(), "Maintainer");
        assert_eq!(role_by_priority(2).unwrap(), "Developer");
        assert_eq!(role_by_priority(3).unwrap(), "Reporter");
        assert_eq!(role_by_priority(4).unwrap(), "RestrictedAnalyst");
        assert!(role_by_priority(5).is_err());
    }

    fn to_agent_metadata(value: serde_json::Value) -> Option<Json<AgentMetadata>> {
        Some(Json(serde_json::from_value(value).unwrap_or(
            AgentMetadata {
                visibility: None,
                runtime: None,
            },
        )))
    }

    #[test]
    fn role_hierarchy() {
        assert!(has_permission("Owner", "RestrictedAnalyst"));
        assert!(has_permission("Maintainer", "Reporter"));
        assert!(!has_permission("Reporter", "Developer"));
        assert!(!has_permission("Unknown", "Reporter"));
    }

    #[test]
    fn agent_visibility_defaults_to_creator_admin() {
        let agent = |metadata: serde_json::Value| AgentRow {
            id: "1".to_string(),
            cloud_project_id: "p".to_string(),
            title: None,
            name: None,
            description: None,
            status: Some("active".to_string()),
            created_by_user_id: Some(5),
            device_id: None,
            local_project_id: None,
            created_at: None,
            updated_at: None,
            deleted_at: None,
            version: Some(1),
            metadata: to_agent_metadata(metadata),
        };
        assert_eq!(agent(json!({})).visibility(), "creator_admin");
        assert_eq!(
            agent(json!({"visibility": "public"})).visibility(),
            "public"
        );
        assert_eq!(
            agent(json!({"visibility": "weird"})).visibility(),
            "creator_admin"
        );
    }
}
