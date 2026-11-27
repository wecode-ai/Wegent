// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Owned runtime cleanup: prepare in a short transaction, delete without a
//! connection, then commit flags only for the runtime references prepared.
use brz_mysql::{FromMysqlCol, Json, Mysql, MysqlResult, MysqlRow, MysqlService, MysqlTransaction};
use brz_redis::{Redis, RedisService};
use serde_json::Value;

use crate::background_jobs::subscription::model::{self, Execution};
use crate::executor_manager::{ExecutorManager, SandboxLookup};
use crate::internal_callback::completion::{
    Completion, Tables, TaskCompletedEvent, sql, task_column,
};
use crate::responses::dispatch::DispatchJob;

use super::super::{local_datetime, now_local};

/// Terminal subtask status and undeleted runtime references are already durable.
/// A separate persistent cursor rotates over a fixed high-water mark with a
/// per-pass budget, so rejection, restart and HTTP/flag failures remain retryable
/// without repeatedly reading retained ordinary chat rows or starving old IDs.
impl CleanupJob {
    pub(crate) async fn retry_pending(app: &crate::AppState) -> anyhow::Result<()> {
        use crate::task_store_maintenance::MaintenanceScan;
        use anyhow::Context;
        const CURSOR: &str = "wegent:completion-cleanup:cursor";
        const BUDGET: usize = 256;
        let redis = app
            .redis
            .as_ref()
            .context("completion cleanup retry requires Redis")?;
        let templates = app.task_store.table_templates();
        let tables = Tables {
            tasks: templates.tasks,
            subtasks: templates.subtasks,
        };
        let saved = redis.get::<_, String>(CURSOR).await?.and_then(|value| {
            let (after, through) = value.split_once(':')?;
            Some((
                after.parse::<i64>().ok()?.max(0),
                through.parse::<i64>().ok()?.max(0),
            ))
        });
        let (mut last_id, mut through_id) = saved.unwrap_or((0, 0));
        if through_id == 0 {
            through_id = app
                .task_store
                .scan_maintenance_subtasks(&MaintenanceScan::CursorLatest)
                .await?
                .first()
                .map(|row| row.get_required::<i64>("id"))
                .transpose()?
                .unwrap_or(0);
        }
        let mut scanned = 0;
        let started = std::time::Instant::now();
        while scanned < BUDGET && started.elapsed() < std::time::Duration::from_secs(8) {
            let rows = app
                .task_store
                .scan_maintenance_subtasks(&MaintenanceScan::CompletionCleanup {
                    last_id,
                    through_id,
                    limit: 100.min(BUDGET - scanned),
                })
                .await?;
            if rows.is_empty() {
                // Wrap after reaching the end. Persistent failure at an early ID
                // cannot starve later records, and each retained flag is revisited.
                redis.set(CURSOR, "0:0").await?;
                return Ok(());
            }
            for row in rows {
                if started.elapsed() >= std::time::Duration::from_secs(8) {
                    redis.set(CURSOR, format!("{last_id}:{through_id}")).await?;
                    return Ok(());
                }
                last_id = row.get_required("id")?;
                scanned += 1;
                let task_id: i64 = row.get_required("task_id")?;
                let subtask_id: i64 = row.get_required("id")?;
                let mysql = app
                    .mysql
                    .route(crate::task_routing::ByTaskId(task_id as u64));
                let plan = mysql
                    .with_transaction(async |tx| {
                        let Some(task) = active_task(tx, tables, task_id).await? else {
                            return Ok(None);
                        };
                        let Some(json) = task_column::<Json<Value>>(&task, "json") else {
                            return Ok(None);
                        };
                        let labels = &json.0["metadata"]["labels"];
                        if labels["type"] == "subscription" {
                            let execution: Option<Execution> = tx
                                .fetch_optional(model::execution_latest_by_task(), (task_id,))
                                .await?;
                            let Some(execution) =
                                execution.filter(|execution| model::terminal(&execution.status))
                            else {
                                return Ok(None);
                            };
                            prepare_subscription(tx, tables, &execution, task_id, subtask_id).await
                        } else if labels["autoDeleteExecutor"] == "true" {
                            prepare_task(tx, tables, task_id, subtask_id, "auto-delete task").await
                        } else {
                            Ok(None)
                        }
                    })
                    .await;
                let plan = match plan {
                    Ok(plan) => plan,
                    Err(error) => {
                        tracing::warn!(%error, task_id, subtask_id, "runtime cleanup retry preparation failed; continuing other tasks");
                        continue;
                    }
                };
                if let Some(plan) = plan
                    && !app
                        .responses_dispatch
                        .submit(DispatchJob::SubscriptionCleanup(Box::new(CleanupJob {
                            task_id,
                            subtask_id,
                            mysql,
                            tables,
                            redis: app.redis.clone(),
                            executor_manager: app.executor_manager.clone(),
                            plan,
                        })))
                {
                    // Stop admission pressure; all remaining flags survive for
                    // the next pass, including the just-rejected runtime.
                    redis.set(CURSOR, format!("{last_id}:{through_id}")).await?;
                    return Ok(());
                }
            }
        }
        redis.set(CURSOR, format!("{last_id}:{through_id}")).await?;
        Ok(())
    }
}

