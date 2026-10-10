// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/lite/group` — the current user's group-chat task list
//! (`app.api.endpoints.adapter.tasks.get_group_tasks_lite` ->
//! `task_kinds_service.get_user_group_tasks_lite`).
//!
//! Source pipeline:
//! 1. `security.get_current_user` — JWT session decode plus the `users`
//!    lookup through the configured reader;
//! 2. `get_group_task_ids_for_accessible_user` — the owned group-chat tasks
//!    plus the tasks the user is an approved member of, resolved through the
//!    configured task store;
//! 3. `count_non_deleted_tasks_by_ids` — the `total` (JSON-`DELETE` rows
//!    excluded), with the empty-ids and zero-total short circuits;
//! 4. `load_tasks_by_ids_ordered` — the page ordered `updated_at DESC` with
//!    `skip`/`limit` (the sharded store re-orders by the id list instead);
//! 5. `build_lite_task_list` — workspaces, teams, devices, the user cache and
//!    the group-chat member counts (`include_group_chat_info=True`), then the
//!    shared `TaskLite` projection.
use std::collections::HashMap;
use std::sync::Arc;

use brz_http_server::Query;
use brz_mysql::{FromMysqlRow as _, MysqlResult};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::crd::CrdDocument;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::task_store::{TASKS_TABLE, workspaces_by_ref_statement};
use crate::tasks_lite_personal::lite_projection::{
    GroupChatRule, LiteTask, device_display_names, opaque_string, project_lite_tasks,
};
use crate::tasks_lite_personal::lite_repository::{
    TaskCandidateRow, TeamRefs, approved_group_chat_members, batch_query_teams,
};

/// Validated query parameters. `page >= 1` and `limit` in `1..=100` are the
/// source `Query` constraints; the defaults are `page=1`, `limit=50`.
#[derive(Debug, Deserialize)]
pub struct GroupTasksParams {
    page: Option<i64>,
    limit: Option<i64>,
}

/// `TaskLiteListResponse`: `{total, items}`.
#[derive(Debug, serde::Serialize)]
struct GroupTasksResponse {
    total: i64,
    items: Vec<LiteTask>,
}

/// Fully validated query parameters.
struct ValidatedParams {
    skip: i64,
    limit: i64,
}

impl GroupTasksParams {
    /// FastAPI's `Query(1, ge=1)` / `Query(50, ge=1, le=100)` reject
    /// out-of-range values with 422.
    fn validated(self) -> Result<ValidatedParams, FastApiError> {
        let page = match self.page {
            None => 1,
            Some(page) if page >= 1 => page,
            Some(_) => {
                return Err(validation_error(
                    "page",
                    "Input should be greater than or equal to 1",
                ));
            }
        };
        let limit = match self.limit {
            None => 50,
            Some(limit) if (1..=100).contains(&limit) => limit,
            Some(_) => {
                return Err(validation_error(
                    "limit",
                    "Input should be between 1 and 100",
                ));
            }
        };
        Ok(ValidatedParams {
            skip: (page - 1) * limit,
            limit,
        })
    }
}

/// FastAPI-style 422 validation error body.
fn validation_error(field: &str, message: &str) -> FastApiError {
    FastApiError::validation(json!([
        {
            "type": "value_error",
            "loc": ["query", field],
            "msg": message,
            "input": "",
        }
    ]))
}

/// GET /api/tasks/lite/group: the group tasks-lite free function, injecting
/// the process-lifetime application state.
#[brz_http_server::get("/api/tasks/lite/group")]
async fn get_group_tasks_lite(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] current_user: crate::auth::SessionUser,
    query: Query<GroupTasksParams>,
) -> Result<GroupTasksResponse, FastApiError> {
    let params = GroupTasksParams {
        page: query.page,
        limit: query.limit,
    }
    .validated()?;
    group_tasks_lite(state, i64::from(current_user.id), &params)
        .await
        .map_err(|_| FastApiError::internal())
}

/// Handler body for `GET /api/tasks/lite/group`.
async fn group_tasks_lite(
    state: &Arc<AppState>,
    user_id: i64,
    params: &ValidatedParams,
) -> MysqlResult<GroupTasksResponse> {
    let all_group_task_ids = state
        .task_store
        .list_group_task_ids_for_accessible_user(user_id)
        .await?;
    if all_group_task_ids.is_empty() {
        return Ok(empty_response());
    }
    let total = state
        .task_store
        .count_non_deleted_by_ids(&all_group_task_ids)
        .await?;
    if total == 0 {
        return Ok(empty_response());
    }
    let raw = state
        .task_store
        .list_by_ids_ordered(
            &all_group_task_ids,
            "updated_at",
            true,
            params.skip,
            Some(params.limit),
            true,
        )
        .await?;
    let tasks = raw
        .into_iter()
        .map(TaskCandidateRow::from_mysql_row)
        .collect::<MysqlResult<Vec<_>>>()?;
    let items = build_lite_task_list(state, &tasks, user_id).await?;
    Ok(GroupTasksResponse { total, items })
}

