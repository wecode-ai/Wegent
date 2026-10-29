// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task/workspace/user+assistant-subtask row creation (`SqlAlchemyTaskStore` +
//! `SqlAlchemySubtaskStore`), rendered as the SQLAlchemy-exact statements in
//! [`crate::task_store_statements`].
//!
//! `POST /api/v1/responses` (source `openapi_responses.create_response`) drives
//! `setup_chat_session` -> `prepare_execution_session` -> `create_new_task` and
//! `create_user_and_assistant_subtasks`, so these are the writes a create
//! request performs. The functions take the already-routed handle: the sharded
//! store binds `ByUserId(user_id)` and supplies the user-scoped id it allocated
//! (`with_id = true`), while the open-source single-table store leaves the id
//! to MySQL (`with_id = false`).
use async_trait::async_trait;
use brz_mysql::{FromMysqlRow, MysqlResult, MysqlService, MysqlTransaction};

use crate::request_sql::{RequestSql, RouteKey, fetch_optional_as};
use crate::task_store_statements::{
    StatementArg, insert_task_shell_statement, max_subtask_message_id_statement,
    update_task_name_and_json_statement,
};

/// The task/subtask creation writes of the create path (`SqlAlchemyTaskStore` /
/// `SqlAlchemySubtaskStore`). Split from [`crate::task_store::TaskStore`] so
/// each source file stays within the file-size bound; `TaskStore` extends this
/// trait, so `dyn TaskStore` still exposes every method.
#[async_trait]
pub trait TaskStoreCreate: Send + Sync {
    /// `task_store.update_fields(name=...)` + `update_json(payload)` on a
    /// freshly created task: rewrite `name` / `json` / `updated_at` in the one
    /// UPDATE SQLAlchemy flushes for the changed columns.
    async fn rename_and_update_task_json(
        &self,
        sql: &mut dyn RequestSql,
        task_id: i64,
        owner_user_id: i64,
        name: &str,
        json: &str,
        updated_at: &str,
    ) -> MysqlResult<u64>;

    /// `create_pending_task_shell_with_workspace`: insert the placeholder Task
    /// and its Workspace inside `SAVEPOINT sa_savepoint_1`, returning
    /// `(task_id, workspace_id)`. The single-table store lets MySQL assign the
    /// ids; a sharded deployment allocates the user-scoped ids before the
    /// insert.
    ///
    /// `mysql` is the application's concrete service for the same reason as
    /// the subtask insert below: `ai-strict` rejects a pooled `SAVEPOINT`, so
    /// the savepoint pair and both inserts run through `with_transaction`,
    /// whose future is not `Send` through a generic store handle.
    async fn create_task_shell_with_workspace(
        &self,
        sql: &mut dyn RequestSql,
        request: &CreateTaskShellRequest<'_>,
    ) -> MysqlResult<(i64, i64)>;

    /// `subtask_store.create_assistant_subtask` and
    /// `create_user_and_assistant_subtasks`: resolve the task's executor
    /// reference (the `_take_task_executor_reference` row lock, the label
    /// consumption, and the fallback assistant read) and insert the paired
    /// user/assistant subtasks inside one transaction, returning both ids and
    /// the resolved executor fields.
    ///
    /// `mysql` is the application's concrete service: the locking read has to
    /// run through `Mysql::with_transaction`, whose future is not `Send` through
    /// a generic store handle. The store supplies its resolved table names and,
    /// for a sharded deployment, the ids it allocated before the insert. The
    /// savepoint index is the session's nested-transaction counter, so a
    /// resumed Task that skipped the task-creation savepoint uses
    /// `sa_savepoint_1`.
    async fn create_user_and_assistant_subtasks_with_executor_reference(
        &self,
        sql: &mut dyn RequestSql,
        savepoint: &str,
        request: &CreateSubtasksRequest<'_>,
    ) -> MysqlResult<crate::task_store_executor_reference::SubtaskPairInsert> {
        // The Source emits the task's rename UPDATE between the executor reads
        // and the savepoint block, so the two halves are separate methods and
        // this composition remains for callers that do not need the split.
        let executor = self
            .resolve_task_executor_on(sql, request.user_subtask.task_id)
            .await?;
        self.create_subtasks_with_executor(sql, savepoint, request, &executor)
            .await
    }

