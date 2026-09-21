// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/responses/{response_id}` — retrieve a response by ID
//! (`app.api.endpoints.openapi_responses.get_response`).
//!
//! Source pipeline: flexible authentication
//! (`security.get_current_user_flexible` -> `get_auth_context`), the
//! `120/minute` fixed-window rate limit on Redis, `resp_{task_id}` parsing,
//! `task_kinds_service.get_task_by_id` (active non-deleted task, membership,
//! and `convert_to_task_dict`), subtask listing, the model string from the
//! task's team reference, and `_task_to_response_object`.
use brz_http_server::StatusCode;
use brz_http_server::{Binary, HttpResponse};
#[cfg(test)]
use serde_json::Value;

use super::auth::get_current_user_flexible;
use super::http_error::HttpError;
use super::output_builder::{ResponseObject, task_to_response_object};
use super::rate_limit::{self, RateLimit};
use super::responses_repository as repo;
use crate::state::AppState;

/// `resp_` prefix of the response id format.
const RESPONSE_ID_PREFIX: &str = "resp_";

/// The 429 body slowapi's `RateLimitExceeded` handler emits
/// (`_rate_limit_exceeded_handler`): `{"error": "Rate limit exceeded: 120 per 1 minute"}`.
fn rate_limit_exceeded() -> RateLimitError {
    RateLimitError {
        status: StatusCode::TOO_MANY_REQUESTS,
        error: format!(
            "Rate limit exceeded: {} per 1 {}",
            RateLimit::default().amount,
            RateLimit::default().granularity
        ),
    }
}

/// The 429 rate-limit failure with its source-specific `{"error": ...}` body
/// (not the FastAPI `{"detail": ...}` shape). `into_http_error` re-serializes
/// the error message into the `detail` string like the source handler does.
struct RateLimitError {
    status: StatusCode,
    error: String,
}

impl RateLimitError {
    /// The mapped status code.
    #[cfg(test)]
    fn status(&self) -> StatusCode {
        self.status
    }
}

impl brz_http_server::IntoHttpError for RateLimitError {
    fn into_http_error(
        self,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        crate::http_compat::FastApiError::json_body(
            self.status,
            serde_json::json!({ "error": self.error }),
        )
        .into_http_error(arena)
    }
}

/// One of the endpoint's failure shapes: the rate-limit 429 body or the
/// standard FastAPI error.
enum ResponseError {
    RateLimit(RateLimitError),
    Http(HttpError),
}

impl From<RateLimitError> for ResponseError {
    fn from(error: RateLimitError) -> Self {
        Self::RateLimit(error)
    }
}

impl From<HttpError> for ResponseError {
    fn from(error: HttpError) -> Self {
        Self::Http(error)
    }
}

impl From<super::auth_error::AuthError> for ResponseError {
    fn from(error: super::auth_error::AuthError) -> Self {
        Self::Http(error.into())
    }
}

impl brz_http_server::IntoHttpError for ResponseError {
    fn into_http_error(
        self,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        match self {
            Self::RateLimit(error) => error.into_http_error(arena),
            Self::Http(error) => error.into_http_error(arena),
        }
    }
}

/// GET /api/v1/responses/{response_id}: the responses free function, injecting
/// the process-lifetime application state.
#[brz_http_server::get("/api/v1/responses/:response_id")]
async fn get_response(
    #[inject(state)] state: &AppState,
    response_id: &str,
    #[header] authorization: Option<&str>,
    #[header("x-api-key")] x_api_key: Option<&str>,
    #[header("wegent-source")] wegent_source: Option<&str>,
    #[header("wegent-username")] wegent_username: Option<&str>,
    #[header("x-forwarded-for")] x_forwarded_for: Option<&str>,
) -> Result<HttpResponse<Binary>, ResponseError> {
    // Authentication (`get_current_user_flexible`).
    let headers = crate::headers::OwnedHeaders::from_pairs([
        ("authorization", authorization),
        ("x-api-key", x_api_key),
        ("wegent-source", wegent_source),
        ("wegent-username", wegent_username),
    ]);
    let current_user = match get_current_user_flexible(
        &state.auth,
        state.user_reader.as_ref(),
        &state.mysql,
        &headers.view(),
    )
    .await
    {
        Ok(user) => user,
        Err(error) => return Err(error.into()),
    };

    // Rate limit (`@limiter.limit(settings.RATE_LIMIT_GET_RESPONSE)`).
    let client_ip = client_ip(x_forwarded_for);
    let limit_key = rate_limit::limit_key(&headers.view(), &client_ip);
    let path = format!("/api/v1/responses/{response_id}");
    if !rate_limit::hit(
        state.redis.as_ref(),
        RateLimit::default(),
        &limit_key,
        &path,
    )
    .await
    {
        return Err(rate_limit_exceeded().into());
    }

    // Response id parsing: `resp_{task_id}`.
    let Some(task_id_str) = response_id.strip_prefix(RESPONSE_ID_PREFIX) else {
        return Err(HttpError::invalid_response_id_prefix(response_id).into());
    };
    let Ok(task_id) = task_id_str.parse::<i64>() else {
        return Err(HttpError::invalid_response_id_numeric(response_id).into());
    };

    match load_response(state, task_id, current_user.id).await {
        Ok(Some(response)) => Ok(HttpResponse::new(Binary::new(
            serde_json::to_vec(&response).unwrap_or_default(),
        ))),
        Ok(None) => Err(HttpError::response_not_found(response_id).into()),
        Err(error) => Err(error.into()),
    }
}

