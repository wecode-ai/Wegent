// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/subscriptions/preview/{preview_id}/confirm`.
//!
//! Mirrors `app.api.endpoints.adapter.subscriptions.confirm_subscription_preview`
//! (router prefix `/subscriptions`, mounted under `/api`). The MCP
//! `preview_subscription` tool stores the pending configuration under
//! `subscription:preview:{preview_id}` (`app.mcp_server.tools.subscription`);
//! this endpoint turns that payload into a Subscription:
//!
//! 1. read the preview key from Redis — a missing key is the source's 404
//!    `{"detail": "Preview not found or expired"}`, a connection failure its
//!    503 `{"detail": "Service temporarily unavailable"}`, and a non-JSON
//!    payload its 500 `{"detail": "Invalid preview data"}`;
//! 2. reject a preview owned by another user with 403;
//! 3. rebuild the exact `SubscriptionCreate` the source constructs: a name
//!    derived from `display_name`/`preview_id`, `task_type=collection`,
//!    `enabled=true`, and the preview's trigger, team, prompt and history
//!    settings;
//! 4. run the shared create pipeline (validation, team lookup, INSERT,
//!    `_internal`, Kind cache invalidation, `db.refresh`);
//! 5. delete the preview key.
//!
//! Success renders `SubscriptionInDB` with status 200: the route declares no
//! `status_code`, unlike `POST /api/subscriptions`'s 201.

use brz_http_server::{Response, StatusCode};
use brz_redis::{ErrorKind, Redis, RedisError, RedisKey2};
use serde_json::{Map, Value, json};

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::subscriptions_item::truthy;

use super::create::{self, Create};

/// `PREVIEW_KEY_PREFIX` (`app.mcp_server.tools.subscription`).
const PREVIEW_KEY_PREFIX: &str = "subscription:preview:";

/// `POST /api/subscriptions/preview/{preview_id}/confirm`.
#[brz_http_server::post("/api/subscriptions/preview/:preview_id/confirm")]
async fn confirm_subscription_preview(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    preview_id: String,
) -> Result<Response, FastApiError> {
    confirm_preview(state, i64::from(user.0.id), &preview_id).await
}

/// Handler body: read, authorize, create, then clear the preview.
async fn confirm_preview(
    state: &AppState,
    user_id: i64,
    preview_id: &str,
) -> Result<Response, FastApiError> {
    // The source creates a client per request; an unavailable client surfaces
    // as `redis.ConnectionError` and the endpoint's 503.
    let Some(redis) = state.redis.as_ref() else {
        return Err(service_unavailable());
    };
    let key = RedisKey2(PREVIEW_KEY_PREFIX, preview_id);
    let preview = load_preview(redis, key).await?;
    let Value::Object(preview) = preview else {
        // `preview_data.get(...)` on a non-object raises `AttributeError`,
        // which escapes to `python_exception_handler`.
        return Err(FastApiError::unhandled());
    };

    // `if preview_data.get("user_id") != current_user.id`.
    if preview.get("user_id").and_then(Value::as_i64) != Some(user_id) {
        return Err(FastApiError::detail(
            StatusCode::FORBIDDEN,
            "Not authorized to confirm this preview",
        ));
    }

    let body = preview_body(&preview, preview_id)?;
    // A direct pydantic `SubscriptionCreate(...)` construction surfaces a
    // `ValidationError` as the framework's 500 body, not FastAPI's 422 body.
    let create = Create::from_value(body).map_err(|_| FastApiError::unhandled())?;
    let response =
        create::create_subscription_with_status(state, user_id, &create, StatusCode::OK).await?;

    // `client.delete(key)` runs after `db.commit()` and is outside the source's
    // `try`, so a failure renders the generic 500 after the row was created.
    if let Err(error) = redis.del(key).await {
        tracing::warn!(%error, "subscription preview cleanup failed");
        return Err(FastApiError::unhandled());
    }
    Ok(response)
}

/// `client.get(f"subscription:preview:{preview_id}")` plus the source's
/// status mapping.
async fn load_preview<R: Redis>(
    redis: &R,
    key: RedisKey2<&str, &str>,
) -> Result<Value, FastApiError> {
    let data = redis
        .get::<_, String>(key)
        .await
        .map_err(preview_redis_error)?;
    let Some(data) = data else {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Preview not found or expired",
        ));
    };
    serde_json::from_str(&data).map_err(|_| {
        FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Invalid preview data")
    })
}

/// Map a Redis failure the way the source's `except redis.ConnectionError`
/// branch does: connection-family errors render 503, everything else escapes
/// to the framework's 500 body.
fn preview_redis_error(error: RedisError) -> FastApiError {
    match error.kind() {
        ErrorKind::Io
        | ErrorKind::NoConnection
        | ErrorKind::AuthenticationFailed
        | ErrorKind::Overloaded => service_unavailable(),
        _ => FastApiError::unhandled(),
    }
}

