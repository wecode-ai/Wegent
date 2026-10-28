// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `persist_completed_result` and the task-status update it triggers
//! (`app/services/chat/storage/db.py`, `app/services/chat/trigger/lifecycle.py`).
use brz_mysql::{FromMysqlCol, Json, Mysql, MysqlRow, MysqlTransaction};
use brz_redis::Redis;
use chrono::NaiveDateTime;
use serde_json::{Map, Value};

use super::Completion;
use super::sql;
use super::task_column;
use crate::internal_callback::py_json::python_dumps;
use crate::internal_callback::session;
use crate::task_store::subtask_column_index;

#[path = "persist_status.rs"]
mod persist_status;
#[path = "persist_terminal.rs"]
mod persist_terminal;
#[cfg(test)]
pub(crate) use persist_status::read_status;
pub(crate) use persist_status::update_task_status_on;
use persist_terminal::update_subtask_status_on;

/// `TaskStatus`'s field order (`app/schemas/kind.py`), used to render the task
/// CRD's `status` object the way `model_dump(mode="json")` does.
const TASK_STATUS_ORDER: [&str; 12] = [
    "state",
    "message",
    "status",
    "progress",
    "result",
    "errorMessage",
    "createdAt",
    "updatedAt",
    "completedAt",
    "subTasks",
    "app",
    "archive",
];

/// The `Task` CRD's top-level field order (`app/schemas/kind.py`).
const TASK_CRD_ORDER: [&str; 5] = ["apiVersion", "kind", "metadata", "spec", "status"];

/// `TaskMetadata`'s field order.
const TASK_METADATA_ORDER: [&str; 4] = ["name", "namespace", "displayName", "labels"];

/// `TaskSpec`'s field order.
const TASK_SPEC_ORDER: [&str; 12] = [
    "title",
    "prompt",
    "teamRef",
    "workspaceRef",
    "is_group_chat",
    "knowledgeBaseRefs",
    "knowledgeBaseScopes",
    "externalKnowledgeRefs",
    "device_id",
    "execution",
    "fork",
    "currentStage",
];

/// The `status.result` model's field order (`SubtaskResult`).
const TASK_RESULT_ORDER: [&str; 18] = [
    "usage",
    "value",
    "blocks",
    "sources",
    "silent_exit",
    "stop_reason",
    "file_changes",
    "loaded_skills",
    "messages_chain",
    "context_metrics",
    "executor_session",
    "reasoning_content",
    "retrieval_summary",
    "silent_exit_reason",
    "context_compactions",
    "deferred_user_input",
    "standalone_chat_workspace_path",
    "deferred_user_input_tool_use_id",
];

fn subtask_column<T: FromMysqlCol>(row: &MysqlRow, column: &str) -> Option<T> {
    let index = subtask_column_index(column)?;
    row.get_at::<Option<T>>(index).ok().flatten()
}

/// `Task.model_dump(mode="json")` (`app/schemas/kind.py:153-168,851-948`)
/// fills every omitted optional field with its default. The stored create
/// payload omits them, so the status update has to add them before rendering
/// the CRD the way the source does.
fn complete_task_model(payload: &mut Map<String, Value>) {
    if let Some(Value::Object(metadata)) = payload.get_mut("metadata") {
        // `ObjectMeta.displayName` / `ObjectMeta.labels`
        metadata.entry("displayName").or_insert(Value::Null);
        metadata.entry("labels").or_insert(Value::Null);
    }
    if let Some(Value::Object(spec)) = payload.get_mut("spec") {
        spec.entry("knowledgeBaseRefs").or_insert(Value::Null);
        spec.entry("knowledgeBaseScopes").or_insert(Value::Null);
        spec.entry("externalKnowledgeRefs")
            .or_insert_with(|| Value::Array(Vec::new()));
        spec.entry("device_id").or_insert(Value::Null);
        spec.entry("execution").or_insert(Value::Null);
        spec.entry("fork").or_insert(Value::Null);
        spec.entry("currentStage").or_insert(Value::Null);
    }
    if let Some(Value::Object(status)) = payload.get_mut("status") {
        // `Status.message` and `TaskStatus.subTasks`/`app`/`archive`.
        status.entry("message").or_insert(Value::Null);
        status.entry("subTasks").or_insert(Value::Null);
        status.entry("app").or_insert(Value::Null);
        status.entry("archive").or_insert(Value::Null);
    }
}

