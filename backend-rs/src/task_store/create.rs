// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! [`DefaultTaskStore`]'s task/subtask creation methods
//! (`create_pending_task_shell_with_workspace`, `create_user_and_assistant_
//! subtasks`, `max_subtask_message_id`, and the `create_new_task` name/json
//! update). Split into a focused module so `task_store.rs` stays within the
//! source-file bound; a sharded deployment implements the same trait methods in
//! `ShardedTaskStore`.
use async_trait::async_trait;
use brz_mysql::{Mysql, MysqlResult};

use super::{DefaultTaskStore, SUBTASKS_TABLE, TASKS_TABLE};
use crate::task_store_create::TaskStoreCreate;

#[async_trait]
impl<M: Mysql> TaskStoreCreate for DefaultTaskStore<M> {
    async fn rename_and_update_task_json(
        &self,
        task_id: i64,
        _owner_user_id: i64,
        name: &str,
        json: &str,
        updated_at: &str,
    ) -> MysqlResult<u64> {
        crate::task_store_create::update_task_name_and_json(
            &self.mysql,
            TASKS_TABLE,
            task_id,
            name,
            json,
            updated_at,
        )
        .await
    }

    async fn create_task_shell_with_workspace(
        &self,
        request: &crate::task_store_create::CreateTaskShellRequest<'_>,
    ) -> MysqlResult<(i64, i64)> {
        crate::task_store_create::create_task_shell_with_workspace(
            &self.mysql,
            TASKS_TABLE,
            "sa_savepoint_1",
            None,
            request,
        )
        .await
    }

    async fn create_user_and_assistant_subtasks_with_executor_reference(
        &self,
        mysql: &brz_mysql::MysqlService,
        savepoint: &str,
        request: &crate::task_store_create::CreateSubtasksRequest<'_>,
    ) -> MysqlResult<crate::task_store_executor_reference::SubtaskPairInsert> {
        crate::task_store_executor_reference::create_subtask_pair_with_executor_reference(
            mysql,
            TASKS_TABLE,
            SUBTASKS_TABLE,
            savepoint,
            false,
            request,
        )
        .await
    }

    async fn max_subtask_message_id(&self, task_id: i64) -> MysqlResult<Option<i64>> {
        crate::task_store_create::max_subtask_message_id(&self.mysql, SUBTASKS_TABLE, task_id).await
    }
}
