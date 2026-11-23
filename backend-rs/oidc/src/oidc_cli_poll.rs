// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/auth/oidc/cli-poll` — poll a CLI OIDC login session.
//!
//! Mirrors `app.api.endpoints.oidc.cli_poll_token` (router prefix
//! `/auth/oidc`, mounted under the app prefix `/api`): read the Redis
//! `cli_login_session:{session_id}` record through `cache_manager`, then
//! render the `CLIPollResponse` model (`app/schemas/user.py`), which always
//! emits all four fields with JSON `null` for the absent ones.
//!
//! `cache_manager.get` swallows every Redis failure into `None` (it logs
//! `logger.error` and returns `None` from `except Exception`), so an
//! unreadable cache is indistinguishable from an expired session: both
//! answer `200 {"status":"failed","error":"Session expired or not found"}`.
//!
//! `cache_manager._decode` keeps undecodable payloads as raw bytes, and the
//! handler's `if not session_data` then `session_data.get(...)` sequence
//! classifies the stored value: falsy JSON (null, false, zero, an empty
//! string, empty arrays or objects) or an empty raw payload renders the
//! failed response, while a truthy non-object (raw bytes, a non-empty
//! string, a non-zero number, or a non-empty array) raises `AttributeError`
//! and the application's `Exception` handler answers
//! `500 {"error_code":500,"detail":"Internal server error"}`. A decoded
//! object's `status` field is stringified with Python's `str()` before the
//! pending/success/failed dispatch, and a non-string `access_token`,
//! `username`, or `error` value fails pydantic's response-model validation
//! with the same 500 body.
//!
//! The required `session_id` query parameter is bound by FastAPI before the
//! handler body runs; a missing value renders the application's
//! `RequestValidationError` handler body
//! (`app/core/exceptions.py::validation_exception_handler`).
use brz_http_server::StatusCode;
use brz_redis::{Redis, RedisBytes, RedisKey2};
use serde::Serialize;
use serde_json::{Value, json};

use crate::http_compat::FastApiError;
use crate::json_compat::python_str;
use crate::state::AppState;

/// `CLI_SESSION_KEY_PREFIX` (`app.api.endpoints.oidc`).
const CLI_SESSION_KEY_PREFIX: &str = "cli_login_session:";

/// `CLIPollResponse` (`app/schemas/user.py`): the field order matches the
/// recorded response body.
#[derive(Debug, Serialize)]
struct CliPollResponse {
    status: String,
    access_token: Option<String>,
    username: Option<String>,
    error: Option<String>,
}

/// GET /api/auth/oidc/cli-poll: the source's free function, injecting the
/// process-lifetime application state. The source declares no authentication
/// dependency, so the route is public.
#[brz_http_server::get("/api/auth/oidc/cli-poll", access = public)]
async fn cli_poll_token(
    #[inject(state)] state: &AppState,
    session_id: Option<String>,
) -> Result<CliPollResponse, FastApiError> {
    // FastAPI binds the required `session_id` query parameter before the
    // handler body runs; a missing value is the application's 422 body.
    let Some(session_id) = session_id else {
        return Err(missing_session_id());
    };
    let session = read_session(state.redis.as_ref(), &session_id).await;
    poll_from_stored(session.as_deref())
}

/// `cache_manager.get(cli_login_session:{session_id})`: the read goes over
/// the shared application Redis service, and a read failure is logged and
/// swallowed into `None`, exactly like an expired session. An unavailable
/// service also degrades to `None`: the source's lazily-connecting client
/// would fail the read and swallow it the same way.
async fn read_session<R: Redis>(redis: Option<&R>, session_id: &str) -> Option<RedisBytes> {
    let redis = redis?;
    match redis
        .get::<_, RedisBytes>(RedisKey2(CLI_SESSION_KEY_PREFIX, session_id))
        .await
    {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(%error, session_id, "cli login session cache read failed");
            None
        }
    }
}