    /// `_take_task_executor_reference` plus the fallback assistant read
    /// (qs27/28) on the caller's request transaction.
    async fn resolve_task_executor_on(
        &self,
        sql: &mut dyn RequestSql,
        task_id: i64,
    ) -> MysqlResult<crate::task_store_executor_reference::AssistantExecutor>;

    /// The subtask savepoint and paired inserts (qs30-34) for an executor the
    /// caller already resolved.
    async fn create_subtasks_with_executor(
        &self,
        sql: &mut dyn RequestSql,
        savepoint: &str,
        request: &CreateSubtasksRequest<'_>,
        executor: &crate::task_store_executor_reference::AssistantExecutor,
    ) -> MysqlResult<crate::task_store_executor_reference::SubtaskPairInsert>;

    /// Atomically advance an automatic pipeline and append its next turn.
    async fn advance_pipeline_stage(
        &self,
        mysql: &MysqlService,
        task_id: i64,
        completed_subtask_id: i64,
    ) -> MysqlResult<Option<crate::task_store::PipelineStageAdvance>>;

    /// `task_store` message-id continuation read: `SELECT max(subtasks
    /// .message_id)` for one task, `None` when it has no subtasks.
    async fn max_subtask_message_id(
        &self,
        sql: &mut dyn RequestSql,
        task_id: i64,
    ) -> MysqlResult<Option<i64>>;
}

/// One `tasks` row insert (`create_pending_task_shell` / `create_workspace`).
///
/// `id` is only bound when the store assigns ids before the insert; the
/// single-table store ignores it and reads the autoincrement id back.
#[derive(Clone, Copy)]
pub struct NewTaskRow<'a> {
    pub id: i64,
    pub user_id: i64,
    pub kind: &'a str,
    pub name: &'a str,
    pub namespace: &'a str,
    pub json: &'a str,
    pub is_active: i64,
    pub created_at: &'a str,
    pub updated_at: &'a str,
    pub project_id: i64,
    pub client_origin: &'a str,
    pub is_group_chat: i64,
}

/// `create_pending_task_shell` / `create_workspace`: insert one `tasks` row and
/// return its id (the supplied id when the store allocates, else MySQL's
/// `last_insert_id`).
///
/// The insert runs on the caller's open transaction: `ai-strict` only admits
/// DML through a pooled `execute`, so every statement inside the source's
/// savepoint is issued on the transaction handle.
pub fn task_insert_arguments(row: &NewTaskRow<'_>, with_id: bool) -> Vec<StatementArg> {
    let mut args: Vec<StatementArg> = Vec::with_capacity(12);
    if with_id {
        args.push(StatementArg::Int(row.id));
    }
    args.push(StatementArg::Int(row.user_id));
    args.push(StatementArg::Str(row.kind.to_string()));
    args.push(StatementArg::Str(row.name.to_string()));
    args.push(StatementArg::Str(row.namespace.to_string()));
    args.push(StatementArg::Str(row.json.to_string()));
    args.push(StatementArg::Int(row.is_active));
    args.push(StatementArg::Str(row.created_at.to_string()));
    args.push(StatementArg::Str(row.updated_at.to_string()));
    args.push(StatementArg::Int(row.project_id));
    args.push(StatementArg::Str(row.client_origin.to_string()));
    args.push(StatementArg::Int(row.is_group_chat));
    args
}

/// One `tasks` row insert on an open driver transaction (background jobs and
/// pipeline turns own their `with_transaction` closure).
pub async fn insert_task_row<T: MysqlTransaction>(
    transaction: &mut T,
    table: &str,
    with_id: bool,
    row: &NewTaskRow<'_>,
) -> MysqlResult<i64> {
    let execution = transaction
        .execute(
            insert_task_shell_statement(table, with_id),
            task_insert_arguments(row, with_id),
        )
        .await?;
    Ok(if with_id {
        row.id
    } else {
        execution.last_insert_id as i64
    })
}

