// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `SharedTaskService.get_public_shared_task`'s task/subtask reads
//! (`GET /api/tasks/share/public`).
//!
//! Split from [`TaskStore`](crate::task_store::TaskStore) so each source file
//! stays within the file-size bound; `TaskStore` extends this trait, so
//! `dyn TaskStore` still exposes both methods.
use async_trait::async_trait;
use brz_mysql::{Mysql, MysqlResult, MysqlRow};

use crate::task_store::DefaultTaskStore;
use crate::task_store_statements::{
    SUBTASKS_TABLE, TASKS_TABLE, active_states_task_owned_statement,
    non_deleted_subtasks_by_message_ordered_statement,
};

/// The public shared-task reads: the active owned task and its non-deleted
/// subtasks, as the source's `task_store.get_task_by_states` and
/// `subtask_store.list_by_task_ordered(exclude_deleted=True)` render them.
#[async_trait]
pub trait TaskStorePublicShare: Send + Sync {
    /// `task_store.get_task_by_states` with
    /// `states = TaskResource.is_active_query()` (`[STATE_ACTIVE,
    /// STATE_SUBSCRIPTION]`) and an explicit `user_id`
    /// (`SharedTaskService.get_public_shared_task`). Unlike
    /// [`TaskStore::get_active_task_owned`](crate::task_store::TaskStore::get_active_task_owned),
    /// both active states pass the filter.
    async fn get_active_states_task_owned(
        &self,
        task_id: i64,
        owner_user_id: i32,
    ) -> MysqlResult<Option<MysqlRow>>;

    /// `subtask_store.list_by_task_ordered` with `exclude_deleted=True` and the
    /// source's default `order_by` (`message_id`, `created_at`): the task's
    /// non-deleted subtasks.
    async fn list_non_deleted_subtasks_ordered(&self, task_id: i64) -> MysqlResult<Vec<MysqlRow>>;
}

#[async_trait]
impl<M: Mysql> TaskStorePublicShare for DefaultTaskStore<M> {
    async fn get_active_states_task_owned(
        &self,
        task_id: i64,
        owner_user_id: i32,
    ) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(
                active_states_task_owned_statement(TASKS_TABLE),
                (task_id, owner_user_id),
            )
            .await
    }

    async fn list_non_deleted_subtasks_ordered(&self, task_id: i64) -> MysqlResult<Vec<MysqlRow>> {
        self.mysql
            .fetch_all(
                non_deleted_subtasks_by_message_ordered_statement(SUBTASKS_TABLE),
                (task_id,),
            )
            .await
    }
}
