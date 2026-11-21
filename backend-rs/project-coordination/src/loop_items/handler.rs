// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/cloud-projects/{project_id}/loop-items` — the project board's
//! loop-item list.
//!
//! Mirrors `app.api.endpoints.deliveries.list_loop_items`:
//! `project_board_snapshot_service.list_item_views(db, project_id,
//! current_user.id, assignee_type, assignee_id, execution_state)` resolves the
//! project access role and returns the provider-aware `LoopItemResponse` list.
//!
//! Source pipeline (`app.services.project_board_snapshot.list_item_views`):
//! 1. `cloud_project_service.get` — `require_cloud_project_role(Viewer)`, the
//!    set-based `project_access_query` that resolves the active project row and
//!    the caller's effective role in one statement;
//! 2. external providers (`github`/`gitlab`): `external_loop_item_provider.list`
//!    calls `require_cloud_project_role(Viewer)` again, lists the project's
//!    issues from the provider API, filters by assignee label, and projects
//!    each issue to a `LoopItemResponse`;
//! 3. local projects: `loop_item_service.list` calls
//!    `_require_internal_task_project` (`require_cloud_project_role(Viewer)`
//!    plus a `409` when the provider is not `local`) and reads the active
//!    `resource_type='task'` rows for the project;
//! 4. `cloud_project_service.access` — `require_cloud_project_role(Viewer)`
//!    once more, supplying the role each item is projected with.
use brz_http_server::StatusCode;
use serde::Deserialize;

use super::response::LoopItemListResponse;
use crate::ProjectState;
use crate::board_snapshot::repository::{BoardSnapshotRepository, has_permission};
use crate::http_compat::FastApiError;
use crate::loop_tasks::http_error::HttpError;
use crate::loop_tasks::item_response::{ProjectFacts, response_values_many};
use crate::loop_tasks::loop_repository::{TaskItemFullRow, visible_item_filter_sql};
use wegent_identity::flexible_auth::FlexibleUser;

/// Query parameters for `GET /api/v1/cloud-projects/{project_id}/loop-items`.
///
/// Mirrors the source `Query(default=None)` declarations: `assignee_type`,
/// `assignee_id`, and `execution_state` are all optional strings with no
/// additional constraints.
#[derive(Debug, Default, Deserialize)]
pub struct LoopItemsQuery {
    #[serde(default)]
    pub assignee_type: Option<String>,
    #[serde(default)]
    pub assignee_id: Option<String>,
    #[serde(default)]
    pub execution_state: Option<String>,
}

/// FastAPI-style 422 for an unparsable `project_id` path parameter. The source
/// declares `project_id: int`, so a non-numeric segment is rejected before the
/// handler runs.
fn path_validation_error(value: &str) -> FastApiError {
    // `validation_exception_handler` (`app/core/exceptions.py`) replaces
    // FastAPI's default array body with the application's own shape.
    FastApiError::request_validation(serde_json::json!([{
        "type": "int_parsing",
        "loc": ["path", "project_id"],
        "msg": "Input should be a valid integer, unable to parse string as an integer",
        "input": value,
    }]))
}

/// GET /api/v1/cloud-projects/{project_id}/loop-items: the loop-items free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/cloud-projects/:project_id/loop-items", group = project_coordination)]
async fn list_loop_items(
    #[inject(state)] state: &ProjectState,
    project_id: &str,
    #[auth] current_user: FlexibleUser,
    query: brz_http_server::Query<LoopItemsQuery>,
) -> Result<LoopItemListResponse, FastApiError> {
    loop_items(state, project_id, &current_user, &query).await
}

/// Handler body for `GET /api/v1/cloud-projects/{project_id}/loop-items`.
async fn loop_items(
    state: &ProjectState,
    project_id: &str,
    current_user: &FlexibleUser,
    params: &LoopItemsQuery,
) -> Result<LoopItemListResponse, FastApiError> {
    // FastAPI path typing (`project_id: int`) validates the segment before the
    // endpoint body runs.
    let project_number: i64 = project_id
        .parse()
        .map_err(|_| path_validation_error(project_id))?;

    let repository = BoardSnapshotRepository::new(&state.mysql);

    // `cloud_project_service.get`: `require_cloud_project_role(Viewer)`.
    let access = repository
        .require_cloud_project_role(project_number, current_user.id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::cloud_project_not_found)?;
    let project = access.project;
    let provider = project.task_provider();

    if matches!(provider.as_str(), "github" | "gitlab") {
        // `external_loop_item_provider.list` calls `require_cloud_project_role`
        // again before listing issues.
        let list_access = repository
            .require_cloud_project_role(project_number, current_user.id)
            .await
            .map_err(HttpError::internal)?
            .ok_or_else(HttpError::cloud_project_not_found)?;
        let items = crate::loop_item_pages::list_external_items(
            &state.external_issue_reads(),
            &project,
            &list_access.role,
            current_user.id,
            params.assignee_type.as_deref(),
            params.assignee_id.as_deref(),
        )
        .await?;
        return Ok(LoopItemListResponse { items });
    }

    // `loop_item_service.list` -> `_require_internal_task_project`: the source
    // calls `require_cloud_project_role(Viewer)` again; every resolved role
    // satisfies `Viewer`, so the 403 cannot fire. A non-`local` provider raises
    // `409`.
    let list_access = repository
        .require_cloud_project_role(project_number, current_user.id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::cloud_project_not_found)?;
    if !has_permission(&list_access.role, "Viewer") {
        return Err(HttpError::insufficient_permission().into());
    }
    if provider != "local" {
        return Err(HttpError::new(
            StatusCode::CONFLICT,
            format!("Project tasks are provided by {provider}; use the local Issue provider"),
        )
        .into());
    }

    let rows = list_local_items(
        state,
        project_number,
        current_user.id,
        &list_access.role,
        project.default_issue_security(),
        params,
    )
    .await?;

    // `cloud_project_service.access`: `require_cloud_project_role(Viewer)` used
    // to project each item.
    let access = repository
        .require_cloud_project_role(project_number, current_user.id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::cloud_project_not_found)?;

    // `response_values_many`: the shared read context projects every item with
    // the resolved access.
    let visibility = project.visibility();
    let default_issue_security = project.default_issue_security();
    let facts = ProjectFacts {
        number: project_number,
        visibility: &visibility,
        provider_is_local: project.task_provider() == "local",
        created_by_user_id: project.created_by_user_id,
        default_issue_security,
    };
    let items = response_values_many(
        &state.loop_item_reads(),
        &rows,
        &current_user.0,
        &facts,
        Some(&access),
    )
    .await
    .map_err(HttpError::into_fastapi)?;

    Ok(LoopItemListResponse { items })
}

