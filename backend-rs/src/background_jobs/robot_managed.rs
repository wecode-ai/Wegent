//! Managed Teams consume the existing execution queue through ordinary Tasks.
use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use serde_json::{Value, json};

use super::super::project::{managed, profile, store};
use super::{
    authority,
    model::{COLUMNS, Execution},
    projection,
};
use crate::{
    AppState,
    responses::create::{resolution, session},
    task_creation::{TaskCrdInput, WorkspaceRepository},
};

#[path = "robot_managed_session.rs"]
mod sessions;

const JOB: &str = super::managed_jobs::EXECUTE;

pub(super) async fn prepare(app: &AppState) -> Result<()> {
    let rows: Vec<Execution> = app.mysql.fetch_all(format!(
        "SELECT {COLUMNS} FROM loop_item_executions WHERE execution_environment='wegent' AND team_id<>0 AND status IN ('queued','claimed','running','cancel_requested') ORDER BY id"
    ), ()).await?;
    for row in rows {
        if row.assignment_pending() {
            continue;
        }
        if row.status == "queued" {
            if !authority::authorized(app, &row).await? {
                continue;
            }
            if let Err(error) = sessions::create(app, &row).await {
                if authority::infrastructure(&error) {
                    return Err(error);
                }
                super::state::fail_preparation(app, &row, &error.to_string()).await?;
                continue;
            }
        }
        reconcile(app, row.id).await?;
    }
    Ok(())
}

#[derive(FromMysqlRow)]
struct TaskState {
    task_id: i64,
    user_id: i64,
    status: String,
    json: Json<Value>,
    result: Option<Json<Value>>,
    error_message: Option<String>,
}

async fn reconcile(app: &AppState, execution_id: i64) -> Result<()> {
    let Some(row): Option<Execution> = app
        .mysql
        .fetch_optional(
            format!("SELECT {COLUMNS} FROM loop_item_executions WHERE id=?"),
            (execution_id,),
        )
        .await?
    else {
        return Ok(());
    };
    let Some(task_id) = row.runtime_task_id.parse::<i64>().ok() else {
        return Ok(());
    };
    let tables = app.task_store.table_templates();
    let routed = app
        .mysql
        .route(crate::task_routing::ByTaskId(task_id as u64));
    let Some(task): Option<TaskState> = routed.fetch_optional(format!(
        "SELECT t.id AS task_id,t.user_id,s.status,t.json,s.result,s.error_message FROM {} t JOIN {} s ON s.task_id=t.id AND s.user_id=t.user_id AND s.id=? AND s.role='ASSISTANT' WHERE t.id=? AND t.user_id=? AND t.kind='Task'",
        tables.tasks, tables.subtasks
    ), (row.intent()["managed_task"]["assistant_subtask_id"].as_i64().unwrap_or(0),task_id,row.executor_owner_user_id)).await? else { return Ok(()) };
    if !owns(&row, &task) {
        bail!("Managed execution Task identity changed");
    }
    if row.status == "cancel_requested"
        && !matches!(task.status.as_str(), "COMPLETED" | "FAILED" | "CANCELLED")
    {
        cancel_task(app, &row, task_id, &task.status).await?;
        return Ok(());
    }
    match task.status.as_str() {
        "PENDING" if row.status == "claimed" => {
            let input: managed::Execute =
                serde_json::from_value(row.intent()["managed_task"].clone())?;
            app.background_jobs
                .submit(
                    JOB,
                    serde_json::to_value(input)?,
                    None,
                    Some(format!("managed-project-execution:{}", row.id)),
                )
                .await?;
        }
        "COMPLETED" | "FAILED" | "CANCELLED" => settle(app, &row, &task).await?,
        _ => {}
    }
    Ok(())
}

async fn cancel_task(app: &AppState, row: &Execution, task_id: i64, status: &str) -> Result<()> {
    if status != "PENDING" {
        crate::task_mutation_api::cancel_task(app, row.executor_owner_user_id, task_id)
            .await
            .map_err(|error| anyhow::anyhow!("Managed cancellation failed: {error:?}"))?;
        return Ok(());
    }
    let redis = app
        .redis
        .as_ref()
        .context("Managed cancellation requires Redis")?;
    let context = crate::internal_callback::completion::Completion {
        app: Some(app),
        mysql: &app.mysql,
        redis,
        tables: crate::internal_callback::tables(app),
        executor_manager: &app.executor_manager,
    };
    crate::internal_callback::completion::complete_terminal(
        &context,
        task_id,
        row.intent()["managed_task"]["assistant_subtask_id"]
            .as_i64()
            .context("Managed assistant turn unavailable")?,
        "CANCELLED",
        None,
        None,
        None,
        None,
        None,
    )
    .await?;
    Ok(())
}