pub(super) struct RuntimeReference {
    pub(super) id: i64,
    pub(super) name: Option<String>,
    pub(super) namespace: Option<String>,
}

pub(super) struct CleanupPlan {
    task_id: i64,
    subtask_id: i64,
    source: &'static str,
    subtasks: Vec<RuntimeReference>,
}

/// Service handles and data only; no request or transaction survives admission.
pub(crate) struct CleanupJob {
    pub(crate) task_id: i64,
    pub(crate) subtask_id: i64,
    mysql: MysqlService,
    tables: Tables,
    redis: Option<RedisService>,
    executor_manager: ExecutorManager,
    plan: CleanupPlan,
}

pub(super) fn submit<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    event: &TaskCompletedEvent<'_>,
    plan: CleanupPlan,
) {
    let Some(app) = ctx.app else {
        tracing::warn!(
            task_id = event.task_id,
            "runtime cleanup owner unavailable; administrative cleanup may be required"
        );
        return;
    };
    let job = CleanupJob {
        task_id: event.task_id,
        subtask_id: event.subtask_id,
        mysql: app
            .mysql
            .route(crate::task_routing::ByTaskId(event.task_id as u64)),
        tables: ctx.tables,
        redis: app.redis.clone(),
        executor_manager: ctx.executor_manager.clone(),
        plan,
    };
    if !app
        .responses_dispatch
        .submit(DispatchJob::SubscriptionCleanup(Box::new(job)))
    {
        tracing::warn!(
            task_id = event.task_id,
            "runtime cleanup rejected; persisted undeleted references remain eligible for maintenance retry"
        );
    }
}

/// With no execution, the task's autoDeleteExecutor label controls cleanup.
pub(super) async fn prepare_auto_delete<T: MysqlTransaction>(
    tx: &mut T,
    tables: Tables,
    event: &TaskCompletedEvent<'_>,
) -> MysqlResult<Option<CleanupPlan>> {
    if !matches!(event.status, "COMPLETED" | "FAILED" | "CANCELLED") {
        return Ok(None);
    }
    let Some(task) = active_task(tx, tables, event.task_id).await? else {
        return Ok(None);
    };
    let auto_delete = task_column::<Json<Value>>(&task, "json").is_some_and(|json| {
        json.0["metadata"]["labels"]["autoDeleteExecutor"].as_str() == Some("true")
    });
    if auto_delete {
        prepare_task(
            tx,
            tables,
            event.task_id,
            event.subtask_id,
            "auto-delete task",
        )
        .await
    } else {
        Ok(None)
    }
}

pub(super) async fn prepare_subscription<T: MysqlTransaction>(
    tx: &mut T,
    tables: Tables,
    execution: &Execution,
    task_id: i64,
    subtask_id: i64,
) -> MysqlResult<Option<CleanupPlan>> {
    let subscription: Option<MysqlRow> = tx
        .fetch_optional(
            model::subscription_statement(false),
            (execution.subscription_id,),
        )
        .await?;
    if subscription.is_none() {
        tracing::warn!(
            subscription_id = execution.subscription_id,
            "cannot clean executor: subscription not found"
        );
        return Ok(None);
    }
    prepare_task(tx, tables, task_id, subtask_id, "subscription completion").await
}

