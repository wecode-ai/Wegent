// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Loop-item reader rows and the `_find_project` id split used by the
//! task-binding read path.

use brz_json::JsonProjection;
use brz_mysql::{FromMysqlRow, Json};
use chrono::NaiveDateTime;

use crate::loop_tasks::loop_columns::CLOUD_CONTEXT_COLUMNS;
use crate::sql_support::StatementArg;

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct ProjectMetadata {
    pub task_provider: Option<String>,
    pub visibility: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct BindingMetadata {
    pub stand_in_pending: Option<bool>,
    pub stand_in_conversation_id: Option<String>,
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
    pub milestone_id: Option<String>,
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
    /// `metadata["badges"]`: the operator-facing badge list.
    pub badges: Option<serde_json::Value>,
    /// `metadata["human_requests"]`: the pending human-input requests.
    pub human_requests: Option<serde_json::Value>,
    /// External-source markers that disable the direct-human view.
    pub external_index: Option<serde_json::Value>,
    pub external_shadow: Option<serde_json::Value>,
}

/// `LoopItemComment.metadata_json` fields read by activity and assignment queries.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct AssignmentMetadata {
    pub assistant_name: Option<serde_json::Value>,
    pub automation: Option<serde_json::Value>,
    pub event_type: Option<String>,
    pub action: Option<String>,
    pub assignment_event_id: Option<String>,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub target_name: Option<serde_json::Value>,
    pub workflow_step: Option<String>,
    pub trigger: Option<String>,
    pub receipt_tracking: Option<bool>,
    pub dispatch_receipt: Option<serde_json::Value>,
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
    pub cloud_project_id: Option<String>,
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

pub fn cloud_context_binding_statement(
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

/// One `loop_items` point read with the raw metadata document.
#[derive(Debug, FromMysqlRow)]
pub struct RawLoopItemRow {
    pub id: String,
    pub cloud_project_id: String,
    pub created_by_user_id: Option<i64>,
    pub assignee_user_id: Option<i64>,
    pub metadata: Option<Json<serde_json::Value>>,
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
pub const EXECUTION_COLUMNS: &str = "loop_item_executions.id AS loop_item_executions_id, \
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
    #[mysql(rename = "loop_item_executions_loop_item_id")]
    pub loop_item_id: Option<String>,
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
    #[mysql(rename = "loop_item_executions_execution_payload")]
    pub execution_payload: Option<Json<serde_json::Value>>,
    #[mysql(rename = "loop_item_executions_updated_at")]
    pub updated_at: Option<NaiveDateTime>,
}

impl ExecutionFullRow {
    /// `LoopItemExecution.executor_type` (`app.models.loop_item_execution`):
    /// the transport role derived from the persisted execution intent, then
    /// the assigned agent or team.
    pub fn executor_type(&self) -> &str {
        let intent = self
            .execution_payload
            .as_ref()
            .and_then(|payload| payload.0.as_object());
        let configured = intent
            .and_then(|intent| intent.get("runtime_selection"))
            .and_then(serde_json::Value::as_object)
            .or(intent)
            .and_then(|selection| selection.get("executor_kind"))
            .and_then(serde_json::Value::as_str);
        if matches!(
            configured,
            Some("generic_robot" | "collaboration_group_dispatch")
        ) {
            return configured.expect("matched literal");
        }
        if self.agent_id.as_deref().is_some_and(|id| !id.is_empty()) {
            "project_robot"
        } else if self.team_id.is_some_and(|id| id != 0) {
            "wegent_team"
        } else {
            "generic_robot"
        }
    }
}

impl BindingRow {
    fn metadata(&self) -> Option<&BindingMetadata> {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
    }

    pub fn stand_in_pending(&self) -> Option<bool> {
        self.metadata()
            .and_then(|metadata| metadata.stand_in_pending)
    }

    pub fn stand_in_conversation_id(&self) -> Option<String> {
        self.metadata()
            .and_then(|metadata| metadata.stand_in_conversation_id.as_deref())
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
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

#[derive(Debug, FromMysqlRow)]
pub struct ItemActivityMetadataRow {
    #[mysql(rename = "activity_metadata")]
    pub metadata: Option<Json<serde_json::Value>>,
}

/// `ProjectChatMessage` projection consumed by `_present_cached_ai_state`.
#[derive(Debug, Clone, FromMysqlRow)]
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
pub fn split_external_item_id(item_id: &str) -> Option<(&str, i64)> {
    let (key, number) = item_id.rsplit_once('-')?;
    if key.is_empty() || number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((key, number.parse().ok()?))
}