/// Re-render one task CRD document the way `Task.model_dump(mode="json")` does.
///
/// The source validates the stored document into its pydantic models and dumps
/// them again, so the written key order is the model's field order rather than
/// whatever order the row happened to hold.
fn render_task_crd(payload: Map<String, Value>) -> Map<String, Value> {
    let mut out = reorder(&payload, &TASK_CRD_ORDER);
    if let Some(Value::Object(metadata)) = out.get("metadata").cloned() {
        out.insert(
            "metadata".into(),
            Value::Object(reorder(&metadata, &TASK_METADATA_ORDER)),
        );
    }
    if let Some(Value::Object(spec)) = out.get("spec").cloned() {
        out.insert(
            "spec".into(),
            Value::Object(reorder(&spec, &TASK_SPEC_ORDER)),
        );
    }
    if let Some(Value::Object(status)) = out.get("status").cloned() {
        let mut status = reorder(&status, &TASK_STATUS_ORDER);
        if let Some(Value::Object(result)) = status.get("result").cloned() {
            status.insert(
                "result".into(),
                Value::Object(reorder(&result, &TASK_RESULT_ORDER)),
            );
        }
        out.insert("status".into(), Value::Object(status));
    }
    out
}

/// Re-render an object with `order` first, then any remaining keys in their
/// original order.
fn reorder(object: &Map<String, Value>, order: &[&str]) -> Map<String, Value> {
    let mut out = Map::new();
    for key in order {
        if let Some(value) = object.get(*key) {
            out.insert((*key).to_string(), value.clone());
        }
    }
    for (key, value) in object {
        if !out.contains_key(key) {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

/// `persist_completed_result`: persist the terminal subtask state, update the
/// task's status, then clean the streaming state up.
///
/// Returns whether the status update produced the source's
/// `PipelineAutoAdvanceIntent`, which `update_subtask_status` awaits before the
/// wrapped emitter publishes its terminal frames.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn persist_completed_result<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    task_id: i64,
    subtask_id: i64,
    status: &str,
    result: Option<&Value>,
    error: Option<&str>,
    executor_name: Option<&str>,
    executor_namespace: Option<&str>,
) -> bool {
    let normalized_status = status.to_uppercase();
    let mut auto_advance = false;
    if let Some(owner_task_id) = update_subtask_status(
        ctx,
        subtask_id,
        &normalized_status,
        result,
        error,
        executor_name,
        executor_namespace,
    )
    .await
    {
        auto_advance = update_task_status(ctx, owner_task_id, subtask_id).await;
    }
    if normalized_status == "COMPLETED" {
        persist_standalone_workspace_path(ctx, task_id, result).await;
    }
    if let Err(failure) =
        session::cleanup_streaming_state(ctx.redis, subtask_id, Some(task_id)).await
    {
        tracing::warn!(%failure, "callback streaming cleanup failed");
    }
    auto_advance
}

/// `_update_subtask_sync`: rewrite the subtask's terminal fields. Returns the
/// subtask's task id so the caller can update the task, or `None` when the row
/// is missing.
#[allow(clippy::too_many_arguments)]
async fn update_subtask_status<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    subtask_id: i64,
    status: &str,
    result: Option<&Value>,
    error: Option<&str>,
    executor_name: Option<&str>,
    executor_namespace: Option<&str>,
) -> Option<i64> {
    let mysql = ctx
        .mysql
        .route(crate::task_routing::ByTaskId(subtask_id as u64));
    let updated = mysql
        .with_transaction(async |transaction| {
            Ok(update_subtask_status_on(
                ctx,
                transaction,
                subtask_id,
                status,
                result,
                error,
                executor_name,
                executor_namespace,
            )
            .await)
        })
        .await
        .ok()
        .flatten()?;
    let (owner_task_id, row, metrics_message) = updated;
    publish_task_run_metrics(ctx, &row, subtask_id, status, metrics_message).await;
    Some(owner_task_id)
}

/// `TaskRunMetricHooks._after_commit` (`app/services/task_run_metric_hooks.py:157-175`):
/// a committed assistant-subtask mutation publishes the task-run metrics. The
/// hook logs and swallows a store failure, so a Redis error leaves the caller's
/// committed result intact.
async fn publish_task_run_metrics<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    row: &MysqlRow,
    subtask_id: i64,
    status: &str,
    message: Option<String>,
) {
    let Some(event) = subtask_metric_event(
        subtask_column::<String>(row, "role").as_deref(),
        subtask_column::<NaiveDateTime>(row, "created_at"),
        subtask_id,
        status,
        message,
    ) else {
        return;
    };
    if let Err(failure) =
        crate::task_run_metrics::record_events(ctx.redis, std::slice::from_ref(&event)).await
    {
        tracing::warn!(%failure, "task run metrics publish failed");
    }
}

