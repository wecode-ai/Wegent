// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Deployment extension point for task and subtask row reads.
//!
//! The public store ([`DefaultTaskStore`]) reads the single `tasks` and
//! `subtasks` tables directly. An application whose deployment resolves task
//! storage differently registers its own [`TaskStore`] implementation through
//! `AppState::task_store` before route construction, the same way
//! `AppState::user_reader` selects the user lookup strategy.
//!
//! Methods return raw rows so each caller keeps its own typed projection; the
//! store owns which statement runs and which parameters it binds. Stores are
//! generic over the handle, so the application picks it and tests can drive the
//! store with a recording one.
use async_trait::async_trait;
use brz_mysql::{Mysql, MysqlResult, MysqlRow};

use crate::tasks_search::statements::{
    owned_task_count_statement, owned_task_ids_statement, tasks_by_ids_statement,
};

pub use crate::task_store_listing::{OwnedTaskPage, SubtaskListing, subtask_context_columns};
pub use crate::task_store_project::{
    active_project_task_statement, fetch_active_project_task, task_project_update_statement,
    update_task_project_and_json,
};
pub use crate::task_store_projects::{
    clear_project_ids_statement, clear_project_update_statement, project_tasks_statement,
    task_update_timestamp,
};

/// How `list_subtasks_by_task` treats the batched subtask-context load that
/// follows the row read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextPolicy {
    /// Never load contexts with the rows.
    Never,
    /// Load contexts whenever the row read returned rows.
    WhenRowsExist,
    /// Load contexts only when the row read resolved a non-default table.
    OnlyWhenResolved,
}

pub use crate::task_store_statements::*;

#[async_trait]
pub trait TaskStore: Send + Sync {
    /// `task_store.list_by_ids` for the running task ids reported by one
    /// device: `user_id` owns the tasks, `task_ids` are the reported ids. An
    /// empty `task_ids` issues no statement.
    async fn list_running_tasks(
        &self,
        user_id: i64,
        task_ids: &[i64],
    ) -> MysqlResult<Vec<MysqlRow>>;

