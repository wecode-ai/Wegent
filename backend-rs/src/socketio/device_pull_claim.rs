// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `runtime.tasks.pull` candidate selection
//! (`app/services/loop_item_executions/service.py::claim_next_for_device`,
//! `:1477-1538`).
//!
//! The queue read returns every structurally eligible row; the device must
//! still satisfy the per-row claimability check (`_execution_is_claimable_by_device`,
//! `:473-525`): current collaboration authority, the project/environment device
//! set, and either the Runner route (`eligible_runner`) or the Issue's device
//! affinity. Ordinary tasks are compiled before the claim transaction reserves
//! capacity and links the Runtime task to the Issue.

use brz_mysql::{FromMysqlRow, MysqlError, MysqlResult, MysqlTransaction};
use chrono::NaiveDateTime;
use serde_json::{Value, json};

use crate::background_jobs::project::{
    authority, device_access::personal_owner, routing, runner_recovery, store,
};
use crate::background_jobs::robot::{authority as robot_authority, model};
use crate::device_identity::{
    DeviceKindRow, owned_device_identity_ids, resolve_owned_device_alias,
};
use crate::loop_tasks::loop_repository::EXECUTION_COLUMNS;
use crate::sql_support::StatementArg;
use crate::state::AppState;

/// `assignment_pending` compiled by the source's hybrid property. The claim
/// queue applies `= 0` to exclude assignments still being prepared.
pub(super) const ASSIGNMENT_REQUEST_OBJECT_EXPR: &str = "coalesce(lower(json_type(JSON_EXTRACT(JSON_EXTRACT(CASE WHEN (json_valid(loop_item_executions.execution_payload) = 1) THEN loop_item_executions.execution_payload ELSE '{}' END, '$.\"runtime_selection\"'), '$.\"assignment_request\"'))) = 'object', 0)";

/// `uses_runner_routing` compiled by the source's hybrid property.
pub(super) const USES_RUNNER_ROUTING_EXPR: &str = "coalesce(lower(json_type(CASE WHEN (lower(json_type(JSON_EXTRACT(CASE WHEN (json_valid(loop_item_executions.execution_payload) = 1) THEN loop_item_executions.execution_payload ELSE '{}' END, '$.\"runtime_selection\"'))) = 'object') THEN JSON_EXTRACT(JSON_EXTRACT(CASE WHEN (json_valid(loop_item_executions.execution_payload) = 1) THEN loop_item_executions.execution_payload ELSE '{}' END, '$.\"runtime_selection\"'), '$.\"runner_routing\"') ELSE JSON_EXTRACT(CASE WHEN (json_valid(loop_item_executions.execution_payload) = 1) THEN loop_item_executions.execution_payload ELSE '{}' END, '$.\"runner_routing\"') END)) = 'object', 0) = 1";

/// `CAPACITY_STATUSES`: a scope whose previous attempt may still own a
/// Runtime process.
const CAPACITY_STATUSES: &str = "'claimed', 'running', 'cancel_requested'";

/// One queued execution row, decoded from the source's full projection.
#[derive(FromMysqlRow)]
pub(super) struct QueueExecutionRow {
    #[mysql(rename = "loop_item_executions_id")]
    pub id: i64,
    #[mysql(rename = "loop_item_executions_loop_item_id")]
    pub loop_item_id: String,
    #[mysql(rename = "loop_item_executions_cloud_project_id")]
    pub cloud_project_id: String,
    #[mysql(rename = "loop_item_executions_executor_owner_user_id")]
    pub executor_owner_user_id: i64,
    #[mysql(rename = "loop_item_executions_assigner_user_id")]
    pub assigner_user_id: i64,
    #[mysql(rename = "loop_item_executions_agent_id")]
    pub agent_id: String,
    #[mysql(rename = "loop_item_executions_team_id")]
    pub team_id: i64,
    #[mysql(rename = "loop_item_executions_automation_run_id")]
    pub automation_run_id: String,
    #[mysql(rename = "loop_item_executions_execution_environment")]
    pub execution_environment: String,
    #[mysql(rename = "loop_item_executions_execution_device_id")]
    pub execution_device_id: String,
    #[mysql(rename = "loop_item_executions_runtime_device_id")]
    pub runtime_device_id: String,
    #[mysql(rename = "loop_item_executions_runtime_task_id")]
    pub runtime_task_id: String,
    #[mysql(rename = "loop_item_executions_status")]
    pub status: String,
    #[mysql(rename = "loop_item_executions_approval_status")]
    pub approval_status: String,
    #[mysql(rename = "loop_item_executions_execution_payload")]
    pub execution_payload: String,
    #[mysql(rename = "loop_item_executions_error_message")]
    pub error_message: String,
    #[mysql(rename = "loop_item_executions_execution_note")]
    pub execution_note: String,
    #[mysql(rename = "loop_item_executions_version")]
    pub version: i64,
    #[mysql(rename = "loop_item_executions_start_requested_at")]
    pub start_requested_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_completed_at")]
    pub completed_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_execution_scope")]
    pub execution_scope: String,
}

