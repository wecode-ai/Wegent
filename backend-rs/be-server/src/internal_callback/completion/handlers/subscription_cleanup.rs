// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Owned runtime cleanup: prepare in a short transaction, delete without a
//! connection, then commit flags only for the runtime references prepared.
use brz_mysql::{FromMysqlCol, Json, Mysql, MysqlResult, MysqlRow, MysqlService, MysqlTransaction};
use brz_redis::Redis;
use serde_json::Value;

use crate::background_jobs::subscription::model::{self, Execution};
use crate::executor_manager::{ExecutorManager, SandboxLookup};
use crate::internal_callback::completion::{
    Completion, Tables, TaskCompletedEvent, sql, task_column,
};
use crate::responses::dispatch::DispatchJob;

use super::super::{local_datetime, now_local};

pub(super) struct RuntimeReference {
    pub(super) id: i64,
    pub(super) name: Option<String>,
    pub(super) namespace: Option<String>,
}

pub(super) struct CleanupPlan {
    task_id: i64,
    source: &'static str,
    subtasks: Vec<RuntimeReference>,
}

/// Service handles and data only; no request or transaction survives admission.
pub(crate) struct CleanupJob {
    pub(crate) task_id: i64,
    pub(crate) subtask_id: i64,
    mysql: MysqlService,
    tables: Tables,
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
        executor_manager: ctx.executor_manager.clone(),
        plan,
    };
    if !app
        .responses_dispatch
        .submit(DispatchJob::SubscriptionCleanup(Box::new(job)))
    {
        tracing::warn!(
            task_id = event.task_id,
            "runtime cleanup rejected; administrative cleanup may be required"
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
    let Some(task) = active_task(tx, tables, event.task_id).await else {
        return Ok(None);
    };
    let auto_delete = task_column::<Json<Value>>(&task, "json").is_some_and(|json| {
        json.0["metadata"]["labels"]["autoDeleteExecutor"].as_str() == Some("true")
    });
    if auto_delete {
        prepare_task(tx, tables, event.task_id, "auto-delete task").await
    } else {
        Ok(None)
    }
}

pub(super) async fn prepare_subscription<T: MysqlTransaction>(
    tx: &mut T,
    tables: Tables,
    execution: &Execution,
    task_id: i64,
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
    prepare_task(tx, tables, task_id, "subscription completion").await
}

async fn prepare_task<T: MysqlTransaction>(
    tx: &mut T,
    tables: Tables,
    task_id: i64,
    source: &'static str,
) -> MysqlResult<Option<CleanupPlan>> {
    let Some(task) = active_task(tx, tables, task_id).await else {
        return Ok(None);
    };
    let Some(owner_user_id) = task_column::<i64>(&task, "user_id") else {
        return Ok(None);
    };
    let mut page = list_not_executor_deleted_by_task(tx, tables, task_id, owner_user_id).await?;
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
        page = executor_cleanup_page(tx, tables, task_id, after_id).await?;
    }
    Ok((!subtasks.is_empty()).then_some(CleanupPlan {
        task_id,
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
            executor_manager,
            plan: CleanupPlan {
                task_id,
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
) -> Option<MysqlRow> {
    tx.fetch_optional(sql::resolve_owner_statement(tables.tasks), (task_id,))
        .await
        .ok()
        .flatten()
}

/// Preserve the sharded task-store owner check before selecting runtime rows.
async fn list_not_executor_deleted_by_task<T: MysqlTransaction>(
    tx: &mut T,
    tables: Tables,
    task_id: i64,
    owner_user_id: i64,
) -> MysqlResult<Vec<MysqlRow>> {
    let owner: Option<MysqlRow> = tx
        .fetch_optional(
            crate::task_store_statements::owner_matches_task_id_statement(tables.tasks),
            (task_id, owner_user_id),
        )
        .await
        .ok()
        .flatten();
    if owner.is_none() {
        let owners: Vec<MysqlRow> = tx
            .fetch_all(
                crate::task_store_statements::distinct_subtask_owners_statement(tables.subtasks),
                (task_id,),
            )
            .await
            .unwrap_or_default();
        if owners.len() != 1 || owners[0].get_required::<i64>("user_id").ok() != Some(owner_user_id)
        {
            return Ok(Vec::new());
        }
    }
    executor_cleanup_page(tx, tables, task_id, 0).await
}

async fn executor_cleanup_page<T: MysqlTransaction>(
    tx: &mut T,
    tables: Tables,
    task_id: i64,
    after_id: i64,
) -> MysqlResult<Vec<MysqlRow>> {
    tx.fetch_all(
        sql::subtasks_not_executor_deleted_by_task(tables),
        (task_id, after_id),
    )
    .await
}

fn subtask_column<T: FromMysqlCol>(row: &MysqlRow, column: &str) -> Option<T> {
    row.get::<T>(column).ok().flatten()
}
