// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Execution-overlay rows and projections for the loop-item-pages read path.
//!
//! `_with_execution_state` (`app.services.loop_items.external_provider`) reads
//! the newest `loop_item_executions` run for an item through
//! `loop_item_execution_service.latest_for_item`, resolves the run's
//! `ProjectChatAgent` and `Kind` rows with `Session.get`, and projects
//! `execution_display_state` and `execution_ai_state`. Every row struct decodes
//! by the column alias SQLAlchemy renders in the recorded `COM_QUERY`
//! (`loop_item_executions_<column>`), the same convention
//! `loop_tasks::loop_repository::ExecutionFullRow` uses for the identical
//! `latest_for_item` statement.
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::loop_tasks::loop_repository::EXECUTION_COLUMNS;

/// The bare `loop_items` entity column list SQLAlchemy renders for
/// `Session.get(ProjectChatAgent, id)`: every mapped column, no labels, no
/// `LIMIT`. Matches the recorded exchange byte-for-byte.
const CHAT_AGENT_ENTITY_COLUMNS: &str = "loop_items.id, loop_items.resource_type, \
     loop_items.project_space, loop_items.cloud_project_id, loop_items.parent_id, \
     loop_items.loop_item_id, loop_items.delivery_id, loop_items.public_id, \
     loop_items.project_key, loop_items.name, loop_items.title, loop_items.description, \
     loop_items.storage_prefix, loop_items.sequence_number, \
     loop_items.next_item_number, loop_items.created_by_user_id, \
     loop_items.updated_by_user_id, loop_items.assignee_user_id, loop_items.user_id, \
     loop_items.added_by_user_id, loop_items.source, loop_items.status, \
     loop_items.priority, loop_items.due_at, loop_items.sort_order, \
     loop_items.current_delivery_id, loop_items.local_project_id, loop_items.device_id, \
     loop_items.is_default, loop_items.task_user_id, loop_items.assignee_agent_id, \
     loop_items.assignee_team_id, loop_items.task_id, loop_items.task_title, \
     loop_items.backend_task_id, loop_items.linked_by_user_id, loop_items.linked_at, \
     loop_items.unlinked_at, loop_items.path, loop_items.kind, loop_items.display_name, \
     loop_items.relative_path, loop_items.object_key, loop_items.content_type, \
     loop_items.size_bytes, loop_items.sha256, loop_items.source_task_binding_id, \
     loop_items.source_task_snapshot, loop_items.markdown_object_key, \
     loop_items.chat_object_key, loop_items.manifest_object_key, loop_items.metadata, \
     loop_items.version, loop_items.created_at, loop_items.updated_at, \
     loop_items.completed_at, loop_items.delivered_at, loop_items.deleted_at";