/// One `tasks` row insert on the caller's request transaction.
pub async fn insert_task_row_on(
    sql: &mut dyn RequestSql,
    route: RouteKey,
    table: &str,
    with_id: bool,
    row: &NewTaskRow<'_>,
) -> MysqlResult<i64> {
    let execution = sql
        .execute_statement(
            route,
            &insert_task_shell_statement(table, with_id),
            task_insert_arguments(row, with_id),
        )
        .await?;
    Ok(if with_id {
        row.id
    } else {
        execution.last_insert_id as i64
    })
}

/// `task_store.update_fields(name=...)` + `update_json(payload)` on a freshly
/// created task: rewrite `name` / `json` / `updated_at` for `task_id`.
pub async fn update_task_name_and_json(
    sql: &mut dyn RequestSql,
    route: RouteKey,
    table: &str,
    task_id: i64,
    name: &str,
    json: &str,
    updated_at: &str,
) -> MysqlResult<u64> {
    sql.execute_statement(
        route,
        &update_task_name_and_json_statement(table),
        vec![
            StatementArg::Str(name.to_string()),
            StatementArg::Str(json.to_string()),
            StatementArg::Str(updated_at.to_string()),
            StatementArg::Int(task_id),
        ],
    )
    .await
    .map(|execution| execution.rows_affected)
}

/// One `subtasks` row insert. `created_at` / `updated_at` are the source
/// model's SQL `now()` defaults and are not bound.
#[derive(Clone, Copy)]
pub struct NewSubtaskRow<'a> {
    pub id: i64,
    pub user_id: i64,
    pub task_id: i64,
    pub team_id: i64,
    pub title: &'a str,
    pub bot_ids: &'a str,
    pub role: &'a str,
    pub executor_namespace: &'a str,
    pub executor_name: &'a str,
    pub executor_deleted_at: i64,
    pub prompt: &'a str,
    pub message_id: i64,
    pub parent_id: i64,
    pub status: &'a str,
    pub progress: i64,
    pub result: &'a str,
    pub error_message: &'a str,
    pub completed_at: &'a str,
    pub sender_type: &'a str,
    pub sender_user_id: i64,
    pub reply_to_subtask_id: i64,
}

/// `insert_subtask_statement`'s bound arguments in column order: the id first
/// when the store allocated it, every other mapped column after.
pub fn subtask_insert_arguments(row: &NewSubtaskRow<'_>, with_id: bool) -> Vec<StatementArg> {
    let mut args: Vec<StatementArg> = Vec::with_capacity(21);
    if with_id {
        args.push(StatementArg::Int(row.id));
    }
    args.push(StatementArg::Int(row.user_id));
    args.push(StatementArg::Int(row.task_id));
    args.push(StatementArg::Int(row.team_id));
    args.push(StatementArg::Str(row.title.to_string()));
    args.push(StatementArg::Str(row.bot_ids.to_string()));
    args.push(StatementArg::Str(row.role.to_string()));
    args.push(StatementArg::Str(row.executor_namespace.to_string()));
    args.push(StatementArg::Str(row.executor_name.to_string()));
    args.push(StatementArg::Int(row.executor_deleted_at));
    args.push(StatementArg::Str(row.prompt.to_string()));
    args.push(StatementArg::Int(row.message_id));
    args.push(StatementArg::Int(row.parent_id));
    args.push(StatementArg::Str(row.status.to_string()));
    args.push(StatementArg::Int(row.progress));
    args.push(StatementArg::Str(row.result.to_string()));
    args.push(StatementArg::Str(row.error_message.to_string()));
    args.push(StatementArg::Str(row.completed_at.to_string()));
    args.push(StatementArg::Str(row.sender_type.to_string()));
    args.push(StatementArg::Int(row.sender_user_id));
    args.push(StatementArg::Int(row.reply_to_subtask_id));
    args
}

/// One `max_1` scalar row.
#[derive(Debug, FromMysqlRow)]
struct MaxMessageIdRow {
    #[mysql(rename = "max_1")]
    max_message_id: Option<i64>,
}

/// `SELECT max(subtasks.message_id)` for one task: `None` when the task has no
/// subtasks (the caller maps it to `next_message_id = 1`).
pub async fn max_subtask_message_id(
    sql: &mut dyn RequestSql,
    route: RouteKey,
    table: &str,
    task_id: i64,
) -> MysqlResult<Option<i64>> {
    let row: Option<MaxMessageIdRow> = fetch_optional_as(
        sql,
        route,
        &max_subtask_message_id_statement(table),
        vec![StatementArg::Int(task_id)],
    )
    .await?;
    Ok(row.and_then(|row| row.max_message_id))
}