/// `loop_item_service.list`: the active `resource_type='task'` rows for the
/// project, with the caller's visibility filter for non-maintainers and the
/// assignee/execution filters.
async fn list_local_items(
    state: &ProjectState,
    project_id: i64,
    user_id: i32,
    role: &str,
    default_security: &str,
    params: &LoopItemsQuery,
) -> Result<Vec<TaskItemFullRow>, HttpError> {
    let mut sql = format!(
        "SELECT {} \nFROM loop_items \n\
         WHERE loop_items.cloud_project_id = {project_id} \
         AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
             ('1970-01-01 00:00:00', '1970-01-01 00:00:01'))",
        crate::cloud_projects::LOOP_ITEMS_COLUMNS
    );
    // `visible_item_filter(user_id, project)` for callers below Maintainer.
    if !has_permission(role, "Maintainer") {
        sql.push_str(&visible_item_filter_sql(user_id, default_security));
    }
    if let Some(kind) = params.assignee_type.as_deref()
        && let Some(id) = params.assignee_id.as_deref().filter(|id| !id.is_empty())
    {
        match kind {
            "user" => {
                let assignee: i64 = id.parse().map_err(|_| {
                    HttpError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "User assignee id must be numeric",
                    )
                })?;
                sql.push_str(&format!(" AND loop_items.assignee_user_id = {assignee}"));
            }
            "agent" => {
                sql.push_str(&format!(" AND loop_items.assignee_agent_id = '{id}'"));
            }
            "team" => {
                let team: i64 = id.parse().map_err(|_| {
                    HttpError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "Team assignee id must be numeric",
                    )
                })?;
                sql.push_str(&format!(" AND loop_items.assignee_team_id = {team}"));
            }
            _ => {}
        }
    }
    if let Some(execution_state) = params.execution_state.as_deref() {
        sql.push_str(&format!(
            " AND loop_items.id IN (SELECT loop_item_executions.loop_item_id \
             FROM loop_item_executions \
             WHERE loop_item_executions.status = '{execution_state}')"
        ));
    }
    sql.push_str(
        " AND loop_items.resource_type IN ('task') \
         ORDER BY loop_items.sort_order, loop_items.updated_at DESC, loop_items.id",
    );
    state
        .mysql
        .fetch_all(sql, ())
        .await
        .map_err(HttpError::internal)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_validation_rejects_non_numeric_project_id() {
        let error = path_validation_error("not-a-number");
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        // `validation_exception_handler` renders the application body, not
        // FastAPI's default `{"detail": [...]}` array.
        assert_eq!(
            error.body_json(),
            serde_json::json!({
                "error_code": 422,
                "detail": "Request parameter validation failed",
                "errors": [{
                    "type": "int_parsing",
                    "loc": ["path", "project_id"],
                    "msg": "Input should be a valid integer, unable to parse string as an integer",
                    "input": "not-a-number",
                }],
            })
        );
    }

    #[test]
    fn default_query_has_no_filters() {
        let params = LoopItemsQuery::default();
        assert!(params.assignee_type.is_none());
        assert!(params.assignee_id.is_none());
        assert!(params.execution_state.is_none());
    }

    #[test]
    fn visible_filter_covers_every_relation_source() {
        let sql = visible_item_filter_sql(273, "open");
        assert!(sql.contains("loop_items.created_by_user_id = 273"));
        assert!(sql.contains("loop_items.assignee_user_id = 273"));
        assert!(sql.contains("resource_type IN ('execution')"));
        assert!(sql.contains("resource_type IN ('collaborator')"));
        assert!(sql.contains("resource_type IN ('chat_agent')"));
        assert!(sql.contains("= 'open'"));
    }
}