/// One `loop_item_executions` row projected by `_with_execution_state`.
/// The column set mirrors the source's full-entity `latest_for_item`
/// selection, so the statement matches the recorded exchange. Each field maps
/// the `loop_item_executions_<column>` alias the statement renders.
#[derive(Debug, brz_mysql::FromMysqlRow)]
#[allow(
    dead_code,
    reason = "selected to mirror the source execution projection"
)]
pub(super) struct ExecutionRow {
    #[mysql(rename = "loop_item_executions_id")]
    pub(super) id: i64,
    #[mysql(rename = "loop_item_executions_agent_id")]
    pub(super) agent_id: Option<String>,
    #[mysql(rename = "loop_item_executions_team_id")]
    pub(super) team_id: Option<i64>,
    #[mysql(rename = "loop_item_executions_status")]
    pub(super) status: Option<String>,
    #[mysql(rename = "loop_item_executions_observed_state")]
    pub(super) observed_state: Option<String>,
    #[mysql(rename = "loop_item_executions_sync_state")]
    pub(super) sync_state: Option<String>,
    #[mysql(rename = "loop_item_executions_attempt_no")]
    pub(super) attempt_no: Option<i64>,
    #[mysql(rename = "loop_item_executions_last_event_seq")]
    pub(super) last_event_seq: Option<i64>,
    #[mysql(rename = "loop_item_executions_queued_at")]
    pub(super) queued_at: Option<chrono::NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_started_at")]
    pub(super) started_at: Option<chrono::NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_completed_at")]
    pub(super) completed_at: Option<chrono::NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_lease_expires_at")]
    pub(super) lease_expires_at: Option<chrono::NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_heartbeat_at")]
    pub(super) heartbeat_at: Option<chrono::NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_error_message")]
    pub(super) error_message: Option<String>,
    #[mysql(rename = "loop_item_executions_execution_note")]
    pub(super) execution_note: Option<String>,
    #[mysql(rename = "loop_item_executions_approval_status")]
    pub(super) approval_status: Option<String>,
    #[mysql(rename = "loop_item_executions_approved_by_user_id")]
    pub(super) approved_by_user_id: Option<i64>,
    #[mysql(rename = "loop_item_executions_approved_at")]
    pub(super) approved_at: Option<chrono::NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_rejected_reason")]
    pub(super) rejected_reason: Option<String>,
    #[mysql(rename = "loop_item_executions_runtime_device_id")]
    pub(super) runtime_device_id: Option<String>,
    #[mysql(rename = "loop_item_executions_runtime_task_id")]
    pub(super) runtime_task_id: Option<String>,
    #[mysql(rename = "loop_item_executions_updated_at")]
    pub(super) updated_at: Option<chrono::NaiveDateTime>,
}

/// One `ProjectChatAgent` row for the assignee-name and AI-state
/// projections: the columns the source reads from the ORM entity.
#[derive(Debug, brz_mysql::FromMysqlRow)]
pub(super) struct AgentEntityRow {
    name: Option<String>,
    title: Option<String>,
    pub(super) created_by_user_id: Option<i32>,
}

impl AgentEntityRow {
    /// `agent.title or agent.name`: the display name, preferring a non-empty
    /// title.
    pub(super) fn display_name(&self) -> Option<String> {
        self.title
            .clone()
            .filter(|value| !value.is_empty())
            .or_else(|| self.name.clone())
    }
}

impl ExecutionRow {
    /// `loop_item_execution_service.latest_for_item`: the newest run for the
    /// task regardless of terminal state. SQLAlchemy renders the labeled
    /// full-entity projection with the string `loop_item_id` inlined as a
    /// quoted literal in a COM_QUERY.
    pub(super) async fn latest_for_item<M: brz_mysql::Mysql>(
        mysql: &M,
        item_id: &str,
    ) -> Result<Option<Self>, brz_mysql::MysqlError> {
        mysql
            .fetch_optional(
                &format!(
                    "SELECT {EXECUTION_COLUMNS} \nFROM loop_item_executions \n\
                     WHERE loop_item_executions.loop_item_id = '{item_id}' \
                     ORDER BY loop_item_executions.id DESC \n LIMIT 1"
                ),
                (),
            )
            .await
    }

    /// `db.get(ProjectChatAgent, agent_id)`: the `Session.get` rendering —
    /// bare entity columns, no `LIMIT`, id inlined as a quoted literal.
    pub(super) async fn chat_agent<M: brz_mysql::Mysql>(
        mysql: &M,
        agent_id: &str,
    ) -> Result<Option<AgentEntityRow>, brz_mysql::MysqlError> {
        mysql
            .fetch_optional(
                &format!(
                    "SELECT {CHAT_AGENT_ENTITY_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.id = '{agent_id}' \
                     AND loop_items.resource_type IN ('chat_agent')"
                ),
                (),
            )
            .await
    }

    /// `loop_datetime_value_is_unset` (`app.models.delivery`): NULL and both
    /// MySQL unset sentinels (`1970-01-01 00:00:00` and `00:00:01`) are
    /// absent.
    fn datetime_model_is_unset(value: Option<chrono::NaiveDateTime>) -> bool {
        match value {
            None => true,
            Some(value) => matches!(
                value.format("%Y-%m-%d %H:%M:%S").to_string().as_str(),
                "1970-01-01 00:00:00" | "1970-01-01 00:00:01"
            ),
        }
    }

