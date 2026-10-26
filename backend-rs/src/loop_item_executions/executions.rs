// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/cloud-projects/{project_id}/executions` — the project
//! execution queue read.
//!
//! Mirrors `app.api.endpoints.loop_item_executions.list_executions`:
//! 1. `security.get_current_user` — the JWT user session principal;
//! 2. `require_cloud_project_role(db, project_id, user_id, Viewer)` — the
//!    point `project_access_query` plus the permission-source reads. No
//!    permission source is `404 "Cloud project not found"`; a role below
//!    `Viewer` is `403 "Insufficient permission"`;
//! 3. `db.get(CloudProject, str(project_id))` — the project entity whose
//!    `workspace_id` column property feeds every row; its metadata (read with
//!    the access row) selects the task provider and the default issue
//!    security;
//! 4. `loop_item_execution_service.list_queue` — the queue rows ordered by
//!    `priority_weight DESC, queued_at ASC, id ASC`, limited to the active
//!    statuses unless `status` or `include_terminal` selects otherwise;
//! 5. task display fields — the live external provider for `github`/`gitlab`
//!    projects, otherwise the visible `resource_type='task'` rows;
//! 6. `runner_catalog.annotate_queue` — the persisted runner-routing intent
//!    of routed rows is projected on every row. The source additionally
//!    resolves the eligible runner candidates of a routed `queued` row to
//!    explain its wait; that resolution needs the runner-routing, device
//!    catalog and cloud-model services, which the target does not implement
//!    yet, so it is not repeated here.
use std::collections::{BTreeSet, HashMap};

use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::board_snapshot::repository::{
    BoardSnapshotRepository, BotConfig, ProjectRow, has_permission,
};
use crate::cloud_projects::{LOOP_ITEMS_COLUMNS, parse_project_id};
use crate::http_compat::FastApiError;
use crate::loop_item_pages::PageIssue;
use crate::loop_item_pages::projection::issue_response;
use crate::loop_tasks::item_response::{isoformat, isoformat_model_unset};
use crate::loop_tasks::loop_repository::{EXECUTION_COLUMNS, visible_item_filter_sql};
use crate::state::AppState;

/// `list_queue`'s default `limit`.
const QUEUE_LIMIT: usize = 200;

/// `ACTIVE_STATUSES` (`app.services.loop_item_executions.service`).
const ACTIVE_STATUSES: [&str; 6] = [
    "waiting_runtime",
    "pending_approval",
    "queued",
    "claimed",
    "running",
    "cancel_requested",
];

/// Query parameters of the source endpoint. FastAPI parses `project_id` as an
/// `int` and `include_terminal` as a boolean; both are validated here so a
/// malformed value renders the pydantic 422 body instead of a silent default.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ExecutionListQuery {
    agent_id: Option<String>,
    assigner_user_id: Option<String>,
    status: Option<String>,
    include_terminal: Option<String>,
}

/// Validated form of [`ExecutionListQuery`]. The source keeps `agent_id` and
/// `status` falsy when empty and filters only a present `assigner_user_id`.
#[derive(Debug, Default)]
struct QueueFilters {
    agent_id: Option<String>,
    assigner_user_id: Option<i64>,
    status: Option<String>,
    include_terminal: bool,
}

/// FastAPI boolean query parsing (pydantic v2 accepted literals).
fn parse_bool(value: &str) -> Result<bool, FastApiError> {
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" | "y" | "t" => Ok(true),
        "false" | "0" | "no" | "off" | "n" | "f" => Ok(false),
        _ => Err(FastApiError::validation(json!([{
            "type": "bool_parsing",
            "loc": ["query", "include_terminal"],
            "msg": "Input should be a valid boolean, unable to interpret input",
            "input": value,
        }]))),
    }
}

/// `Query(assigner_user_id: Optional[int])`. A present value that is not an
/// integer is the pydantic `int_parsing` 422.
fn parse_assigner_user_id(raw: Option<&str>) -> Result<Option<i64>, FastApiError> {
    let Some(value) = raw else {
        return Ok(None);
    };
    value.parse::<i64>().map(Some).map_err(|_| {
        FastApiError::validation(json!([{
            "type": "int_parsing",
            "loc": ["query", "assigner_user_id"],
            "msg": "Input should be a valid integer, unable to parse string as an integer",
            "input": value,
        }]))
    })
}