/// Handler body of `cli_poll_token` over one stored session payload: decode,
/// apply Python truthiness, then dispatch on the stringified `status`.
fn poll_from_stored(session: Option<&[u8]>) -> Result<CliPollResponse, FastApiError> {
    let Some(bytes) = session else {
        return Ok(session_expired());
    };
    let session_data = match serde_json::from_slice::<Value>(bytes) {
        // `cache_manager._decode`: `orjson.loads(data)`.
        Ok(value) => value,
        // Undecodable payloads stay raw bytes: empty bytes are falsy, any
        // other raw payload proceeds to `.get` and raises.
        Err(_) => {
            return if bytes.is_empty() {
                Ok(session_expired())
            } else {
                Err(FastApiError::unhandled())
            };
        }
    };
    // `if not session_data`: Python truthiness of the decoded value.
    if !brz_json::adapters::python_truthy(&session_data) {
        return Ok(session_expired());
    }
    let Value::Object(map) = session_data else {
        // A truthy non-object raises `AttributeError` on `.get`.
        return Err(FastApiError::unhandled());
    };
    // `status = session_data.get("status", "pending")`, then `str(status)`.
    let status = match map.get("status") {
        Some(value) => python_str(value),
        None => "pending".to_owned(),
    };
    if status == "pending" {
        Ok(CliPollResponse {
            status,
            access_token: None,
            username: None,
            error: None,
        })
    } else if status == "success" {
        Ok(CliPollResponse {
            status,
            access_token: opt_str(map.get("access_token"))?,
            username: opt_str(map.get("username"))?,
            error: None,
        })
    } else {
        // Every other stringified status renders the literal "failed".
        Ok(CliPollResponse {
            status: "failed".to_owned(),
            access_token: None,
            username: None,
            error: opt_str(map.get("error"))?,
        })
    }
}

/// `CLIPollResponse(status="failed", error="Session expired or not found")`.
fn session_expired() -> CliPollResponse {
    CliPollResponse {
        status: "failed".to_owned(),
        access_token: None,
        username: None,
        error: Some("Session expired or not found".to_owned()),
    }
}

/// `session_data.get(field)` passed to an `Optional[str]` response field:
/// a missing key or JSON `null` stays `None`, a string is kept, and any
/// other JSON value fails pydantic validation (the application's 500 body).
fn opt_str(value: Option<&Value>) -> Result<Option<String>, FastApiError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(FastApiError::unhandled()),
    }
}

/// The application's `validation_exception_handler` body for the missing
/// required `session_id` query parameter.
fn missing_session_id() -> FastApiError {
    FastApiError::json_body(StatusCode::UNPROCESSABLE_ENTITY, missing_session_id_body())
}