fn empty_response() -> GroupTasksResponse {
    GroupTasksResponse {
        total: 0,
        items: Vec::new(),
    }
}

/// `build_lite_task_list` with `include_group_chat_info=True` (the group list):
/// workspace git repositories, team fields, device names, the user lookup and
/// the group-chat member counts, then the shared per-item projection.
async fn build_lite_task_list(
    state: &Arc<AppState>,
    tasks: &[TaskCandidateRow],
    user_id: i64,
) -> MysqlResult<Vec<LiteTask>> {
    if tasks.is_empty() {
        return Ok(Vec::new());
    }

    // Collect the distinct workspace references and device ids (source sets).
    let mut workspace_refs: Vec<(String, String)> = Vec::new();
    let mut device_ids: Vec<String> = Vec::new();
    for task in tasks {
        let crd = CrdDocument::project(&task.json);
        if let Some(workspace_ref) = crd
            .spec
            .as_ref()
            .and_then(|spec| spec.workspace_ref.as_ref())
        {
            let name = workspace_ref.name();
            let namespace = workspace_ref.namespace();
            let key = (name.to_string(), namespace.to_string());
            if !name.is_empty() && !workspace_refs.contains(&key) {
                workspace_refs.push(key);
            }
        }
        if let Some(device_id) = crd
            .spec
            .as_ref()
            .and_then(|spec| opaque_string(&spec.device_id))
            .filter(|value| !value.is_empty())
            && !device_ids.iter().any(|id| id == &device_id)
        {
            device_ids.push(device_id);
        }
    }
    let team_refs = TeamRefs::from_page(tasks);

    let workspace_data = batch_workspaces(state, user_id, &workspace_refs).await?;
    let team_data = batch_query_teams(&state.mysql, &team_refs, user_id).await?;
    // `userReader.get_by_id` only feeds `user_name`, which the lite projection
    // does not return; the registered reader keeps the source dependency
    // topology.
    let _ = state.user_reader.get_by_id(user_id).await;
    let device_data = device_display_names(&state.mysql, user_id, &device_ids).await;
    let group_task_ids: Vec<i64> = tasks.iter().map(|task| task.id).collect();
    let members = approved_group_chat_members(&state.mysql, &group_task_ids).await?;

    Ok(project_lite_tasks(
        tasks,
        &team_data,
        &workspace_data,
        &device_data,
        GroupChatRule::WithMembers(&members),
    ))
}

/// `_batch_query_workspaces` for the group list (`list_workspaces_by_refs`):
/// the base-table read first, then the owner's shard. The later row wins, so a
/// migrated copy shadows its legacy index row.
async fn batch_workspaces(
    state: &Arc<AppState>,
    user_id: i64,
    refs: &[(String, String)],
) -> MysqlResult<HashMap<(String, String), String>> {
    if refs.is_empty() {
        return Ok(HashMap::new());
    }
    let mut rows = state
        .mysql
        .fetch_all(workspaces_by_ref_statement(TASKS_TABLE, user_id, refs), ())
        .await?;
    rows.extend(
        state
            .task_store
            .list_workspaces_by_ref(user_id, refs)
            .await?,
    );

    let mut data: HashMap<(String, String), String> = HashMap::new();
    for row in &rows {
        let name: String = row.get_required("name")?;
        let namespace: String = row.get_required("namespace")?;
        let json: Value = row.get_required("json").unwrap_or(Value::Null);
        let git_repo = json
            .get("spec")
            .and_then(|spec| spec.get("repository"))
            .and_then(|repository| repository.get("gitRepo"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        data.insert((name, namespace), git_repo);
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_validate_like_the_source_query_constraints() {
        let params = GroupTasksParams {
            page: Some(2),
            limit: Some(20),
        }
        .validated()
        .unwrap();
        assert_eq!(params.skip, 20);
        assert_eq!(params.limit, 20);

        let default = GroupTasksParams {
            page: None,
            limit: None,
        }
        .validated()
        .unwrap();
        assert_eq!(default.skip, 0);
        assert_eq!(default.limit, 50);

        assert!(
            GroupTasksParams {
                page: Some(0),
                limit: None
            }
            .validated()
            .is_err()
        );
        assert!(
            GroupTasksParams {
                page: None,
                limit: Some(101)
            }
            .validated()
            .is_err()
        );
    }
}