fn service_unavailable() -> FastApiError {
    FastApiError::detail(
        StatusCode::SERVICE_UNAVAILABLE,
        "Service temporarily unavailable",
    )
}

/// Rebuild `SubscriptionCreate(...)` from the stored preview payload.
fn preview_body(preview: &Map<String, Value>, preview_id: &str) -> Result<Value, FastApiError> {
    let name = preview_name(required_str(preview, "display_name")?, preview_id)
        .ok_or_else(FastApiError::unhandled)?;

    // `SubscriptionCreate(name=..., namespace=team_namespace or default, ...)`.
    let mut body = Map::new();
    body.insert("name".to_string(), Value::String(name));
    body.insert(
        "namespace".to_string(),
        preview
            .get("team_namespace")
            .cloned()
            .unwrap_or_else(|| json!("default")),
    );
    body.insert(
        "display_name".to_string(),
        Value::String(required_str(preview, "display_name")?.to_string()),
    );
    body.insert(
        "description".to_string(),
        preview.get("description").cloned().unwrap_or(Value::Null),
    );
    // `task_type=SubscriptionTaskType.COLLECTION`.
    body.insert("task_type".to_string(), json!("collection"));
    body.insert(
        "trigger_type".to_string(),
        Value::String(required_str(preview, "trigger_type")?.to_string()),
    );
    body.insert(
        "trigger_config".to_string(),
        required_clone(preview, "trigger_config")?,
    );
    body.insert("team_id".to_string(), required_clone(preview, "team_id")?);
    body.insert(
        "prompt_template".to_string(),
        Value::String(required_str(preview, "prompt_template")?.to_string()),
    );
    body.insert(
        "preserve_history".to_string(),
        preview
            .get("preserve_history")
            .cloned()
            .unwrap_or_else(|| json!(false)),
    );
    body.insert(
        "history_message_count".to_string(),
        preview
            .get("history_message_count")
            .cloned()
            .unwrap_or_else(|| json!(10)),
    );
    body.insert(
        "retry_count".to_string(),
        preview
            .get("retry_count")
            .cloned()
            .unwrap_or_else(|| json!(1)),
    );
    body.insert(
        "timeout_seconds".to_string(),
        preview
            .get("timeout_seconds")
            .cloned()
            .unwrap_or_else(|| json!(600)),
    );
    body.insert("enabled".to_string(), json!(true));
    body.insert("model_ref".to_string(), model_ref(preview));
    if let Some(expires_at) = expires_at(preview) {
        body.insert("expires_at".to_string(), expires_at);
    }
    Ok(Value::Object(body))
}

fn required_str<'a>(preview: &'a Map<String, Value>, key: &str) -> Result<&'a str, FastApiError> {
    // A missing/invalid key raises `KeyError`/`TypeError` in the source and
    // escapes to the generic 500 handler.
    preview
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(FastApiError::unhandled)
}

fn required_clone(preview: &Map<String, Value>, key: &str) -> Result<Value, FastApiError> {
    preview
        .get(key)
        .cloned()
        .ok_or_else(FastApiError::unhandled)
}

/// `f"sub-{display_name.lower().replace(' ', '-')[:30]}-{preview_id.split('_')[1][:8]}"`.
fn preview_name(display_name: &str, preview_id: &str) -> Option<String> {
    let slug: String = display_name
        .to_lowercase()
        .replace(' ', "-")
        .chars()
        .take(30)
        .collect();
    let suffix: String = preview_id.split('_').nth(1)?.chars().take(8).collect();
    Some(format!("sub-{slug}-{suffix}"))
}

/// `if preview_data.get("model_name"): {...}` using Python truthiness.
fn model_ref(preview: &Map<String, Value>) -> Value {
    let model_name = preview.get("model_name");
    if !truthy(&model_name.cloned().unwrap_or(Value::Null)) {
        return Value::Null;
    }
    json!({
        "name": model_name.cloned().unwrap_or(Value::Null),
        "namespace": preview
            .get("model_namespace")
            .cloned()
            .unwrap_or_else(|| json!("default")),
    })
}

/// `datetime.fromisoformat(expires_at.replace("Z", "+00:00"))` with the
/// source's `except (ValueError, AttributeError): pass` fallback to `None`.
fn expires_at(preview: &Map<String, Value>) -> Option<Value> {
    let raw = preview.get("expires_at").and_then(Value::as_str)?;
    if raw.is_empty() || !is_iso_datetime(raw) {
        return None;
    }
    Some(Value::String(raw.to_string()))
}