/// The `TaskRunMetricEvent` one committed subtask status change produces.
///
/// `_before_flush` tracks assistant subtasks only and this flow never changes a
/// subtask's role, so the committed role is the tracked role. The update path
/// modifies an existing subtask, so it never records the id in the run totals,
/// while a status change always syncs the failure aggregates.
fn subtask_metric_event(
    role: Option<&str>,
    created_at: Option<NaiveDateTime>,
    subtask_id: i64,
    status: &str,
    message: Option<String>,
) -> Option<crate::task_run_metrics::SubtaskMetricEvent> {
    if role != Some("ASSISTANT") {
        return None;
    }
    Some(crate::task_run_metrics::SubtaskMetricEvent {
        subtask_id,
        created_at: created_at?,
        failed: status == "FAILED",
        state_changed_at: super::handlers::now_local(),
        message,
        record_total: false,
        sync_failure: true,
    })
}

/// The statements `_update_subtask_sync` issues, in recorded order: the
/// `subtask_store.get_by_id` read of the assistant subtask (whose
/// `subqueryload(Subtask.contexts)` is the second read), then the status-only
/// flush. `ctx.tables` carries the deployment's `{{subtasks}}` template so the
/// first statement renders the task's shard, exactly like the recorded
/// `subtasks_0711` read.
///
/// Exposed so the create path's focused test can pin the read and its position
/// without a database.
pub(crate) fn running_transition_statements(tables: sql::Tables) -> [String; 3] {
    [
        sql::subtask_by_id(tables),
        sql::contexts_by_subtask(),
        sql::update_subtask_running(tables),
    ]
}

/// `ExecutionDispatcher._update_subtask_to_running`
/// (`app/services/execution/dispatcher.py:335-355`, called before the mode
/// branch at `:166`): `db_handler.update_subtask_status(subtask_id, "RUNNING")`
/// reads the subtask with its contexts, writes the status-only flush, commits
/// (publishing the after-commit run metrics), then re-derives the Task CRD
/// status in a second session.
pub(crate) async fn mark_subtask_running<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    subtask_id: i64,
) {
    let [read_subtask, read_contexts, update_running] = running_transition_statements(ctx.tables);
    let mysql = ctx
        .mysql
        .route(crate::task_routing::ByTaskId(subtask_id as u64));
    let row: Option<MysqlRow> = mysql
        .fetch_optional(read_subtask, (subtask_id,))
        .await
        .ok()
        .flatten();
    // `_update_subtask_sync`'s `if not subtask: return None`: a vanished row
    // ends the transition without an error, a write, or after-commit metrics.
    let Some(row) = row else {
        return;
    };
    // `SubtaskStore.get_by_id` eager-loads `Subtask.contexts`.
    let _contexts: Vec<MysqlRow> = mysql
        .fetch_all(read_contexts, (subtask_id,))
        .await
        .unwrap_or_default();
    let task_id = subtask_column::<i64>(&row, "task_id").unwrap_or(0);
    let now = local_datetime();
    // A single statement runs on the pooled connection's autocommit; no
    // explicit transaction or COMMIT is needed.
    if let Err(failure) = mysql
        .execute(update_running, ("RUNNING", now.as_str(), subtask_id))
        .await
    {
        tracing::warn!(%failure, "subtask running update failed");
        return;
    }
    // `_before_flush` tracks the status change (`record_total=False`,
    // `sync_failure=True`) and `_after_commit` publishes it. A RUNNING subtask
    // carries no error message, so the failure reason is empty.
    publish_task_run_metrics(ctx, &row, subtask_id, "RUNNING", None).await;
    update_task_status(ctx, task_id, subtask_id).await;
}