impl QueueExecutionRow {
    /// The durable facts the claimability checks read. Queue status is only
    /// `queued`, so `start_requested_at`/`completed_at` keep the row's values.
    pub(super) fn execution(&self) -> model::Execution {
        model::Execution {
            id: self.id,
            loop_item_id: self.loop_item_id.clone(),
            cloud_project_id: self.cloud_project_id.clone(),
            executor_owner_user_id: self.executor_owner_user_id,
            assigner_user_id: self.assigner_user_id,
            agent_id: self.agent_id.clone(),
            team_id: self.team_id,
            automation_run_id: self.automation_run_id.clone(),
            execution_environment: self.execution_environment.clone(),
            execution_device_id: self.execution_device_id.clone(),
            runtime_device_id: self.runtime_device_id.clone(),
            runtime_task_id: self.runtime_task_id.clone(),
            status: self.status.clone(),
            approval_status: self.approval_status.clone(),
            execution_payload: self.execution_payload.clone(),
            error_message: self.error_message.clone(),
            execution_note: self.execution_note.clone(),
            version: self.version,
            start_requested_at: self.start_requested_at,
            completed_at: self.completed_at,
        }
    }
}

pub(super) struct ClaimPreparation {
    pub(super) runtime_task_id: String,
    pub(super) runtime_turn_id: String,
    pub(super) intent: Value,
    runner: Option<i64>,
}

impl ClaimPreparation {
    pub(super) fn profile_template(task_id: String, execution_id: i64) -> Self {
        Self {
            runtime_turn_id: format!("{task_id}-execution-{execution_id}"),
            runtime_task_id: task_id,
            intent: Value::Null,
            runner: None,
        }
    }

    fn binding_task_id(&self) -> String {
        if self.intent["runtime_selection"]["executor_kind"] == "collaboration_group_dispatch" {
            format!("{}-manager-initial", self.runtime_task_id)
        } else {
            self.runtime_task_id.clone()
        }
    }
}

/// Resolve model identities without persisting credentials. The claim
/// transaction must still revalidate this candidate before reserving it.
pub(super) async fn prepare_candidate(
    app: &AppState,
    row: &QueueExecutionRow,
    owner_user_id: i64,
    execution_target_id: &str,
    runtime_device_id: &str,
) -> anyhow::Result<Option<ClaimPreparation>> {
    let Some(runner) =
        resolve_owned_device_alias(&app.mysql, owner_user_id, execution_target_id).await?
    else {
        return Ok(None);
    };
    let execution = row.execution();
    let mut intent = execution.intent();
    if execution.routed() {
        let route = execution.selection();
        let selected = match routing::runner_model_selection(
            app,
            execution.assigner_user_id,
            &runner.json,
            &route["runner_routing"]["model"],
        )
        .await
        {
            Ok(Some(selected)) => selected,
            Err(error) if robot_authority::infrastructure(&error) => return Err(error),
            Ok(None) | Err(_) => return Ok(None),
        };
        bind_model(&mut intent, route, selected, runner.id, runtime_device_id);
    }
    Ok(Some(claim_preparation(
        execution.id,
        intent,
        Some(runner.id),
    )))
}

