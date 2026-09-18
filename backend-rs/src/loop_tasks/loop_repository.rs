// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Typed `loop_items` rows and the loop-item task-binding read path.
//!
//! Mirrors the single-table `LoopNode` mapping (`app.models.delivery`): the
//! `loop_items` table holds project (`resource_type='project'`), task
//! (`'task'`), and execution/binding (`'execution'`) rows.
use crate::json_compat::JsonProjection;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
#[cfg(test)]
use serde_json::Value;

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct ProjectMetadata {
    pub task_provider: Option<String>,
    pub visibility: Option<String>,
}
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct BindingMetadata {
    pub workflow_node_id: Option<String>,
}

/// Whether a datetime equals the unset sentinel or is NULL
/// (`loop_datetime_value_is_unset`).
pub fn datetime_is_unset(value: Option<NaiveDateTime>) -> bool {
    match value {
        None => true,
        // `_MYSQL_UNSET_DATETIME` sentinel in `app.models.delivery`.
        Some(value) => value.format("%Y-%m-%d %H:%M:%S").to_string() == "1970-01-01 00:00:01",
    }
}

/// `loop_items` project row (`CloudProject`, `resource_type='project'`).
#[allow(dead_code)]
#[derive(Debug, FromMysqlRow)]
pub struct ProjectRow {
    pub id: String,
    pub project_key: String,
    pub created_by_user_id: i32,
    pub status: String,
    pub metadata: Option<Json<JsonProjection<ProjectMetadata>>>,
}

impl ProjectRow {
    /// `CloudProject.task_provider`: metadata `task_provider` when it is one
    /// of the known providers, otherwise `local`.
    pub fn task_provider(&self) -> String {
        let known = ["local", "github", "gitlab", "dingtalk_aitable"];
        self.metadata
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
            .and_then(|metadata| metadata.task_provider.as_deref())
            .filter(|provider| known.contains(provider))
            .unwrap_or("local")
            .to_string()
    }

    /// `CloudProject.visibility`: `public` only when metadata says so.
    pub fn is_public(&self) -> bool {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
            .and_then(|metadata| metadata.visibility.as_deref())
            == Some("public")
    }
}

/// `loop_items` task row (`LoopItem`, `resource_type='task'`).
#[allow(dead_code)]
#[derive(Debug, FromMysqlRow)]
pub struct TaskItemRow {
    pub id: String,
    pub cloud_project_id: String,
    pub created_by_user_id: i32,
    pub deleted_at: Option<NaiveDateTime>,
}

/// `loop_items` execution/binding row (`LoopItemTaskBinding`,
/// `resource_type='execution'`).
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
    pub metadata: Option<Json<JsonProjection<BindingMetadata>>>,
}

/// `loop_items` execution/binding row for `find_cloud_context`, selected with
/// the source's full 60-column labeled projection so the prepared statement
/// matches the recorded exchange for replay. The typed row consumes only the
/// binding fields; the remaining labeled columns are read by the driver and
/// discarded.
#[derive(Debug, FromMysqlRow)]
pub struct CloudContextBindingRow {
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
    pub backend_task_id: i64,
    #[mysql(rename = "loop_items_linked_by_user_id")]
    pub linked_by_user_id: i32,
    #[mysql(rename = "loop_items_linked_at")]
    pub linked_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_unlinked_at")]
    pub unlinked_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_metadata")]
    pub metadata: Option<Json<JsonProjection<BindingMetadata>>>,
}

impl CloudContextBindingRow {
    /// `LoopItemTaskBinding.workflow_node_id`: the metadata value when it is
    /// a non-empty string, otherwise `None`.
    pub fn workflow_node_id(&self) -> Option<String> {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
            .and_then(|metadata| metadata.workflow_node_id.clone())
            .filter(|value| !value.is_empty())
    }
}