fn parse_filters(query: &ExecutionListQuery) -> Result<QueueFilters, FastApiError> {
    let include_terminal = match query.include_terminal.as_deref() {
        None => false,
        Some(value) => parse_bool(value)?,
    };
    Ok(QueueFilters {
        agent_id: query.agent_id.clone().filter(|value| !value.is_empty()),
        assigner_user_id: parse_assigner_user_id(query.assigner_user_id.as_deref())?,
        status: query.status.clone().filter(|value| !value.is_empty()),
        include_terminal,
    })
}

/// Render one MySQL string literal the way SQLAlchemy does (single quotes are
/// doubled). The source inlines every filter value as a literal.
fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// `loop_item_execution_service.list_queue`: the queue projection with the
/// caller's optional filters and the source's fixed ordering and limit.
fn queue_statement(project_id: i64, filters: &QueueFilters) -> String {
    let mut sql = format!(
        "SELECT {EXECUTION_COLUMNS} \nFROM loop_item_executions \n\
         WHERE loop_item_executions.cloud_project_id = '{project_id}'"
    );
    if let Some(agent_id) = filters.agent_id.as_deref() {
        sql.push_str(&format!(
            " AND loop_item_executions.agent_id = {}",
            sql_literal(agent_id)
        ));
    }
    if let Some(assigner_user_id) = filters.assigner_user_id {
        sql.push_str(&format!(
            " AND loop_item_executions.assigner_user_id = {assigner_user_id}"
        ));
    }
    if let Some(status) = filters.status.as_deref() {
        sql.push_str(&format!(
            " AND loop_item_executions.status = {}",
            sql_literal(status)
        ));
    } else if !filters.include_terminal {
        let statuses = ACTIVE_STATUSES
            .iter()
            .map(|status| sql_literal(status))
            .collect::<Vec<_>>()
            .join(", ");
        sql.push_str(&format!(" AND loop_item_executions.status IN ({statuses})"));
    }
    sql.push_str(&format!(
        " ORDER BY loop_item_executions.priority_weight DESC, \
         loop_item_executions.queued_at ASC, loop_item_executions.id ASC \n LIMIT {QUEUE_LIMIT}"
    ));
    sql
}