/// `_update_task_status_sync`: re-derive the task's status from its assistant
/// subtasks and rewrite the task CRD. Returns the source's auto-advance
/// decision; a failed transaction carries no intent, matching the source's
/// `try/except` around the whole block.
pub(crate) async fn update_task_status<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    task_id: i64,
    changed_subtask_id: i64,
) -> bool {
    let mysql = ctx
        .mysql
        .route(crate::task_routing::ByTaskId(task_id as u64));
    match mysql
        .with_transaction(async |transaction| {
            Ok(update_task_status_on(ctx, transaction, task_id, changed_subtask_id).await)
        })
        .await
    {
        Ok(auto_advance) => auto_advance,
        Err(error) => {
            tracing::error!(%error, "callback task status transaction failed");
            false
        }
    }
}

/// The collaboration strategy's two decisions for one completion:
/// `get_task_status_on_subtask_complete` renders the status, and
/// `get_auto_advance_info` decides whether `_update_task_status_sync` schedules
/// the next pipeline turn (`app/services/adapters/collaboration_strategy.py`).
struct CollaborationStatus {
    status: String,
    progress: Option<i64>,
    auto_advance: bool,
}

/// `CollaborationStrategyFactory.get_strategy_for_task` plus
/// `get_task_status_on_subtask_complete` and `get_auto_advance_info`.
async fn collaboration_status<M: Mysql, R: Redis, T: MysqlTransaction>(
    ctx: &Completion<'_, M, R>,
    mysql: &mut T,
    task_id: i64,
    payload: &Map<String, Value>,
    subtask: &MysqlRow,
    subtask_status: &str,
) -> Option<CollaborationStatus> {
    // `get_regular_active_task`: the exact task read the factory issues. Its
    // outcome decides whether the factory reads the task's Team at all.
    let regular_task_found = mysql
        .fetch_optional::<_, _, MysqlRow>(
            sql::regular_active_task_statement(ctx.tables.tasks),
            (task_id,),
        )
        .await
        .map(|row| row.is_some())
        .unwrap_or(false);

    let team = strategy_team(mysql, regular_task_found, payload).await;

    // `PipelineCollaborationStrategy`: a stage that requires confirmation holds
    // the task at `PENDING_CONFIRMATION` instead of completing it. Only this
    // strategy auto-advances; every other collaboration model returns `None`
    // from `get_auto_advance_info` without further reads.
    let pipeline = team
        .as_ref()
        .and_then(|team| team.pointer("/spec/collaborationModel"))
        .and_then(Value::as_str)
        == Some("pipeline");
    if subtask_status == "COMPLETED"
        && pipeline
        && let Some(team) = team.as_ref()
        && let Some(bot_id) = subtask_column::<Json<Value>>(subtask, "bot_ids")
            .and_then(|ids| ids.0.as_array()?.first()?.as_i64())
    {
        let bot: Option<(String, String)> = mysql
            .fetch_optional(
                "SELECT kinds.name, kinds.namespace FROM kinds WHERE kinds.id = ? \
                 AND kinds.kind = 'Bot' AND kinds.is_active = true LIMIT 1",
                (bot_id,),
            )
            .await
            .ok()
            .flatten();
        if let Some((name, namespace)) = bot {
            let stage = stage_decision(payload, team, &name, &namespace);
            if stage.requires_confirmation {
                return Some(CollaborationStatus {
                    status: "PENDING_CONFIRMATION".to_string(),
                    progress: Some(100),
                    auto_advance: false,
                });
            }
            return Some(CollaborationStatus {
                status: "COMPLETED".to_string(),
                progress: Some(100),
                auto_advance: stage.auto_advance,
            });
        }
    }
    // `DefaultCollaborationStrategy.get_task_status_on_subtask_complete`: map
    // the subtask status directly, defaulting to the subtask status itself.
    let (status, progress) = match subtask_status {
        "COMPLETED" => ("COMPLETED".to_string(), Some(100)),
        "CANCELLED" => ("CANCELLED".to_string(), Some(100)),
        "FAILED" => ("FAILED".to_string(), None),
        "RUNNING" => ("RUNNING".to_string(), None),
        other => (other.to_string(), None),
    };
    Some(CollaborationStatus {
        status,
        progress,
        auto_advance: false,
    })
}