/// The workspace row built from the allocated task id
/// (`workspace_factory(task_id)`).
pub struct WorkspacePayload {
    pub name: String,
    pub namespace: String,
    pub json: String,
}

/// `create_pending_task_shell_with_workspace` inputs.
pub struct CreateTaskShellRequest<'a> {
    pub user_id: i64,
    pub client_origin: &'a str,
    pub is_group_chat: bool,
    pub project_id: i64,
    pub created_at: &'a str,
    pub updated_at: &'a str,
    /// The placeholder name (`task-pending-{uuid4().hex}`); the caller supplies
    /// a fresh value so the row is never a stale literal.
    pub pending_name: &'a str,
    /// Builds the Workspace row from the allocated task id.
    pub workspace: &'a (dyn Fn(i64) -> WorkspacePayload + Send + Sync),
}

/// `create_pending_task_shell_with_workspace`: insert the placeholder Task and
/// its Workspace inside `SAVEPOINT {savepoint}` (the source's `begin_nested`),
/// returning `(task_id, workspace_id)`.
///
/// `preallocated` carries the store-assigned ids for the sharded deployment
/// (`Some((task_id, workspace_id))`); the single-table store passes `None` and
/// reads the autoincrement ids back.
///
/// The source's request session already had an open transaction, so the
/// savepoint and both inserts belong to one atomic block. `brz-mysql`'s
/// `ai-strict` rejects `SAVEPOINT`/`RELEASE SAVEPOINT` through the pooled
/// `execute`; the block therefore runs on an explicit transaction, which keeps
/// the savepoint pair and the two inserts atomic and commits them together.
pub async fn create_task_shell_with_workspace(
    sql: &mut dyn RequestSql,
    route: RouteKey,
    table: &str,
    savepoint: &str,
    preallocated: Option<(i64, i64)>,
    request: &CreateTaskShellRequest<'_>,
) -> MysqlResult<(i64, i64)> {
    let with_id = preallocated.is_some();
    sql.execute_statement(route, &format!("SAVEPOINT {savepoint}"), Vec::new())
        .await?;

    let task_row = NewTaskRow {
        id: preallocated.map_or(0, |ids| ids.0),
        user_id: request.user_id,
        kind: "Task",
        name: request.pending_name,
        namespace: "default",
        json: "{\"kind\": \"Task\"}",
        is_active: 1,
        created_at: request.created_at,
        updated_at: request.updated_at,
        project_id: request.project_id,
        client_origin: request.client_origin,
        is_group_chat: i64::from(request.is_group_chat),
    };
    let task_id = insert_task_row_on(sql, route, table, with_id, &task_row).await?;

    let workspace = (request.workspace)(task_id);
    let workspace_row = NewTaskRow {
        id: preallocated.map_or(0, |ids| ids.1),
        user_id: request.user_id,
        kind: "Workspace",
        name: &workspace.name,
        namespace: &workspace.namespace,
        json: &workspace.json,
        is_active: 1,
        created_at: request.created_at,
        updated_at: request.updated_at,
        project_id: 0,
        client_origin: request.client_origin,
        is_group_chat: 0,
    };
    let workspace_id = insert_task_row_on(sql, route, table, with_id, &workspace_row).await?;

    sql.execute_statement(route, &format!("RELEASE SAVEPOINT {savepoint}"), Vec::new())
        .await?;
    Ok((task_id, workspace_id))
}

