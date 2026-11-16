// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Unit tests for the Wework desktop authorization session endpoints.

use super::*;

/// A placeholder frontend URL for the authorize-URL tests, mirroring
/// Synthetic frontend origin for authorization URL tests.
const TEST_FRONTEND_URL: &str = "https://wegent.example.invalid";

#[test]
fn accepts_a_valid_uuid4() {
    assert!(valid_uuid4("00000000-0000-4000-8000-000000000001"));
    assert!(valid_uuid4("00000000-0000-4000-8000-000000000000"));
    assert!(valid_uuid4("6f2b1c2b-1234-4abc-9def-0123456789ab"));
}

#[test]
fn rejects_malformed_or_non_v4_ids() {
    assert!(!valid_uuid4(""));
    assert!(!valid_uuid4("00000000-0000-4000-8000-00000000000")); // too short
    assert!(!valid_uuid4("00000000-0000-5000-8000-000000000001")); // not v4
    assert!(!valid_uuid4("00000000-0000-4000-8000-00000000000g")); // bad hex
    assert!(!valid_uuid4("00000000000040008000000000000001")); // no dashes
}

#[test]
fn approval_body_matches_the_recorded_response() {
    assert_eq!(
        serde_json::to_string(&Approval {
            status: "approved".to_string()
        })
        .unwrap(),
        r#"{"status":"approved"}"#
    );
}

/// `_read_session`'s `if not session_data`: the falsy JSON values render
/// the 404 while any other decoded value proceeds to the dict check.
#[test]
fn js_truthy_matches_python_truthiness() {
    assert!(!js_truthy(&serde_json::json!(null)));
    assert!(!js_truthy(&serde_json::json!(false)));
    assert!(!js_truthy(&serde_json::json!(0)));
    assert!(!js_truthy(&serde_json::json!("")));
    assert!(!js_truthy(&serde_json::json!([])));
    assert!(!js_truthy(&serde_json::json!({})));
    assert!(js_truthy(&serde_json::json!(true)));
    assert!(js_truthy(&serde_json::json!(1)));
    assert!(js_truthy(&serde_json::json!("x")));
    assert!(js_truthy(&serde_json::json!([1])));
    assert!(js_truthy(&serde_json::json!({"status": "pending"})));
}

#[test]
fn read_failure_bodies_match_the_source() {
    assert_eq!(
        session_expired().detail_message(),
        Some("Authorization session expired or not found")
    );
    assert_eq!(
        session_expired().status(),
        brz_http_server::StatusCode::NOT_FOUND
    );
    assert_eq!(
        invalid_session().detail_message(),
        Some("Authorization session is invalid")
    );
    assert_eq!(
        invalid_session().status(),
        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        invalid_poll_token().detail_message(),
        Some("Invalid authorization polling token")
    );
    assert_eq!(
        invalid_poll_token().status(),
        brz_http_server::StatusCode::UNAUTHORIZED
    );
}

/// The pending body has all six fields, with `null` for the
/// absent ones.
#[test]
fn pending_poll_body_matches_the_recorded_response() {
    let body = serde_json::to_string(&poll_status("pending")).unwrap();
    assert_eq!(
        body,
        concat!(
            r#"{"status":"pending","access_token":null,"refresh_token":null,"#,
            r#""token_type":null,"username":null,"error":null}"#
        )
    );
}

#[test]
fn success_poll_body_serializes_in_pydantic_field_order() {
    let response = PollResponse {
        status: "success".to_owned(),
        access_token: Some("access".to_owned()),
        refresh_token: Some("refresh".to_owned()),
        token_type: Some("bearer".to_owned()),
        username: Some("example-user".to_owned()),
        error: None,
    };
    assert_eq!(
        serde_json::to_string(&response).unwrap(),
        concat!(
            r#"{"status":"success","access_token":"access","refresh_token":"refresh","#,
            r#""token_type":"bearer","username":"example-user","error":null}"#
        )
    );
}

fn session(fields: &[(&str, Value)]) -> serde_json::Map<String, Value> {
    fields
        .iter()
        .map(|(key, value)| (key.to_string(), value.clone()))
        .collect()
}

