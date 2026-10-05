// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Typed `loop_items` rows and the loop-item task-binding read path.
//!
//! Mirrors the single-table `LoopNode` mapping (`app.models.delivery`): the
//! `loop_items` table holds project (`resource_type='project'`), task
//! (`'task'`), and execution/binding (`'execution'`) rows.
use crate::cloud_projects::{LOOP_ITEMS_COLUMNS, ProjectListRow};
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
    pub model_selection: Option<serde_json::Value>,
    pub change_requests: Option<serde_json::Value>,
}

/// `LoopItem.metadata_json` fields consumed by `response_values`
/// (`app.services.loop_items.service`). Values are kept as raw JSON so the
/// pydantic `populate_tags`/`_present_cached_ai_state` guards
/// (`isinstance(value, dict)` / `isinstance(value, list)`) are applied after
/// decoding, exactly as the source does.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct ItemMetadata {
    pub content_revision: Option<serde_json::Value>,
    pub read_revisions: Option<serde_json::Value>,
    pub assignment_history: Option<serde_json::Value>,
    pub status_history: Option<serde_json::Value>,
    pub collaboration_group: Option<serde_json::Value>,
    pub automation: Option<serde_json::Value>,
    pub workflow: Option<serde_json::Value>,
    pub execution_config: Option<serde_json::Value>,
    pub approval: Option<serde_json::Value>,
    pub execution_state: Option<serde_json::Value>,
    pub execution_note: Option<serde_json::Value>,
    pub execution_error: Option<serde_json::Value>,
    pub queued_at: Option<serde_json::Value>,
    pub ai_state: Option<serde_json::Value>,
    pub tags: Option<serde_json::Value>,
    pub human_work: Option<serde_json::Value>,
    pub external_index: Option<serde_json::Value>,
    pub external_shadow: Option<serde_json::Value>,
}

/// `LoopItemComment.metadata_json` assignment-event fields
/// (`app.services.issue_assignments.ASSIGNMENT_EVENT_TYPE`).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct AssignmentMetadata {
    pub event_type: Option<String>,
    pub action: Option<String>,
    pub assignment_event_id: Option<String>,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub target_name: Option<serde_json::Value>,
    pub workflow_step: Option<String>,
    pub trigger: Option<String>,
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

    /// `LoopItemTaskBinding.model_selection`: the metadata value when it is a
    /// JSON object, otherwise `None`.
    pub fn model_selection(&self) -> Option<serde_json::Value> {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
            .and_then(|metadata| metadata.model_selection.clone())
            .filter(serde_json::Value::is_object)
    }

    /// `LoopItemTaskBinding.change_requests`: the metadata list entries that
    /// are JSON objects, otherwise an empty list.
    pub fn change_requests(&self) -> Vec<serde_json::Value> {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
            .and_then(|metadata| metadata.change_requests.clone())
            .and_then(|value| match value {
                serde_json::Value::Array(items) => Some(items),
                _ => None,
            })
            .unwrap_or_default()
            .into_iter()
            .filter(serde_json::Value::is_object)
            .collect()
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

/// `db.get(LoopItem, item_id)` row: the source's full 60-column labeled
/// `loop_items` projection (`resource_type='task'`). The typed row consumes
/// the fields `response_values` reads.
#[derive(Debug, FromMysqlRow)]
pub struct TaskItemFullRow {
    #[mysql(rename = "loop_items_id")]
    pub id: String,
    #[mysql(rename = "loop_items_cloud_project_id")]
    pub cloud_project_id: String,
    #[mysql(rename = "loop_items_parent_id")]
    pub parent_id: Option<String>,
    #[mysql(rename = "loop_items_title")]
    pub title: Option<String>,
    #[mysql(rename = "loop_items_description")]
    pub description: Option<String>,
    #[mysql(rename = "loop_items_sequence_number")]
    pub sequence_number: Option<i64>,
    #[mysql(rename = "loop_items_status")]
    pub status: Option<String>,
    #[mysql(rename = "loop_items_priority")]
    pub priority: Option<String>,
    #[mysql(rename = "loop_items_due_at")]
    pub due_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_sort_order")]
    pub sort_order: i64,
    #[mysql(rename = "loop_items_created_by_user_id")]
    pub created_by_user_id: Option<i32>,
    #[mysql(rename = "loop_items_assignee_user_id")]
    pub assignee_user_id: Option<i32>,
    #[mysql(rename = "loop_items_assignee_agent_id")]
    pub assignee_agent_id: Option<String>,
    #[mysql(rename = "loop_items_assignee_team_id")]
    pub assignee_team_id: Option<i32>,
    #[mysql(rename = "loop_items_current_delivery_id")]
    pub current_delivery_id: Option<String>,
    #[mysql(rename = "loop_items_version")]
    pub version: i64,
    #[mysql(rename = "loop_items_created_at")]
    pub created_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_updated_at")]
    pub updated_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_completed_at")]
    pub completed_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_metadata")]
    pub metadata: Option<Json<JsonProjection<ItemMetadata>>>,
}

impl TaskItemFullRow {
    /// (`deleted_at` unset-aware) `response_values` metadata view.
    pub fn metadata(&self) -> Option<&ItemMetadata> {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
    }
}

/// `db.query(LoopItemComment).filter(loop_item_id == ...)`: one comment row
/// selected with the same labeled `loop_items` projection.
#[allow(
    dead_code,
    reason = "selected to mirror the source comment projection; only the assignment fields are read"
)]
#[derive(Debug, FromMysqlRow)]
pub struct CommentRow {
    #[mysql(rename = "loop_items_id")]
    pub id: String,
    #[mysql(rename = "loop_items_loop_item_id")]
    pub loop_item_id: Option<String>,
    #[mysql(rename = "loop_items_description")]
    pub description: Option<String>,
    #[mysql(rename = "loop_items_created_by_user_id")]
    pub created_by_user_id: Option<i32>,
    #[mysql(rename = "loop_items_created_at")]
    pub created_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_updated_at")]
    pub updated_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_metadata")]
    pub metadata: Option<Json<JsonProjection<AssignmentMetadata>>>,
}

