// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Typed `loop_items` rows and the loop-item task-binding read path.
//!
//! Mirrors the single-table `LoopNode` mapping (`app.models.delivery`): the
//! `loop_items` table holds project (`resource_type='project'`), task
//! (`'task'`), and execution/binding (`'execution'`) rows.
use crate::board_snapshot::repository::ProjectRow as BoardProjectRow;
use crate::cloud_projects::{LOOP_ITEMS_COLUMNS, ProjectListRow, WORKSPACE_ID_COLUMN};
use crate::device_identity::owned_device_identity_ids;
use crate::sql_support::StatementArg;
use brz_json::JsonProjection;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;

use super::loop_columns::CLOUD_CONTEXT_COLUMNS;
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
    pub execution_context: Option<serde_json::Value>,
    pub human_assignment_id: Option<String>,
    pub dispatch_id: Option<String>,
    pub dispatch_round_id: Option<String>,
    pub assignment_id: Option<String>,
    pub issue_assignment_id: Option<String>,
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
    pub activity_read_sequences: Option<serde_json::Value>,
    pub security_level: Option<serde_json::Value>,
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
    /// External-source markers that disable the direct-human view.
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
    pub receipt_tracking: Option<bool>,
    pub human_read_at: Option<String>,
    pub stand_in_received_at: Option<String>,
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

/// `loop_items` execution/binding row (`LoopItemTaskBinding`,
/// `resource_type='execution'`), selected with the source's full labeled
/// 60-column projection so the prepared statement matches the recorded
/// `list_task_bindings` exchange.
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
    pub backend_task_id: Option<i64>,
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
    /// a non-empty string, otherwise `None`. This is the only binding property
    /// `find_runtime_task_cloud_context` injects explicitly; the other
    /// metadata-derived response fields keep their pydantic defaults.
    pub fn workflow_node_id(&self) -> Option<String> {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
            .and_then(|metadata| metadata.workflow_node_id.clone())
            .filter(|value| !value.is_empty())
    }
}

fn cloud_context_binding_statement(
    user_id: i32,
    device_ids: &[String],
    task_id: &str,
) -> (String, Vec<StatementArg>) {
    let placeholders = vec!["?"; device_ids.len()].join(", ");
    let sql = include_str!("cloud_context_binding.sql")
        .replace("{columns}", CLOUD_CONTEXT_COLUMNS)
        .replace("{device_ids}", &placeholders);
    let mut args = vec![StatementArg::Int(i64::from(user_id))];
    args.extend(device_ids.iter().cloned().map(StatementArg::Str));
    args.push(StatementArg::Str(task_id.to_owned()));
    (sql, args)
}

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
    #[mysql(rename = "loop_items_start_at")]
    pub start_at: Option<NaiveDateTime>,
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

/// One labeled `users` row from `db.query(User).filter(User.id.in_(...))`.
#[derive(Debug, FromMysqlRow)]
pub struct UserNameRow {
    #[mysql(rename = "users_id")]
    pub id: i64,
    #[mysql(rename = "users_user_name")]
    pub user_name: String,
}