/// The source's full column projection for `find_cloud_context`
/// (`db.query(LoopItemTaskBinding)` labeled like SQLAlchemy's query rendering).
/// Selected to match the recorded statement; the typed row consumes only the
/// response fields.
const CLOUD_CONTEXT_COLUMNS: &str = "loop_items.id AS loop_items_id, \
     loop_items.resource_type AS loop_items_resource_type, \
     loop_items.project_space AS loop_items_project_space, \
     loop_items.cloud_project_id AS loop_items_cloud_project_id, \
     loop_items.parent_id AS loop_items_parent_id, \
     loop_items.loop_item_id AS loop_items_loop_item_id, \
     loop_items.delivery_id AS loop_items_delivery_id, \
     loop_items.public_id AS loop_items_public_id, \
     loop_items.project_key AS loop_items_project_key, \
     loop_items.name AS loop_items_name, \
     loop_items.title AS loop_items_title, \
     loop_items.description AS loop_items_description, \
     loop_items.storage_prefix AS loop_items_storage_prefix, \
     loop_items.sequence_number AS loop_items_sequence_number, \
     loop_items.next_item_number AS loop_items_next_item_number, \
     loop_items.created_by_user_id AS loop_items_created_by_user_id, \
     loop_items.updated_by_user_id AS loop_items_updated_by_user_id, \
     loop_items.assignee_user_id AS loop_items_assignee_user_id, \
     loop_items.user_id AS loop_items_user_id, \
     loop_items.added_by_user_id AS loop_items_added_by_user_id, \
     loop_items.source AS loop_items_source, \
     loop_items.status AS loop_items_status, \
     loop_items.priority AS loop_items_priority, \
     loop_items.due_at AS loop_items_due_at, \
     loop_items.sort_order AS loop_items_sort_order, \
     loop_items.current_delivery_id AS loop_items_current_delivery_id, \
     loop_items.local_project_id AS loop_items_local_project_id, \
     loop_items.device_id AS loop_items_device_id, \
     loop_items.is_default AS loop_items_is_default, \
     loop_items.task_user_id AS loop_items_task_user_id, \
     loop_items.assignee_agent_id AS loop_items_assignee_agent_id, \
     loop_items.assignee_team_id AS loop_items_assignee_team_id, \
     loop_items.task_id AS loop_items_task_id, \
     loop_items.task_title AS loop_items_task_title, \
     loop_items.backend_task_id AS loop_items_backend_task_id, \
     loop_items.linked_by_user_id AS loop_items_linked_by_user_id, \
     loop_items.linked_at AS loop_items_linked_at, \
     loop_items.unlinked_at AS loop_items_unlinked_at, \
     loop_items.path AS loop_items_path, \
     loop_items.kind AS loop_items_kind, \
     loop_items.display_name AS loop_items_display_name, \
     loop_items.relative_path AS loop_items_relative_path, \
     loop_items.object_key AS loop_items_object_key, \
     loop_items.content_type AS loop_items_content_type, \
     loop_items.size_bytes AS loop_items_size_bytes, \
     loop_items.sha256 AS loop_items_sha256, \
     loop_items.source_task_binding_id AS loop_items_source_task_binding_id, \
     loop_items.source_task_snapshot AS loop_items_source_task_snapshot, \
     loop_items.markdown_object_key AS loop_items_markdown_object_key, \
     loop_items.chat_object_key AS loop_items_chat_object_key, \
     loop_items.manifest_object_key AS loop_items_manifest_object_key, \
     loop_items.metadata AS loop_items_metadata, \
     loop_items.version AS loop_items_version, \
     loop_items.created_at AS loop_items_created_at, \
     loop_items.updated_at AS loop_items_updated_at, \
     loop_items.completed_at AS loop_items_completed_at, \
     loop_items.delivered_at AS loop_items_delivered_at, \
     loop_items.deleted_at AS loop_items_deleted_at";

impl BindingRow {
    /// `LoopItemTaskBinding.workflow_node_id`: the metadata value when it is
    /// a non-empty string, otherwise `None`.
    pub fn workflow_node_id(&self) -> Option<String> {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
            .and_then(|metadata| metadata.workflow_node_id.as_deref())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }
}