/// The status dispatch of `poll_wework_auth_session` over stored records.
/// `None` mirrors an unavailable Redis service, whose swallowed write
/// failure never changes the response.
#[tokio::test]
async fn poll_dispatches_on_the_stored_status() {
    let pending = session(&[("status", "pending".into()), ("poll_token", "t".into())]);
    let body = serde_json::to_string(
        &poll_from_session(
            None::<&brz_redis::RedisService>,
            "00000000-0000-4000-8000-000000000001",
            pending,
        )
        .await
        .expect("pending response"),
    )
    .unwrap();
    assert_eq!(body, poll_body("pending", None));

    let declined = session(&[("status", "declined".into())]);
    let body = serde_json::to_string(
        &poll_from_session(
            None::<&brz_redis::RedisService>,
            "00000000-0000-4000-8000-000000000001",
            declined,
        )
        .await
        .expect("declined response"),
    )
    .unwrap();
    assert_eq!(body, poll_body("declined", None));

    let claimed = session(&[("status", "claimed".into())]);
    let body = serde_json::to_string(
        &poll_from_session(
            None::<&brz_redis::RedisService>,
            "00000000-0000-4000-8000-000000000001",
            claimed,
        )
        .await
        .expect("claimed response"),
    )
    .unwrap();
    assert_eq!(
        body,
        poll_body(
            "failed",
            Some("Authorization token has already been claimed")
        )
    );

    // An unknown status renders the stored error, with the literal
    // fallback for an absent, null, or empty error value.
    for error in ["stored error", ""] {
        let mut failed = session(&[("status", "expired".into())]);
        failed.insert("error".to_string(), Value::String(error.to_owned()));
        let body = serde_json::to_string(
            &poll_from_session(
                None::<&brz_redis::RedisService>,
                "00000000-0000-4000-8000-000000000001",
                failed,
            )
            .await
            .expect("failed response"),
        )
        .unwrap();
        let expected = if error.is_empty() {
            "Authorization failed"
        } else {
            error
        };
        assert_eq!(body, poll_body("failed", Some(expected)));
    }
    let mut failed = session(&[("status", "expired".into())]);
    failed.insert("error".to_string(), Value::Null);
    let body = serde_json::to_string(
        &poll_from_session(
            None::<&brz_redis::RedisService>,
            "00000000-0000-4000-8000-000000000001",
            failed,
        )
        .await
        .expect("failed response"),
    )
    .unwrap();
    assert_eq!(body, poll_body("failed", Some("Authorization failed")));
}