async fn prepare_task<T: MysqlTransaction>(
    tx: &mut T,
    tables: Tables,
    task_id: i64,
    subtask_id: i64,
    source: &'static str,
) -> MysqlResult<Option<CleanupPlan>> {
    let Some(task) = active_task(tx, tables, task_id).await? else {
        return Ok(None);
    };
    let Some(owner_user_id) = task_column::<i64>(&task, "user_id") else {
        return Ok(None);
    };
    let subtask_id = if subtask_id > 0 {
        subtask_id
    } else {
        crate::internal_callback::completion::latest_assistant_id(tx, tables.subtasks, task_id)
            .await?
            .unwrap_or(0)
    };
    if subtask_id <= 0 {
        return Ok(None);
    }
    if !is_finished_turn(tx, tables, task_id, subtask_id, &task).await? {
        return Ok(None);
    }
    let mut page =
        list_not_executor_deleted_by_task(tx, tables, task_id, owner_user_id, subtask_id).await?;
    let mut subtasks = Vec::new();
    while !page.is_empty() {
        let after_id = page
            .last()
            .and_then(|row| subtask_column::<i64>(row, "id"))
            .unwrap_or(0);
        for row in &page {
            if let Some(id) = subtask_column::<i64>(row, "id") {
                subtasks.push(RuntimeReference {
                    id,
                    name: subtask_column::<String>(row, "executor_name"),
                    namespace: subtask_column::<String>(row, "executor_namespace"),
                });
            }
        }
        page = executor_cleanup_page(tx, tables, task_id, after_id, subtask_id).await?;
    }
    Ok((!subtasks.is_empty()).then_some(CleanupPlan {
        task_id,
        subtask_id,
        source,
        subtasks,
    }))
}

impl CleanupJob {
    #[cfg(test)]
    pub(crate) fn test_job(
        mysql: MysqlService,
        tables: Tables,
        executor_manager: ExecutorManager,
        task_id: i64,
    ) -> Self {
        Self {
            task_id,
            subtask_id: 42,
            mysql,
            tables,
            redis: None,
            executor_manager,
            plan: CleanupPlan {
                task_id,
                subtask_id: 0,
                source: "subscription completion",
                subtasks: vec![RuntimeReference {
                    id: 42,
                    name: Some("fixture-runtime".into()),
                    namespace: Some("default".into()),
                }],
            },
        }
    }

    pub(crate) async fn run(self) {
        if self.plan.subtask_id > 0 {
            let Some(redis) = self.redis.clone() else {
                tracing::warn!(
                    task_id = self.task_id,
                    "runtime cleanup lifecycle lease unavailable; references remain retryable"
                );
                return;
            };
            // SandboxManager.create_sandbox uses the same full Redis key.
            // Acquire before the DB recheck and renew throughout HTTP deletion,
            // so a resumed run cannot rebind the task sandbox in that interval.
            let key = format!("wegent-sandbox:lock:task-lifecycle:{}", self.task_id);
            if crate::internal_callback::completion::with_owned_lease(
                &redis,
                &key,
                || "runtime cleanup lifecycle lease unavailable",
                None,
                |_| async {
                    self.run_owned().await;
                    Ok(())
                },
            )
            .await
            .is_err()
            {
                tracing::warn!(
                    key,
                    "runtime cleanup lifecycle lease failed; references remain retryable"
                );
            }
        } else {
            self.run_owned().await;
        }
    }

    async fn run_owned(self) {
        // An admitted job may wait behind slow deletes. A newer continuation
        // owns the shared sandbox, so leave the durable references for its
        // eventual terminal cleanup rather than deleting that newer run.
        if self.plan.subtask_id > 0 {
            let current = self
                .mysql
                .with_transaction(async |tx| {
                    let Some(task) = active_task(tx, self.tables, self.task_id).await? else {
                        return Ok(false);
                    };
                    is_finished_turn(tx, self.tables, self.task_id, self.plan.subtask_id, &task)
                        .await
                })
                .await;
            if !matches!(current, Ok(true)) {
                if let Err(error) = current {
                    tracing::warn!(%error, task_id=self.task_id, "runtime cleanup ownership recheck failed; references remain retryable");
                }
                return;
            }
        }
        // No connection is acquired until all HTTP deletion attempts finish.
        let (sandbox_deleted, successful_keys) = self.delete_runtimes().await;
        let updates: Vec<_> = self
            .plan
            .subtasks
            .into_iter()
            .filter_map(|row| {
                let key = (
                    row.namespace.clone().unwrap_or_default(),
                    row.name.clone().unwrap_or_default(),
                );
                (sandbox_deleted || successful_keys.contains(&key))
                    .then(|| (local_datetime(now_local()), row))
            })
            .collect();
        if updates.is_empty() {
            tracing::warn!(
                task_id = self.task_id,
                source = self.plan.source,
                "runtime deletion failed; administrative cleanup may be required"
            );
            return;
        }
        let sql = deleted_statement(self.tables);
        if let Err(error) = self
            .mysql
            .with_transaction(async |tx| apply_executor_deleted_updates(tx, &sql, &updates).await)
            .await
        {
            tracing::warn!(%error, task_id = self.task_id, "runtime deleted but flags failed to commit; administrative cleanup may be required");
        }
    }