    /// `task_store.get_active_task`: the task row for `task_id` when its kind
    /// is `Task` and it is active.
    async fn get_active_task(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `task_access_store._get_accessible_task`: the active task row the
    /// access store authorizes a viewer against. Unlike `get_active_task`,
    /// this read is not preceded by the store's legacy owner/migrated-copy
    /// probes: the access store reads the table the id's own encoding
    /// selects, so an id that the owner-probed read resolves to another
    /// table still reads the id's own table here.
    async fn get_accessible_task(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `task_access_store.get_runtime_state`: the viewer-authorized runtime
    /// checkpoint for `task_id`, or no row when the task is absent, inactive,
    /// JSON-deleted, or not visible to `user_id`.
    async fn get_runtime_state(&self, task_id: i64, user_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `_get_accessible_task`'s owner projection of an active task.
    async fn get_task_owner_id(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `subtask_store.list_by_task_ordered` with `order_by="id"` and the
    /// optional `message_ids` filter. `Some(empty)` issues no statement.
    async fn list_subtasks_ordered(
        &self,
        task_id: i64,
        message_ids: Option<&[i64]>,
    ) -> MysqlResult<Vec<MysqlRow>>;

    /// `task_store.list_recent_owner_only_tasks`: the owner's own tasks that
    /// carry no approved member, one page at a time.
    async fn list_recent_owner_only_tasks(
        &self,
        user_id: i64,
        limit: i64,
    ) -> MysqlResult<Vec<MysqlRow>>;

    /// `_batch_query_workspaces`: workspace rows by `(user_id, namespace,
    /// name)` reference. An empty ref list issues no statement.
    async fn list_workspaces_by_ref(
        &self,
        user_id: i64,
        refs: &[(String, String)],
    ) -> MysqlResult<Vec<MysqlRow>>;

    /// `list_personal_task_candidates_after`: one page of the owner's personal
    /// task candidates with the keyset cursor.
    async fn list_personal_task_candidates(
        &self,
        user_id: i64,
        limit: i64,
        cursor: Option<(chrono::NaiveDateTime, i64)>,
        client_origin: Option<&str>,
    ) -> MysqlResult<Vec<MysqlRow>>;

    /// `task_store.list_owned_task_ids`: one page of the user's owned active
    /// non-system tasks, newest `(created_at, id)` first, plus the source
    /// total. The caller passes `limit + extra_limit` as `limit`; a sharded
    /// deployment merges the base and owner-shard tables.
    async fn list_owned_task_ids(
        &self,
        user_id: i64,
        skip: i64,
        limit: i64,
    ) -> MysqlResult<OwnedTaskPage>;

    /// `task_store.list_by_ids`: the full task projection for `task_ids` with
    /// no owner filter. An empty `task_ids` issues no statement.
    async fn list_tasks_by_ids(&self, task_ids: &[i64]) -> MysqlResult<Vec<MysqlRow>>;

    /// `task_store.list_group_task_ids_for_accessible_user`: the ids of the
    /// user's active non-system group-chat tasks they own or hold an approved
    /// membership in. The single-table store reads the owner rows and the
    /// joined member rows; the sharded store resolves the member rows through
    /// `list_by_ids` and filters them in Rust.
    async fn list_group_task_ids_for_accessible_user(&self, user_id: i64) -> MysqlResult<Vec<i64>>;

    /// `task_store.count_non_deleted_by_ids`: how many of `task_ids` are not
    /// JSON-deleted. An empty `task_ids` issues no statement and counts zero.
    async fn count_non_deleted_by_ids(&self, task_ids: &[i64]) -> MysqlResult<i64>;

    /// `task_store.list_by_ids_ordered`: the page of `task_ids` after the
    /// optional `DELETE` exclusion, ordered by `order_field` (`id`,
    /// `created_at`, or `updated_at`, validated by the caller), then bounded by
    /// `skip`/`limit`. The single-table store orders in SQL; the sharded store
    /// re-orders by the caller's `task_ids` order.
    async fn list_by_ids_ordered(
        &self,
        task_ids: &[i64],
        order_field: &str,
        descending: bool,
        skip: i64,
        limit: Option<i64>,
        exclude_deleted: bool,
    ) -> MysqlResult<Vec<MysqlRow>>;

    /// `task_store.get_workspace_by_ref`: the owner's workspace row for that
    /// reference, or no row when the deployment resolves none.
    async fn get_workspace_by_ref(
        &self,
        owner_user_id: i64,
        name: &str,
        namespace: &str,
    ) -> MysqlResult<Option<MysqlRow>>;

    /// `SubtaskStore.list_by_task_for_user_ordered`: the task's subtasks that
    /// belong to one user, ordered by `message_id`.
    async fn list_subtasks_for_user(
        &self,
        task_id: i64,
        user_id: i32,
    ) -> MysqlResult<Vec<MysqlRow>>;

    /// `task_store.get_task_by_states` with `states = [STATE_ACTIVE]` and an
    /// explicit owner.
    async fn get_active_task_owned(
        &self,
        task_id: i64,
        owner_user_id: i32,
    ) -> MysqlResult<Option<MysqlRow>>;

    /// `subtask_store.get_by_id`: one subtask's `(id, user_id, task_id)`.
    async fn get_subtask_ref(&self, subtask_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `subtask_store.list_by_user` (limit 1): the newest subtask of one user.
    async fn get_latest_subtask_ref_for_user(&self, user_id: i32) -> MysqlResult<Option<MysqlRow>>;

    /// `task_store.get_by_id`: one task's `(id, user_id, kind)`.
    async fn get_task_ref(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `TaskStore.get_by_id`: the full task projection.
    async fn get_task(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `subtask_store.list_by_task` (`query.all()`, no ordering): the task's
    /// subtasks.
    async fn list_subtasks_by_task(&self, task_id: i64) -> MysqlResult<Vec<MysqlRow>>;

    /// `task_store.list_active_project_tasks`: the active tasks of one project
    /// owned by `owner_user_id`, newest `updated_at` first.
    async fn list_active_project_tasks(
        &self,
        project_id: i64,
        owner_user_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<Vec<MysqlRow>>;

    /// `task_store.get_active_project_task`: the active task of one project
    /// owned by `owner_user_id`, optionally scoped to a client origin.
    async fn get_active_project_task(
        &self,
        task_id: i64,
        project_id: i64,
        owner_user_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<Option<MysqlRow>>;

    /// `task_store.update_fields(project_id = 0)` followed by
    /// `task_store.update_json`: one committed update that clears the task's
    /// project link and rewrites its CRD JSON. `owner_user_id` lets a
    /// deployment resolve the same table `get_active_project_task` read.
    async fn set_task_project_and_json(
        &self,
        task_id: i64,
        project_id: i64,
        owner_user_id: i64,
        json: &str,
        updated_at: chrono::NaiveDateTime,
    ) -> MysqlResult<()>;

    /// `task_store.clear_project_for_owned_tasks`: detach one project's tasks
    /// owned by `owner_user_id` by setting `project_id = 0`, returning the
    /// number of rows the store updated. A single-table deployment runs one
    /// update; a sharded deployment clears the base table and the owner's
    /// shard.
    async fn clear_project_for_owned_tasks(
        &self,
        project_id: i64,
        owner_user_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<u64>;

    /// `task_store.get_by_id` restricted to one owner: the full task
    /// projection of that owner's task.
    async fn get_task_owned(
        &self,
        task_id: i64,
        owner_user_id: i64,
    ) -> MysqlResult<Option<MysqlRow>>;

    /// `subtask_store.list_ids_by_task`: the task's subtask ids.
    async fn list_subtask_ids_by_task(&self, task_id: i64) -> MysqlResult<Vec<MysqlRow>>;

    /// `subtask_store.list_by_task_ordered` with the source's default
    /// `order_by`: the task's subtasks ordered `message_id`, `created_at`,
    /// with the contexts the source attaches on the path that reads a table
    /// the deployment resolved itself.
    async fn list_subtasks_by_task_ordered(
        &self,
        task_id: i64,
        owner_user_id: i64,
    ) -> MysqlResult<SubtaskListing>;

    /// `task_store.get_active_non_deleted_task`: the active task of one id,
    /// before the caller's `_is_json_deleted` filter.
    async fn get_active_task_by_id(
        &self,
        task_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<Option<MysqlRow>>;

    /// `_owner_matches_task_id`: whether `owner_user_id` owns the task, or is
    /// the only user its subtasks belong to.
    async fn task_owner_matches(&self, task_id: i64, owner_user_id: i64) -> MysqlResult<bool>;

    /// `task_store.get_active_or_archived_task`: the task row for `task_id`
    /// when it is an active or archived `Task`, optionally scoped to a client
    /// origin. This read carries no owner filter; the delete path checks the
    /// owner itself.
    async fn get_active_or_archived_task(
        &self,
        task_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<Option<MysqlRow>>;

    /// `_handle_member_leave`'s `task_store.get_active_task`: the active task
    /// for `task_id`, optionally scoped to a client origin, with no owner
    /// filter.
    async fn get_active_task_for_origin(
        &self,
        task_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<Option<MysqlRow>>;

    /// `task_store.get_owned_active_task`: the active task of `task_id` owned
    /// by `user_id`, optionally scoped to a client origin.
    async fn get_owned_active_task(
        &self,
        task_id: i64,
        user_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<Option<MysqlRow>>;

    /// `subtask_store.list_by_task_unfiltered`: every subtask of `task_id`,
    /// with the owner filter the resolved table requires.
    async fn list_subtasks_by_task_unfiltered(
        &self,
        task_id: i64,
        owner_user_id: i64,
    ) -> MysqlResult<Vec<MysqlRow>>;

    /// `_queue_bulk_status_metrics`'s read plus `mark_task_subtasks_deleted`:
    /// the failed assistant subtasks are read first (for run metrics), then
    /// the matching subtask ids, then every subtask of `task_id` is set to
    /// `DELETE`. Returns the number of updated rows.
    async fn mark_task_subtasks_deleted(
        &self,
        task_id: i64,
        owner_user_id: i64,
        updated_at: &str,
    ) -> MysqlResult<u64>;

    /// `task_store.soft_delete_task`: rewrite the task's json, clear its active
    /// flag, and stamp `updated_at`.
    async fn soft_delete_task(
        &self,
        task_id: i64,
        owner_user_id: i64,
        json: &str,
        updated_at: &str,
    ) -> MysqlResult<u64>;

    /// `task_store.update_json` on a task or workspace row: rewrite its json
    /// and stamp `updated_at`.
    async fn update_task_json(
        &self,
        task_id: i64,
        owner_user_id: i64,
        json: &str,
        updated_at: &str,
    ) -> MysqlResult<u64>;
}

/// The single-table store: every statement reads the base `tasks` /
/// `subtasks` tables on the handle it was built with.
pub struct DefaultTaskStore<M: Mysql> {
    pub(crate) mysql: M,
}

impl<M: Mysql> DefaultTaskStore<M> {
    pub fn new(mysql: M) -> Self {
        Self { mysql }
    }
}

#[async_trait]
impl<M: Mysql> TaskStore for DefaultTaskStore<M> {
    async fn list_running_tasks(
        &self,
        _user_id: i64,
        task_ids: &[i64],
    ) -> MysqlResult<Vec<MysqlRow>> {
        if task_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.mysql
            .fetch_all(
                running_tasks_by_ids_statement(TASKS_TABLE, task_ids.len()),
                task_ids.to_vec(),
            )
            .await
    }

    async fn get_active_task(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(active_task_statement(TASKS_TABLE), (task_id,))
            .await
    }

    async fn get_accessible_task(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>> {
        // The single-table store has one table to resolve, so the access
        // store's read is the same statement as `get_active_task`.
        self.get_active_task(task_id).await
    }

    async fn get_runtime_state(&self, task_id: i64, user_id: i64) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(
                runtime_state_statement(TASKS_TABLE),
                (task_id, user_id, task_id, user_id.to_string()),
            )
            .await
    }

    async fn get_task_owner_id(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(task_owner_statement(TASKS_TABLE), (task_id,))
            .await
    }

    async fn list_subtasks_ordered(
        &self,
        task_id: i64,
        message_ids: Option<&[i64]>,
    ) -> MysqlResult<Vec<MysqlRow>> {
        if message_ids.is_some_and(|ids| ids.is_empty()) {
            return Ok(Vec::new());
        }
        self.mysql
            .fetch_all(
                subtasks_ordered_statement(SUBTASKS_TABLE, message_ids.unwrap_or_default()),
                (task_id,),
            )
            .await
    }

    async fn list_recent_owner_only_tasks(
        &self,
        user_id: i64,
        limit: i64,
    ) -> MysqlResult<Vec<MysqlRow>> {
        self.mysql
            .fetch_all(
                recent_owner_only_tasks_statement(TASKS_TABLE),
                (user_id, limit),
            )
            .await
    }

    async fn list_workspaces_by_ref(
        &self,
        user_id: i64,
        refs: &[(String, String)],
    ) -> MysqlResult<Vec<MysqlRow>> {
        if refs.is_empty() {
            return Ok(Vec::new());
        }
        self.mysql
            .fetch_all(workspaces_by_ref_statement(TASKS_TABLE, user_id, refs), ())
            .await
    }

    async fn list_personal_task_candidates(
        &self,
        user_id: i64,
        limit: i64,
        cursor: Option<(chrono::NaiveDateTime, i64)>,
        client_origin: Option<&str>,
    ) -> MysqlResult<Vec<MysqlRow>> {
        // Argument order follows the predicate order: `user_id`, the optional
        // origin, the optional keyset (`created_at` twice, then `id`), `limit`.
        let mut args: Vec<StatementArg> = vec![StatementArg::Int(user_id)];
        if let Some(origin) = client_origin {
            args.push(StatementArg::Str(origin.to_string()));
        }
        if let Some((created_at, id)) = cursor {
            args.push(StatementArg::DateTime(created_at));
            args.push(StatementArg::DateTime(created_at));
            args.push(StatementArg::Int(id));
        }
        args.push(StatementArg::Int(limit));
        self.mysql
            .fetch_all(
                personal_task_candidates_statement(
                    TASKS_TABLE,
                    client_origin.is_some(),
                    cursor.is_some(),
                ),
                args,
            )
            .await
    }

    async fn list_owned_task_ids(
        &self,
        user_id: i64,
        skip: i64,
        limit: i64,
    ) -> MysqlResult<OwnedTaskPage> {
        let totals = self
            .mysql
            .fetch_all(owned_task_count_statement(TASKS_TABLE), (user_id,))
            .await?;
        let total = totals
            .first()
            .map_or(Ok(0), |row: &MysqlRow| row.get_required::<i64>("count_1"))?;
        let rows = self
            .mysql
            .fetch_all(
                owned_task_ids_statement(TASKS_TABLE, skip > 0),
                (user_id, limit, skip),
            )
            .await?;
        let ids = rows
            .iter()
            .map(|row: &MysqlRow| row.get_required::<i64>("id"))
            .collect::<MysqlResult<Vec<_>>>()?;
        Ok(OwnedTaskPage { total, ids })
    }

    async fn list_tasks_by_ids(&self, task_ids: &[i64]) -> MysqlResult<Vec<MysqlRow>> {
        if task_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.mysql
            .fetch_all(
                tasks_by_ids_statement(TASKS_TABLE, task_ids.len()),
                task_ids.to_vec(),
            )
            .await
    }

    async fn list_group_task_ids_for_accessible_user(&self, user_id: i64) -> MysqlResult<Vec<i64>> {
        // `_OWNED_GROUP_CHAT_SQL` then `_MEMBER_TASK_IDS_SQL`, unioned as sets;
        // the id list keeps a stable order so a caller can re-order or count it.
        let owned: Vec<MysqlRow> = self
            .mysql
            .fetch_all(owned_group_chat_ids_statement(TASKS_TABLE), (1i8, user_id))
            .await?;
        let members: Vec<MysqlRow> = self
            .mysql
            .fetch_all(
                member_task_ids_statement(TASKS_TABLE),
                (user_id.to_string(), 1i8),
            )
            .await?;
        let mut ids: Vec<i64> = Vec::new();
        for row in owned.iter().chain(members.iter()) {
            let id = row.get_required::<i64>("id")?;
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        Ok(ids)
    }

    async fn count_non_deleted_by_ids(&self, task_ids: &[i64]) -> MysqlResult<i64> {
        if task_ids.is_empty() {
            return Ok(0);
        }
        let rows: Vec<MysqlRow> = self
            .mysql
            .fetch_all(
                count_non_deleted_tasks_statement(TASKS_TABLE, task_ids.len()),
                task_ids.to_vec(),
            )
            .await?;
        match rows.first() {
            Some(row) => row.get_required("count_1"),
            None => Ok(0),
        }
    }

    async fn list_by_ids_ordered(
        &self,
        task_ids: &[i64],
        order_field: &str,
        descending: bool,
        skip: i64,
        limit: Option<i64>,
        exclude_deleted: bool,
    ) -> MysqlResult<Vec<MysqlRow>> {
        if task_ids.is_empty() {
            return Ok(Vec::new());
        }
        let sql = tasks_by_ids_ordered_statement(
            TASKS_TABLE,
            task_ids.len(),
            order_field,
            descending,
            exclude_deleted,
            skip > 0,
        );
        // Argument order follows the statement: the id list, then the page
        // bounds (the source binds `LIMIT` before `OFFSET`). A missing limit is
        // the SQLAlchemy unbounded sentinel: every row the page can hold.
        let mut args: Vec<StatementArg> = task_ids.iter().copied().map(StatementArg::Int).collect();
        args.push(StatementArg::Int(limit.unwrap_or(i64::MAX)));
        if skip > 0 {
            args.push(StatementArg::Int(skip));
        }
        self.mysql.fetch_all(sql, args).await
    }

    async fn get_workspace_by_ref(
        &self,
        owner_user_id: i64,
        name: &str,
        namespace: &str,
    ) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(
                workspace_by_ref_statement(TASKS_TABLE),
                (owner_user_id, name, namespace),
            )
            .await
    }

    async fn list_subtasks_for_user(
        &self,
        task_id: i64,
        user_id: i32,
    ) -> MysqlResult<Vec<MysqlRow>> {
        self.mysql
            .fetch_all(
                subtasks_by_owner_statement(SUBTASKS_TABLE),
                (task_id, user_id),
            )
            .await
    }

    async fn get_active_task_owned(
        &self,
        task_id: i64,
        owner_user_id: i32,
    ) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(
                active_task_owned_statement(TASKS_TABLE),
                (task_id, owner_user_id),
            )
            .await
    }

    async fn get_subtask_ref(&self, subtask_id: i64) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(subtask_ref_statement(SUBTASKS_TABLE), (subtask_id,))
            .await
    }

    async fn get_latest_subtask_ref_for_user(&self, user_id: i32) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(latest_subtask_ref_statement(SUBTASKS_TABLE), (user_id,))
            .await
    }

    async fn get_task_ref(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(task_ref_statement(TASKS_TABLE), (task_id,))
            .await
    }

    async fn get_task(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(task_by_id_statement(TASKS_TABLE), (task_id,))
            .await
    }

    async fn list_subtasks_by_task(&self, task_id: i64) -> MysqlResult<Vec<MysqlRow>> {
        self.mysql
            .fetch_all(subtasks_by_task_statement(SUBTASKS_TABLE), (task_id,))
            .await
    }

    async fn list_active_project_tasks(
        &self,
        project_id: i64,
        owner_user_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<Vec<MysqlRow>> {
        let sql = project_tasks_statement(TASKS_TABLE, client_origin.is_some());
        match client_origin {
            Some(origin) => {
                self.mysql
                    .fetch_all(sql, (project_id, owner_user_id, origin))
                    .await
            }
            None => self.mysql.fetch_all(sql, (project_id, owner_user_id)).await,
        }
    }

    async fn get_active_project_task(
        &self,
        task_id: i64,
        project_id: i64,
        owner_user_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<Option<MysqlRow>> {
        fetch_active_project_task(
            &self.mysql,
            TASKS_TABLE,
            task_id,
            project_id,
            owner_user_id,
            client_origin,
        )
        .await
    }

    async fn set_task_project_and_json(
        &self,
        task_id: i64,
        project_id: i64,
        _owner_user_id: i64,
        json: &str,
        updated_at: chrono::NaiveDateTime,
    ) -> MysqlResult<()> {
        update_task_project_and_json(
            &self.mysql,
            TASKS_TABLE,
            task_id,
            project_id,
            json,
            updated_at,
        )
        .await
    }

    async fn clear_project_for_owned_tasks(
        &self,
        project_id: i64,
        owner_user_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<u64> {
        // `TaskResource.updated_at`'s Python-side `onupdate` binds first; the
        // single-table store runs the one bulk update the base store issues.
        let timestamp = task_update_timestamp();
        let sql = clear_project_update_statement(TASKS_TABLE, client_origin.is_some());
        let execution = match client_origin {
            Some(origin) => {
                self.mysql
                    .execute(sql, (timestamp.as_str(), project_id, owner_user_id, origin))
                    .await?
            }
            None => {
                self.mysql
                    .execute(sql, (timestamp.as_str(), project_id, owner_user_id))
                    .await?
            }
        };
        Ok(execution.rows_affected)
    }

    async fn get_task_owned(
        &self,
        task_id: i64,
        owner_user_id: i64,
    ) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(
                task_by_id_owned_statement(TASKS_TABLE),
                (task_id, owner_user_id),
            )
            .await
    }

    async fn list_subtask_ids_by_task(&self, task_id: i64) -> MysqlResult<Vec<MysqlRow>> {
        self.mysql
            .fetch_all(subtask_ids_by_task_statement(SUBTASKS_TABLE), (task_id,))
            .await
    }

    async fn list_subtasks_by_task_ordered(
        &self,
        task_id: i64,
        _owner_user_id: i64,
    ) -> MysqlResult<SubtaskListing> {
        let rows = self
            .mysql
            .fetch_all(
                subtasks_by_message_ordered_statement(SUBTASKS_TABLE),
                (task_id,),
            )
            .await?;
        // The open-source store leaves the contexts to its callers, as the
        // base store does.
        Ok(SubtaskListing {
            rows,
            contexts: None,
        })
    }

    async fn get_active_task_by_id(
        &self,
        task_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<Option<MysqlRow>> {
        let sql = active_task_by_id_statement(TASKS_TABLE, true, client_origin.is_some());
        match client_origin {
            Some(origin) => self.mysql.fetch_optional(sql, (task_id, origin)).await,
            None => self.mysql.fetch_optional(sql, (task_id,)).await,
        }
    }

    async fn task_owner_matches(&self, task_id: i64, owner_user_id: i64) -> MysqlResult<bool> {
        let row: Option<MysqlRow> = self
            .mysql
            .fetch_optional(
                owner_matches_task_id_statement(TASKS_TABLE),
                (task_id, owner_user_id),
            )
            .await?;
        if row.is_some() {
            return Ok(true);
        }
        let owners: Vec<MysqlRow> = self
            .mysql
            .fetch_all(
                distinct_subtask_owners_statement(SUBTASKS_TABLE),
                (task_id,),
            )
            .await?;
        if owners.len() != 1 {
            return Ok(false);
        }
        Ok(owners[0].get_required::<i64>("user_id")? == owner_user_id)
    }

    async fn get_active_or_archived_task(
        &self,
        task_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<Option<MysqlRow>> {
        let sql = active_or_archived_task_statement(TASKS_TABLE, client_origin.is_some());
        match client_origin {
            Some(origin) => self.mysql.fetch_optional(sql, (task_id, origin)).await,
            None => self.mysql.fetch_optional(sql, (task_id,)).await,
        }
    }

    async fn get_active_task_for_origin(
        &self,
        task_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<Option<MysqlRow>> {
        let sql = active_task_for_origin_statement(TASKS_TABLE, client_origin.is_some());
        match client_origin {
            Some(origin) => self.mysql.fetch_optional(sql, (task_id, origin)).await,
            None => self.mysql.fetch_optional(sql, (task_id,)).await,
        }
    }

    async fn get_owned_active_task(
        &self,
        task_id: i64,
        user_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<Option<MysqlRow>> {
        let sql = owned_active_task_statement(TASKS_TABLE, client_origin.is_some());
        match client_origin {
            Some(origin) => {
                self.mysql
                    .fetch_optional(sql, (task_id, user_id, origin))
                    .await
            }
            None => self.mysql.fetch_optional(sql, (task_id, user_id)).await,
        }
    }

    async fn list_subtasks_by_task_unfiltered(
        &self,
        task_id: i64,
        owner_user_id: i64,
    ) -> MysqlResult<Vec<MysqlRow>> {
        let sql = subtasks_by_task_unfiltered_statement(SUBTASKS_TABLE, true);
        self.mysql.fetch_all(sql, (task_id, owner_user_id)).await
    }

    async fn mark_task_subtasks_deleted(
        &self,
        task_id: i64,
        owner_user_id: i64,
        updated_at: &str,
    ) -> MysqlResult<u64> {
        // `_queue_bulk_status_metrics`: the failed assistant subtasks feeding
        // the run-metric hook, read before the update.
        let _metrics: Vec<MysqlRow> = self
            .mysql
            .fetch_all(
                failed_assistant_subtasks_statement(SUBTASKS_TABLE, true),
                (task_id, owner_user_id),
            )
            .await?;
        // SQLAlchemy runs the `synchronize_session='fetch'` id read before the
        // bulk update, so the statement order matches the source.
        let _ids: Vec<MysqlRow> = self
            .mysql
            .fetch_all(
                subtask_ids_for_update_statement(SUBTASKS_TABLE, true),
                (task_id, owner_user_id),
            )
            .await?;
        let sql = mark_subtasks_deleted_statement(SUBTASKS_TABLE, true);
        self.mysql
            .execute(sql, (true, "DELETE", updated_at, task_id, owner_user_id))
            .await
            .map(|outcome| outcome.rows_affected)
    }

    async fn soft_delete_task(
        &self,
        task_id: i64,
        _owner_user_id: i64,
        json: &str,
        updated_at: &str,
    ) -> MysqlResult<u64> {
        let sql = soft_delete_task_statement(TASKS_TABLE);
        self.mysql
            .execute(sql, (json, 0i8, updated_at, task_id))
            .await
            .map(|outcome| outcome.rows_affected)
    }

    async fn update_task_json(
        &self,
        task_id: i64,
        _owner_user_id: i64,
        json: &str,
        updated_at: &str,
    ) -> MysqlResult<u64> {
        let sql = update_task_json_statement(TASKS_TABLE);
        self.mysql
            .execute(sql, (json, updated_at, task_id))
            .await
            .map(|outcome| outcome.rows_affected)
    }
}

#[cfg(test)]
#[path = "task_store_tests.rs"]
mod tests;