fn claim_preparation(execution_id: i64, intent: Value, runner: Option<i64>) -> ClaimPreparation {
    let runtime_task_id = intent["origin_context"]["comment_continue_task_id"]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("codex-queue-{execution_id}"));
    let runtime_turn_id = format!("{runtime_task_id}-execution-{execution_id}");
    ClaimPreparation {
        runtime_task_id,
        runtime_turn_id,
        intent,
        runner,
    }
}

/// Reserve one execution only after its Runtime payload is ready. The Issue
/// lock serializes affinity and capacity with other claims and assignment prep.
pub(super) async fn reserve(
    app: &AppState,
    command: &super::device_pull::PullCommand<'_>,
    candidate: &QueueExecutionRow,
    prepared: &ClaimPreparation,
    canonical_device: &str,
) -> MysqlResult<bool> {
    app.mysql.with_transaction(async |tx| {
        crate::device_records::lock_device_owner(tx, command.owner_user_id).await?;
        let Some(issue) = store::locked(tx, "task", &candidate.loop_item_id).await? else {
            return Ok(false);
        };
        let row: Option<QueueExecutionRow> = tx.fetch_optional(
            format!("SELECT {EXECUTION_COLUMNS} FROM loop_item_executions WHERE id=? FOR UPDATE"),
            (candidate.id,),
        ).await?;
        let Some(row) = row.filter(|row| row.version == candidate.version && row.status == "queued") else {
            return Ok(false);
        };
        let execution = row.execution();
        if execution.assignment_pending() {
            return Ok(false);
        }
        let mut query = &mut *tx;
        let runner = crate::device_identity::resolve_owned_device_alias_on(
            &mut query, command.owner_user_id, command.execution_target_id,
        ).await?;
        let Some(runner) = runner.filter(|runner| Some(runner.id) == prepared.runner) else {
            return Ok(false);
        };
        if runner.json["spec"]["runtimeInstanceId"].as_str() != Some(command.runtime_instance_id) {
            return Ok(false);
        }
        if !robot_authority::authorized_on(app, &mut query, &execution, Some(&issue))
            .await.map_err(claim_error)?
        {
            return Ok(false);
        }
        let environments = authority::execution_environment_ids_on(
            &mut query, &row.cloud_project_id, &row.agent_id,
        ).await.map_err(claim_error)?;
        if !environments.contains(&runner.id)
            && !execution.permits_personal_device(personal_owner(command.owner_user_id, &runner.json), runner.id) {
            return Ok(false);
        }
        if !runner_recovery::session_matches_on(&mut query, &execution, runner.id).await.map_err(claim_error)? {
            return Ok(false);
        }
        let runner_id = runner.id.to_string();
        let binding = match routing::issue_binding_on(&mut query, &issue).await {
            Ok(binding) => binding,
            Err(error) if robot_authority::infrastructure(&error) => return Err(claim_error(error)),
            Err(_) => return Ok(false),
        };
        if let Some(bound) = binding.as_ref()
            && bound != &runner_id
            && !runner_recovery::original_session(&execution)
            && !runner_recovery::permits_on(&mut query, &execution, bound).await.map_err(claim_error)?
        {
            return Ok(false);
        }
        if execution.routed() {
            for (agent, snapshot) in model::runner_routes(&row.agent_id, &execution.selection()) {
                let candidates = routing::candidates_for_snapshot_on(
                    &mut query, &row.cloud_project_id, agent, snapshot,
                    execution.assigner_user_id, execution.automatic(),
                ).await.map_err(claim_error)?;
                if !candidates.contains(&runner.id) {
                    return Ok(false);
                }
            }
        }
        // Recheck the persisted occurrence after authorization under the claim lock.
        if !matches!(
            super::device_pull::workday::check_on(
                &mut query,
                &execution,
                chrono::Utc::now().naive_utc(),
            ).await?,
            Ok(true)
        ) {
            return Ok(false);
        }
        if !row.execution_scope.is_empty() {
            let occupied: Option<(i64,)> = tx.fetch_optional(
                format!("SELECT id FROM loop_item_executions WHERE execution_scope=? AND status IN ({CAPACITY_STATUSES}) LIMIT 1 FOR UPDATE"),
                (row.execution_scope.as_str(),),
            ).await?;
            if occupied.is_some() {
                return Ok(false);
            }
        }
        let updated = tx.execute(
            "UPDATE loop_item_executions SET status='claimed',
             execution_device_id=COALESCE(NULLIF(execution_device_id,''),?),
             execution_environment=?, executor_owner_user_id=?, runtime_device_id=?,
             runtime_instance_id=?, runtime_task_id=?, execution_payload=?,
             claimed_at=UTC_TIMESTAMP(6), heartbeat_at=UTC_TIMESTAMP(6),
             lease_expires_at=DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 300 SECOND),
             version=version+1 WHERE id=? AND status='queued' AND version=?",
            (canonical_device, command.environment, command.owner_user_id,
             command.runtime_device_id, command.runtime_instance_id,
             prepared.runtime_task_id.as_str(), prepared.intent.to_string(),
             row.id, row.version),
        ).await?;
        if updated.rows_affected != 1 {
            return Ok(false);
        }
        if !runner_recovery::original_session(&execution)
            && binding.as_ref() != Some(&runner_id)
        {
            tx.execute(
                "UPDATE loop_items SET metadata=JSON_SET(
                   IF(JSON_TYPE(metadata)='OBJECT',metadata,JSON_OBJECT()),
                   '$.runner_binding', JSON_OBJECT('environment_id', ?))
                 WHERE id=?",
                (runner_id, issue.id.as_str()),
            ).await?;
        }
        bind_issue_task(tx, command, &issue, &row, prepared, canonical_device).await?;
        Ok(true)
    }).await
}