    async fn delete_runtimes(&self) -> (bool, Vec<(String, String)>) {
        let sandbox_id = self.plan.task_id.to_string();
        let mode = self.executor_manager.get_sandbox(&sandbox_id).await;
        let sandbox_deleted = if matches!(mode, SandboxLookup::Found | SandboxLookup::Failed) {
            self.executor_manager.delete_sandbox(&sandbox_id).await.0
        } else {
            false
        };
        let mut successful_keys = Vec::new();
        if matches!(mode, SandboxLookup::NotFound) {
            // A terminal assistant may bind only the task sandbox. A confirmed
            // 404 makes its empty runtime reference safe to acknowledge too.
            successful_keys.extend(
                self.plan
                    .subtasks
                    .iter()
                    .filter(|row| row.name.as_deref().is_none_or(str::is_empty))
                    .map(|row| {
                        (
                            row.namespace.clone().unwrap_or_default(),
                            row.name.clone().unwrap_or_default(),
                        )
                    }),
            );
        }
        if matches!(mode, SandboxLookup::NotFound | SandboxLookup::Failed) {
            let mut attempted = Vec::new();
            for row in &self.plan.subtasks {
                let Some(name) = row.name.as_deref().filter(|name| !name.is_empty()) else {
                    continue;
                };
                let key = (row.namespace.clone().unwrap_or_default(), name.to_string());
                if attempted.contains(&key) {
                    continue;
                }
                attempted.push(key.clone());
                match self
                    .executor_manager
                    .delete_executor_task(&key.1, &key.0)
                    .await
                {
                    Ok(()) => successful_keys.push(key),
                    Err(error) => {
                        tracing::warn!(%error, task_id = self.task_id, "executor delete failed")
                    }
                }
            }
        }
        (sandbox_deleted, successful_keys)
    }
}

pub(super) fn deleted_statement(tables: Tables) -> String {
    format!(
        "{} AND executor_deleted_at=false AND executor_name <=> ? AND executor_namespace <=> ?",
        sql::update_subtask_executor_deleted(tables)
    )
}

/// All flag writes share one short transaction. Null-safe predicates prevent
/// a new runtime binding from being marked deleted after the HTTP wait.
pub(super) async fn apply_executor_deleted_updates<T: MysqlTransaction>(
    tx: &mut T,
    sql: &str,
    updates: &[(String, RuntimeReference)],
) -> MysqlResult<()> {
    for (updated_at, row) in updates {
        tx.execute(
            sql,
            (
                true,
                updated_at.as_str(),
                row.id,
                row.name.as_deref(),
                row.namespace.as_deref(),
            ),
        )
        .await?;
    }
    Ok(())
}

async fn active_task<T: MysqlTransaction>(
    tx: &mut T,
    tables: Tables,
    task_id: i64,
) -> MysqlResult<Option<MysqlRow>> {
    tx.fetch_optional(sql::resolve_owner_statement(tables.tasks), (task_id,))
        .await
}

async fn is_finished_turn<T: MysqlTransaction>(
    tx: &mut T,
    tables: Tables,
    task_id: i64,
    subtask_id: i64,
    task: &MysqlRow,
) -> MysqlResult<bool> {
    let Some(json) = task_column::<Json<Value>>(task, "json") else {
        return Ok(false);
    };
    if !matches!(
        json.0["status"]["status"].as_str(),
        Some("COMPLETED" | "FAILED" | "CANCELLED")
    ) {
        return Ok(false);
    }
    if subtask_id > 0 {
        return Ok(crate::internal_callback::completion::latest_assistant_id(
            tx,
            tables.subtasks,
            task_id,
        )
        .await?
            == Some(subtask_id));
    }
    Ok(true)
}