/// `CollaborationStrategyFactory.get_strategy_for_task`'s team read
/// (`app/services/adapters/collaboration_strategy.py:405-440`).
///
/// The factory answers `DefaultCollaborationStrategy` as soon as
/// `get_regular_active_task` finds no row, before `_get_team_from_task_ref` can
/// read `kinds`; a task outside the regular active state (a subscription task,
/// whose `is_active` is not the single active state) therefore issues no Team
/// read at all. The ref's `user_id` is what `_get_team_from_task_ref` keys the
/// read on, so a ref without one resolves no team either.
async fn strategy_team<T: MysqlTransaction>(
    mysql: &mut T,
    regular_task_found: bool,
    payload: &Map<String, Value>,
) -> Option<Value> {
    if !regular_task_found {
        return None;
    }
    let team_ref = payload
        .get("spec")
        .and_then(|spec| spec.get("teamRef"))
        .and_then(Value::as_object)?;
    let name = team_ref
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let namespace = team_ref
        .get("namespace")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let owner = team_ref.get("user_id").and_then(Value::as_i64)?;
    let team: Option<MysqlRow> = mysql
        .fetch_optional(sql::team_by_owner(), (owner, namespace, name))
        .await
        .ok()
        .flatten();
    team.and_then(|row| row.get::<Json<Value>>("kinds_json").ok().flatten())
        .map(|json| json.0)
}

/// `PipelineCollaborationStrategy._should_require_confirmation` and the
/// `get_auto_advance_info` gate, resolved from the same member list.
struct StageDecision {
    requires_confirmation: bool,
    auto_advance: bool,
}

fn stage_decision(
    payload: &Map<String, Value>,
    team: &Value,
    bot_name: &str,
    bot_namespace: &str,
) -> StageDecision {
    let none = StageDecision {
        requires_confirmation: false,
        auto_advance: false,
    };
    let Some(members) = team.pointer("/spec/members").and_then(Value::as_array) else {
        return none;
    };
    if members.is_empty() {
        return none;
    }
    let Some(current_stage) = current_stage(payload) else {
        return none;
    };
    if current_stage >= members.len() {
        return none;
    }
    // A completion whose bot belongs to an older stage is stale: the source
    // skips both the confirmation check and the auto-advance for it.
    let matched = member_stage(members, bot_name, bot_namespace);
    if matched.is_some_and(|stage| stage != current_stage) {
        return none;
    }
    let current_requires = members[current_stage]
        .get("requireConfirmation")
        .and_then(Value::as_bool)
        == Some(true);
    let has_next = current_stage + 1 < members.len();
    StageDecision {
        // `should_set_pending_confirmation_on_complete` needs the completed
        // bot to resolve to the current stage.
        requires_confirmation: matched == Some(current_stage) && current_requires && has_next,
        // `get_auto_advance_info` then only re-checks the current member.
        auto_advance: !current_requires && has_next,
    }
}

/// `task_crd.spec.currentStage` with the source's `None -> 0` default.
fn current_stage(payload: &Map<String, Value>) -> Option<usize> {
    match payload
        .get("spec")
        .and_then(|spec| spec.get("currentStage"))
    {
        None | Some(Value::Null) => Some(0),
        Some(value) => value.as_u64().and_then(|stage| usize::try_from(stage).ok()),
    }
}

/// The member whose `botRef` names the bot that completed the stage.
fn member_stage(members: &[Value], bot_name: &str, bot_namespace: &str) -> Option<usize> {
    members.iter().position(|member| {
        member.pointer("/botRef/name").and_then(Value::as_str) == Some(bot_name)
            && member
                .pointer("/botRef/namespace")
                .and_then(Value::as_str)
                .unwrap_or("default")
                == bot_namespace
    })
}