impl CommentRow {
    /// `LoopItemComment.metadata_json` assignment-event view.
    pub fn assignment(&self) -> Option<&AssignmentMetadata> {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
    }
}

/// The source's full column projection for `loop_item_executions`
/// (`loop_item_execution_service.latest_for_item`).
const EXECUTION_COLUMNS: &str = "loop_item_executions.id AS loop_item_executions_id, \
     loop_item_executions.loop_item_id AS loop_item_executions_loop_item_id, \
     loop_item_executions.cloud_project_id AS loop_item_executions_cloud_project_id, \
     loop_item_executions.executor_owner_user_id AS loop_item_executions_executor_owner_user_id, \
     loop_item_executions.agent_id AS loop_item_executions_agent_id, \
     loop_item_executions.team_id AS loop_item_executions_team_id, \
     loop_item_executions.backend_task_id AS loop_item_executions_backend_task_id, \
     loop_item_executions.automation_run_id AS loop_item_executions_automation_run_id, \
     loop_item_executions.execution_environment AS loop_item_executions_execution_environment, \
     loop_item_executions.execution_device_id AS loop_item_executions_execution_device_id, \
     loop_item_executions.runtime_instance_id AS loop_item_executions_runtime_instance_id, \
     loop_item_executions.assigner_user_id AS loop_item_executions_assigner_user_id, \
     loop_item_executions.status AS loop_item_executions_status, \
     loop_item_executions.priority_weight AS loop_item_executions_priority_weight, \
     loop_item_executions.queued_at AS loop_item_executions_queued_at, \
     loop_item_executions.started_at AS loop_item_executions_started_at, \
     loop_item_executions.completed_at AS loop_item_executions_completed_at, \
     loop_item_executions.lease_expires_at AS loop_item_executions_lease_expires_at, \
     loop_item_executions.heartbeat_at AS loop_item_executions_heartbeat_at, \
     loop_item_executions.attempt_no AS loop_item_executions_attempt_no, \
     loop_item_executions.previous_execution_id AS loop_item_executions_previous_execution_id, \
     loop_item_executions.execution_scope AS loop_item_executions_execution_scope, \
     loop_item_executions.observed_state AS loop_item_executions_observed_state, \
     loop_item_executions.sync_state AS loop_item_executions_sync_state, \
     loop_item_executions.claimed_at AS loop_item_executions_claimed_at, \
     loop_item_executions.start_requested_at AS loop_item_executions_start_requested_at, \
     loop_item_executions.observed_at AS loop_item_executions_observed_at, \
     loop_item_executions.cancel_requested_at AS loop_item_executions_cancel_requested_at, \
     loop_item_executions.last_event_seq AS loop_item_executions_last_event_seq, \
     loop_item_executions.termination_reason AS loop_item_executions_termination_reason, \
     loop_item_executions.retry_attempt AS loop_item_executions_retry_attempt, \
     loop_item_executions.max_retries AS loop_item_executions_max_retries, \
     loop_item_executions.error_message AS loop_item_executions_error_message, \
     loop_item_executions.execution_note AS loop_item_executions_execution_note, \
     loop_item_executions.approval_status AS loop_item_executions_approval_status, \
     loop_item_executions.approved_by_user_id AS loop_item_executions_approved_by_user_id, \
     loop_item_executions.approved_at AS loop_item_executions_approved_at, \
     loop_item_executions.rejected_reason AS loop_item_executions_rejected_reason, \
     loop_item_executions.runtime_device_id AS loop_item_executions_runtime_device_id, \
     loop_item_executions.runtime_task_id AS loop_item_executions_runtime_task_id, \
     loop_item_executions.execution_payload AS loop_item_executions_execution_payload, \
     loop_item_executions.version AS loop_item_executions_version, \
     loop_item_executions.created_at AS loop_item_executions_created_at, \
     loop_item_executions.updated_at AS loop_item_executions_updated_at";

