// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Deployment extension point for task and subtask row reads.
//!
//! The public store ([`DefaultTaskStore`]) reads the single `tasks` and
//! `subtasks` tables directly; an application whose deployment resolves task
//! storage differently registers its own [`TaskStore`] through
//! `AppState::task_store` before route construction. Methods return raw rows so
//! each caller keeps its own typed projection, and tests drive the store
//! through the same handle abstraction.
use async_trait::async_trait;
use brz_mysql::{Mysql, MysqlResult, MysqlRow};

use crate::tasks_search::statements::tasks_by_ids_statement;

pub use crate::task_store_default::DefaultTaskStore;
pub use crate::task_store_listing::{
    OwnedTaskPage, SubtaskListing, SubtaskPage, count_subtasks_by_task, load_subtasks_by_ids,
    ordered_subtasks_for_user, page_subtasks_by_task, subtask_context_columns,
};
pub use crate::task_store_pipeline::{PipelineStageAdvance, advance_pipeline_stage};
pub use crate::task_store_project::{
    active_project_task_statement, fetch_active_project_task, task_by_id_refresh_statement,
    task_project_update_statement, update_task_project_and_json,
};
pub use crate::task_store_projects::{
    clear_project_ids_statement, clear_project_update_statement, project_tasks_statement,
    task_update_timestamp,
};
pub use crate::task_store_statements::task_column_index;
pub use crate::task_store_tables::TableTemplates;

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

pub use crate::task_store_cancel_statements::{
    running_assistant_for_user_statement, update_subtask_cancelled_statement,
};
pub use crate::task_store_create::*;
pub use crate::task_store_edit::*;
pub use crate::task_store_executor_reference::{
    AssistantExecutor, SubtaskPairInsert, consume_executor_reference,
    create_subtask_pair_with_executor_reference, latest_assistant_executor_statement,
    task_for_update_first_statement,
};
pub use crate::task_store_project_count::{
    TaskStoreProjectCount, active_task_status_predicate, count_active_project_tasks_read,
    count_active_tasks_by_project_read,
};
pub use crate::task_store_public_share::TaskStorePublicShare;
pub use crate::task_store_statements::*;
pub use crate::task_store_subtask_content::{SubtaskContentField, execute_subtask_content_update};

pub use crate::task_store_traits::{DeletedSubtasks, TaskStore};

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

    async fn get_regular_active_task(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(regular_active_task_statement(TASKS_TABLE), (task_id,))
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
        ordered_subtasks_for_user(&self.mysql, SUBTASKS_TABLE, task_id, user_id).await
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

    async fn running_assistant_for_user(
        &self,
        task_id: i64,
        user_id: i64,
    ) -> MysqlResult<Option<MysqlRow>> {
        crate::task_store_subtask_writes::running_assistant_for_user(self, task_id, user_id).await
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

    async fn update_subtask_cancelled(
        &self,
        _task_id: i64,
        subtask_id: i64,
        updated_at: &str,
        completed_at: &str,
        reset_error_message: bool,
    ) -> MysqlResult<u64> {
        crate::task_store_subtask_writes::update_subtask_cancelled(
            self,
            subtask_id,
            updated_at,
            completed_at,
            reset_error_message,
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
    ) -> MysqlResult<DeletedSubtasks> {
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

    async fn has_running_assistant(&self, task_id: i64) -> MysqlResult<bool> {
        let row: Option<MysqlRow> = self
            .mysql
            .fetch_optional(running_assistant_statement(SUBTASKS_TABLE), (task_id,))
            .await?;
        Ok(row.is_some())
    }

    async fn message_edit_tables(&self, _task_id: i64) -> MysqlResult<MessageEditTables> {
        // The single-table store has no model selection to run: every id reads
        // the base tables, and `_filter_owner_user_id` is part of each
        // statement.
        Ok(MessageEditTables {
            tasks: TASKS_TABLE.to_owned(),
            subtasks: SUBTASKS_TABLE.to_owned(),
            ownership: MessageEditOwnership::StatementFilter,
        })
    }

    fn table_templates(&self) -> TableTemplates {
        crate::task_store_tables::default_table_templates()
    }
}

#[cfg(test)]
#[path = "task_store_tests.rs"]
mod tests;

mod create;