/// One labeled `loop_item_executions` row. The statement selects the source's
/// full entity projection (`EXECUTION_COLUMNS`); only the response fields and
/// the runtime intent are decoded.
#[derive(Debug, FromMysqlRow)]
struct ExecutionRow {
    #[mysql(rename = "loop_item_executions_id")]
    id: i64,
    #[mysql(rename = "loop_item_executions_loop_item_id")]
    loop_item_id: Option<String>,
    #[mysql(rename = "loop_item_executions_cloud_project_id")]
    cloud_project_id: Option<String>,
    #[mysql(rename = "loop_item_executions_executor_owner_user_id")]
    executor_owner_user_id: Option<i64>,
    #[mysql(rename = "loop_item_executions_agent_id")]
    agent_id: Option<String>,
    #[mysql(rename = "loop_item_executions_team_id")]
    team_id: Option<i64>,
    #[mysql(rename = "loop_item_executions_backend_task_id")]
    backend_task_id: Option<i64>,
    #[mysql(rename = "loop_item_executions_automation_run_id")]
    automation_run_id: Option<String>,
    #[mysql(rename = "loop_item_executions_execution_environment")]
    execution_environment: Option<String>,
    #[mysql(rename = "loop_item_executions_execution_device_id")]
    execution_device_id: Option<String>,
    #[mysql(rename = "loop_item_executions_runtime_instance_id")]
    runtime_instance_id: Option<String>,
    #[mysql(rename = "loop_item_executions_assigner_user_id")]
    assigner_user_id: Option<i64>,
    #[mysql(rename = "loop_item_executions_status")]
    status: Option<String>,
    #[mysql(rename = "loop_item_executions_priority_weight")]
    priority_weight: Option<i32>,
    #[mysql(rename = "loop_item_executions_queued_at")]
    queued_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_started_at")]
    started_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_completed_at")]
    completed_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_lease_expires_at")]
    lease_expires_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_heartbeat_at")]
    heartbeat_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_claimed_at")]
    claimed_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_start_requested_at")]
    start_requested_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_observed_at")]
    observed_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_cancel_requested_at")]
    cancel_requested_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_attempt_no")]
    attempt_no: Option<i64>,
    #[mysql(rename = "loop_item_executions_previous_execution_id")]
    previous_execution_id: Option<i64>,
    #[mysql(rename = "loop_item_executions_execution_scope")]
    execution_scope: Option<String>,
    #[mysql(rename = "loop_item_executions_observed_state")]
    observed_state: Option<String>,
    #[mysql(rename = "loop_item_executions_sync_state")]
    sync_state: Option<String>,
    #[mysql(rename = "loop_item_executions_last_event_seq")]
    last_event_seq: Option<i64>,
    #[mysql(rename = "loop_item_executions_termination_reason")]
    termination_reason: Option<String>,
    #[mysql(rename = "loop_item_executions_retry_attempt")]
    retry_attempt: Option<i64>,
    #[mysql(rename = "loop_item_executions_error_message")]
    error_message: Option<String>,
    #[mysql(rename = "loop_item_executions_execution_note")]
    execution_note: Option<String>,
    #[mysql(rename = "loop_item_executions_approval_status")]
    approval_status: Option<String>,
    #[mysql(rename = "loop_item_executions_approved_by_user_id")]
    approved_by_user_id: Option<i64>,
    #[mysql(rename = "loop_item_executions_rejected_reason")]
    rejected_reason: Option<String>,
    #[mysql(rename = "loop_item_executions_runtime_device_id")]
    runtime_device_id: Option<String>,
    #[mysql(rename = "loop_item_executions_runtime_task_id")]
    runtime_task_id: Option<String>,
    #[mysql(rename = "loop_item_executions_execution_payload")]
    execution_payload: Option<String>,
    #[mysql(rename = "loop_item_executions_version")]
    version: Option<i32>,
    #[mysql(rename = "loop_item_executions_created_at")]
    created_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_updated_at")]
    updated_at: Option<NaiveDateTime>,
}

