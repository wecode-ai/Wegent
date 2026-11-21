// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/loop-items/{item_id}` — one loop item.
//!
//! Mirrors `app.api.endpoints.deliveries.get_loop_item`:
//! `external_loop_item_provider.is_external_item(db, item_id)` selects the
//! provider branch; otherwise `loop_item_service.get` reads the local task row
//! (`_get_item_row` + `_require_item_access`) and projects it through
//! `loop_item_service.response_values`.
//!
//! The provider branch runs `_visible_issue`: resolve the project again,
//! authorize `Viewer`, fetch the issue, project it, and map an invisible issue
//! to `404 "TODO not found"`.
use brz_http_server::StatusCode;

use super::auth::FlexibleUser;
use super::http_error::HttpError;
use super::item_access::{
    default_issue_security, project_task_provider, project_visibility, require_item_access,
};
use super::item_response::{
    LoopItemResponse, ProjectFacts, response_values_for_invited_item, response_values_many,
};
use super::loop_repository::{LoopItemRepository, split_external_item_id};
use crate::ProjectState;
use crate::board_snapshot::external_provider::{
    issue_get_url, provider_repository, request_json, resolve_provider_config,
};
use crate::board_snapshot::repository::BoardSnapshotRepository;
use crate::http_compat::FastApiError;
use crate::loop_item_pages::PageIssue;
use crate::loop_item_pages::projection::issue_response_with;

/// GET /api/v1/loop-items/{item_id}: the loop-item free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/v1/loop-items/:item_id", group = project_coordination)]
async fn get_loop_item(
    #[inject(state)] state: &ProjectState,
    item_id: &str,
    #[auth] current_user: FlexibleUser,
) -> Result<LoopItemResponse, FastApiError> {
    get_loop_item_body(state, item_id, &current_user).await
}

/// Handler body for `GET /api/v1/loop-items/{item_id}`.
async fn get_loop_item_body(
    state: &ProjectState,
    item_id: &str,
    current_user: &FlexibleUser,
) -> Result<LoopItemResponse, FastApiError> {
    let repository = LoopItemRepository::new(&state.mysql);

    // `external_loop_item_provider.is_external_item(db, item_id)`: ids shaped
    // `KEY-number` whose project is github/gitlab backed.
    if repository
        .find_external_project(item_id)
        .await
        .map_err(HttpError::internal)?
        .is_some()
    {
        return external_item(state, item_id, current_user).await;
    }

    // `loop_item_service.get`: `_get_item_row` then `_require_item_access`.
    let item = repository
        .get_task_item_entity(item_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::todo_not_found)?;
    let project_number: i64 = item
        .cloud_project_id
        .parse()
        .map_err(|_| HttpError::cloud_project_not_found())?;
    let access = require_item_access(&state.mysql, &item, current_user.id).await?;
    let project = access.project;

    // `_loop_item_response` -> `response_values(db, item, user_id)`: the
    // projection resolves the project access again (`access=None`).
    let visibility = project_visibility(&project);
    let provider = project_task_provider(&project);
    let facts = ProjectFacts {
        number: project_number,
        visibility: &visibility,
        provider_is_local: provider == "local",
        // Not selected by the `db.get(CloudProject, ...)` entity read; the
        // projection does not consume it.
        created_by_user_id: 0,
        default_issue_security: default_issue_security(&project),
    };
    let reads = crate::LoopItemReads {
        mysql: &state.mysql,
        user_reader: state.user_reader.as_ref(),
    };
    if access.invited_only {
        return response_values_for_invited_item(&reads, &item, &current_user.0, &facts)
            .await
            .map_err(HttpError::into_fastapi);
    }
    // `LoopItemReadContext.load(db, [item], user_id, access)`: the detail read
    // builds the same full read context a page read does, so the recorded
    // context statements (executions, users, agents, teams, messages,
    // human bindings, visible ids) appear once each.
    let mut responses = response_values_many(
        &reads,
        std::slice::from_ref(&item),
        &current_user.0,
        &facts,
        None,
    )
    .await
    .map_err(HttpError::into_fastapi)?;
    responses
        .pop()
        .ok_or_else(|| HttpError::internal_detail().into())
}

/// `external_loop_item_provider.get`: `_visible_issue` for one provider issue.
async fn external_item(
    state: &ProjectState,
    item_id: &str,
    current_user: &FlexibleUser,
) -> Result<LoopItemResponse, FastApiError> {
    let repository = LoopItemRepository::new(&state.mysql);

    // `_resolve_project`: the second `_find_project` call; an id that stopped
    // resolving raises the source's 404.
    let project = repository
        .find_external_project(item_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::todo_not_found)?;
    let (_, number) = split_external_item_id(item_id).ok_or_else(HttpError::todo_not_found)?;
    let project_number: i64 = project
        .id
        .parse()
        .map_err(|_| HttpError::cloud_project_not_found())?;

    // `require_cloud_project_role(db, project.id, user_id, Viewer)`.
    let access = BoardSnapshotRepository::new(&state.mysql)
        .require_cloud_project_role(project_number, current_user.id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::cloud_project_not_found)?;

    // `_get_issue(project, number)`.
    let task_provider = project.task_provider();
    let (config, token) =
        resolve_provider_config(&state.jwt_key, &project).map_err(provider_config_error)?;
    let repository_name = provider_repository(&config).map_err(provider_config_error)?;
    let url = issue_get_url(&task_provider, &config, &repository_name, number);
    let value = request_json(&state.attachment_http, &token, &task_provider, &url)
        .await
        .map_err(|error| error.into_fastapi())?;
    let issue: PageIssue = serde_json::from_value(value).map_err(|error| {
        tracing::error!(%error, "provider issue body is not an object");
        FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
    })?;

    // `_response` with the source defaults (`include_description=True`,
    // `include_badges=True`), then the visibility gate.
    let response = issue_response_with(
        &state.mysql,
        &project,
        &access.role,
        current_user.id,
        &issue,
        true,
        true,
    )
    .await
    .map_err(HttpError::internal)?;
    if !response.can_view_detail() {
        return Err(HttpError::todo_not_found().into());
    }
    Ok(response.into_loop_items())
}

/// `_config`'s credential/repository failures: `409` with the source message.
fn provider_config_error(error: String) -> FastApiError {
    FastApiError::detail(brz_http_server::StatusCode::CONFLICT, error)
}