/// Preserve the sharded task-store owner check before selecting runtime rows.
async fn list_not_executor_deleted_by_task<T: MysqlTransaction>(
    tx: &mut T,
    tables: Tables,
    task_id: i64,
    owner_user_id: i64,
    subtask_id: i64,
) -> MysqlResult<Vec<MysqlRow>> {
    let owner: Option<MysqlRow> = tx
        .fetch_optional(
            crate::task_store_statements::owner_matches_task_id_statement(tables.tasks),
            (task_id, owner_user_id),
        )
        .await?;
    if owner.is_none() {
        let owners: Vec<MysqlRow> = tx
            .fetch_all(
                crate::task_store_statements::distinct_subtask_owners_statement(tables.subtasks),
                (task_id,),
            )
            .await?;
        if owners.len() != 1 || owners[0].get_required::<i64>("user_id").ok() != Some(owner_user_id)
        {
            return Ok(Vec::new());
        }
    }
    executor_cleanup_page(tx, tables, task_id, 0, subtask_id).await
}

async fn executor_cleanup_page<T: MysqlTransaction>(
    tx: &mut T,
    tables: Tables,
    task_id: i64,
    after_id: i64,
    subtask_id: i64,
) -> MysqlResult<Vec<MysqlRow>> {
    if subtask_id > 0 {
        let table = tables.subtasks;
        // message_id is the conversation order used by latest_assistant_id;
        // it is the binding to this completed turn, not an invented execution FK.
        return tx.fetch_all(format!(
            "SELECT id, executor_name, executor_namespace FROM {table} \
             WHERE task_id=? AND executor_deleted_at=false AND id>? \
             AND message_id <= (SELECT message_id FROM (SELECT message_id FROM {table} WHERE id=? AND task_id=?) AS completed_turn) \
             ORDER BY id LIMIT 100"
        ), (task_id, after_id, subtask_id, task_id)).await;
    }
    tx.fetch_all(
        sql::subtasks_not_executor_deleted_by_task(tables),
        (task_id, after_id),
    )
    .await
}

fn subtask_column<T: FromMysqlCol>(row: &MysqlRow, column: &str) -> Option<T> {
    row.get::<T>(column).ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::mysql_rows::{MysqlRows, Value as Cell};
    use serde_json::json;

    #[tokio::test]
    async fn queued_subscription_cleanup_observes_a_newer_continuation_before_http() {
        for status in [Some("COMPLETED"), Some("PENDING"), None] {
            let rows = MysqlRows::start_results(move |sql| {
                let row = if sql.contains("FROM `tasks`") {
                    vec![
                        ("id", Cell::I64(7)),
                        ("user_id", Cell::I64(3650)),
                        (
                            "json",
                            Cell::Bytes(
                                serde_json::to_vec(&json!({"status":{"status":status}})).unwrap(),
                            ),
                        ),
                    ]
                } else {
                    vec![("id", Cell::I64(44))]
                };
                (row.clone(), vec![row])
            })
            .await;
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let manager =
                ExecutorManager::new(format!("http://{}", listener.local_addr().unwrap())).unwrap();
            let job = CleanupJob {
                task_id: 7,
                subtask_id: 42,
                mysql: rows.mysql.clone(),
                tables: Tables {
                    tasks: "tasks",
                    subtasks: "subtasks",
                },
                redis: None,
                executor_manager: manager,
                plan: CleanupPlan {
                    task_id: 7,
                    subtask_id: 42,
                    source: "subscription completion",
                    subtasks: vec![RuntimeReference {
                        id: 42,
                        name: None,
                        namespace: None,
                    }],
                },
            };
            job.run_owned().await;
            use futures_util::FutureExt;
            assert!(
                listener.accept().now_or_never().is_none(),
                "old queued cleanup must issue no HTTP for a resumed or malformed task"
            );
            assert!(
                !rows
                    .queries()
                    .iter()
                    .any(|query| query.starts_with("UPDATE "))
            );
        }
    }
}