/// `_persist_standalone_workspace_path`: store a local executor's standalone
/// chat workspace path on the task CRD.
async fn persist_standalone_workspace_path<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    task_id: i64,
    result: Option<&Value>,
) {
    let Some(path) = result
        .and_then(|value| value.get("standalone_chat_workspace_path"))
        .filter(|value| !value.is_null())
        .cloned()
    else {
        return;
    };
    let mysql = ctx
        .mysql
        .route(crate::task_routing::ByTaskId(task_id as u64));
    let task: Option<MysqlRow> = mysql
        .fetch_optional(sql::active_task_statement(ctx.tables.tasks), (task_id,))
        .await
        .ok()
        .flatten();
    let Some(task) = task else {
        return;
    };
    let Some(Value::Object(mut payload)) =
        task_column::<Json<Value>>(&task, "json").map(|json| json.0)
    else {
        return;
    };
    match payload
        .entry("spec")
        .or_insert_with(|| Value::Object(Map::new()))
    {
        Value::Object(spec) => {
            spec.insert("standaloneChatWorkspacePath".into(), path);
        }
        _ => return,
    }
    let json_text = python_dumps(&Value::Object(render_task_crd(payload)));
    let now = local_datetime();
    let sql = sql::update_task_json_statement(ctx.tables.tasks);
    let _ = mysql.execute(sql, (json_text, now, task_id)).await;
}

/// `datetime.now()` in the `DATETIME(6)` form the source binds to its columns.
fn local_datetime() -> String {
    chrono::Local::now()
        .naive_local()
        .format("%Y-%m-%d %H:%M:%S%.6f")
        .to_string()
}

/// `datetime.now().isoformat()`: microsecond precision, no offset.
fn local_isoformat() -> String {
    chrono::Local::now()
        .naive_local()
        .format("%Y-%m-%dT%H:%M:%S%.6f")
        .to_string()
}

#[cfg(test)]
#[path = "collaboration_team_tests.rs"]
mod collaboration_team_tests;

#[cfg(test)]
#[path = "persist_status_read_tests.rs"]
mod persist_status_read_tests;