/// The `approved` claim: the tokens are served once and the record is
/// rewritten without them.
#[tokio::test]
async fn approved_poll_claims_the_tokens() {
    let record = session(&[
        ("status", "approved".into()),
        ("auth_mode", "device_bound_refresh".into()),
        ("poll_token", "t".into()),
        ("access_token", "access".into()),
        ("refresh_token", "refresh".into()),
        ("username", "example-user".into()),
    ]);
    let body = serde_json::to_string(
        &poll_from_session(
            None::<&brz_redis::RedisService>,
            "00000000-0000-4000-8000-000000000001",
            record,
        )
        .await
        .expect("success response"),
    )
    .unwrap();
    assert_eq!(
        body,
        concat!(
            r#"{"status":"success","access_token":"access","refresh_token":"refresh","#,
            r#""token_type":"bearer","username":"example-user","error":null}"#
        )
    );

    // A device-bound session without a string refresh token fails the
    // claim; a legacy session serves the access token alone.
    let mut legacy = session(&[
        ("status", "approved".into()),
        ("auth_mode", "legacy_access".into()),
        ("access_token", "legacy-access".into()),
    ]);
    let body = serde_json::to_string(
        &poll_from_session(
            None::<&brz_redis::RedisService>,
            "00000000-0000-4000-8000-000000000001",
            legacy.clone(),
        )
        .await
        .expect("legacy success response"),
    )
    .unwrap();
    assert!(
        body.contains(r#""access_token":"legacy-access""#)
            && body.contains(r#""refresh_token":null"#)
    );

    legacy.remove("access_token");
    let body = serde_json::to_string(
        &poll_from_session(
            None::<&brz_redis::RedisService>,
            "00000000-0000-4000-8000-000000000001",
            legacy,
        )
        .await
        .expect("missing token response"),
    )
    .unwrap();
    assert_eq!(
        body,
        poll_body("failed", Some("Authorization token is missing"))
    );
}

/// The stored `poll_token` is the poll credential: the claim path is
/// reached only by the handler after `_require_poll_token` matches it.
#[tokio::test]
async fn pending_poll_serves_the_stored_status() {
    let record = session(&[
        ("status", "pending".into()),
        ("poll_token", "stored-token".into()),
    ]);
    let body = serde_json::to_string(
        &poll_from_session(
            None::<&brz_redis::RedisService>,
            "00000000-0000-4000-8000-000000000001",
            record,
        )
        .await
        .expect("poll response"),
    )
    .unwrap();
    assert_eq!(body, poll_body("pending", None));
}

/// The application's 422 body for the missing required `poll_token`
/// query parameter.
#[test]
fn missing_poll_token_renders_the_application_422_body() {
    let error = missing_poll_token();
    assert_eq!(
        error.status(),
        brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
    );
}

/// The poll endpoint is registered exactly once in the public route
/// group; before this migration the route table selected the path but no
/// handler existed, so the gateway answered with the 404 fallback.
#[test]
fn poll_is_registered_in_the_public_group() {
    use brz_http_server::__private::inventory;
    let paths: Vec<_> = inventory::iter::<crate::__http_registry_http_apis::Entry>()
        .flat_map(|entry| (entry.0.routes)())
        .map(|route| route.path)
        .filter(|path| *path == "/api/auth/wework/sessions/:session_id/poll")
        .collect();
    assert_eq!(paths, ["/api/auth/wework/sessions/:session_id/poll"]);
}

/// The create endpoint is registered exactly once in the public route
/// group; before this migration the route table selected the path but no
/// handler existed, so the gateway answered the recorded desktop login
/// request with the 404 fallback.
#[test]
fn create_is_registered_in_the_public_group() {
    use brz_http_server::__private::inventory;
    let paths: Vec<_> = inventory::iter::<crate::__http_registry_http_apis::Entry>()
        .flat_map(|entry| (entry.0.routes)())
        .map(|route| route.path)
        .filter(|path| *path == "/api/auth/wework/sessions")
        .collect();
    assert_eq!(paths, ["/api/auth/wework/sessions"]);
}

/// `random_poll_token` matches `secrets.token_urlsafe(32)`: 43
/// unpadded base64url characters over the URL-safe alphabet.
#[test]
fn poll_token_matches_token_urlsafe_width_and_alphabet() {
    let token = random_poll_token().expect("OS randomness is available");
    assert_eq!(token.len(), 43);
    assert!(
        token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    );
}

/// `get_wework_web_config`: `FRONTEND_URL.rstrip("/")` and
/// `WEGENT_SOCKET_URL.strip().rstrip("/") or None`, in the schema's declared
/// field order.
#[test]
fn web_config_trims_urls_and_nullifies_an_empty_socket_url() {
    let response = web_config(
        &format!("{TEST_FRONTEND_URL}/"),
        Some("wss://socket.example.invalid/".to_string()),
    );
    assert_eq!(
        serde_json::to_string(&response).unwrap(),
        format!(
            r#"{{"web_url":"{TEST_FRONTEND_URL}","socket_url":"wss://socket.example.invalid"}}"#
        )
    );

    for socket_url in [
        None,
        Some(String::new()),
        Some("   ".to_string()),
        Some("///".to_string()),
    ] {
        let response = web_config(TEST_FRONTEND_URL, socket_url);
        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            format!(r#"{{"web_url":"{TEST_FRONTEND_URL}","socket_url":null}}"#)
        );
    }
}

/// The config endpoint is registered exactly once in the public route group;
/// the route table already selected the path, and without a Rust handler the
/// gateway answered the recorded request with the 404 fallback.
#[test]
fn config_is_registered_in_the_public_group() {
    use brz_http_server::__private::inventory;
    let paths: Vec<_> = inventory::iter::<crate::__http_registry_http_apis::Entry>()
        .flat_map(|entry| (entry.0.routes)())
        .map(|route| route.path)
        .filter(|path| *path == "/api/auth/wework/config")
        .collect();
    assert_eq!(paths, ["/api/auth/wework/config"]);
}

/// RFC 7638 thumbprint of the standard P-256 generator point; no recorded
/// device identity is used.
#[test]
fn device_key_thumbprint_matches_rfc7638() {
    let key = CreateDevicePublicKey {
        kty: "EC".to_string(),
        crv: "P-256".to_string(),
        x: "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY".to_string(),
        y: "T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU".to_string(),
    };
    assert_eq!(
        device_key_thumbprint(&key),
        "xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M"
    );
}

/// `_validated_device_public_key`'s classification: the EC/P-256 check,
/// the 32-byte coordinate check, and the kept component values.
#[test]
fn validated_device_public_key_classifies_errors() {
    let valid = validated_device_public_key(&serde_json::json!({
        "kty": "EC", "crv": "P-256",
        "x": "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY",
        "y": "T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
    }))
    .expect("valid key");
    assert_eq!(
        serde_json::to_value(render_device_public_key(&valid)).unwrap(),
        serde_json::json!({
            "kty": "EC", "crv": "P-256",
            "x": "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY",
            "y": "T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
        })
    );

    // A missing component defaults to "" and fails the EC/P-256 check
    // first (kty) or the decode check (x/y).
    let error = validated_device_public_key(&serde_json::json!({})).expect_err("missing kty");
    assert_eq!(error.status(), brz_http_server::StatusCode::BAD_REQUEST);
    assert_eq!(
        error.detail_message(),
        Some("Device public key must use EC P-256")
    );
    let error = validated_device_public_key(&serde_json::json!({
        "kty": "RSA", "crv": "P-256", "x": "A", "y": "B",
    }))
    .expect_err("wrong kty");
    assert_eq!(
        error.detail_message(),
        Some("Device public key must use EC P-256")
    );
    let error = validated_device_public_key(&serde_json::json!({
        "kty": "EC", "crv": "P-256", "x": "AAAA", "y": "AAAA",
    }))
    .expect_err("short coordinates");
    assert_eq!(error.detail_message(), Some("Invalid device public key"));
}

/// `create_session`'s pending record for device-bound and legacy sessions.
#[test]
fn build_session_record_matches_the_recorded_pending_shape() {
    let record = build_session_record(
        "example-poll-token".to_string(),
        1792120612,
        1792120912,
        Some(serde_json::json!({
            "kty": "EC", "crv": "P-256",
            "x": "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY",
            "y": "T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
        })),
    )
    .expect("device-bound record");
    assert_eq!(
        Value::Object(record),
        serde_json::json!({
            "status": "pending",
            "auth_mode": "device_bound_refresh",
            "poll_token": "example-poll-token",
            "created_at": 1792120612,
            "expires_at": 1792120912,
            "device_public_key": {
                "kty": "EC", "crv": "P-256",
                "x": "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY",
                "y": "T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
            },
            "device_thumbprint": "xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M",
        })
    );

    // Without a device key the record stays legacy and carries no device
    // members.
    let legacy = build_session_record("t".to_string(), 1, 301, None).expect("legacy record");
    assert_eq!(
        Value::Object(legacy),
        serde_json::json!({
            "status": "pending",
            "auth_mode": "legacy_access",
            "poll_token": "t",
            "created_at": 1,
            "expires_at": 301,
        })
    );
}

/// The create write surfaces a swallowed Redis failure: the source checks
/// `cache_manager.set`'s returned flag and answers its own 500.
#[tokio::test]
async fn create_write_surfaces_the_swallowed_failure() {
    use brz_redis::{
        EncodeRedisArg, EncodeRedisArgs, ErrorKind, FromRedisBulk, FromRedisValue, RedisError,
        RedisResult, RedisValues,
    };

    /// A `Redis` stub whose `SET` answers with an error, exercising the
    /// source's checked write flag.
    struct FailRedis;
    impl Redis for FailRedis {
        async fn command<R>(&self, _command: brz_redis::Cmd) -> RedisResult<R>
        where
            R: FromRedisValue + Send,
        {
            Err(RedisError::new(
                ErrorKind::ClientError,
                "stub write failure",
            ))
        }

        async fn get<K, R>(&self, _key: K) -> RedisResult<Option<R>>
        where
            K: EncodeRedisArg + Send,
            R: FromRedisBulk + Send,
        {
            Ok(None)
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

        async fn hmget<K, F, R>(&self, _key: K, _fields: F) -> RedisResult<RedisValues<R>>
        where
            K: EncodeRedisArg + Send,
            F: EncodeRedisArgs + Send,
            R: FromRedisBulk + Send,
        {
            Err(RedisError::new(
                ErrorKind::ClientError,
                "stub does not serve HMGET",
            ))
        }
    }

    // No service renders the same false as a swallowed failure.
    assert!(!write_new_session_over(None::<&FailRedis>, "s", Value::Null).await);
    assert!(
        !write_new_session_over(
            Some(&FailRedis),
            "s",
            serde_json::json!({"status": "pending"}),
        )
        .await
    );
}

/// `_authorize_base_url` and `_build_authorize_url`: the FRONTEND_URL
/// fallback and trailing-slash trim. The
/// `WEWORK_AUTHORIZE_BASE_URL` env override is environment state, so this
/// exercises the fallback path only.
#[test]
fn authorize_url_uses_the_frontend_url_fallback() {
    let url = build_authorize_url(
        &format!("{TEST_FRONTEND_URL}/"),
        "00000000-0000-4000-8000-000000000002",
    )
    .expect("authorize url");
    assert_eq!(
        url,
        "https://wegent.example.invalid/auth/wework/authorize\
         ?session_id=00000000-0000-4000-8000-000000000002"
    );
    // An unparseable base renders the source's 500.
    let error = build_authorize_url("not-a-url", "s").expect_err("invalid base");
    assert_eq!(
        error.status(),
        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        error.detail_message(),
        Some("Wework authorization Web URL is invalid")
    );
    // An empty base renders the unconfigured 500.
    let error = build_authorize_url("", "s").expect_err("empty base");
    assert_eq!(
        error.detail_message(),
        Some("Wework authorization Web URL is not configured")
    );
}

fn poll_body(status: &str, error: Option<&str>) -> String {
    let error = match error {
        Some(text) => format!("{text:?}"),
        None => "null".to_owned(),
    };
    format!(
        "{{\"status\":\"{status}\",\"access_token\":null,\"refresh_token\":null,\
         \"token_type\":null,\"username\":null,\"error\":{error}}}"
    )
}

/// The optional body binds like `WeworkAuthSessionCreateRequest | None = None`:
/// absent, JSON `null`, and `{}` are unset; a non-object body, a non-object
/// `device_public_key`, and non-string components are the application's 422.
#[test]
fn create_body_binding_matches_pydantic() {
    assert!(bind_create_body(None).expect("absent body").is_none());
    assert!(
        bind_create_body(Some(&Value::Null))
            .expect("null body")
            .is_none()
    );
    assert!(
        bind_create_body(Some(&serde_json::json!({})))
            .expect("empty object")
            .is_none()
    );
    assert!(
        bind_create_body(Some(&serde_json::json!({"device_public_key": null})))
            .expect("null device key")
            .is_none()
    );

    let key = serde_json::json!({
        "kty": "EC", "crv": "P-256", "x": "a", "y": "b",
    });
    assert_eq!(
        bind_create_body(Some(&serde_json::json!({"device_public_key": key.clone()})))
            .expect("valid device key"),
        Some(key)
    );

    let unprocessable = brz_http_server::StatusCode::UNPROCESSABLE_ENTITY;
    let error = bind_create_body(Some(&serde_json::json!([1, 2]))).expect_err("array body");
    assert_eq!(error.status(), unprocessable);
    let error = bind_create_body(Some(&serde_json::json!({"device_public_key": "x"})))
        .expect_err("not a dict");
    assert_eq!(error.status(), unprocessable);
}

/// Pydantic's `dict[str, str]` binding reports one `string_type` entry per
/// non-string value, including keys the endpoint ignores.
#[test]
fn device_key_binding_reports_every_non_string_value() {
    let components = serde_json::json!({
        "kty": 1, "crv": "P-256", "x": "a", "y": null, "zz": 2,
    });
    let Value::Object(components) = components else {
        unreachable!("fixture is an object");
    };
    assert_eq!(
        Value::Array(device_public_key_errors(&components)),
        serde_json::json!([
            {
                "type": "string_type",
                "loc": ["body", "device_public_key", "kty"],
                "msg": "Input should be a valid string",
                "input": 1,
            },
            {
                "type": "string_type",
                "loc": ["body", "device_public_key", "y"],
                "msg": "Input should be a valid string",
                "input": null,
            },
            {
                "type": "string_type",
                "loc": ["body", "device_public_key", "zz"],
                "msg": "Input should be a valid string",
                "input": 2,
            },
        ])
    );
}

/// `urlparse(raw).netloc` must be non-empty: a scheme with no authority is
/// the source's 500, not an accepted base.
#[test]
fn authorize_base_requires_a_netloc() {
    assert!(has_http_scheme_and_netloc("https://wegent.example.invalid"));
    assert!(has_http_scheme_and_netloc(
        "HTTPS://wegent.example.invalid/path"
    ));
    assert!(!has_http_scheme_and_netloc("https:///path"));
    assert!(!has_http_scheme_and_netloc("https://?q"));
    assert!(!has_http_scheme_and_netloc("https://"));
    assert!(!has_http_scheme_and_netloc("ftp://wegent.example.invalid"));
}
