// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/resources` — the user's owned agents and execution environments
//! (`app.api.endpoints.workspaces.list_personal_resources`).
use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::response::PersonalResourcesResponse;
use super::service;

/// GET /api/v1/resources: list the current user's owned agents and execution
/// environments.
///
/// The source endpoint is async (`list_personal_resources`) and uses the
/// `get_current_user_jwt_apikey_tasktoken` dependency; the framework
/// `AppAuthenticator::SessionUser` performs the equivalent bearer JWT + user
/// lookup (the recorded request authenticates a bearer token resolving to the
/// `sifang` user). FastAPI serializes the returned `PersonalResourcesResponse`
/// via `model_validate` + `model_dump_json`; the response body is the UTF-8
/// JSON document, and the `content-type` is `application/json`.
///
/// A 404 `User not found` is unreachable here because authentication already
/// loads the user (the inner `db.get(User, user_id)` is satisfied by the
/// identity-mapped session user and issues no query).
#[brz_http_server::get("/api/v1/resources")]
async fn list_personal_resources(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
) -> Result<PersonalResourcesResponse, FastApiError> {
    service::list_personal_resources(state, &current_user.0).await
}