/// The source's full column projection for `loop_item_executions`
/// (`loop_item_execution_service.latest_for_item`).
pub(crate) const EXECUTION_COLUMNS: &str = "loop_item_executions.id AS loop_item_executions_id, \
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
    fn metadata(&self) -> Option<&BindingMetadata> {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
    }

    /// `LoopItemTaskBinding.workflow_node_id`: the metadata value when it is
    /// a non-empty string, otherwise `None`.
    pub fn workflow_node_id(&self) -> Option<String> {
        self.metadata()
            .and_then(|metadata| metadata.workflow_node_id.as_deref())
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    }

    /// `LoopItemTaskBinding.human_assignment_id`.
    pub fn human_assignment_id(&self) -> Option<String> {
        self.metadata()
            .and_then(|metadata| metadata.human_assignment_id.as_deref())
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    }

    /// `LoopItemTaskBinding.dispatch_id`.
    pub fn dispatch_id(&self) -> Option<String> {
        self.metadata()
            .and_then(|metadata| metadata.dispatch_id.as_deref())
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    }

    /// `LoopItemTaskBinding.dispatch_round_id`.
    pub fn dispatch_round_id(&self) -> Option<String> {
        self.metadata()
            .and_then(|metadata| metadata.dispatch_round_id.as_deref())
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    }

    /// `LoopItemTaskBinding.assignment_id`.
    pub fn assignment_id(&self) -> Option<String> {
        self.metadata()
            .and_then(|metadata| metadata.assignment_id.as_deref())
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    }

    /// `LoopItemTaskBinding.model_selection`: the stored object, or `None`
    /// when the metadata value is not a JSON object.
    pub fn model_selection(&self) -> Option<&serde_json::Value> {
        self.metadata()
            .and_then(|metadata| metadata.model_selection.as_ref())
            .filter(|value| value.is_object())
    }

    /// `LoopItemTaskBinding.execution_context`: the stored object, or `None`
    /// when the metadata value is not a JSON object.
    pub fn execution_context(&self) -> Option<&serde_json::Value> {
        self.metadata()
            .and_then(|metadata| metadata.execution_context.as_ref())
            .filter(|value| value.is_object())
    }

    /// `LoopItemTaskBinding.change_requests`: only the object entries of the
    /// stored list.
    pub fn change_requests(&self) -> Vec<serde_json::Value> {
        self.metadata()
            .and_then(|metadata| metadata.change_requests.as_ref())
            .and_then(serde_json::Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter(|value| value.is_object())
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// Base role hierarchy (`app.schemas.base_role`); lower is more privileged.
fn role_level(role: &str) -> i32 {
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
pub fn has_permission(user_role: &str, required_role: &str) -> bool {
    role_level(user_role) <= role_level(required_role)
}

/// Shared ordered assignment-event query for transactional and ordinary reads.
pub(super) fn item_comments_query() -> String {
    format!(
        "SELECT {CLOUD_CONTEXT_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.loop_item_id = ? \
                     AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
                         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
                     AND loop_items.resource_type IN ('comment') \
                     ORDER BY loop_items.created_at, loop_items.id",
    )
}

/// Loop-item repositories for the task-binding read path.
pub struct LoopItemRepository<'a, M> {
    mysql: &'a M,
}

/// `visible_item_filter(user_id, project)` (`app.services.loop_items.access`)
/// rendered exactly as SQLAlchemy emits it for the task-list query: the
/// `security_level` JSON path through the `CASE ... WHEN 'null'` coalesce
/// form, and the single-table-inheritance subqueries over `loop_items` with
/// their `resource_type` guards (execution bindings, collaborator rows, and
/// owned chat agents).
pub(crate) fn visible_item_filter_sql(user_id: i32, default_security: &str) -> String {
    let related = related_item_predicate_sql(user_id);
    format!(
        " AND (coalesce(CASE JSON_EXTRACT(loop_items.metadata, '$.\"security_level\"') \
         WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata, \
         '$.\"security_level\"')) END, '{default_security}') = 'open' OR {related})"
    )
}

/// The five related-item branches share the current single-table schema.
fn related_item_predicate_sql(user_id: i32) -> String {
    format!(
        "loop_items.created_by_user_id = {user_id} \
         OR loop_items.assignee_user_id = {user_id} \
         OR loop_items.id IN (SELECT loop_items.loop_item_id \n\
         FROM loop_items \n\
         WHERE loop_items.task_user_id = {user_id} \
         AND (loop_items.unlinked_at IS NULL OR loop_items.unlinked_at IN \
         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         AND loop_items.resource_type IN ('execution')) \
         OR loop_items.id IN (SELECT loop_items.loop_item_id \n\
         FROM loop_items \n\
         WHERE loop_items.user_id = {user_id} \
         AND loop_items.resource_type IN ('collaborator')) \
         OR loop_items.assignee_agent_id IN (SELECT loop_items.id \n\
         FROM loop_items \n\
         WHERE loop_items.created_by_user_id = {user_id} \
         AND loop_items.status = 'active' \
         AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         AND loop_items.resource_type IN ('chat_agent'))"
    )
}

impl<'a, M: Mysql> LoopItemRepository<'a, M> {
    pub fn new(mysql: &'a M) -> Self {
        Self { mysql }
    }

    /// `ExternalLoopItemProvider._find_project`: resolve `KEY-number` ids to
    /// an external-provider project row. Returns `Ok(None)` when the id does
    /// not parse or the project is not github/gitlab backed.
    pub async fn find_external_project(
        &self,
        item_id: &str,
    ) -> MysqlResult<Option<BoardProjectRow>> {
        let Some((key, number)) = split_external_item_id(item_id) else {
            return Ok(None);
        };
        let _ = number;
        // `db.query(CloudProject).filter(CloudProject.project_key == key)`
        // renders the full labeled projection, not a narrowed column list.
        let project: Option<BoardProjectRow> = self
            .mysql
            .fetch_optional(
                &format!(
                    "SELECT {WORKSPACE_ID_COLUMN}, {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.project_key = ? \n\
                     AND loop_items.resource_type IN ('project') \n LIMIT 1",
                ),
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

    /// Caller-owned active bindings for the item,
    /// newest first, selected with the source's labeled `loop_items`
    /// projection. The recorded contract filters `resource_type='execution'`
    /// bindings whose `unlinked_at` is unset; it does not filter
    /// `deleted_at`, so the statement stays compatible with the recorded
    /// exchange.
    pub async fn list_task_bindings(
        &self,
        item_id: &str,
        user_id: i32,
    ) -> MysqlResult<Vec<BindingRow>> {
        self.mysql
            .fetch_all(
                &format!(
                    "SELECT {CLOUD_CONTEXT_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.loop_item_id = ? AND loop_items.task_user_id = ? \
                     AND (loop_items.unlinked_at IS NULL OR loop_items.unlinked_at IN \
                         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
                     AND loop_items.resource_type IN ('execution') \
                     ORDER BY loop_items.linked_at DESC, loop_items.id DESC",
                ),
                (item_id, user_id),
            )
            .await
    }

    /// `LoopItemService.find_cloud_context`: the active runtime-task binding
    /// for `(task_user_id, owned device identity, task_id)`. `Ok(None)` maps to the
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
        let device_ids =
            owned_device_identity_ids(self.mysql, i64::from(user_id), device_id).await?;
        let (sql, args) = cloud_context_binding_statement(user_id, &device_ids, task_id);
        self.mysql.fetch_optional(sql, args).await
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

    /// `LoopItemService._get_item_row`: the full entity projection for one
    /// non-deleted task row. `Ok(None)` maps to the source's 404.
    pub async fn get_task_item_entity(
        &self,
        item_id: &str,
    ) -> MysqlResult<Option<TaskItemFullRow>> {
        self.mysql
            .fetch_optional(
                &format!(
                    "SELECT {CLOUD_CONTEXT_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.id = ? AND (loop_items.deleted_at IS NULL OR \
                     loop_items.deleted_at IN ('1970-01-01 00:00:00', \
                     '1970-01-01 00:00:01')) AND loop_items.resource_type IN ('task') \
                     \n LIMIT 1",
                ),
                (item_id,),
            )
            .await
    }

    /// `loop_item_service.list`: the active task rows of one project, ordered
    /// by `sort_order, updated_at DESC`. The recorded COM_QUERY inlines the
    /// numeric `cloud_project_id`. When the caller lacks `Maintainer`, the
    /// source adds the `visible_item_filter`; `default_security` is the
    /// project's `default_issue_security`.
    pub async fn list_project_task_items(
        &self,
        project_id: &str,
        user_id: i32,
        visible_filter: Option<&str>,
    ) -> MysqlResult<Vec<TaskItemFullRow>> {
        let visibility = match visible_filter {
            Some(default_security) => visible_item_filter_sql(user_id, default_security),
            None => String::new(),
        };
        self.mysql
            .fetch_all(
                &format!(
                    "SELECT {CLOUD_CONTEXT_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.cloud_project_id = {project_id} \
                     AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
                         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')){visibility} \
                     AND loop_items.resource_type IN ('task') \
                     ORDER BY loop_items.sort_order, loop_items.updated_at DESC",
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
            .fetch_all(item_comments_query(), (item_id,))
            .await
    }

    /// Indexed current assignments, preserving the event reducer's key order.
    pub async fn list_active_assignment_comments(
        &self,
        item_id: &str,
    ) -> MysqlResult<Vec<CommentRow>> {
        self.mysql.fetch_all(format!(
            "SELECT {CLOUD_CONTEXT_COLUMNS} FROM loop_items active \
             JOIN loop_items ON loop_items.id = active.loop_item_id \
             WHERE active.parent_id = ? AND active.resource_type = 'assignment_index' \
             AND loop_items.resource_type = 'comment' \
             AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) \
             ORDER BY active.sort_order, loop_items.id"
        ), (item_id,)).await
    }

    /// `LoopItemService.list_comments`: the item's comment rows ordered by
    /// `created_at ASC` (the source issues no secondary `id` ordering here).
    pub async fn list_comments(&self, item_id: &str) -> MysqlResult<Vec<CommentRow>> {
        self.mysql
            .fetch_all(
                &format!(
                    "SELECT {CLOUD_CONTEXT_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.loop_item_id = ? \
                     AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
                         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
                     AND loop_items.resource_type IN ('comment') \
                     ORDER BY loop_items.created_at ASC",
                ),
                (item_id,),
            )
            .await
    }

    /// `db.query(User).filter(User.id.in_(author_ids)).all()`: the comment
    /// authors' display names, with the source's labeled `users` projection.
    pub async fn list_user_names(&self, ids: &[i32]) -> MysqlResult<Vec<UserNameRow>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; ids.len()].join(", ");
        self.mysql
            .fetch_all(
                format!(
                    "SELECT {} \nFROM users \nWHERE users.id IN ({placeholders})",
                    crate::user_reader::users_projection(),
                ),
                ids.to_vec(),
            )
            .await
    }

    /// Manager activities, newest first, for the current round's human identity.
    pub async fn item_activity_metadata(
        &self,
        project_id: &str,
        item_id: &str,
    ) -> MysqlResult<Vec<ItemActivityMetadataRow>> {
        self.mysql
            .fetch_all(
                "SELECT project_chat_messages.metadata AS activity_metadata \
                 FROM project_chat_messages \
                 WHERE project_chat_messages.project_id = ? \
                 AND project_chat_messages.task_id = ? \
                 ORDER BY project_chat_messages.created_at DESC, project_chat_messages.id DESC",
                (project_id, item_id),
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
                    "SELECT loop_items.id AS loop_items_id FROM loop_items \
                     WHERE loop_items.id = ? AND ({}) \
                     AND loop_items.resource_type IN ('task') LIMIT 1",
                    related_item_predicate_sql(user_id),
                ),
                (item_id,),
            )
            .await?;
        Ok(row.is_some())
    }

    /// `db.get(ProjectChatAgent, id)`: the chat-agent row when it exists. The
    /// source's `Session.get` renders the unlabeled entity projection with no
    /// `LIMIT`, matching the recorded exchange for replay.
    pub async fn chat_agent(&self, agent_id: &str) -> MysqlResult<Option<ChatAgentRow>> {
        self.mysql
            .fetch_optional(
                &format!(
                    "SELECT {} \nFROM loop_items \n\
                     WHERE loop_items.id = '{agent_id}' \
                     AND loop_items.resource_type IN ('chat_agent')",
                    crate::cloud_projects::entity_columns(),
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
}

/// Raw activity metadata preserves the Python guards for malformed manager plans.
#[derive(Debug, FromMysqlRow)]
pub struct ItemActivityMetadataRow {
    #[mysql(rename = "activity_metadata")]
    pub metadata: Option<Json<serde_json::Value>>,
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
/// projections. The row carries its primary key so an identity-map hit can be
/// recognized by id.
#[derive(Debug, Clone, FromMysqlRow)]
pub struct ChatAgentRow {
    #[mysql(rename = "id")]
    #[allow(dead_code, reason = "carried for identity-map id comparison")]
    pub id: String,
    #[mysql(rename = "name")]
    pub name: Option<String>,
    #[mysql(rename = "title")]
    pub title: Option<String>,
    #[mysql(rename = "created_by_user_id")]
    pub created_by_user_id: Option<i32>,
}

impl ChatAgentRow {
    /// Whether this row is the agent identified by `agent_id`.
    pub fn matches_id(&self, agent_id: &str) -> bool {
        self.id == agent_id
    }

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
mod visible_filter_tests {
    use super::visible_item_filter_sql;

    #[test]
    fn visible_item_filter_matches_the_recorded_rendering() {
        let rendered = visible_item_filter_sql(86, "open");
        // The recorded statement's filter fragment (case 30e04068, user 86).
        let expected = " AND (coalesce(CASE JSON_EXTRACT(loop_items.metadata, '$.\"security_level\"') WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata, '$.\"security_level\"')) END, 'open') = 'open' OR loop_items.created_by_user_id = 86 OR loop_items.assignee_user_id = 86 OR loop_items.id IN (SELECT loop_items.loop_item_id \nFROM loop_items \nWHERE loop_items.task_user_id = 86 AND (loop_items.unlinked_at IS NULL OR loop_items.unlinked_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) AND loop_items.resource_type IN ('execution')) OR loop_items.id IN (SELECT loop_items.loop_item_id \nFROM loop_items \nWHERE loop_items.user_id = 86 AND loop_items.resource_type IN ('collaborator')) OR loop_items.assignee_agent_id IN (SELECT loop_items.id \nFROM loop_items \nWHERE loop_items.created_by_user_id = 86 AND loop_items.status = 'active' AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) AND loop_items.resource_type IN ('chat_agent')))";
        let normalize = |s: &str| re_whitespace(s);
        fn re_whitespace(s: &str) -> String {
            s.split_whitespace().collect::<Vec<_>>().join(" ")
        }
        assert_eq!(normalize(&rendered), normalize(expected));
        assert!(rendered.contains("$.\"security_level\""));
        assert!(
            rendered.contains(
                "loop_items.user_id = 86 AND loop_items.resource_type IN ('collaborator')"
            )
        );
    }
}

#[cfg(test)]
#[path = "loop_repository_tests.rs"]
mod tests;