fn owns(row: &Execution, task: &TaskState) -> bool {
    task.user_id == row.executor_owner_user_id
        && row.runtime_task_id == task.task_id.to_string()
        && task.json.0["metadata"]["labels"]["projectRobotExecutionId"]
            .as_str()
            .and_then(|id| id.parse::<i64>().ok())
            == Some(row.id)
}

pub(crate) async fn source_matches(
    app: &AppState,
    row: &Execution,
    metadata: &Value,
) -> brz_mysql::MysqlResult<bool> {
    let Some(task_id) = row.runtime_task_id.parse::<i64>().ok().filter(|id| *id > 0) else {
        return Ok(false);
    };
    if row.team_id <= 0 || metadata["backend_task_id"].as_i64() != Some(task_id) {
        return Ok(false);
    }
    let tables = app.task_store.table_templates();
    let routed = app
        .mysql
        .route(crate::task_routing::ByTaskId(task_id as u64));
    let document: Option<(Json<Value>,)> = routed
        .fetch_optional(
            format!(
                "SELECT json FROM {} WHERE id=? AND user_id=? AND kind='Task'",
                tables.tasks
            ),
            (task_id, row.executor_owner_user_id),
        )
        .await?;
    Ok(document.is_some_and(|(document,)| source_labels_match(row, &document.0)))
}

fn source_labels_match(row: &Execution, document: &Value) -> bool {
    let labels = &document["metadata"]["labels"];
    labels["weworkSpaceProjectId"] == row.cloud_project_id
        && labels["weworkSpaceTaskId"] == row.loop_item_id
        && labels["projectAutomationTeamId"]
            .as_str()
            .and_then(|id| id.parse::<i64>().ok())
            == Some(row.team_id)
}

/// The ordinary completion event is primary; the queue scan repairs missed events.
pub(crate) async fn complete(
    app: &AppState,
    event: &crate::internal_callback::completion::TaskCompletedEvent<'_>,
) -> Result<bool> {
    if !matches!(event.status, "COMPLETED" | "FAILED" | "CANCELLED") {
        return Ok(false);
    }
    let tables = app.task_store.table_templates();
    let routed = app
        .mysql
        .route(crate::task_routing::ByTaskId(event.task_id as u64));
    let (document,): (Json<Value>,) = routed
        .fetch_one(
            format!(
                "SELECT json FROM {} WHERE id=? AND user_id=? AND kind='Task'",
                tables.tasks
            ),
            (event.task_id, event.user_id),
        )
        .await?;
    let Some(id) = document.0["metadata"]["labels"]["projectRobotExecutionId"]
        .as_str()
        .and_then(|id| id.parse::<i64>().ok())
    else {
        return Ok(false);
    };
    let row: Option<Execution> = app.mysql.fetch_optional(format!(
        "SELECT {COLUMNS} FROM loop_item_executions WHERE id=? AND backend_task_id=? AND executor_owner_user_id=? \
         AND execution_environment='wegent' AND status IN ('claimed','running','cancel_requested') \
         AND JSON_EXTRACT(execution_payload,'$.managed_task.assistant_subtask_id')=?"
    ),(id,event.task_id,event.user_id,event.subtask_id)).await?;
    let Some(row) = row else { return Ok(false) };
    let task = TaskState {
        task_id: event.task_id,
        user_id: event.user_id,
        status: event.status.into(),
        json: document,
        result: event.result.cloned().map(Json),
        error_message: event.error.map(str::to_owned),
    };
    if !owns(&row, &task) {
        bail!("Managed completion source changed")
    }
    settle(app, &row, &task).await?;
    Ok(true)
}

pub(crate) async fn authorize_task(app: &AppState, task_id: i64, owner: i64) -> Result<bool> {
    let tables = app.task_store.table_templates();
    let routed = app
        .mysql
        .route(crate::task_routing::ByTaskId(task_id as u64));
    let (document,): (Json<Value>,) = routed
        .fetch_one(
            format!(
                "SELECT json FROM {} WHERE id=? AND user_id=? AND kind='Task'",
                tables.tasks
            ),
            (task_id, owner),
        )
        .await?;
    let Some(id) = document.0["metadata"]["labels"]["projectRobotExecutionId"]
        .as_str()
        .and_then(|id| id.parse::<i64>().ok())
    else {
        return Ok(true);
    };
    let row: Option<Execution> = app.mysql.fetch_optional(format!("SELECT {COLUMNS} FROM loop_item_executions WHERE id=? AND executor_owner_user_id=? AND runtime_task_id=? AND execution_environment='wegent' AND status IN ('claimed','running')"),(id,owner,task_id.to_string())).await?;
    let Some(row) = row else { return Ok(false) };
    authority::authorized(app, &row).await
}