impl ExecutionRow {
    /// `LoopItemExecution.execution_intent` then `runtime_selection`: the
    /// stored `execution_payload` decoded as a JSON object; V1 rows stored the
    /// selection dictionary directly, so a non-object `runtime_selection` key
    /// leaves the whole intent as the selection.
    fn runtime_selection(&self) -> Value {
        let intent = self
            .execution_payload
            .as_deref()
            .filter(|payload| !payload.is_empty())
            .and_then(|payload| serde_json::from_str::<Value>(payload).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        match intent.get("runtime_selection") {
            Some(selection) if selection.is_object() => selection.clone(),
            _ => intent,
        }
    }
}

/// `_optional_text(value)`: an empty string is absent.
fn optional_text(value: Option<&str>) -> Option<String> {
    value.filter(|value| !value.is_empty()).map(str::to_string)
}

/// `execution_display_state`: the single user-facing state derived from
/// execution truth.
fn display_state(status: &str, observed_state: Option<&str>, sync_state: Option<&str>) -> String {
    match status {
        "completed" => return "succeeded".to_string(),
        "failed" | "cancelled" => return status.to_string(),
        _ => {}
    }
    if matches!(sync_state, Some("stale" | "diverged")) {
        return "unknown".to_string();
    }
    match status {
        "pending_approval" => "waiting_approval",
        "waiting_runtime" => "waiting_runtime",
        "queued" => "queued",
        "cancel_requested" => "cancelling",
        "claimed" => "starting",
        "running" if observed_state == Some("running") => "running",
        _ => "waiting_runtime",
    }
    .to_string()
}

/// `LoopItemExecution.executor_type`: the configured transport role, otherwise
/// the persisted assignment shape.
fn executor_type(selection: &Value, agent_id: Option<&str>, team_id: Option<i64>) -> String {
    if let Some(kind) = selection.get("executor_kind").and_then(Value::as_str)
        && matches!(kind, "generic_robot" | "collaboration_group_dispatch")
    {
        return kind.to_string();
    }
    if agent_id.is_some() {
        return "project_robot".to_string();
    }
    if team_id.is_some() {
        return "wegent_team".to_string();
    }
    "generic_robot".to_string()
}

/// One `LoopItemExecutionView` row (`app.schemas.project_chat`), in the
/// schema's declaration order. `workspace_id` is a `SnowflakeId`, so a present
/// id serializes as its decimal string.
#[derive(Debug, Serialize)]
struct ExecutionView {
    runner_routing: Option<Value>,
    id: i64,
    workspace_id: Option<String>,
    loop_item_id: String,
    cloud_project_id: String,
    task_title: String,
    task_status: Option<String>,
    task_priority: Option<String>,
    executor_type: String,
    agent_id: Option<String>,
    team_id: Option<i64>,
    backend_task_id: Option<i64>,
    automation_run_id: String,
    executor_owner_user_id: i64,
    assigner_user_id: i64,
    execution_environment: String,
    execution_device_id: Option<String>,
    runtime_instance_id: Option<String>,
    status: String,
    display_state: String,
    observed_state: String,
    sync_state: String,
    priority_weight: i32,
    queued_at: Option<String>,
    started_at: Option<String>,
    completed_at: Option<String>,
    lease_expires_at: Option<String>,
    heartbeat_at: Option<String>,
    claimed_at: Option<String>,
    start_requested_at: Option<String>,
    observed_at: Option<String>,
    cancel_requested_at: Option<String>,
    attempt_no: i32,
    previous_execution_id: Option<i64>,
    execution_scope: String,
    last_event_seq: i64,
    termination_reason: String,
    retry_attempt: i32,
    error_message: String,
    execution_note: String,
    approval_status: Option<String>,
    approved_by_user_id: Option<i64>,
    rejected_reason: Option<String>,
    runtime_device_id: Option<String>,
    runtime_task_id: Option<String>,
    agent_max_concurrent_executions: i32,
    runtime_profile_id: Option<String>,
    runtime_source: Option<String>,
    can_select_runtime: bool,
    waiting_runtime_reason: Option<String>,
    runtime_payload: Option<Value>,
    version: i32,
    created_at: Option<String>,
    updated_at: Option<String>,
}

impl ExecutionView {
    /// Project one queue row. `workspace_id` is the project's column property
    /// (the source re-reads the identity-mapped project row per execution).
    fn project(
        row: &ExecutionRow,
        workspace_id: Option<i64>,
        agent_limits: &HashMap<String, i32>,
        viewer_user_id: i32,
    ) -> Self {
        let selection = row.runtime_selection();
        let routed = selection
            .get("runner_routing")
            .is_some_and(Value::is_object);
        let agent_id = optional_text(row.agent_id.as_deref());
        // `optional_team_id` / `optional_backend_task_id` hide the zero
        // sentinel the table stores for "none".
        let team_id = row.team_id.filter(|value| *value != 0);
        let backend_task_id = row.backend_task_id.filter(|value| *value != 0);
        let status = row.status.clone().unwrap_or_default();
        let executor_owner_user_id = row.executor_owner_user_id.unwrap_or(0);
        let agent_max = row
            .agent_id
            .as_deref()
            .and_then(|id| agent_limits.get(id).copied())
            .unwrap_or(1);
        // `can_select_runtime` and `waiting_runtime_reason` read the status
        // before it moves into the response body.
        let can_select_runtime = executor_owner_user_id == i64::from(viewer_user_id)
            && !routed
            && matches!(status.as_str(), "waiting_runtime" | "queued");
        let waiting_runtime_reason =
            (status == "waiting_runtime").then(|| row.execution_note.clone().unwrap_or_default());
        Self {
            runner_routing: routed.then(|| selection.clone()),
            id: row.id,
            workspace_id: workspace_id
                .filter(|value| *value != 0)
                .map(|value| value.to_string()),
            loop_item_id: row.loop_item_id.clone().unwrap_or_default(),
            cloud_project_id: row.cloud_project_id.clone().unwrap_or_default(),
            task_title: String::new(),
            task_status: None,
            task_priority: None,
            executor_type: executor_type(&selection, agent_id.as_deref(), team_id),
            agent_id,
            team_id,
            backend_task_id,
            automation_run_id: row.automation_run_id.clone().unwrap_or_default(),
            executor_owner_user_id,
            assigner_user_id: row.assigner_user_id.unwrap_or(0),
            execution_environment: row.execution_environment.clone().unwrap_or_default(),
            execution_device_id: optional_text(row.execution_device_id.as_deref()),
            runtime_instance_id: optional_text(row.runtime_instance_id.as_deref()),
            display_state: display_state(
                &status,
                row.observed_state.as_deref(),
                row.sync_state.as_deref(),
            ),
            observed_state: row
                .observed_state
                .clone()
                .unwrap_or_else(|| "unconfirmed".to_string()),
            sync_state: row
                .sync_state
                .clone()
                .unwrap_or_else(|| "pending".to_string()),
            status,
            priority_weight: row.priority_weight.unwrap_or(0),
            queued_at: isoformat_model_unset(row.queued_at),
            started_at: isoformat_model_unset(row.started_at),
            completed_at: isoformat_model_unset(row.completed_at),
            lease_expires_at: isoformat_model_unset(row.lease_expires_at),
            heartbeat_at: isoformat_model_unset(row.heartbeat_at),
            claimed_at: isoformat_model_unset(row.claimed_at),
            start_requested_at: isoformat_model_unset(row.start_requested_at),
            observed_at: isoformat_model_unset(row.observed_at),
            cancel_requested_at: isoformat_model_unset(row.cancel_requested_at),
            attempt_no: row.attempt_no.unwrap_or(1) as i32,
            previous_execution_id: row.previous_execution_id.filter(|value| *value != 0),
            execution_scope: row.execution_scope.clone().unwrap_or_default(),
            last_event_seq: row.last_event_seq.unwrap_or(0),
            termination_reason: row.termination_reason.clone().unwrap_or_default(),
            retry_attempt: row.retry_attempt.unwrap_or(0) as i32,
            error_message: row.error_message.clone().unwrap_or_default(),
            execution_note: row.execution_note.clone().unwrap_or_default(),
            approval_status: optional_text(row.approval_status.as_deref()),
            approved_by_user_id: row.approved_by_user_id.filter(|value| *value != 0),
            rejected_reason: optional_text(row.rejected_reason.as_deref()),
            runtime_device_id: optional_text(row.runtime_device_id.as_deref()),
            runtime_task_id: optional_text(row.runtime_task_id.as_deref()),
            agent_max_concurrent_executions: agent_max,
            runtime_profile_id: selection
                .get("runtime_profile_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            runtime_source: selection
                .get("runtime_source")
                .and_then(Value::as_str)
                .map(str::to_string),
            can_select_runtime,
            waiting_runtime_reason,
            runtime_payload: None,
            version: row.version.unwrap_or(1),
            created_at: isoformat(row.created_at),
            updated_at: isoformat(row.updated_at),
        }
    }

    fn mark_task(&mut self, title: String, status: Option<String>, priority: Option<String>) {
        self.task_title = title;
        self.task_status = status;
        self.task_priority = priority;
    }
}

/// `GET /api/v1/cloud-projects/{project_id}/executions`, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/v1/cloud-projects/:project_id/executions")]
async fn list_executions(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] current_user: crate::auth::SessionUser,
    query: brz_http_server::Query<ExecutionListQuery>,
) -> Result<Value, FastApiError> {
    let project_number = parse_project_id(project_id)?;
    let filters = parse_filters(&query)?;
    executions(state, project_number, current_user.id, &filters).await
}

/// Handler body for the execution queue read.
async fn executions(
    state: &AppState,
    project_number: i64,
    user_id: i32,
    filters: &QueueFilters,
) -> Result<Value, FastApiError> {
    let repository = BoardSnapshotRepository::new(&state.mysql);

    // `require_cloud_project_role(db, project_id, user_id, Viewer)`: the point
    // access statement and its permission-source reads. `check` runs before
    // the project entity read, and the caller's role is compared afterwards.
    let access = repository
        .require_cloud_project_role(project_number, user_id)
        .await
        .map_err(internal)?
        .ok_or_else(cloud_project_not_found)?;

    // `db.get(CloudProject, str(cloud_project_id))`: the entity read that
    // supplies the project's `workspace_id`.
    let project = repository
        .project_entity(project_number)
        .await
        .map_err(internal)?;

    if !has_permission(&access.role, "Viewer") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }
    let Some(project) = project else {
        // A missing entity after a successful access check would raise
        // `AttributeError` in the source's projection.
        return Err(FastApiError::unhandled());
    };
    let workspace_id = project.workspace_id;