/// `resource_members` row (`ResourceMember`).
#[derive(Debug, FromMysqlRow)]
pub struct MemberRow {
    #[mysql(rename = "role")]
    pub member_role: String,
}

/// Base role hierarchy (`app.schemas.base_role`); lower is more privileged.
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
pub fn has_permission(user_role: &str, required_role: &str) -> bool {
    role_level(user_role) <= role_level(required_role)
}

/// Loop-item repositories for the task-binding read path.
pub struct LoopItemRepository<'a, M> {
    mysql: &'a M,
}

impl<'a, M: Mysql> LoopItemRepository<'a, M> {
    pub fn new(mysql: &'a M) -> Self {
        Self { mysql }
    }

    /// `ExternalLoopItemProvider._find_project`: resolve `KEY-number` ids to
    /// an external-provider project row. Returns `Ok(None)` when the id does
    /// not parse or the project is not github/gitlab backed.
    pub async fn find_external_project(&self, item_id: &str) -> MysqlResult<Option<ProjectRow>> {
        let Some((key, number)) = split_external_item_id(item_id) else {
            return Ok(None);
        };
        let _ = number;
        let project: Option<ProjectRow> = self
            .mysql
            .fetch_optional(
                "SELECT id, project_key, created_by_user_id, status, metadata \
                 FROM loop_items \
                 WHERE project_key = ? AND resource_type IN ('project') LIMIT 1",
                (key,),
            )
            .await?;
        Ok(match project {
            Some(project) if matches!(project.task_provider().as_str(), "github" | "gitlab") => {
                Some(project)
            }
            _ => None,
        })
    }

    /// `LoopItemService._get_item_row`: the task row must exist and not be
    /// deleted (unset-datetime aware). `Ok(None)` maps to 404.
    pub async fn get_task_item(&self, item_id: &str) -> MysqlResult<Option<TaskItemRow>> {
        self.mysql
            .fetch_optional(
                "SELECT id, cloud_project_id, created_by_user_id, deleted_at \
                 FROM loop_items \
                 WHERE id = ? \
                 AND (deleted_at IS NULL OR deleted_at IN \
                     ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
                 AND resource_type IN ('task') LIMIT 1",
                (item_id,),
            )
            .await
    }

    /// `require_cloud_project_role` project lookup: active project row.
    pub async fn get_project(&self, project_id: &str) -> MysqlResult<Option<ProjectRow>> {
        self.mysql
            .fetch_optional(
                "SELECT id, project_key, created_by_user_id, status, metadata \
                 FROM loop_items \
                 WHERE id = ? AND status = 'active' \
                 AND resource_type IN ('project') LIMIT 1",
                (project_id,),
            )
            .await
    }

    /// `require_cloud_project_role` membership lookup for a non-creator user.
    pub async fn get_membership(
        &self,
        project_id: &str,
        user_id: i32,
    ) -> MysqlResult<Option<MemberRow>> {
        self.mysql
            .fetch_optional(
                "SELECT `role` FROM resource_members \
                 WHERE resource_type = 'CloudProject' AND resource_id = ? \
                 AND entity_type = 'user' AND entity_id = ? \
                 AND status = 'approved' LIMIT 1",
                (project_id, user_id.to_string()),
            )
            .await
    }

    /// `LoopItemService.list_task_bindings`: active bindings for the item,
    /// newest first.
    pub async fn list_task_bindings(&self, item_id: &str) -> MysqlResult<Vec<BindingRow>> {
        self.mysql
            .fetch_all(
                "SELECT id, cloud_project_id, loop_item_id, task_user_id, \
                 device_id, task_id, task_title, backend_task_id, \
                 linked_by_user_id, linked_at, unlinked_at, metadata \
                 FROM loop_items \
                 WHERE loop_item_id = ? \
                 AND (unlinked_at IS NULL OR unlinked_at IN \
                     ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
                 AND resource_type IN ('execution') \
                 ORDER BY linked_at DESC, id DESC",
                (item_id,),
            )
            .await
    }