async fn bind_issue_task(
    tx: &mut impl MysqlTransaction,
    command: &super::device_pull::PullCommand<'_>,
    issue: &store::Node,
    row: &QueueExecutionRow,
    prepared: &ClaimPreparation,
    canonical_device: &str,
) -> MysqlResult<()> {
    let task_id = prepared.binding_task_id();
    let existing: Option<(String, String)> = tx.fetch_optional(
        format!("SELECT id, loop_item_id FROM loop_items WHERE resource_type='execution'
                 AND task_user_id=? AND device_id=? AND task_id=? AND {}
                 AND (unlinked_at IS NULL OR unlinked_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))
                 ORDER BY id DESC LIMIT 1 FOR UPDATE", store::LIVE),
        (command.owner_user_id, command.runtime_device_id, task_id.as_str()),
    ).await?;
    let selection = &prepared.intent["runtime_selection"];
    let mut metadata = json!({"workspace_device_id": if row.execution_device_id.is_empty() {
        canonical_device
    } else {
        &row.execution_device_id
    }});
    if selection["model"]
        .as_str()
        .is_some_and(|model| !model.is_empty())
    {
        metadata["model_selection"] = json!({
            "modelName": selection["model"], "modelType": selection["model_type"],
            "options": selection["model_options"]
        });
    }
    if let Some((id, item)) = existing {
        if item != issue.id {
            return Err(MysqlError::InvalidQuery {
                reason: "Runtime task already belongs to another Issue".to_owned(),
            });
        }
        tx.execute(
            "UPDATE loop_items SET task_title=?, metadata=JSON_MERGE_PATCH(
                    IF(JSON_TYPE(metadata)='OBJECT',metadata,JSON_OBJECT()), CAST(? AS JSON))
                    WHERE id=?",
            (issue.title.as_str(), metadata.to_string(), id),
        )
        .await?;
        return Ok(());
    }
    store::insert(
        tx,
        "execution",
        json!({
            "cloud_project_id": issue.cloud_project_id, "loop_item_id": issue.id,
            "task_user_id": command.owner_user_id, "device_id": command.runtime_device_id,
            "task_id": task_id, "task_title": issue.title,
            "linked_by_user_id": command.owner_user_id,
            "linked_at": chrono::Utc::now().naive_utc().format("%Y-%m-%d %H:%M:%S%.6f").to_string(),
            "metadata": metadata
        }),
    )
    .await?;
    Ok(())
}