    let rows: Vec<ExecutionRow> = state
        .mysql
        .fetch_all(queue_statement(project_number, filters), ())
        .await
        .map_err(internal)?;

    let agent_limits = agent_limits(&state.mysql, &rows).await.map_err(internal)?;
    let mut items: Vec<ExecutionView> = rows
        .iter()
        .map(|row| ExecutionView::project(row, workspace_id, &agent_limits, user_id))
        .collect();

    let project_row = &access.project;
    if matches!(project_row.task_provider().as_str(), "github" | "gitlab") {
        annotate_external_tasks(
            state,
            &mut items,
            project_row,
            project_number,
            &access.role,
            user_id,
        )
        .await?;
    } else {
        annotate_local_tasks(&state.mysql, &mut items, project_row, &access.role, user_id).await?;
    }

    let total = items.len();
    Ok(json!({ "items": items, "total": total }))
}

/// `404 "Cloud project not found"` from `require_cloud_project_role`.
fn cloud_project_not_found() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::NOT_FOUND,
        "Cloud project not found",
    )
}

/// The source's uncaught exception body for a dependency failure.
fn internal(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "execution queue dependency failure");
    FastApiError::unhandled()
}

/// `_agent_limits(db, agent_ids)`: `bot_max_concurrent_executions` for every
/// configured agent of the page. The query is skipped for an empty set.
async fn agent_limits<M: Mysql>(
    mysql: &M,
    rows: &[ExecutionRow],
) -> MysqlResult<HashMap<String, i32>> {
    let agent_ids: BTreeSet<&str> = rows
        .iter()
        .filter_map(|row| row.agent_id.as_deref())
        .filter(|agent_id| !agent_id.is_empty())
        .collect();
    if agent_ids.is_empty() {
        return Ok(HashMap::new());
    }
    #[derive(Debug, FromMysqlRow)]
    struct AgentLimitRow {
        #[mysql(rename = "loop_items_id")]
        id: String,
        #[mysql(rename = "loop_items_metadata")]
        metadata: Option<Json<Value>>,
    }
    let ids = agent_ids
        .iter()
        .map(|agent_id| sql_literal(agent_id))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
         WHERE loop_items.id IN ({ids}) AND loop_items.resource_type IN ('chat_agent')"
    );
    let agents: Vec<AgentLimitRow> = mysql.fetch_all(sql, ()).await?;
    Ok(agents
        .into_iter()
        .map(|agent| {
            let metadata = agent.metadata.as_ref().and_then(|json| json.0.as_object());
            (
                agent.id,
                BotConfig::from_metadata(metadata).max_concurrent_executions(),
            )
        })
        .collect())
}