    /// `LoopItemService.find_cloud_context`: the active runtime-task binding
    /// for `(task_user_id, device_id, task_id)`. `Ok(None)` maps to the
    /// `Cloud context not found` 404.
    ///
    /// The projection mirrors the source SQLAlchemy `db.query(LoopItemTaskBinding)`
    /// labeled column list exactly (all 60 mapped `loop_items` columns, aliased
    /// `loop_items_<column>`), so the prepared statement matches the recorded
    /// exchange for replay. The typed row consumes only the binding fields;
    /// its `#[mysql(rename = ...)]` attributes map the labeled columns back to
    /// the row fields.
    pub async fn find_cloud_context_binding(
        &self,
        user_id: i32,
        device_id: &str,
        task_id: &str,
    ) -> MysqlResult<Option<CloudContextBindingRow>> {
        self.mysql
            .fetch_optional(
                &format!(
                    "SELECT {CLOUD_CONTEXT_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.task_user_id = ? \
                     AND loop_items.device_id = ? \
                     AND loop_items.task_id = ? \
                     AND (loop_items.unlinked_at IS NULL OR loop_items.unlinked_at IN \
                         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
                     AND loop_items.resource_type IN ('execution') \n LIMIT 1",
                ),
                (user_id, device_id, task_id),
            )
            .await
    }
}

/// `_find_project` id split: `KEY-number` with an all-digit number.
fn split_external_item_id(item_id: &str) -> Option<(&str, u64)> {
    let (key, number) = item_id.rsplit_once('-')?;
    if key.is_empty() || number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((key, number.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_external_item_ids() {
        assert_eq!(
            split_external_item_id("WEWORKC2FA61-507"),
            Some(("WEWORKC2FA61", 507))
        );
        assert_eq!(split_external_item_id("plain"), None);
        assert_eq!(split_external_item_id("KEY-abc"), None);
        assert_eq!(split_external_item_id("-507"), None);
    }

    #[test]
    fn role_hierarchy() {
        assert!(has_permission("Owner", "RestrictedAnalyst"));
        assert!(has_permission("Maintainer", "Reporter"));
        assert!(!has_permission("Reporter", "Developer"));
        assert!(!has_permission("Unknown", "Reporter"));
    }

    #[test]
    fn task_provider_falls_back_to_local() {
        let project = |metadata: Value| ProjectRow {
            id: "1".to_string(),
            project_key: "K".to_string(),
            created_by_user_id: 1,
            status: "active".to_string(),
            metadata: Some(Json(metadata.into())),
        };
        assert_eq!(
            project(serde_json::json!({"task_provider": "gitlab"})).task_provider(),
            "gitlab"
        );
        assert_eq!(
            project(serde_json::json!({"task_provider": "weird"})).task_provider(),
            "local"
        );
        assert_eq!(project(Value::Null).task_provider(), "local");
    }

    #[test]
    fn workflow_node_id_reads_metadata() {
        let binding = |metadata: Value| BindingRow {
            id: "1".to_string(),
            cloud_project_id: "2".to_string(),
            loop_item_id: Some("3".to_string()),
            task_user_id: 1,
            device_id: "d".to_string(),
            task_id: "t".to_string(),
            task_title: None,
            backend_task_id: 0,
            linked_by_user_id: 1,
            linked_at: None,
            unlinked_at: None,
            metadata: Some(Json(metadata.into())),
        };
        assert_eq!(
            binding(serde_json::json!({"workflow_node_id": "node-1"})).workflow_node_id(),
            Some("node-1".to_string())
        );
        assert_eq!(
            binding(serde_json::json!({"workflow_node_id": ""})).workflow_node_id(),
            None
        );
        assert_eq!(binding(serde_json::json!({})).workflow_node_id(), None);
    }
}