/// `subtask_store.create_user_and_assistant_subtasks` inputs.
pub struct CreateSubtasksRequest<'a> {
    pub user_subtask: NewSubtaskRow<'a>,
    pub assistant_subtask: NewSubtaskRow<'a>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_store_statements::{
        TASKS_TABLE, insert_subtask_statement, insert_task_shell_statement,
        update_task_name_and_json_statement,
    };
    use brz_mysql::MysqlResult;
    use std::sync::Mutex;

    fn task_row() -> NewTaskRow<'static> {
        NewTaskRow {
            id: 897_064_049_841_442,
            user_id: 6527,
            kind: "Task",
            name: "task-pending-1b13c69441b0420380902e4a4527911c",
            namespace: "default",
            json: "{\"kind\": \"Task\"}",
            is_active: 1,
            created_at: "2026-10-10 14:20:16.485897",
            updated_at: "2026-10-10 14:20:16.485903",
            project_id: 0,
            client_origin: "frontend",
            is_group_chat: 0,
        }
    }

    fn subtask_row(id: i64) -> NewSubtaskRow<'static> {
        NewSubtaskRow {
            id,
            user_id: 6527,
            task_id: 897_064_049_841_442,
            team_id: 568_317,
            title: "User message",
            bot_ids: "[568316]",
            role: "USER",
            executor_namespace: "",
            executor_name: "",
            executor_deleted_at: 0,
            prompt: "不吃糊饼",
            message_id: 1,
            parent_id: 0,
            status: "COMPLETED",
            progress: 100,
            result: "null",
            error_message: "",
            completed_at: "2026-10-10 14:20:16.519036",
            sender_type: "USER",
            sender_user_id: 6527,
            reply_to_subtask_id: 0,
        }
    }

    /// Records every statement issued through the caller-owned handle.
    #[derive(Default)]
    struct RecordedRequestSql {
        calls: Mutex<Vec<(RouteKey, String, usize)>>,
    }

    impl RecordedRequestSql {
        fn calls(&self) -> Vec<(RouteKey, String, usize)> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl crate::request_sql::RequestSql for RecordedRequestSql {
        async fn execute_statement(
            &mut self,
            route: RouteKey,
            sql: &str,
            arguments: crate::request_sql::StatementArgs,
        ) -> MysqlResult<brz_mysql::MysqlExecution> {
            self.calls
                .lock()
                .unwrap()
                .push((route, sql.to_string(), arguments.len()));
            Ok(brz_mysql::MysqlExecution {
                rows_affected: 1,
                last_insert_id: 42,
            })
        }

        async fn fetch_optional_row(
            &mut self,
            route: RouteKey,
            sql: &str,
            arguments: crate::request_sql::StatementArgs,
        ) -> MysqlResult<Option<brz_mysql::MysqlRow>> {
            self.calls
                .lock()
                .unwrap()
                .push((route, sql.to_string(), arguments.len()));
            Ok(None)
        }

        async fn fetch_all_rows(
            &mut self,
            route: RouteKey,
            sql: &str,
            arguments: crate::request_sql::StatementArgs,
        ) -> MysqlResult<Vec<brz_mysql::MysqlRow>> {
            self.calls
                .lock()
                .unwrap()
                .push((route, sql.to_string(), arguments.len()));
            Ok(Vec::new())
        }
    }

    #[tokio::test]
    async fn insert_task_row_binds_the_sharded_id() {
        let mut sql = RecordedRequestSql::default();
        let id = insert_task_row_on(
            &mut sql,
            RouteKey::User(509),
            "tasks_0383",
            true,
            &task_row(),
        )
        .await
        .expect("insert");
        assert_eq!(id, 897_064_049_841_442);
        let calls = sql.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, RouteKey::User(509));
        assert_eq!(calls[0].1, insert_task_shell_statement("tasks_0383", true));
        assert_eq!(calls[0].2, 12);
    }

    #[tokio::test]
    async fn insert_task_row_returns_the_database_id_on_the_base_table() {
        let mut sql = RecordedRequestSql::default();
        let id = insert_task_row_on(&mut sql, RouteKey::None, TASKS_TABLE, false, &task_row())
            .await
            .expect("insert");
        assert_eq!(id, 42);
        let calls = sql.calls();
        assert_eq!(calls[0].1, insert_task_shell_statement(TASKS_TABLE, false));
        assert_eq!(calls[0].2, 11);
    }

    #[tokio::test]
    async fn update_task_name_and_json_binds_three_values_and_the_id() {
        let mut sql = RecordedRequestSql::default();
        let affected = update_task_name_and_json(
            &mut sql,
            RouteKey::Task(897_064_049_841_442),
            "tasks_0383",
            897_064_049_841_442,
            "task-897064049841442",
            "{\"kind\": \"Task\"}",
            "2026-10-10 14:20:16.492551",
        )
        .await
        .expect("update");
        assert_eq!(affected, 1);
        let calls = sql.calls();
        assert_eq!(
            calls[0].1,
            update_task_name_and_json_statement("tasks_0383")
        );
        assert_eq!(calls[0].2, 4);
    }

    #[tokio::test]
    async fn max_subtask_message_id_reads_the_scalar() {
        let mut sql = RecordedRequestSql::default();
        let value = max_subtask_message_id(
            &mut sql,
            RouteKey::Task(897_064_049_841_442),
            "subtasks_0383",
            897_064_049_841_442,
        )
        .await
        .expect("read");
        assert_eq!(value, None);
        let calls = sql.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].2, 1);
        assert!(
            calls[0]
                .1
                .contains("max(subtasks_0383.message_id) AS max_1")
        );
    }

    /// The Source's `begin_nested()` block: one `SAVEPOINT`, the Task and
    /// Workspace inserts, then `RELEASE SAVEPOINT`, all on the caller's handle
    /// and with no transaction of its own.
    #[tokio::test]
    async fn create_task_shell_with_workspace_emits_savepoints_only() {
        let workspace = |task_id: i64| WorkspacePayload {
            name: format!("workspace-{task_id}"),
            namespace: "default".to_string(),
            json: "{\"kind\": \"Workspace\"}".to_string(),
        };
        let request = CreateTaskShellRequest {
            user_id: 509,
            client_origin: "frontend",
            is_group_chat: false,
            project_id: 2571,
            created_at: "2026-10-25 19:09:17.335721",
            updated_at: "2026-10-25 19:09:17.335721",
            pending_name: "task-pending-7bb581d77ac088dffe1f3b75c2fab96e",
            workspace: &workspace,
        };
        let mut sql = RecordedRequestSql::default();
        let ids = create_task_shell_with_workspace(
            &mut sql,
            RouteKey::User(509),
            "{{tasks}}",
            "sa_savepoint_1",
            Some((897_064_049_841_442, 897_064_049_841_443)),
            &request,
        )
        .await
        .expect("create");
        assert_eq!(ids, (897_064_049_841_442, 897_064_049_841_443));

        let calls = sql.calls();
        assert_eq!(calls.len(), 4, "{calls:?}");
        assert_eq!(calls[0].1, "SAVEPOINT sa_savepoint_1");
        assert!(calls[1].1.starts_with("INSERT INTO {{tasks}} (id, user_id"));
        assert!(calls[2].1.starts_with("INSERT INTO {{tasks}} (id, user_id"));
        assert_eq!(calls[3].1, "RELEASE SAVEPOINT sa_savepoint_1");
        assert!(
            calls
                .iter()
                .all(|(_, sql, _)| !sql.starts_with("BEGIN") && !sql.starts_with("COMMIT")),
            "the savepoint pair must not open or close a transaction: {calls:?}"
        );
        assert!(
            calls
                .iter()
                .all(|(route, _, _)| *route == RouteKey::User(509)),
            "every statement keeps the owner shard key: {calls:?}"
        );
    }

    #[test]
    fn insert_subtask_columns_bind_in_the_recorded_order() {
        let row = subtask_row(897_064_049_841_444);
        let allocated = subtask_insert_arguments(&row, true);
        assert_eq!(allocated.len(), 21);
        assert!(matches!(
            allocated[0],
            StatementArg::Int(897_064_049_841_444)
        ));
        assert!(matches!(allocated[1], StatementArg::Int(6527)));
        assert!(matches!(
            allocated[4],
            StatementArg::Str(ref title) if title == "User message"
        ));
        assert_eq!(
            insert_subtask_statement("subtasks_0383", true),
            "INSERT INTO subtasks_0383 (id, user_id, task_id, team_id, title, bot_ids, `role`, executor_namespace, executor_name, executor_deleted_at, prompt, message_id, parent_id, status, progress, result, error_message, created_at, updated_at, completed_at, sender_type, sender_user_id, reply_to_subtask_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), now(), ?, ?, ?, ?)"
        );

        let auto = subtask_insert_arguments(&row, false);
        assert_eq!(auto.len(), 20, "the autoincrement form binds no id");
        assert!(matches!(auto[0], StatementArg::Int(6527)));
    }
}