pub(super) fn redelivery_preparation(row: &QueueExecutionRow) -> Option<ClaimPreparation> {
    if row.runtime_task_id.is_empty() {
        return None;
    }
    Some(ClaimPreparation {
        runtime_task_id: row.runtime_task_id.clone(),
        runtime_turn_id: format!("{}-execution-{}", row.runtime_task_id, row.id),
        intent: row.execution().intent(),
        runner: None,
    })
}

pub(super) async fn renew_redelivery(
    app: &AppState,
    command: &super::device_pull::PullCommand<'_>,
    row: &QueueExecutionRow,
) -> MysqlResult<bool> {
    app.mysql
        .with_transaction(async |tx| {
            let Some(issue) = store::locked(tx, "task", &row.loop_item_id).await? else {
                return Ok(false);
            };
            let mut query = &mut *tx;
            if !robot_authority::authorized_on(app, &mut query, &row.execution(), Some(&issue))
                .await
                .map_err(claim_error)?
            {
                return Ok(false);
            }
            let changed = tx
                .execute(
                    "UPDATE loop_item_executions SET heartbeat_at=UTC_TIMESTAMP(6),
               lease_expires_at=DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 300 SECOND)
             WHERE id=? AND version=? AND status='claimed'
               AND executor_owner_user_id=? AND runtime_device_id=? AND runtime_instance_id=?
               AND (start_requested_at IS NULL OR start_requested_at IN
                    ('1970-01-01 00:00:00','1970-01-01 00:00:01'))",
                    (
                        row.id,
                        row.version,
                        command.owner_user_id,
                        command.runtime_device_id,
                        command.runtime_instance_id,
                    ),
                )
                .await?;
            Ok(changed.rows_affected == 1)
        })
        .await
}

fn claim_error(error: anyhow::Error) -> MysqlError {
    MysqlError::InvalidQuery {
        reason: error.to_string(),
    }
}

fn bind_model(
    intent: &mut Value,
    mut selection: Value,
    selected: Value,
    runner_id: i64,
    runtime_device_id: &str,
) {
    selection["model"] = selected["model"].clone();
    selection["model_type"] = selected["model_type"].clone();
    selection["model_options"] = selected["model_options"].clone();
    selection["resolved_environment_id"] = json!(runner_id.to_string());
    selection["account_label"] = selected["account_label"].clone();
    intent["runtime_selection"] = selection;
    if let Some(request) = intent["runtime_request"].as_object_mut() {
        if !request.is_empty() {
            request.insert("deviceId".into(), json!(runtime_device_id));
            request.insert("modelId".into(), selected["model"].clone());
            request.insert("modelType".into(), selected["model_type"].clone());
            request.insert("modelOptions".into(), selected["model_options"].clone());
            request.insert(
                "modelSelection".into(),
                json!({
                    "modelName": selected["model"],
                    "modelType": selected["model_type"],
                    "options": selected["model_options"],
                }),
            );
        }
        request.shift_remove("modelConfig");
        request.shift_remove("model_config");
    }
}

/// `claim_next_for_device`'s queue read (`prepare_queued_assignments` runs
/// first, then this source filter).
pub(super) async fn queue_rows(
    app: &AppState,
    owner_user_id: i64,
    execution_device_ids: &[String],
    environment: &str,
) -> MysqlResult<Vec<QueueExecutionRow>> {
    queue_rows_with_assignments(app, owner_user_id, execution_device_ids, environment, false).await
}

pub(super) async fn queue_rows_for_catalog_probe(
    app: &AppState,
    owner_user_id: i64,
    execution_device_ids: &[String],
    environment: &str,
) -> MysqlResult<Vec<QueueExecutionRow>> {
    queue_rows_with_assignments(app, owner_user_id, execution_device_ids, environment, true).await
}