/// One `loop_items` task row consumed by the display annotation.
#[derive(Debug, FromMysqlRow)]
struct TaskAnnotationRow {
    #[mysql(rename = "loop_items_id")]
    id: String,
    #[mysql(rename = "loop_items_name")]
    name: Option<String>,
    #[mysql(rename = "loop_items_title")]
    title: Option<String>,
    #[mysql(rename = "loop_items_status")]
    status: Option<String>,
    #[mysql(rename = "loop_items_priority")]
    priority: Option<String>,
}

impl TaskAnnotationRow {
    /// `item.title or item.name or ""`.
    fn display_title(&self) -> String {
        self.title
            .clone()
            .filter(|value| !value.is_empty())
            .or_else(|| self.name.clone().filter(|value| !value.is_empty()))
            .unwrap_or_default()
    }
}

/// `db.query(LoopItem).filter(LoopItem.id.in_(item_ids))` with the source's
/// visibility predicate for callers below `Maintainer`.
async fn task_annotation_rows<M: Mysql>(
    mysql: &M,
    item_ids: &[String],
    visibility: Option<&str>,
) -> MysqlResult<Vec<TaskAnnotationRow>> {
    let ids = item_ids
        .iter()
        .map(|item_id| sql_literal(item_id))
        .collect::<Vec<_>>()
        .join(", ");
    let visibility = visibility.unwrap_or_default();
    let sql = format!(
        "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
         WHERE loop_items.id IN ({ids}){visibility} \
         AND loop_items.resource_type IN ('task')"
    );
    mysql.fetch_all(sql, ()).await
}