    /// `iso(value)`: `_optional_datetime(value).isoformat()` — the model
    /// unset check, then naive `isoformat()` (no offset, fractional digits
    /// only when nonzero).
    pub(super) fn optional_iso(value: Option<chrono::NaiveDateTime>) -> Option<String> {
        if Self::datetime_model_is_unset(value) {
            return None;
        }
        let value = value?;
        let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
        if value.and_utc().timestamp_subsec_nanos() == 0 {
            Some(base)
        } else {
            Some(format!(
                "{base}.{:06}",
                value.and_utc().timestamp_subsec_micros()
            ))
        }
    }

    /// `_optional_dt` + pydantic `isoformat()`: naive datetimes serialize
    /// without an offset, with 6-digit microseconds when nonzero. Uses the
    /// model-variant unset check, matching the source's
    /// `loop_datetime_value_is_unset`.
    fn naive_iso(value: Option<chrono::NaiveDateTime>) -> Option<String> {
        Self::optional_iso(value)
    }

    /// `_execution_approval_view(execution)`: the approval projection.
    pub(super) fn approval_view(&self) -> Option<ApprovalView> {
        let status = self.approval_status.as_deref()?;
        if status.is_empty() {
            return None;
        }
        // The `status` discriminant is always emitted first; the per-status
        // branch fields follow. `approval` is `dict[str, Any] | None` in the
        // source schema, so missing branch fields must serialize as `null`
        // (not be omitted) to match the source's `view[key] = value` writes,
        // which leave a branch's other keys unset only because pydantic later
        // re-serializes the dict as-is. The recorded cases have no executions,
        // so this branch is reached only on the unrecorded execution path.
        let (requested_at, approved_by_user_id, approved_at, rejected_reason) = match status {
            "pending" => (Self::naive_iso(self.queued_at), None, None, None),
            "approved" => (
                None,
                self.approved_by_user_id,
                Self::naive_iso(self.approved_at),
                None,
            ),
            "rejected" => (None, None, None, self.rejected_reason.clone()),
            _ => (None, None, None, None),
        };
        Some(ApprovalView {
            status: status.to_string(),
            requested_at,
            approved_by_user_id,
            approved_at,
            rejected_reason,
        })
    }
}

/// `_execution_approval_view(execution)`: the approval projection shape.
/// All four branch fields are always present; the source sets only the
/// fields for the active status, and the others stay `null`. The field
/// order (`status`, `requested_at`, `approved_by_user_id`, `approved_at`,
/// `rejected_reason`) is the union of the source's per-status dict writes
/// in declaration order.
#[derive(Debug, Serialize)]
pub(super) struct ApprovalView {
    status: String,
    requested_at: Option<String>,
    approved_by_user_id: Option<i64>,
    approved_at: Option<String>,
    rejected_reason: Option<String>,
}

/// `execution_display_state` (`app.services.loop_item_executions.service`):
/// the single user-facing state derived from execution truth.
pub(super) fn execution_display_state(execution: &ExecutionRow) -> String {
    let status = execution.status.as_deref().unwrap_or("");
    if status == "completed" {
        return "succeeded".to_string();
    }
    if matches!(status, "failed" | "cancelled") {
        return status.to_string();
    }
    if matches!(
        execution.sync_state.as_deref(),
        Some("stale") | Some("diverged")
    ) {
        return "unknown".to_string();
    }
    if status == "pending_approval" {
        return "waiting_approval".to_string();
    }
    if status == "waiting_runtime" {
        return "waiting_runtime".to_string();
    }
    if status == "queued" {
        return "queued".to_string();
    }
    if status == "cancel_requested" {
        return "cancelling".to_string();
    }
    if status == "claimed" {
        return "starting".to_string();
    }
    if status == "running" && execution.observed_state.as_deref() == Some("running") {
        return "running".to_string();
    }
    "waiting_runtime".to_string()
}

