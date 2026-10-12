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

use crate::tasks_search::statements::tasks_by_ids_statement;

pub use crate::task_store_default::DefaultTaskStore;
pub use crate::task_store_listing::{
    OwnedTaskPage, SubtaskListing, SubtaskPage, count_subtasks_by_task, load_subtasks_by_ids,
    page_subtasks_by_task, subtask_context_columns,
};
pub use crate::task_store_project::{
    active_project_task_statement, fetch_active_project_task, task_by_id_refresh_statement,
    task_project_update_statement, update_task_project_and_json,
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

pub use crate::task_store_create::*;
pub use crate::task_store_statements::*;
pub use crate::task_store_subtask_content::{SubtaskContentField, execute_subtask_content_update};

#[async_trait]
pub trait TaskStore: crate::task_store_create::TaskStoreCreate {
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

    /// `task_store.list_recent_task_team_refs` (`recent_team_refs.py`): the
    /// owner's recent non-group tasks carrying no approved member, projected to
    /// the `metadata.labels.taskType` and `spec.teamRef` JSON extracts. The
    /// source reads the base `tasks` table, so a deployment's sharded store must
    /// not reroute this picker.
    async fn list_recent_task_team_refs(
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

    /// `task_store.list_accessible_task_ids`: one page of the user's accessible
    /// active non-system tasks (owned or approved member), newest `created_at`
    /// first, plus the source's distinct count. The caller passes
    /// `limit + extra_limit` as `limit`.
    async fn list_accessible_task_ids(
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

    /// `task_store.get_task_by_states` with `states = [STATE_ACTIVE]` and no
    /// owner filter (the internal workspace-archive endpoints'
    /// `_get_active_task`): the active `Task` row of `task_id`, whichever user
    /// owns it.
    async fn get_active_task_any_owner(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `subtask_store.get_by_id`: one subtask's `(id, user_id, task_id)`.
    async fn get_subtask_ref(&self, subtask_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `SubtaskStore.get_latest_assistant_for_user_by_statuses`: the newest
    /// assistant subtask of `task_id`/`user_id` whose status is one of
    /// `statuses`, or no row. An empty `statuses` issues no statement.
    async fn latest_assistant_for_user_by_statuses(
        &self,
        task_id: i64,
        user_id: i32,
        statuses: &[&str],
    ) -> MysqlResult<Option<MysqlRow>>;

    /// `subtask_store.update_fields` for the cancel flow: mark one subtask
    /// COMPLETED with its partial result. Returns the affected row count.
    async fn update_subtask_completed(
        &self,
        task_id: i64,
        subtask_id: i64,
        result_json: &str,
        updated_at: &str,
        completed_at: &str,
    ) -> MysqlResult<u64>;

    /// `db.refresh(subtask)`: re-read one subtask row by primary key.
    async fn refresh_subtask(&self, task_id: i64, subtask_id: i64)
    -> MysqlResult<Option<MysqlRow>>;

    /// `subtask_store.list_by_user` (limit 1): the newest subtask of one user.
    async fn get_latest_subtask_ref_for_user(&self, user_id: i32) -> MysqlResult<Option<MysqlRow>>;

    /// `task_store.get_by_id`: one task's `(id, user_id, kind)`.
    async fn get_task_ref(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `TaskStore.get_by_id`: the full task projection.
    async fn get_task(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `subtask_store.get_by_id`: the full subtask row for `subtask_id`
    /// (`db.query(Subtask)`), positioned as [`subtask_by_id_statement`]
    /// projects it.
    async fn get_subtask(&self, subtask_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `subtask_store.update_fields` for the message-content update plus
    /// `db.commit()`: flush the one dirty content column (when the source's
    /// attribute history or `flag_modified` marks it) and `updated_at`, keyed
    /// by the subtask's primary key.
    async fn update_subtask_content(
        &self,
        subtask_id: i64,
        field: Option<&SubtaskContentField>,
        updated_at: &str,
    ) -> MysqlResult<()>;

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

    /// `db.refresh(task)`: the task row re-read by primary key after the
    /// project-link write commits. `owner_user_id` lets a deployment resolve
    /// the same table the write targeted.
    async fn refresh_task(&self, task_id: i64, owner_user_id: i64)
    -> MysqlResult<Option<MysqlRow>>;

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

    /// `subtask_store.list_by_task`: the page of fully-loaded subtask rows for
    /// one task, ordered `message_id, created_at` ascending. `owner_user_id`
    /// carries the non-member filter the caller's `is_member` produced (`Some`
    /// restricts to that owner, `None` keeps the member view);
    /// `before_message_id` bounds older messages, and `from_latest` selects
    /// the descending page before the store restores ascending id order, as
    /// the source does.
    async fn list_subtasks_by_task_for_page(
        &self,
        task_id: i64,
        owner_user_id: Option<i32>,
        before_message_id: Option<i64>,
        from_latest: bool,
        skip: i64,
        limit: i64,
    ) -> MysqlResult<Vec<MysqlRow>>;

    /// `subtask_store.count_by_task_for_user`: the number of subtasks of one
    /// task, with the optional non-member owner filter.
    async fn count_subtasks_for_task(
        &self,
        task_id: i64,
        owner_user_id: Option<i32>,
    ) -> MysqlResult<i64>;

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

    async fn list_recent_task_team_refs(
        &self,
        user_id: i64,
        limit: i64,
    ) -> MysqlResult<Vec<MysqlRow>> {
        self.mysql
            .fetch_all(
                recent_task_team_refs_statement(TASKS_TABLE),
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
        crate::task_store_listing::personal_task_candidates(
            &self.mysql,
            user_id,
            limit,
            cursor,
            client_origin,
        )
        .await
    }

    async fn list_owned_task_ids(
        &self,
        user_id: i64,
        skip: i64,
        limit: i64,
    ) -> MysqlResult<OwnedTaskPage> {
        crate::task_store_listing::owned_task_id_page(&self.mysql, user_id, skip, limit).await
    }

    async fn list_accessible_task_ids(
        &self,
        user_id: i64,
        skip: i64,
        limit: i64,
    ) -> MysqlResult<OwnedTaskPage> {
        crate::task_store_listing::accessible_task_id_page(&self.mysql, user_id, skip, limit).await
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
        crate::task_store_listing::accessible_group_task_ids(&self.mysql, user_id).await
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
        crate::task_store_listing::task_rows_by_ids_ordered(
            &self.mysql,
            task_ids,
            order_field,
            descending,
            skip,
            limit,
            exclude_deleted,
        )
        .await
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

    async fn get_active_task_any_owner(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(active_task_no_owner_statement(TASKS_TABLE), (task_id,))
            .await
    }

    async fn get_subtask_ref(&self, subtask_id: i64) -> MysqlResult<Option<MysqlRow>> {
        crate::task_store_subtask_writes::get_subtask_ref(self, subtask_id).await
    }

    async fn latest_assistant_for_user_by_statuses(
        &self,
        task_id: i64,
        user_id: i32,
        statuses: &[&str],
    ) -> MysqlResult<Option<MysqlRow>> {
        crate::task_store_subtask_writes::latest_assistant_for_user_by_statuses(
            self, task_id, user_id, statuses,
        )
        .await
    }

    async fn update_subtask_completed(
        &self,
        _task_id: i64,
        subtask_id: i64,
        result_json: &str,
        updated_at: &str,
        completed_at: &str,
    ) -> MysqlResult<u64> {
        crate::task_store_subtask_writes::update_subtask_completed(
            self,
            subtask_id,
            result_json,
            updated_at,
            completed_at,
        )
        .await
    }

    async fn refresh_subtask(
        &self,
        _task_id: i64,
        subtask_id: i64,
    ) -> MysqlResult<Option<MysqlRow>> {
        crate::task_store_subtask_writes::refresh_subtask(self, subtask_id).await
    }

    async fn get_latest_subtask_ref_for_user(&self, user_id: i32) -> MysqlResult<Option<MysqlRow>> {
        crate::task_store_subtask_writes::latest_subtask_ref_for_user(self, user_id).await
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

    async fn get_subtask(&self, subtask_id: i64) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(subtask_by_id_statement(SUBTASKS_TABLE), (subtask_id,))
            .await
    }

    async fn update_subtask_content(
        &self,
        subtask_id: i64,
        field: Option<&SubtaskContentField>,
        updated_at: &str,
    ) -> MysqlResult<()> {
        execute_subtask_content_update(&self.mysql, SUBTASKS_TABLE, subtask_id, field, updated_at)
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

    async fn refresh_task(
        &self,
        task_id: i64,
        _owner_user_id: i64,
    ) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(task_by_id_refresh_statement(TASKS_TABLE), (task_id,))
            .await
    }

    async fn clear_project_for_owned_tasks(
        &self,
        project_id: i64,
        owner_user_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<u64> {
        crate::task_store_project::clear_project_for_owned_tasks(
            &self.mysql,
            project_id,
            owner_user_id,
            client_origin,
        )
        .await
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

    async fn list_subtasks_by_task_for_page(
        &self,
        task_id: i64,
        owner_user_id: Option<i32>,
        before_message_id: Option<i64>,
        from_latest: bool,
        skip: i64,
        limit: i64,
    ) -> MysqlResult<Vec<MysqlRow>> {
        page_subtasks_by_task(
            &self.mysql,
            SUBTASKS_TABLE,
            task_id,
            &SubtaskPage {
                owner_user_id,
                before_message_id,
                from_latest,
                skip,
                limit,
            },
        )
        .await
    }

    async fn count_subtasks_for_task(
        &self,
        task_id: i64,
        owner_user_id: Option<i32>,
    ) -> MysqlResult<i64> {
        count_subtasks_by_task(&self.mysql, SUBTASKS_TABLE, task_id, owner_user_id).await
    }

    async fn list_subtasks_by_task_ordered(
        &self,
        task_id: i64,
        _owner_user_id: i64,
    ) -> MysqlResult<SubtaskListing> {
        crate::task_store_listing::ordered_subtasks_by_task(&self.mysql, SUBTASKS_TABLE, task_id)
            .await
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
        crate::task_store_subtask_writes::task_owner_matches(self, task_id, owner_user_id).await
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
        crate::task_store_subtask_writes::mark_subtasks_deleted(
            self,
            task_id,
            owner_user_id,
            updated_at,
        )
        .await
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

mod create;