/// `{"error_code":422,"detail":"Request parameter validation failed",
/// "errors":[...]}` — the body `app/core/exceptions.py` renders for
/// FastAPI's `RequestValidationError` on the missing query parameter.
fn missing_session_id_body() -> Value {
    json!({
        "error_code": 422,
        "detail": "Request parameter validation failed",
        "errors": [
            {
                "type": "missing",
                "loc": ["query", "session_id"],
                "msg": "Field required",
                "input": null,
            },
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::__private::inventory;
    use brz_redis::{
        EncodeRedisArg, EncodeRedisArgs, ErrorKind, FromRedisBulk, RedisError, RedisResult,
    };

    /// The poll endpoint is registered exactly once in the public route
    /// group; before this migration the path had no handler, so the gateway
    /// answered the recorded request with the 404 fallback.
    #[test]
    fn cli_poll_is_registered_in_the_public_group() {
        let paths: Vec<_> = inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)())
            .map(|route| route.path)
            .filter(|path| *path == "/api/auth/oidc/cli-poll")
            .collect();
        assert_eq!(paths, ["/api/auth/oidc/cli-poll"]);
    }

    #[test]
    fn response_serializes_in_pydantic_field_order() {
        // The recorded success body shape: all four fields, `null` for the
        // absent ones (synthetic values; the recorded token is evidence).
        let body = serde_json::to_string(&CliPollResponse {
            status: "success".to_owned(),
            access_token: Some("tok".to_owned()),
            username: Some("example-user".to_owned()),
            error: None,
        })
        .unwrap();
        assert_eq!(
            body,
            r#"{"status":"success","access_token":"tok","username":"example-user","error":null}"#
        );

        let body = serde_json::to_string(&CliPollResponse {
            status: "pending".to_owned(),
            access_token: None,
            username: None,
            error: None,
        })
        .unwrap();
        assert_eq!(
            body,
            r#"{"status":"pending","access_token":null,"username":null,"error":null}"#
        );
    }

    #[test]
    fn missing_session_id_renders_the_application_422_body() {
        let error = missing_session_id();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            serde_json::to_string(&missing_session_id_body()).unwrap(),
            concat!(
                r#"{"error_code":422,"detail":"Request parameter validation failed","errors":"#,
                r#"[{"type":"missing","loc":["query","session_id"],"msg":"Field required","input":null}]}"#
            )
        );
    }

    #[test]
    fn missing_or_falsy_session_renders_the_expired_body() {
        let expected = r#"{"status":"failed","access_token":null,"username":null,"error":"Session expired or not found"}"#;
        // A missing key, an empty raw payload, and every falsy JSON value.
        for session in [
            None,
            Some(&b""[..]),
            Some(&b"null"[..]),
            Some(&b"false"[..]),
            Some(&b"0"[..]),
            Some(&b"\"\""[..]),
            Some(&b"[]"[..]),
            Some(&b"{}"[..]),
        ] {
            let body = serde_json::to_string(&poll_from_stored(session).expect("expired response"))
                .unwrap();
            assert_eq!(body, expected, "session={session:?}");
        }
    }

    #[test]
    fn truthy_non_object_session_renders_the_500_body() {
        // Raw undecodable bytes, a non-empty string, a non-zero number, and
        // a non-empty array all raise before the status dispatch.
        for session in [&b"not-json"[..], &b"\"abc\""[..], &b"5"[..], &b"[1,2]"[..]] {
            let error = poll_from_stored(Some(session)).expect_err("server error");
            assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
        }
    }

    #[test]
    fn object_session_dispatches_on_the_stringified_status() {
        // A truthy object without `status` defaults to pending.
        let pending = poll_from_stored(Some(br#"{"access_token":"x"}"#)).unwrap();
        assert_eq!(pending.status, "pending");
        assert!(pending.access_token.is_none());

        let pending = poll_from_stored(Some(br#"{"status":"pending"}"#)).unwrap();
        assert_eq!(pending.status, "pending");

        let success = poll_from_stored(Some(
            br#"{"status":"success","access_token":"t","username":"u"}"#,
        ))
        .unwrap();
        assert_eq!(success.status, "success");
        assert_eq!(success.access_token.as_deref(), Some("t"));
        assert_eq!(success.username.as_deref(), Some("u"));
        assert!(success.error.is_none());

        // A success without the token fields keeps JSON null.
        let success = poll_from_stored(Some(br#"{"status":"success"}"#)).unwrap();
        assert!(success.access_token.is_none() && success.username.is_none());

        let failed = poll_from_stored(Some(br#"{"status":"failed","error":"bad"}"#)).unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.error.as_deref(), Some("bad"));

        // A failed status without an error keeps JSON null.
        let failed = poll_from_stored(Some(br#"{"status":"failed"}"#)).unwrap();
        assert!(failed.error.is_none());

        // Unknown statuses render the literal "failed" with the stored error.
        let other = poll_from_stored(Some(br#"{"status":"whatever","error":"x"}"#)).unwrap();
        assert_eq!(other.status, "failed");
        assert_eq!(other.error.as_deref(), Some("x"));

        // `status: null` stringifies to "None" and takes the failed branch.
        let null_status = poll_from_stored(Some(br#"{"status":null}"#)).unwrap();
        assert_eq!(null_status.status, "failed");
        assert!(null_status.error.is_none());

        // `str()` of non-string statuses.
        for (payload, status) in [
            (br#"{"status":7}"#.as_slice(), "failed"),
            (br#"{"status":true}"#.as_slice(), "failed"),
        ] {
            let response = poll_from_stored(Some(payload)).unwrap();
            assert_eq!(response.status, status);
        }
    }

    #[test]
    fn wrong_typed_response_fields_render_the_500_body() {
        for payload in [
            &br#"{"status":"success","access_token":123}"#[..],
            &br#"{"status":"success","username":99}"#[..],
            &br#"{"status":"failed","error":42}"#[..],
        ] {
            let error = poll_from_stored(Some(payload)).expect_err("server error");
            assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
        }
    }

    #[test]
    fn python_str_matches_the_source_coercions() {
        assert_eq!(python_str(&Value::Null), "None");
        assert_eq!(python_str(&Value::Bool(true)), "True");
        assert_eq!(python_str(&Value::Bool(false)), "False");
        assert_eq!(python_str(&serde_json::json!(7)), "7");
        assert_eq!(python_str(&serde_json::json!(-3)), "-3");
        assert_eq!(python_str(&serde_json::json!("ok")), "ok");
        // Containers render with Python's repr (single quotes, ", " joins).
        assert_eq!(python_str(&serde_json::json!(["a", 1])), "['a', 1]");
        assert_eq!(python_str(&serde_json::json!({"k": "v"})), "{'k': 'v'}");
    }

    /// One canned `GET` outcome for [`read_session`].
    enum StubGet {
        Miss,
        Hit(&'static [u8]),
        Fail,
    }

    /// A `Redis` implementation answering only `GET` from a canned outcome.
    struct StubRedis(StubGet);

    impl Redis for StubRedis {
        async fn get<K, R>(&self, _key: K) -> RedisResult<Option<R>>
        where
            K: EncodeRedisArg + Send,
            R: FromRedisBulk + Send,
        {
            match &self.0 {
                StubGet::Miss => Ok(None),
                StubGet::Hit(bytes) => {
                    R::from_redis_bulk(RedisBytes::from(bytes.to_vec())).map(Some)
                }
                StubGet::Fail => Err(RedisError::new(ErrorKind::ClientError, "stub read failure")),
            }
        }

        async fn set<K, V>(&self, _key: K, _value: V) -> RedisResult<()>
        where
            K: EncodeRedisArg + Send,
            V: EncodeRedisArg + Send,
        {
            Ok(())
        }

        async fn mget<K, R>(&self, _keys: K) -> RedisResult<Vec<Option<R>>>
        where
            K: EncodeRedisArgs + Send,
            R: FromRedisBulk + Send,
        {
            Ok(Vec::new())
        }

        async fn del_many<K>(&self, _keys: K) -> RedisResult<i64>
        where
            K: EncodeRedisArgs + Send,
        {
            Ok(0)
        }

        async fn pfcount<K>(&self, _keys: K) -> RedisResult<i64>
        where
            K: EncodeRedisArgs + Send,
        {
            Ok(0)
        }

        async fn hget<K, F, R>(&self, _key: K, _field: F) -> RedisResult<Option<R>>
        where
            K: EncodeRedisArg + Send,
            F: EncodeRedisArg + Send,
            R: FromRedisBulk + Send,
        {
            Ok(None)
        }

        async fn hmget<K, F, R>(
            &self,
            _key: K,
            _fields: F,
        ) -> RedisResult<brz_redis::RedisValues<R>>
        where
            K: EncodeRedisArg + Send,
            F: EncodeRedisArgs + Send,
            R: FromRedisBulk + Send,
        {
            // The stub never serves a hash read; the default `command`
            // escape hatch would reject it, so surface that failure.
            Err(brz_redis::RedisError::new(
                brz_redis::ErrorKind::ClientError,
                "stub does not serve HMGET",
            ))
        }
    }

    #[tokio::test]
    async fn read_session_swallows_failures_like_cache_manager() {
        // A missing service yields None like a swallowed read failure.
        assert!(read_session(None::<&StubRedis>, "s").await.is_none());
        assert!(
            read_session(Some(&StubRedis(StubGet::Miss)), "s")
                .await
                .is_none()
        );
        assert!(
            read_session(Some(&StubRedis(StubGet::Fail)), "s")
                .await
                .is_none()
        );
        // A hit returns the raw stored bytes for `_decode`.
        let hit = read_session(
            Some(&StubRedis(StubGet::Hit(br#"{"status":"pending"}"#))),
            "s",
        )
        .await
        .expect("stored bytes");
        assert_eq!(hit.as_ref(), &br#"{"status":"pending"}"#[..]);
    }
}