/// `execution_ai_state` (`app.services.loop_item_executions.service`):
/// project the authoritative execution attempt onto the task AI metadata.
/// Returns `None` for a run awaiting approval. The base view never carries a
/// cached AI state, so `existing` starts empty on this read path.
pub(super) async fn execution_ai_state<M: brz_mysql::Mysql>(
    mysql: &M,
    execution: &ExecutionRow,
) -> Result<Option<Value>, brz_mysql::MysqlError> {
    if execution.status.as_deref() == Some("pending_approval") {
        return Ok(None);
    }
    // `db.get(ProjectChatAgent, execution.agent_id)` — one independent
    // Session.get for the run's agent.
    let agent = match execution.agent_id.as_deref().filter(|id| !id.is_empty()) {
        Some(agent_id) => ExecutionRow::chat_agent(mysql, agent_id).await?,
        None => None,
    };
    // `db.get(Kind, execution.team_id) if execution.team_id else None`: an
    // unset team id is stored as 0, which is falsy, so no lookup runs.
    let team_name = match execution.team_id.filter(|team_id| *team_id != 0) {
        Some(team_id) => kind_name(mysql, team_id).await?,
        None => None,
    };
    // `execution.executor_type` derives from the stored execution payload; a
    // payload-less row with an agent is a `project_robot`, so the agent's
    // title/name wins and the team name is the fallback.
    let agent_name = agent
        .as_ref()
        .and_then(|agent| agent.display_name())
        .or(team_name);
    // `execution.team_id or None`: an unset 0 renders as null.
    let team_id = execution.team_id.filter(|team_id| *team_id != 0);
    let run_id = json!(format!("exec-{}", execution.id));
    let state = Map::from_iter([
        ("run_id".to_string(), run_id),
        (
            "status".to_string(),
            json!(execution_display_state(execution)),
        ),
        (
            "agent_id".to_string(),
            json!(execution.agent_id.as_deref().filter(|id| !id.is_empty())),
        ),
        ("team_id".to_string(), json!(team_id)),
        ("agent_name".to_string(), json!(agent_name)),
        (
            "runtime_device_id".to_string(),
            json!(
                execution
                    .runtime_device_id
                    .as_deref()
                    .filter(|id| !id.is_empty())
            ),
        ),
        (
            "runtime_task_id".to_string(),
            json!(
                execution
                    .runtime_task_id
                    .as_deref()
                    .filter(|id| !id.is_empty())
            ),
        ),
        (
            "started_at".to_string(),
            json!(ExecutionRow::optional_iso(execution.started_at)),
        ),
        (
            "heartbeat_at".to_string(),
            json!(ExecutionRow::optional_iso(execution.heartbeat_at)),
        ),
        (
            "lease_expires_at".to_string(),
            json!(ExecutionRow::optional_iso(execution.lease_expires_at)),
        ),
        (
            "completed_at".to_string(),
            json!(ExecutionRow::optional_iso(execution.completed_at)),
        ),
        (
            "updated_at".to_string(),
            json!(ExecutionRow::optional_iso(execution.updated_at)),
        ),
        (
            "last_error".to_string(),
            json!(
                execution
                    .error_message
                    .as_deref()
                    .filter(|message| !message.is_empty())
            ),
        ),
    ]);
    Ok(Some(Value::Object(state)))
}

/// `db.get(Kind, id)`: the team's `name` when the row exists.
pub(super) async fn kind_name<M: brz_mysql::Mysql>(
    mysql: &M,
    team_id: i64,
) -> Result<Option<String>, brz_mysql::MysqlError> {
    #[derive(Debug, brz_mysql::FromMysqlRow)]
    struct NameRow {
        #[mysql(rename = "kinds_name")]
        name: Option<String>,
    }
    let row: Option<NameRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT kinds.name AS kinds_name \nFROM kinds \n\
                 WHERE kinds.id = {team_id} \n LIMIT 1"
            ),
            (),
        )
        .await?;
    Ok(row.and_then(|row| row.name))
}