#[cfg(test)]
#[path = "persist_running_tests.rs"]
mod persist_running_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pipeline_confirmation_uses_the_completed_bots_current_nonfinal_stage() {
        let team = json!({"spec": {"members": [
            {"botRef": {"name": "first", "namespace": "default"}, "requireConfirmation": true},
            {"botRef": {"name": "second", "namespace": "default"}, "requireConfirmation": true}
        ]}});
        let task = |stage: Value| {
            json!({"spec": {"currentStage": stage}})
                .as_object()
                .unwrap()
                .clone()
        };
        let requires = |task: &Map<String, Value>, bot: &str, namespace: &str| {
            stage_decision(task, &team, bot, namespace).requires_confirmation
        };
        assert!(requires(&task(json!(0)), "first", "default"));
        assert!(!requires(&task(json!(1)), "second", "default"));
        assert!(!requires(&task(json!(1)), "first", "default"));
        assert!(!requires(&task(json!(0)), "missing", "default"));
        assert!(!requires(&task(json!(0)), "first", "other"));
        assert!(requires(&task(Value::Null), "first", "default"));
        let mut automatic = team.clone();
        automatic["spec"]["members"][0]["requireConfirmation"] = json!(false);
        assert!(
            !stage_decision(&task(json!(0)), &automatic, "first", "default").requires_confirmation
        );
    }

    /// `get_auto_advance_info` only produces an intent for a non-final current
    /// stage that needs no confirmation, and never for a stale completion.
    #[test]
    fn pipeline_auto_advance_requires_a_current_nonfinal_stage() {
        let team = json!({"spec": {"members": [
            {"botRef": {"name": "first", "namespace": "default"}, "requireConfirmation": false},
            {"botRef": {"name": "second", "namespace": "default"}, "requireConfirmation": false}
        ]}});
        let task = |stage: Value| {
            json!({"spec": {"currentStage": stage}})
                .as_object()
                .unwrap()
                .clone()
        };
        let advances = |task: &Map<String, Value>, bot: &str| {
            stage_decision(task, &team, bot, "default").auto_advance
        };
        assert!(advances(&task(json!(0)), "first"));
        assert!(!advances(&task(json!(1)), "second"));
        assert!(!advances(&task(json!(1)), "first"));
        let mut final_team = team.clone();
        final_team["spec"]["members"] = json!([
            {"botRef": {"name": "only", "namespace": "default"}, "requireConfirmation": false}
        ]);
        assert!(!stage_decision(&task(json!(0)), &final_team, "only", "default").auto_advance);
    }

    /// `_before_flush` tracks assistant subtasks: a user subtask, an untracked
    /// row, and a missing creation stamp publish nothing.
    #[test]
    fn only_assistant_subtask_changes_produce_a_metric_event() {
        let created = chrono::NaiveDate::from_ymd_opt(2026, 10, 16)
            .expect("valid date")
            .and_hms_opt(10, 56, 4)
            .expect("valid time");
        assert!(subtask_metric_event(Some("USER"), Some(created), 7, "COMPLETED", None).is_none());
        assert!(subtask_metric_event(Some("ASSISTANT"), None, 7, "COMPLETED", None).is_none());
        let event = subtask_metric_event(
            Some("ASSISTANT"),
            Some(created),
            7,
            "FAILED",
            Some("boom".to_string()),
        )
        .expect("assistant subtask recorded");
        assert_eq!(event.subtask_id, 7);
        assert_eq!(event.created_at, created);
        assert!(event.failed);
        assert!(event.sync_failure);
        assert!(!event.record_total);
        assert_eq!(event.message.as_deref(), Some("boom"));
    }

    #[test]
    fn task_crd_is_rendered_in_the_model_field_order() {
        let stored = json!({
            "status": {"progress": 100, "state": "Available", "status": "COMPLETED"},
            "apiVersion": "agent.wecode.io/v1",
            "spec": {"fork": null, "title": "t", "prompt": "p"},
            "kind": "Task",
            "metadata": {"labels": {"source": "chat_shell"}, "name": "task-1", "namespace": "default"},
        });
        let rendered = render_task_crd(stored.as_object().unwrap().clone());
        assert_eq!(
            python_dumps(&Value::Object(rendered)),
            "{\"apiVersion\": \"agent.wecode.io/v1\", \"kind\": \"Task\", \
             \"metadata\": {\"name\": \"task-1\", \"namespace\": \"default\", \"labels\": {\"source\": \"chat_shell\"}}, \
             \"spec\": {\"title\": \"t\", \"prompt\": \"p\", \"fork\": null}, \
             \"status\": {\"state\": \"Available\", \"status\": \"COMPLETED\", \"progress\": 100}}"
        );
    }

    /// `Task.model_dump(mode="json")` fills every omitted optional field, so
    /// the status update carries the keys the stored create payload lacks
    /// (`app/schemas/kind.py:153-168,851-948`; recorded `UPDATE tasks` qs1642).
    #[test]
    fn task_status_update_dumps_the_full_model_shape() {
        let mut payload = json!({
            "status": {
                "progress": 0, "state": "Available", "status": "RUNNING", "result": null,
                "errorMessage": "", "createdAt": "2026-10-20T15:01:11.726425",
                "updatedAt": "2026-10-20T15:01:12.423528", "completedAt": null
            },
            "apiVersion": "agent.wecode.io/v1",
            "spec": {
                "title": "t", "prompt": "p", "teamRef": {"name": "team", "namespace": "n"},
                "workspaceRef": {"name": "w", "namespace": "default"}, "is_group_chat": false
            },
            "kind": "Task",
            "metadata": {"labels": {}, "name": "task-1", "namespace": "default"}
        })
        .as_object()
        .unwrap()
        .clone();
        complete_task_model(&mut payload);
        let rendered = Value::Object(render_task_crd(payload));
        assert_eq!(
            rendered.pointer("/metadata/displayName"),
            Some(&Value::Null)
        );
        for field in [
            "knowledgeBaseRefs",
            "knowledgeBaseScopes",
            "device_id",
            "execution",
            "fork",
            "currentStage",
        ] {
            assert_eq!(
                rendered.pointer(&format!("/spec/{field}")),
                Some(&Value::Null),
                "{field}"
            );
        }
        assert_eq!(
            rendered.pointer("/spec/externalKnowledgeRefs"),
            Some(&json!([]))
        );
        for field in ["message", "subTasks", "app", "archive"] {
            assert_eq!(
                rendered.pointer(&format!("/status/{field}")),
                Some(&Value::Null),
                "{field}"
            );
        }
        let status = rendered.get("status").unwrap().as_object().unwrap();
        assert_eq!(
            status.keys().map(String::as_str).collect::<Vec<_>>(),
            vec![
                "state",
                "message",
                "status",
                "progress",
                "result",
                "errorMessage",
                "createdAt",
                "updatedAt",
                "completedAt",
                "subTasks",
                "app",
                "archive",
            ]
        );
    }
}
