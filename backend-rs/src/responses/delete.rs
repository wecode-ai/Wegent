// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `DELETE /api/v1/responses/{response_id}` — delete a response
//! (`app.api.endpoints.openapi_responses.delete_response`).
//!
//! Source flow: flexible authentication (`security.get_current_user_flexible`,
//! shared with `get_response`), the `settings.RATE_LIMIT_DELETE_RESPONSE`
//! fixed-window rate limit, `resp_{task_id}` parsing, the `source=chat_shell`
//! running-stream stop, `task_kinds_service.delete_task`, and the
//! `ResponseDeletedObject` body.
use serde::Serialize;

use super::auth::ResponsesUser;
use super::error::{ResponseError, rate_limit_exceeded};
use super::http_error::HttpError;
use super::rate_limit::{self, RateLimit};
use super::responses_repository as repo;
use super::stream_state::{cancel_stream, delete_streaming_content, unregister_stream};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `resp_` prefix of the response id format.
const RESPONSE_ID_PREFIX: &str = "resp_";
/// `SubtaskStatus` values the chat-shell stream stop searches for.
const RUNNING_ASSISTANT_STATUSES: [&str; 2] = ["PENDING", "RUNNING"];

/// `ResponseDeletedObject` (`app.schemas.openapi_response`): `id`, `object`,
/// `deleted`.
#[derive(Debug, Serialize)]
pub struct ResponseDeletedObject {
    pub id: String,
    pub object: &'static str,
    pub deleted: bool,
}

/// DELETE /api/v1/responses/{response_id}.
#[brz_http_server::delete("/api/v1/responses/:response_id")]
async fn delete_response(
    #[inject(state)] state: &AppState,
    response_id: &str,
    #[auth] current_user: ResponsesUser,
    #[header("x-forwarded-for")] x_forwarded_for: Option<&str>,
) -> Result<ResponseDeletedObject, ResponseError> {
    // Rate limit (`@limiter.limit(settings.RATE_LIMIT_DELETE_RESPONSE)`).
    let limit = RateLimit::delete_response();
    let client_ip = client_ip(x_forwarded_for);
    let limit_key = current_user
        .rate_limit_key
        .clone()
        .unwrap_or_else(|| format!("ip:{client_ip}"));
    let path = format!("/api/v1/responses/{response_id}");
    if !rate_limit::hit(state.redis.as_ref(), limit, &limit_key, &path).await {
        return Err(rate_limit_exceeded(limit).into());
    }

    // Response id parsing: `resp_{task_id}`.
    let Some(task_id_str) = response_id.strip_prefix(RESPONSE_ID_PREFIX) else {
        return Err(HttpError::invalid_response_id_prefix(response_id).into());
    };
    let Ok(task_id) = task_id_str.parse::<i64>() else {
        return Err(HttpError::invalid_response_id_numeric(response_id).into());
    };

    // The `source=chat_shell` running-stream stop before deletion.
    stop_chat_shell_stream(state, task_id, current_user.id).await?;

    // `task_kinds_service.delete_task(db, task_id, user_id)` (no client
    // origin). A 404 becomes `Response '<id>' not found`; anything else is
    // re-raised with its own status and detail.
    match crate::task_mutation_api::delete_task::delete_task(
        state,
        i64::from(current_user.id),
        task_id,
        None,
    )
    .await
    {
        Ok(()) => {}
        Err(error) if error.status() == brz_http_server::StatusCode::NOT_FOUND => {
            return Err(HttpError::response_not_found(response_id).into());
        }
        Err(error) => return Err(map_delete_error(error).into()),
    }

    Ok(ResponseDeletedObject {
        id: response_id.to_string(),
        object: "response",
        deleted: true,
    })
}

/// The `source=chat_shell` branch of `delete_response`: find the newest
/// `PENDING`/`RUNNING` assistant subtask and stop, drop, and unregister its
/// stream before the task is deleted. A non-chat-shell or stream-less task is
/// a no-op.
async fn stop_chat_shell_stream(
    state: &AppState,
    task_id: i64,
    user_id: i32,
) -> Result<(), ResponseError> {
    // `task_store.get_task_by_states(states=[STATE_ACTIVE], owner)`.
    let Some(task_kind) =
        repo::get_task_by_states_active_owned(state.task_store.as_ref(), task_id, user_id)
            .await
            .map_err(internal)?
    else {
        return Ok(());
    };

    // `source_label == "chat_shell"`.
    let task_crd = crate::crd::CrdDocument::project_opaque(&task_kind.json.0);
    let source_label = task_crd
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.labels.as_ref())
        .and_then(|labels| labels.source.clone());
    if source_label.as_deref() != Some("chat_shell") {
        return Ok(());
    }

    let running = state
        .task_store
        .latest_assistant_for_user_by_statuses(task_id, user_id, &RUNNING_ASSISTANT_STATUSES)
        .await
        .map_err(internal)?;
    let Some(running) = running else {
        return Ok(());
    };
    let subtask_id: i64 = running.get_required("id").map_err(internal)?;

    // `session_manager.cancel_stream` -> `delete_streaming_content` ->
    // `unregister_stream`.
    cancel_stream(state.redis.as_ref(), subtask_id).await;
    delete_streaming_content(state.redis.as_ref(), subtask_id).await;
    unregister_stream(state.redis.as_ref(), subtask_id).await;
    Ok(())
}

/// Re-render a `delete_task` `FastApiError` as the responses error shape,
/// preserving its status and detail (the source re-raises the `HTTPException`
/// it does not map to the response-not-found 404).
fn map_delete_error(error: FastApiError) -> HttpError {
    let status = error.status();
    let detail = error
        .detail_message()
        .unwrap_or("Internal server error")
        .to_owned();
    HttpError::new(status, detail)
}

/// The client IP used by the rate-limit fallback key
/// (`request.client.host`): the leftmost `x-forwarded-for` entry or the
/// socket peer.
fn client_ip(x_forwarded_for: Option<&str>) -> String {
    x_forwarded_for
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

fn internal(error: impl std::fmt::Display) -> HttpError {
    tracing::error!(%error, "[delete_response] dependency failure");
    HttpError::internal("database query failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleted_object_matches_the_recorded_body() {
        // Response shape: `{"id":"resp_...","object":"response","deleted":true}`.
        let body = ResponseDeletedObject {
            id: "resp_100000000000001".to_string(),
            object: "response",
            deleted: true,
        };
        assert_eq!(
            serde_json::to_string(&body).expect("serializes"),
            r#"{"id":"resp_100000000000001","object":"response","deleted":true}"#
        );
    }
}