async fn settle(app: &AppState, row: &Execution, task: &TaskState) -> Result<()> {
    let status = match task.status.as_str() {
        "COMPLETED" => "completed",
        "CANCELLED" => "cancelled",
        _ => "failed",
    };
    let result = task
        .result
        .as_ref()
        .and_then(|result| super::super::project::completion::final_text(Some(&result.0)));
    let detail = if status == "failed" {
        task.error_message.as_deref().unwrap_or_default()
    } else {
        result.as_deref().unwrap_or_default()
    };
    let effects = app.mysql.with_transaction(async |tx| {
        let Some(issue) = store::locked(tx,"task",&row.loop_item_id).await? else { return Ok(projection::Effects::default()) };
        let current: Option<Execution> = tx.fetch_optional(format!("SELECT {COLUMNS} FROM loop_item_executions WHERE id=? FOR UPDATE"),(row.id,)).await?;
        let Some(current) = current.filter(|current| current.runtime_task_id == row.runtime_task_id && matches!(current.status.as_str(),"claimed"|"running"|"cancel_requested")) else { return Ok(projection::Effects::default()) };
        let authorized = authority::authorized_on(app,&mut &mut *tx,&current,Some(&issue)).await
            .map_err(|error|brz_mysql::MysqlError::InvalidQuery{reason:error.to_string()})?;
        let (status, detail) = if authorized { (status, detail) } else { ("cancelled", "Execution authorization revoked") };
        let observed = if status == "completed" { "succeeded" } else { status };
        tx.execute("UPDATE loop_item_executions SET status=?,completed_at=UTC_TIMESTAMP(6),observed_state=?,observed_at=UTC_TIMESTAMP(6),sync_state='in_sync',version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(status,observed,current.id)).await?;
        projection::terminal_on(tx,app,&current,status,detail,"managed_task_completed",chrono::Utc::now().naive_utc(),true).await
    }).await?;
    projection::publish(app, effects).await
}

pub(crate) async fn mark_started(
    app: &AppState,
    task_id: i64,
    owner: i64,
    chat: bool,
) -> Result<bool> {
    let tables = app.task_store.table_templates();
    let routed = app
        .mysql
        .route(crate::task_routing::ByTaskId(task_id as u64));
    let transport = if chat {
        "JSON_SET(json,'$.metadata.labels.managedTransport','chat_shell')"
    } else {
        "JSON_REMOVE(json,'$.metadata.labels.managedTransport')"
    };
    routed
        .execute(
            format!(
                "UPDATE {} SET json={transport} WHERE id=? AND user_id=?",
                tables.tasks
            ),
            (task_id, owner),
        )
        .await?;
    let row: Option<Execution> = app.mysql.fetch_optional(format!("SELECT {COLUMNS} FROM loop_item_executions WHERE execution_environment='wegent' AND runtime_task_id=? AND executor_owner_user_id=? ORDER BY id DESC LIMIT 1"),(task_id.to_string(),owner)).await?;
    let Some(row) = row else { return Ok(true) };
    app.mysql.with_transaction(async |tx| {
        let Some(issue) = store::locked(tx,"task",&row.loop_item_id).await? else { return Ok(false) };
        let current: Option<Execution> = tx.fetch_optional(format!("SELECT {COLUMNS} FROM loop_item_executions WHERE id=? FOR UPDATE"),(row.id,)).await?;
        let Some(current) = current.filter(|row|matches!(row.status.as_str(),"claimed"|"running")) else { return Ok(false) };
        if !authority::authorized_on(app,&mut &mut *tx,&current,Some(&issue)).await.map_err(|error|brz_mysql::MysqlError::InvalidQuery{reason:error.to_string()})? { return Ok(false) }
        tx.execute("UPDATE loop_item_executions SET status='running',started_at=UTC_TIMESTAMP(6),start_requested_at=UTC_TIMESTAMP(6),version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND status='claimed'",(current.id,)).await?;
        Ok(true)
    }).await.map_err(Into::into)
}

pub(super) enum Continuation {
    Native,
    Waiting,
    Ready(Option<i64>, i64),
}

pub(super) async fn continuation(
    app: &AppState,
    row: &Execution,
    source: &Value,
) -> Result<Continuation> {
    let Some(id) = super::super::project::authority::integer(&source["execution_id"]) else {
        return Ok(Continuation::Native);
    };
    let original: Option<Execution> = app
        .mysql
        .fetch_optional(
            format!("SELECT {COLUMNS} FROM loop_item_executions WHERE id=?"),
            (id,),
        )
        .await?;
    let Some(original) = original else {
        return Ok(Continuation::Native);
    };
    continuation_for(row, &original)
}

fn continuation_for(row: &Execution, original: &Execution) -> Result<Continuation> {
    if original.execution_environment != "wegent" {
        return Ok(Continuation::Native);
    }
    if original.cloud_project_id != row.cloud_project_id
        || original.loop_item_id != row.loop_item_id
        || original.agent_id != row.agent_id
    {
        bail!("Managed source belongs to another Issue or Agent");
    }
    if !original.terminal() {
        return Ok(Continuation::Waiting);
    }
    let task = if original.runtime_task_id.is_empty() {
        None
    } else {
        Some(
            original
                .runtime_task_id
                .parse::<i64>()
                .context("The original managed Task identity is invalid")?,
        )
    };
    Ok(Continuation::Ready(task, original.executor_owner_user_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn execution() -> Execution {
        Execution {
            id: 1,
            loop_item_id: "issue".into(),
            cloud_project_id: "project".into(),
            executor_owner_user_id: 7,
            assigner_user_id: 7,
            agent_id: "agent".into(),
            team_id: 42,
            automation_run_id: String::new(),
            execution_environment: "wegent".into(),
            execution_device_id: String::new(),
            runtime_device_id: String::new(),
            runtime_task_id: "101".into(),
            status: "completed".into(),
            approval_status: "approved".into(),
            execution_payload: "{}".into(),
            error_message: String::new(),
            execution_note: String::new(),
            version: 1,
            start_requested_at: None,
            completed_at: None,
        }
    }

    #[test]
    fn managed_replies_wait_then_reuse_the_original_task_with_exact_scope() {
        let current = execution();
        let mut original = execution();
        assert!(matches!(
            continuation_for(&current, &original).unwrap(),
            Continuation::Ready(Some(101), 7)
        ));
        original.status = "running".into();
        assert!(matches!(
            continuation_for(&current, &original).unwrap(),
            Continuation::Waiting
        ));
        original.status = "failed".into();
        original.runtime_task_id.clear();
        assert!(matches!(
            continuation_for(&current, &original).unwrap(),
            Continuation::Ready(None, 7)
        ));
        original.loop_item_id = "another-issue".into();
        assert!(continuation_for(&current, &original).is_err());
        original = execution();
        original.agent_id = "another-agent".into();
        assert!(continuation_for(&current, &original).is_err());
        original = execution();
        original.cloud_project_id = "another-project".into();
        assert!(continuation_for(&current, &original).is_err());
    }

    #[test]
    fn managed_results_require_the_exact_task_owner_and_execution_label() {
        let row = execution();
        let mut task = TaskState {
            task_id: 101,
            user_id: 7,
            status: "COMPLETED".into(),
            json: Json(json!({"metadata":{"labels":{"projectRobotExecutionId":"1"}}})),
            result: None,
            error_message: None,
        };
        assert!(owns(&row, &task));
        task.user_id = 8;
        assert!(!owns(&row, &task));
        task.user_id = 7;
        task.task_id = 102;
        assert!(!owns(&row, &task));
        task.task_id = 101;
        task.json.0["metadata"]["labels"]["projectRobotExecutionId"] = json!("2");
        assert!(!owns(&row, &task));
    }

    #[test]
    fn managed_sources_cannot_cross_project_issue_or_team() {
        let row = execution();
        let mut document = json!({"metadata":{"labels":{
            "weworkSpaceProjectId":"project","weworkSpaceTaskId":"issue","projectAutomationTeamId":"42"
        }}});
        assert!(source_labels_match(&row, &document));
        for (key, value) in [
            ("weworkSpaceProjectId", "other-project"),
            ("weworkSpaceTaskId", "other-issue"),
            ("projectAutomationTeamId", "43"),
        ] {
            let previous = document["metadata"]["labels"][key].clone();
            document["metadata"]["labels"][key] = json!(value);
            assert!(!source_labels_match(&row, &document));
            document["metadata"]["labels"][key] = previous;
        }
    }
}