async fn queue_rows_with_assignments(
    app: &AppState,
    owner_user_id: i64,
    execution_device_ids: &[String],
    environment: &str,
    include_assignments: bool,
) -> MysqlResult<Vec<QueueExecutionRow>> {
    let placeholders = std::iter::repeat_n("?", execution_device_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = queue_sql(&placeholders, include_assignments);
    let mut args = Vec::with_capacity(execution_device_ids.len() + 2);
    args.push(StatementArg::Int(owner_user_id));
    args.extend(
        execution_device_ids
            .iter()
            .map(|device_id| StatementArg::Str(device_id.clone())),
    );
    args.push(StatementArg::Str(environment.to_owned()));
    app.mysql.fetch_all(sql, args).await
}

fn queue_sql(placeholders: &str, include_assignments: bool) -> String {
    let assignment_filter = if include_assignments {
        String::new()
    } else {
        format!("AND {ASSIGNMENT_REQUEST_OBJECT_EXPR} = 0")
    };
    format!(
        "SELECT {EXECUTION_COLUMNS} \
         FROM loop_item_executions \
         WHERE (loop_item_executions.executor_owner_user_id = ? \
                OR {USES_RUNNER_ROUTING_EXPR}) \
         AND (loop_item_executions.execution_device_id IN ({placeholders}) \
              AND loop_item_executions.execution_environment = ? \
              OR loop_item_executions.execution_device_id = '') \
         AND loop_item_executions.status = 'queued' \
         AND loop_item_executions.execution_environment IN ('local','cloud') \
         AND loop_item_executions.team_id = 0 \
         {assignment_filter} \
         ORDER BY loop_item_executions.priority_weight DESC, \
                  loop_item_executions.queued_at ASC, loop_item_executions.id ASC"
    )
}

/// `_execution_is_claimable_by_device` + `_next_claimable_candidate`: the
/// first priority/FIFO row this device may claim, or `None` when the queue
/// holds no claimable work.
pub(super) async fn select_claimable(
    app: &AppState,
    owner_user_id: i64,
    execution_target_id: &str,
    rows: Vec<QueueExecutionRow>,
) -> anyhow::Result<Option<QueueExecutionRow>> {
    select_candidate(app, owner_user_id, execution_target_id, rows, false).await
}

pub(super) async fn select_catalog_candidate(
    app: &AppState,
    owner_user_id: i64,
    execution_target_id: &str,
    rows: Vec<QueueExecutionRow>,
) -> anyhow::Result<Option<QueueExecutionRow>> {
    select_candidate(app, owner_user_id, execution_target_id, rows, true).await
}

async fn select_candidate(
    app: &AppState,
    owner_user_id: i64,
    execution_target_id: &str,
    rows: Vec<QueueExecutionRow>,
    catalog_probe: bool,
) -> anyhow::Result<Option<QueueExecutionRow>> {
    let mut claimable = Vec::new();
    for row in rows {
        if claimable_by_device(app, owner_user_id, execution_target_id, &row, catalog_probe).await?
            && super::device_pull::workday::eligible(app, &row.execution()).await?
        {
            claimable.push(row);
        }
    }
    let scopes = claimable
        .iter()
        .map(|row| row.execution_scope.clone())
        .filter(|scope| !scope.is_empty())
        .collect::<Vec<_>>();
    let occupied = occupied_execution_scopes(app, &scopes).await?;
    Ok(claimable
        .into_iter()
        .find(|row| row.execution_scope.is_empty() || !occupied.contains(&row.execution_scope)))
}

/// `_execution_is_claimable_by_device` (`service.py:473-525`): current
/// execution authority, the project/environment device set, and then either
/// the Runner route or the Issue's device affinity.
async fn claimable_by_device(
    app: &AppState,
    owner_user_id: i64,
    execution_target_id: &str,
    row: &QueueExecutionRow,
    catalog_probe: bool,
) -> anyhow::Result<bool> {
    let execution = row.execution();
    if (execution.assignment_pending() && !catalog_probe)
        || execution.team_id != 0
        || !matches!(execution.execution_environment.as_str(), "local" | "cloud")
    {
        return Ok(false);
    }
    let runner = resolve_owned_device_alias(&app.mysql, owner_user_id, execution_target_id).await?;
    if !robot_authority::authorized(app, &execution).await? {
        return Ok(false);
    }
    let Some(runner) = runner else {
        return Ok(false);
    };
    // `_execution_is_claimable_by_device`: `execution_environment_ids` reads
    // the project point record and its workspace/project Device grants (plus
    // the Agent's legacy device reference), not the workspace parent
    // aggregate `routing::allowed_devices` starts with.
    let environments =
        authority::execution_environment_ids(app, &row.cloud_project_id, &row.agent_id).await?;
    if !environments.contains(&runner.id)
        && !execution
            .permits_personal_device(personal_owner(owner_user_id, &runner.json), runner.id)
    {
        return Ok(false);
    }
    if execution.routed() {
        // The source re-resolves the runner for the routing branch.
        let runner =
            resolve_owned_device_alias(&app.mysql, owner_user_id, execution_target_id).await?;
        let Some(runner) = runner else {
            return Ok(false);
        };
        return eligible_runner(app, &execution, &runner, catalog_probe).await;
    }
    matches_issue_device_affinity(app, owner_user_id, execution_target_id, &execution).await
}

/// `runner_routing.eligible_runner` (`runner_routing.py:492-528`): the bound
/// Runner wins, then every route's candidate set and cloud model must accept
/// this device.
async fn eligible_runner(
    app: &AppState,
    execution: &model::Execution,
    runner: &DeviceKindRow,
    catalog_probe: bool,
) -> anyhow::Result<bool> {
    if !robot_authority::authorized(app, execution).await? {
        return Ok(false);
    }
    if !runner_recovery::session_matches_on(&mut &app.mysql, execution, runner.id).await? {
        return Ok(false);
    }
    let selection = execution.selection();
    let bound = match load_issue_binding(app, &execution.loop_item_id).await {
        Ok(bound) => bound,
        Err(error) if robot_authority::infrastructure(&error) => return Err(error),
        Err(_) => return Ok(false),
    };
    if let Some(bound) = bound
        && bound != runner.id.to_string()
        && !runner_recovery::original_session(execution)
        && !runner_recovery::permits_on(&mut &app.mysql, execution, &bound).await?
    {
        return Ok(false);
    }
    if let Some(resolved) = selection["resolved_environment_id"].as_str()
        && resolved != runner.id.to_string()
    {
        return Ok(false);
    }
    for (agent_id, route) in model::runner_routes(&execution.agent_id, &selection) {
        let members = if catalog_probe {
            routing::catalog_probe_candidates(
                app,
                &execution.cloud_project_id,
                agent_id,
                route,
                execution.assigner_user_id,
                execution.automatic(),
            )
            .await
        } else {
            routing::candidates_for_snapshot(
                app,
                &execution.cloud_project_id,
                agent_id,
                route,
                execution.assigner_user_id,
                execution.automatic(),
            )
            .await
        };
        let members = match members {
            Ok(members) => members,
            Err(error) if robot_authority::infrastructure(&error) => return Err(error),
            Err(_) => return Ok(false),
        };
        if !members.contains(&runner.id) {
            return Ok(false);
        }
        if catalog_probe {
            continue;
        }
        match routing::runner_model_selection(
            app,
            execution.assigner_user_id,
            &runner.json,
            &route["model"],
        )
        .await
        {
            Ok(Some(_)) => {}
            Err(error) if robot_authority::infrastructure(&error) => return Err(error),
            Ok(None) | Err(_) => return Ok(false),
        }
    }
    Ok(true)
}

/// `_matches_issue_device_affinity` (`service.py:436-470`): an Issue keeps
/// running on its bound Runner, else on the device that claimed it last.
async fn matches_issue_device_affinity(
    app: &AppState,
    owner_user_id: i64,
    execution_target_id: &str,
    execution: &model::Execution,
) -> anyhow::Result<bool> {
    if runner_recovery::original_session(execution) {
        let runner =
            resolve_owned_device_alias(&app.mysql, owner_user_id, execution_target_id).await?;
        let Some(runner) = runner else {
            return Ok(false);
        };
        return runner_recovery::session_matches_on(&mut &app.mysql, execution, runner.id).await;
    }
    let bound = match load_issue_binding(app, &execution.loop_item_id).await {
        Ok(bound) => bound,
        Err(error) if robot_authority::infrastructure(&error) => return Err(error),
        Err(_) => return Ok(false),
    };
    if let Some(bound) = bound {
        let runner =
            resolve_owned_device_alias(&app.mysql, owner_user_id, execution_target_id).await?;
        return Ok(runner.is_some_and(|runner| runner.id.to_string() == bound));
    }
    let affinity_device_id =
        issue_runtime_device(app, &execution.loop_item_id, execution.id).await?;
    if affinity_device_id.is_empty() {
        return Ok(true);
    }
    same_runtime_device(app, owner_user_id, &affinity_device_id, execution_target_id).await
}

/// `runner_routing.issue_binding` (`runner_routing.py:211-216`): the Issue
/// row's historical Runner binding, when one exists.
async fn load_issue_binding(app: &AppState, loop_item_id: &str) -> anyhow::Result<Option<String>> {
    let Some(issue) = store::get(&app.mysql, "task", loop_item_id).await? else {
        return Ok(None);
    };
    routing::issue_binding(app, &issue).await
}

/// `_issue_runtime_device` (`service.py:414-433`): the latest device that
/// claimed this Issue, excluding the row under test.
async fn issue_runtime_device(
    app: &AppState,
    loop_item_id: &str,
    exclude_execution_id: i64,
) -> MysqlResult<String> {
    #[derive(FromMysqlRow)]
    struct Row {
        #[mysql(rename = "loop_item_executions_runtime_device_id")]
        runtime_device_id: String,
    }
    let row: Option<Row> = app
        .mysql
        .fetch_optional(
            format!(
                "SELECT {EXECUTION_COLUMNS} \
                 FROM loop_item_executions \
                 WHERE loop_item_executions.loop_item_id = ? \
                 AND loop_item_executions.id != ? \
                 AND loop_item_executions.runtime_device_id != '' \
                 ORDER BY loop_item_executions.id DESC \
                 LIMIT 1"
            ),
            (loop_item_id, exclude_execution_id),
        )
        .await?;
    Ok(row.map(|row| row.runtime_device_id).unwrap_or_default())
}

/// `_same_runtime_device` (`service.py:164-187`): the two Runtime identities
/// name one device when their alias sets intersect.
pub(super) async fn same_runtime_device(
    app: &AppState,
    owner_user_id: i64,
    left_device_id: &str,
    right_device_id: &str,
) -> anyhow::Result<bool> {
    let left = owned_device_identity_ids(&app.mysql, owner_user_id, left_device_id).await?;
    let right = owned_device_identity_ids(&app.mysql, owner_user_id, right_device_id).await?;
    Ok(left.iter().any(|id| right.contains(id)))
}

/// `_occupied_execution_scopes` (`service.py:348-365`): scopes whose previous
/// attempt may still own a Runtime process. An empty scope set skips the read.
async fn occupied_execution_scopes(
    app: &AppState,
    execution_scopes: &[String],
) -> MysqlResult<Vec<String>> {
    if execution_scopes.is_empty() {
        return Ok(Vec::new());
    }
    #[derive(FromMysqlRow)]
    struct Row {
        #[mysql(rename = "loop_item_executions_execution_scope")]
        execution_scope: String,
    }
    let placeholders = std::iter::repeat_n("?", execution_scopes.len())
        .collect::<Vec<_>>()
        .join(",");
    let args = execution_scopes
        .iter()
        .map(|scope| StatementArg::Str(scope.clone()))
        .collect::<Vec<_>>();
    let rows: Vec<Row> = app
        .mysql
        .fetch_all(occupied_scopes_sql(&placeholders), args)
        .await?;
    Ok(rows.into_iter().map(|row| row.execution_scope).collect())
}

fn occupied_scopes_sql(placeholders: &str) -> String {
    format!(
        "SELECT loop_item_executions.execution_scope \
         AS loop_item_executions_execution_scope \
         FROM loop_item_executions \
         WHERE loop_item_executions.status IN ({CAPACITY_STATUSES}) \
         AND loop_item_executions.execution_scope != '' \
         AND loop_item_executions.execution_scope IN ({placeholders})"
    )
}

#[cfg(test)]
#[path = "device_pull_claim_tests.rs"]
mod tests;
