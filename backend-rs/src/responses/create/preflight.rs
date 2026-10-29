// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The dependency reads the create flow performs before it resolves the bot's
//! model.
//!
//! The source runs two read groups ahead of `TaskRequestBuilder.build`'s
//! `_get_model_config` (`request_builder.py:324`):
//!
//! * `prepare_execution_request`'s guarded generation-context enrichment
//!   (`chat/trigger/request_preparation.py:868-878`): the current subtask's
//!   attachment contexts, the task's subtasks, and their ready attachment
//!   contexts; the reads run even when the results are empty
//!   (`context/context_service.py:1971-2058`);
//! * `_build_workspace` (`request_builder.py:286`, `:2970-3039`): the Task's
//!   `workspaceRef` through `task_store.get_workspace_by_ref`, then the
//!   guarded Project of `_merge_project_workspace` (`:3119-3143`).
//!
//! Both groups therefore run before a model lookup can raise
//! `400 Model <name> not found`.
use serde_json::Value;

use super::contexts;
use super::skill_generation;
use crate::http_compat::FastApiError;
use crate::task_store::TaskStore;

/// `subtask_store.list_by_task_unfiltered`: the task's subtask ids, in the
/// store's order, feeding `context_service.get_attachments_by_task`
/// (`backend/app/services/context/context_service.py:2042`). The source call
/// passes no `owner_user_id`, so the sharded store's `_owner_matches_task_id`
/// probe returns true
/// before any query and the read carries no `user_id` filter.
async fn subtask_ids(task_store: &dyn TaskStore, task_id: i64) -> Result<Vec<i64>, FastApiError> {
    let rows = task_store
        .list_subtasks_by_task_unfiltered(task_id, None)
        .await
        .map_err(super::request::dependency)?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let index = crate::task_store::subtask_column_index("id")?;
            row.get_at::<Option<i64>>(index).ok().flatten()
        })
        .collect())
}

/// `prepare_execution_request`'s generation-context enrichment inputs
/// (`request_preparation.py:868-878`): the current subtask's attachment
/// contexts and the task's ready attachment contexts.
pub(super) async fn generation_context<M: brz_mysql::Mysql>(
    mysql: &M,
    task_store: &dyn TaskStore,
    task_id: i64,
    user_subtask_id: i64,
    user_id: i64,
) -> Result<Option<Value>, FastApiError> {
    let current_attachments = contexts::attachments_by_subtask(mysql, user_subtask_id)
        .await
        .map_err(super::request::dependency)?;
    let task_subtask_ids = subtask_ids(task_store, task_id).await?;
    let task_attachments = contexts::attachments_by_task(mysql, &task_subtask_ids)
        .await
        .map_err(super::request::dependency)?;
    Ok(skill_generation::enrich_skill_generation_context(
        None,
        &current_attachments,
        &task_attachments,
        user_subtask_id,
        user_id,
    ))
}

/// The two reads of `_build_workspace` that precede the model resolution.
pub(super) struct WorkspaceReads {
    /// `get_workspace_by_ref`'s `spec.repository` projection and branch.
    pub(super) workspace_resource: Option<(Value, String)>,
    /// The Task's stored Project configuration, when it has a `project_id`.
    pub(super) project_config: Option<Value>,
}

pub(super) async fn workspace<M: brz_mysql::Mysql>(
    mysql: &M,
    task_store: &dyn TaskStore,
    task_json: &Value,
    project_id: i64,
    user_id: i64,
) -> WorkspaceReads {
    let workspace_resource =
        super::project_workspace::workspace_repository(task_store, task_json, user_id).await;
    let project_config =
        super::project_workspace::load_project_config(mysql, project_id, user_id).await;
    WorkspaceReads {
        workspace_resource,
        project_config,
    }
}