/// The `get_response` flow after authentication: task detail, subtasks, and
/// the model string, converted into the `ResponseObject`.
async fn load_response(
    state: &AppState,
    task_id: i64,
    user_id: i32,
) -> Result<Option<ResponseObject>, HttpError> {
    let mysql = &state.mysql;
    let internal = |error: brz_mysql::MysqlError| {
        tracing::error!(%error, "responses database dependency failure");
        HttpError::internal("database query failed")
    };

    // `task_kinds_service.get_task_by_id`.
    let task = repo::get_active_non_deleted_task(mysql, task_id)
        .await
        .map_err(internal)?;
    let Some(task) = task else {
        return Ok(None);
    };
    if !repo::is_member(mysql, task_id, user_id)
        .await
        .map_err(internal)?
    {
        return Ok(None);
    }

    // `convert_to_task_dict`: workspace by ref, team resolution, user load.
    let task_crd = crate::crd::CrdDocument::project_opaque(&task.json.0);
    if let Some(workspace_ref) = task_crd
        .spec
        .as_ref()
        .and_then(|spec| spec.workspace_ref.as_ref())
    {
        let name = workspace_ref.name();
        let namespace = workspace_ref.namespace();
        let _ = repo::get_workspace_by_ref(mysql, state.task_policy, task.user_id, name, namespace)
            .await
            .map_err(internal)?;
    }
    let _team = repo::resolve_team(mysql, &task, user_id)
        .await
        .map_err(internal)?;
    let _ = super::auth::cached_user_by_id(state.user_reader.as_ref(), i64::from(task.user_id))
        .await
        .map_err(|error| {
            tracing::error!(?error, "responses user reader dependency failure");
            internal(brz_mysql::MysqlError::InvalidQuery {
                reason: "user reader dependency failure".to_owned(),
            })
        })?;

    // `subtask_store.list_by_task_for_user_ordered`.
    let subtasks = repo::list_subtasks_for_user_ordered(mysql, task_id, user_id)
        .await
        .map_err(internal)?;

    // `task_store.get_task_by_states(states=[STATE_ACTIVE],
    // owner_user_id=current_user.id)` + model-string reconstruction.
    let task_kind = repo::get_task_by_states_active_owned(mysql, task_id, user_id)
        .await
        .map_err(internal)?;
    let model_string = model_string_for(&task_kind);

    Ok(Some(task_to_response_object(
        &task,
        &model_string,
        &subtasks,
        None,
    )))
}

/// Model string from the task CRD team reference:
/// `{team_namespace}#{team_name}` plus `#{model_id}` when the `modelId` label
/// is set; `unknown` when the task row is absent.
fn model_string_for(task_kind: &Option<repo::TaskRow>) -> String {
    let Some(task_kind) = task_kind else {
        return "unknown".to_string();
    };
    let task_crd = crate::crd::CrdDocument::project_opaque(&task_kind.json.0);
    let Some(team_ref) = task_crd
        .spec
        .as_ref()
        .and_then(|spec| spec.team_ref.as_ref())
    else {
        return "unknown".to_string();
    };
    let team_name = team_ref.name();
    let team_namespace = team_ref.namespace();
    let model_id = task_crd
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.labels.as_ref())
        .and_then(|labels| labels.model_id.as_ref())
        .and_then(crate::json_compat::OpaqueJson::project::<String>);
    match model_id {
        Some(model_id) => format!("{team_namespace}#{team_name}#{model_id}"),
        None => format!("{team_namespace}#{team_name}"),
    }
}

/// The client IP used by the rate-limit fallback key
/// (`request.client.host`): the leftmost `x-forwarded-for` entry or the
/// socket peer.
fn client_ip(x_forwarded_for: Option<&str>) -> String {
    // The target is deployed behind the recording gateway, which forwards
    // `x-forwarded-for`; the replay transport supplies the original client
    // address there.
    x_forwarded_for
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task_row(json: Value) -> repo::TaskRow {
        repo::TaskRow {
            id: 1,
            user_id: 89,
            json: brz_mysql::Json(crate::json_compat::OpaqueJson::from(json)),
            created_at: None,
        }
    }

    #[test]
    fn model_string_from_team_ref() {
        let json = serde_json::json!({
            "spec": {"teamRef": {"name": "example-team", "namespace": "example", "user_id": 1001}},
            "metadata": {"labels": {"modelId": "gpt"}},
        });
        assert_eq!(
            model_string_for(&Some(task_row(json))),
            "example#example-team#gpt"
        );

        let json = serde_json::json!({
            "spec": {"teamRef": {"name": "example-team", "namespace": "example"}},
        });
        assert_eq!(
            model_string_for(&Some(task_row(json))),
            "example#example-team"
        );

        assert_eq!(model_string_for(&None), "unknown");
    }

    #[test]
    fn rate_limit_error_body_matches_slowapi() {
        let response = rate_limit_exceeded();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    }
}