/// `loop_item_execution_service.latest_for_item`: the newest run for the item
/// (`ORDER BY id DESC LIMIT 1`).
#[derive(Debug, FromMysqlRow)]
pub struct ExecutionFullRow {
    #[mysql(rename = "loop_item_executions_id")]
    pub id: i64,
    #[mysql(rename = "loop_item_executions_agent_id")]
    pub agent_id: Option<String>,
    #[mysql(rename = "loop_item_executions_team_id")]
    pub team_id: Option<i64>,
    #[mysql(rename = "loop_item_executions_status")]
    pub status: Option<String>,
    #[mysql(rename = "loop_item_executions_observed_state")]
    pub observed_state: Option<String>,
    #[mysql(rename = "loop_item_executions_sync_state")]
    pub sync_state: Option<String>,
    #[mysql(rename = "loop_item_executions_attempt_no")]
    pub attempt_no: Option<i64>,
    #[mysql(rename = "loop_item_executions_last_event_seq")]
    pub last_event_seq: Option<i64>,
    #[mysql(rename = "loop_item_executions_queued_at")]
    pub queued_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_started_at")]
    pub started_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_completed_at")]
    pub completed_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_lease_expires_at")]
    pub lease_expires_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_heartbeat_at")]
    pub heartbeat_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_error_message")]
    pub error_message: Option<String>,
    #[mysql(rename = "loop_item_executions_execution_note")]
    pub execution_note: Option<String>,
    #[mysql(rename = "loop_item_executions_approval_status")]
    pub approval_status: Option<String>,
    #[mysql(rename = "loop_item_executions_approved_by_user_id")]
    pub approved_by_user_id: Option<i64>,
    #[mysql(rename = "loop_item_executions_approved_at")]
    pub approved_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_rejected_reason")]
    pub rejected_reason: Option<String>,
    #[mysql(rename = "loop_item_executions_runtime_device_id")]
    pub runtime_device_id: Option<String>,
    #[mysql(rename = "loop_item_executions_runtime_task_id")]
    pub runtime_task_id: Option<String>,
    #[mysql(rename = "loop_item_executions_updated_at")]
    pub updated_at: Option<NaiveDateTime>,
}

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

    /// The underlying MySQL handle, for collaborators that share the same
    /// connection (for example the `require_cloud_project_role` helper).
    pub fn mysql(&self) -> &'a M {
        self.mysql
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

    /// `db.get(LoopItem, item_id)` (`find_cloud_context`'s item lookup and
    /// `response_values`'s task row): the active `resource_type='task'` row
    /// with the source's full labeled projection.
    pub async fn get_task_item_full(&self, item_id: &str) -> MysqlResult<Option<TaskItemFullRow>> {
        self.mysql
            .fetch_optional(
                &format!(
                    "SELECT {CLOUD_CONTEXT_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.id = '{item_id}' \
                     AND loop_items.resource_type IN ('task')",
                ),
                (),
            )
            .await
    }

    /// `db.get(CloudProject, binding.cloud_project_id)` (`find_cloud_context`):
    /// the bound project row. SQLAlchemy renders the string primary key as a
    /// quoted literal with the polymorphic `resource_type` filter and no
    /// `status`/`LIMIT` clause, so the statement matches the recorded
    /// `db.get` exchange (the `access_project` helper renders a different
    /// statement and does not match here).
    pub async fn get_cloud_project(&self, project_id: &str) -> MysqlResult<Option<ProjectListRow>> {
        self.mysql
            .fetch_optional(
                &format!(
                    "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.id = '{project_id}' \
                     AND loop_items.resource_type IN ('project')",
                ),
                (),
            )
            .await
    }

    /// `loop_item_execution_service.latest_for_item`: the newest run for the
    /// task regardless of terminal state.
    pub async fn latest_execution_for_item(
        &self,
        item_id: &str,
    ) -> MysqlResult<Option<ExecutionFullRow>> {
        self.mysql
            .fetch_optional(
                &format!(
                    "SELECT {EXECUTION_COLUMNS} \nFROM loop_item_executions \n\
                     WHERE loop_item_executions.loop_item_id = '{item_id}' \
                     ORDER BY loop_item_executions.id DESC \n LIMIT 1",
                ),
                (),
            )
            .await
    }

    /// `issue_assignment_service._active_events`: the item's comment rows in
    /// activity order.
    pub async fn list_item_comments(&self, item_id: &str) -> MysqlResult<Vec<CommentRow>> {
        self.mysql
            .fetch_all(
                &format!(
                    "SELECT {CLOUD_CONTEXT_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.loop_item_id = '{item_id}' \
                     AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
                         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
                     AND loop_items.resource_type IN ('comment') \
                     ORDER BY loop_items.created_at, loop_items.id",
                ),
                (),
            )
            .await
    }

    /// `access.is_related_item`: whether one item is related to the caller
    /// through ownership, assignment, an active runtime-task binding, a
    /// collaborator row, or an owned project agent.
    pub async fn is_related_item(&self, item_id: &str, user_id: i32) -> MysqlResult<bool> {
        #[derive(Debug, FromMysqlRow)]
        struct ExistsRow {
            #[mysql(rename = "loop_items_id")]
            #[allow(dead_code, reason = "presence-only probe")]
            id: String,
        }
        let row: Option<ExistsRow> = self
            .mysql
            .fetch_optional(
                &format!(
                    "SELECT loop_items.id AS loop_items_id \nFROM loop_items \n\
                     WHERE loop_items.id = '{item_id}' AND (loop_items.created_by_user_id = {user_id} \
                     OR loop_items.assignee_user_id = {user_id} \
                     OR loop_items.id IN (SELECT loop_items.loop_item_id FROM loop_items \
                         WHERE loop_items.task_user_id = {user_id} \
                         AND (loop_items.unlinked_at IS NULL OR loop_items.unlinked_at IN \
                             ('1970-01-01 00:00:00', '1970-01-01 00:00:01'))) \
                     OR loop_items.id IN (SELECT loop_item_collaborators.loop_item_id FROM loop_item_collaborators \
                         WHERE loop_item_collaborators.user_id = {user_id}) \
                     OR loop_items.assignee_agent_id IN (SELECT loop_items.id FROM loop_items \
                         WHERE loop_items.created_by_user_id = {user_id} AND loop_items.status = 'active' \
                         AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
                             ('1970-01-01 00:00:00', '1970-01-01 00:00:01')))) \n LIMIT 1",
                ),
                (),
            )
            .await?;
        Ok(row.is_some())
    }

    /// `db.get(ProjectChatAgent, id)`: the chat-agent row when it exists.
    pub async fn chat_agent(&self, agent_id: &str) -> MysqlResult<Option<ChatAgentRow>> {
        self.mysql
            .fetch_optional(
                &format!(
                    "SELECT loop_items.name AS loop_items_name, loop_items.title AS loop_items_title, \
                     loop_items.created_by_user_id AS loop_items_created_by_user_id \n\
                     FROM loop_items \n\
                     WHERE loop_items.id = '{agent_id}' \
                     AND loop_items.resource_type IN ('chat_agent') \n LIMIT 1",
                ),
                (),
            )
            .await
    }

    /// `db.get(Kind, id)`: the team's `name` when the row exists.
    pub async fn kind_name(&self, team_id: i64) -> MysqlResult<Option<String>> {
        #[derive(Debug, FromMysqlRow)]
        struct NameRow {
            #[mysql(rename = "kinds_name")]
            name: Option<String>,
        }
        let row: Option<NameRow> = self
            .mysql
            .fetch_optional(
                &format!(
                    "SELECT kinds.name AS kinds_name \nFROM kinds \n\
                     WHERE kinds.id = {team_id} \n LIMIT 1",
                ),
                (),
            )
            .await?;
        Ok(row.and_then(|row| row.name))
    }

    /// `_present_cached_ai_state`'s `ProjectChatMessage` lookup: the message's
    /// terminal state for a cached task AI projection.
    pub async fn project_chat_message(
        &self,
        message_id: &str,
        item_id: &str,
    ) -> MysqlResult<Option<ProjectChatMessageRow>> {
        self.mysql
            .fetch_optional(
                "SELECT project_chat_messages.status AS project_chat_messages_status, \
                 project_chat_messages.content AS project_chat_messages_content, \
                 project_chat_messages.updated_at AS project_chat_messages_updated_at \n\
                 FROM project_chat_messages \n\
                 WHERE project_chat_messages.message_id = ? \
                 AND project_chat_messages.task_id = ? \
                 AND (project_chat_messages.deleted_at IS NULL OR project_chat_messages.deleted_at IN \
                     ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \n LIMIT 1",
                (message_id, item_id),
            )
            .await
    }

    /// `human_issue_work_service._fallback_reviewer_ids`: the approved
    /// `Owner`/`Maintainer` member ids of one project.
    pub async fn project_reviewer_ids(&self, project_id: &str) -> MysqlResult<Vec<i64>> {
        #[derive(Debug, FromMysqlRow)]
        struct IdRow {
            #[mysql(rename = "resource_members_entity_id")]
            entity_id: String,
        }
        let rows: Vec<IdRow> = self
            .mysql
            .fetch_all(
                &format!(
                    "SELECT resource_members.entity_id AS resource_members_entity_id \n\
                     FROM resource_members \n\
                     WHERE resource_members.resource_type = 'CloudProject' \
                     AND resource_members.resource_id = '{project_id}' \
                     AND resource_members.entity_type = 'user' \
                     AND resource_members.status = 'approved' \
                     AND resource_members.`role` IN ('Owner', 'Maintainer')",
                ),
                (),
            )
            .await?;
        Ok(rows
            .into_iter()
            .filter_map(|row| row.entity_id.parse().ok())
            .collect())
    }
}

/// `ProjectChatMessage` projection consumed by `_present_cached_ai_state`.
#[derive(Debug, FromMysqlRow)]
pub struct ProjectChatMessageRow {
    #[mysql(rename = "project_chat_messages_status")]
    pub status: String,
    #[mysql(rename = "project_chat_messages_content")]
    pub content: Option<String>,
    #[mysql(rename = "project_chat_messages_updated_at")]
    pub updated_at: Option<NaiveDateTime>,
}

/// `ProjectChatAgent` projection consumed by the assignee-name and approval
/// projections.
#[derive(Debug, FromMysqlRow)]
pub struct ChatAgentRow {
    #[mysql(rename = "loop_items_name")]
    pub name: Option<String>,
    #[mysql(rename = "loop_items_title")]
    pub title: Option<String>,
    #[mysql(rename = "loop_items_created_by_user_id")]
    pub created_by_user_id: Option<i32>,
}

impl ChatAgentRow {
    /// `agent.title or agent.name`: the display name, preferring a non-empty
    /// title.
    pub fn display_name(&self) -> Option<String> {
        self.title
            .clone()
            .filter(|value| !value.is_empty())
            .or_else(|| self.name.clone())
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