/// Accept the ISO-8601 shapes `datetime.fromisoformat` produces for the stored
/// preview (`datetime.isoformat()` or a caller-supplied value).
fn is_iso_datetime(raw: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(raw).is_ok()
        || chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f").is_ok()
        || chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.f").is_ok()
        || chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d").is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recorded_preview() -> Map<String, Value> {
        json!({
            "preview_id": "preview_26d9d11d",
            "execution_id": "exec_1cdf1e7b4b80",
            "display_name": "edge-service · 每日20:30当日总结",
            "description": "edge-service 排期总结",
            "trigger_type": "cron",
            "trigger_config": {
                "expression": "30 20 19-23,26-28 10 *",
                "timezone": "Asia/Shanghai",
            },
            "prompt_template": "summary",
            "preserve_history": false,
            "history_message_count": 10,
            "retry_count": 1,
            "timeout_seconds": 600,
            "expires_at": Value::Null,
            "user_id": 1005,
            "team_id": 122457,
            "team_namespace": "default",
            "timezone": "Asia/Shanghai",
            "model_name": Value::Null,
            "model_namespace": "default",
        })
        .as_object()
        .cloned()
        .unwrap()
    }

    #[test]
    fn name_matches_the_recorded_preview() {
        assert_eq!(
            preview_name("edge-service · 每日20:30当日总结", "preview_26d9d11d").as_deref(),
            Some("sub-edge-service-·-每日20:30当日总结-26d9d11d")
        );
    }

    #[test]
    fn name_takes_thirty_code_points_then_the_preview_suffix() {
        let name =
            preview_name("abcdefghijklmnopqrstuvwxyz0123456789", "preview_abcd1234").unwrap();
        assert_eq!(name, "sub-abcdefghijklmnopqrstuvwxyz0123-abcd1234");
        assert!(preview_name("display", "preview").is_none());
    }

    #[test]
    fn body_matches_the_source_constructor() {
        let preview = recorded_preview();
        let body = preview_body(&preview, "preview_26d9d11d").unwrap();
        assert_eq!(
            body["name"],
            "sub-edge-service-·-每日20:30当日总结-26d9d11d"
        );
        assert_eq!(body["namespace"], "default");
        assert_eq!(body["task_type"], "collection");
        assert_eq!(body["enabled"], true);
        assert_eq!(body["retry_count"], 1);
        assert_eq!(body["timeout_seconds"], 600);
        assert_eq!(body["model_ref"], Value::Null);
        assert_eq!(body["trigger_config"]["timezone"], "Asia/Shanghai");
        assert!(body.get("expires_at").is_none());
    }

    #[test]
    fn body_defaults_match_the_source_get_fallbacks() {
        let mut preview = recorded_preview();
        preview.remove("preserve_history");
        preview.remove("history_message_count");
        preview.remove("retry_count");
        preview.remove("timeout_seconds");
        preview.remove("team_namespace");
        let body = preview_body(&preview, "preview_26d9d11d").unwrap();
        assert_eq!(body["namespace"], "default");
        assert_eq!(body["preserve_history"], false);
        assert_eq!(body["history_message_count"], 10);
        assert_eq!(body["retry_count"], 1);
        assert_eq!(body["timeout_seconds"], 600);
    }

    #[test]
    fn model_ref_is_built_only_for_a_truthy_model_name() {
        let mut preview = recorded_preview();
        preview.insert("model_name".to_string(), json!("gpt-4o"));
        preview.insert("model_namespace".to_string(), json!("team-space"));
        assert_eq!(
            model_ref(&preview),
            json!({"name": "gpt-4o", "namespace": "team-space"})
        );
        preview.insert("model_name".to_string(), json!(""));
        assert_eq!(model_ref(&preview), Value::Null);
    }

    #[test]
    fn expires_at_keeps_only_parseable_values() {
        let mut preview = recorded_preview();
        preview.insert("expires_at".to_string(), json!("2026-10-19T12:30:00"));
        assert_eq!(expires_at(&preview), Some(json!("2026-10-19T12:30:00")));
        preview.insert("expires_at".to_string(), json!("not-a-date"));
        assert_eq!(expires_at(&preview), None);
    }

    #[test]
    fn connection_family_redis_errors_render_the_source_503() {
        for kind in [
            ErrorKind::Io,
            ErrorKind::NoConnection,
            ErrorKind::AuthenticationFailed,
            ErrorKind::Overloaded,
        ] {
            let error = preview_redis_error(RedisError::new(kind, "stub"));
            assert_eq!(error.status(), StatusCode::SERVICE_UNAVAILABLE);
        }
        let error = preview_redis_error(RedisError::new(ErrorKind::ResponseError, "stub"));
        assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn registered_route_keeps_python_ownership() {
        const PATH: &str = "/api/subscriptions/preview/:preview_id/confirm";
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&file).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "POST")),
            "POST {PATH} must remain on Python until cutover"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(
            &http::Method::POST,
            "/api/subscriptions/preview/preview_26d9d11d/confirm"
        ));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == PATH && route.methods & POST != 0);
        assert!(registered, "POST {PATH} must be registered by the router");
    }
}