/// Fills the task display fields from the project's visible task rows and
/// drops executions whose task is not visible to a non-maintainer.
async fn annotate_local_tasks<M: Mysql>(
    mysql: &M,
    items: &mut Vec<ExecutionView>,
    project: &ProjectRow,
    role: &str,
    user_id: i32,
) -> Result<(), FastApiError> {
    let item_ids: Vec<String> = items.iter().map(|item| item.loop_item_id.clone()).collect();
    if item_ids.is_empty() {
        return Ok(());
    }
    let maintainer = has_permission(role, "Maintainer");
    let visibility =
        (!maintainer).then(|| visible_item_filter_sql(user_id, project.default_issue_security()));
    let rows = task_annotation_rows(mysql, &item_ids, visibility.as_deref())
        .await
        .map_err(internal)?;
    let by_id: HashMap<&str, &TaskAnnotationRow> =
        rows.iter().map(|row| (row.id.as_str(), row)).collect();
    if !maintainer {
        items.retain(|item| by_id.contains_key(item.loop_item_id.as_str()));
    }
    for item in items.iter_mut() {
        match by_id.get(item.loop_item_id.as_str()) {
            Some(row) => item.mark_task(
                row.display_title(),
                row.status.clone(),
                row.priority.clone(),
            ),
            None => item.mark_task(String::new(), None, None),
        }
    }
    Ok(())
}

/// `external_loop_item_provider.list(db, project_id, user_id)`: re-run the
/// access check, list the project's provider issues, and retain the visible
/// ones. The source then reads the issue title, status, and priority.
async fn annotate_external_tasks(
    state: &AppState,
    items: &mut Vec<ExecutionView>,
    project: &ProjectRow,
    project_number: i64,
    role: &str,
    user_id: i32,
) -> Result<(), FastApiError> {
    let repository = BoardSnapshotRepository::new(&state.mysql);
    // `external_loop_item_provider.list` calls `require_cloud_project_role`
    // again before listing issues.
    let access = repository
        .require_cloud_project_role(project_number, user_id)
        .await
        .map_err(internal)?
        .ok_or_else(cloud_project_not_found)?;
    if !has_permission(&access.role, "Viewer") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }

    let values = crate::board_snapshot::external_provider::list_issue_values(
        &state.attachment_http,
        &state.auth.jwt_key,
        project,
    )
    .await
    .map_err(|error| {
        FastApiError::detail(
            brz_http_server::StatusCode::BAD_GATEWAY,
            format!(
                "{}{error}",
                crate::board_snapshot::external_provider::PROVIDER_REQUEST_FAILED_PREFIX
            ),
        )
    })?;

    let maintainer = has_permission(role, "Maintainer");
    let mut issues: HashMap<String, (String, String, String)> = HashMap::new();
    for value in values {
        let Ok(issue) = serde_json::from_value::<PageIssue>(value) else {
            continue;
        };
        let response = issue_response(state, project, role, user_id, &issue)
            .await
            .map_err(internal)?;
        let item = response.into_loop_items();
        if item.can_view_detail {
            issues.insert(
                item.id.clone(),
                (
                    item.title.clone(),
                    item.status.clone(),
                    item.priority.clone(),
                ),
            );
        }
    }
    if !maintainer {
        items.retain(|item| issues.contains_key(&item.loop_item_id));
    }
    for item in items.iter_mut() {
        match issues.get(&item.loop_item_id) {
            Some((title, status, priority)) => {
                item.mark_task(title.clone(), Some(status.clone()), Some(priority.clone()))
            }
            None => item.mark_task(String::new(), None, None),
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "executions_tests.rs"]
mod tests;
