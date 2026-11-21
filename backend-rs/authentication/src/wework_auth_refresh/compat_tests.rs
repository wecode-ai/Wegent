// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Independent Python signatures and expected results, with a fixed clock.
use super::*;
use jsonwebtoken::Validation;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Fixtures {
    now: i64,
    secret: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    algorithm: String,
    request: WeworkTokenRefreshRequest,
    expected: Expected,
}

#[derive(Deserialize)]
struct Expected {
    status: u16,
    detail: Option<String>,
}

fn fixtures() -> Fixtures {
    serde_json::from_str(include_str!("../../tests/fixtures/wework_refresh.json")).unwrap()
}

fn config(secret: &str, algorithm: &str) -> AuthConfig {
    AuthConfig {
        jwt_key: secret.into(),
        legacy_jwt_keys: Vec::new(),
        algorithm: algorithm.into(),
    }
}

#[test]
fn signed_requests_match_python_endpoint_results() {
    let fixtures = fixtures();
    assert_eq!(fixtures.cases.len(), 56);
    for case in fixtures.cases {
        let auth = config(&fixtures.secret, &case.algorithm);
        let result = verify_refresh_request(&auth, &case.request, fixtures.now);
        if case.expected.status == 200 {
            let claims = result.unwrap_or_else(|error| panic!("{}: {error:?}", case.name));
            assert_eq!(claims["sub"], "fixture-user", "{}", case.name);
            assert_eq!(claims["user_id"], 7, "{}", case.name);
        } else {
            let error = result.expect_err(&case.name);
            assert_eq!(
                error.status().as_u16(),
                case.expected.status,
                "{}",
                case.name
            );
            assert_eq!(
                error.detail_message(),
                case.expected.detail.as_deref(),
                "{}",
                case.name
            );
        }
    }
}

fn user() -> UserRow {
    UserRow {
        id: 7,
        user_name: "fixture-user".into(),
        users_password_hash: String::new(),
        email: None,
        git_info: brz_mysql::Json(json!(null).into()),
        is_active: 1,
        role: "user".into(),
        auth_source: "password".into(),
        preferences: "{}".into(),
        created_at: chrono::DateTime::UNIX_EPOCH.naive_utc(),
        updated_at: chrono::DateTime::UNIX_EPOCH.naive_utc(),
    }
}

#[test]
fn valid_python_credentials_mint_a_signed_desktop_access_token() {
    let fixtures = fixtures();
    let user = user();
    for case in fixtures
        .cases
        .iter()
        .filter(|case| matches!(case.name.as_str(), "valid" | "hs384" | "hs512"))
    {
        let auth = config(&fixtures.secret, &case.algorithm);
        let claims = verify_refresh_request(&auth, &case.request, fixtures.now).unwrap();
        let before = chrono::Utc::now().timestamp();
        let response = issue_refreshed_token(&auth, &claims, Some(&user)).unwrap();
        let after = chrono::Utc::now().timestamp();
        assert_eq!(response.token_type, "bearer");
        assert_eq!(response.expires_in, wework_access_expire_minutes() * 60);
        let token = jsonwebtoken::decode::<Value>(
            &response.access_token,
            &DecodingKey::from_secret(fixtures.secret.as_bytes()),
            &Validation::new(jwt_algorithm(&case.algorithm)),
        )
        .unwrap();
        assert_eq!(token.claims["sub"], "fixture-user");
        assert_eq!(token.claims["user_id"], 7);
        assert_eq!(token.claims["token_use"], "wework_access");
        let expires = token.claims["exp"].as_i64().unwrap();
        assert!((before + response.expires_in..=after + response.expires_in).contains(&expires));
        assert_eq!(token.claims.as_object().unwrap().len(), 4);
    }
}

#[test]
fn missing_inactive_or_mismatched_users_cannot_refresh() {
    let auth = config("test-key", "HS256");
    let mut user = user();
    let claims = json!({"user_id": 7});
    assert_eq!(
        issue_refreshed_token(&auth, &claims, None)
            .unwrap_err()
            .status()
            .as_u16(),
        401
    );
    user.is_active = 0;
    assert_eq!(
        issue_refreshed_token(&auth, &claims, Some(&user))
            .unwrap_err()
            .status()
            .as_u16(),
        401
    );
    user.is_active = 1;
    for id in [json!(8), json!(true), json!(u64::MAX)] {
        let error = issue_refreshed_token(&auth, &json!({"user_id": id}), Some(&user)).unwrap_err();
        assert_eq!(
            error.detail_message(),
            Some("Desktop login is no longer valid")
        );
    }
    // Match Python's isinstance(user_id, int) gate.
    for id in [json!(null), json!("8"), json!(8.5)] {
        assert!(issue_refreshed_token(&auth, &json!({"user_id": id}), Some(&user)).is_ok());
    }
}

fn tamper_signature(token: &str) -> String {
    let mut parts: Vec<_> = token.split('.').map(str::to_owned).collect();
    let mut signature = decode_b64url(&parts[2]).unwrap();
    signature[0] ^= 1;
    parts[2] = base64url_nopad(&signature);
    parts.join(".")
}

#[test]
fn signature_tampering_and_token_substitution_are_rejected() {
    let fixtures = fixtures();
    let auth = config(&fixtures.secret, "HS256");
    let case = fixtures
        .cases
        .iter()
        .find(|case| case.name == "valid")
        .unwrap();
    let tampered = WeworkTokenRefreshRequest {
        refresh_token: case.request.refresh_token.clone(),
        proof: tamper_signature(&case.request.proof),
    };
    assert_eq!(
        verify_refresh_request(&auth, &tampered, fixtures.now)
            .unwrap_err()
            .detail_message(),
        Some("Invalid desktop device proof")
    );
    let tampered = WeworkTokenRefreshRequest {
        refresh_token: tamper_signature(&case.request.refresh_token),
        proof: case.request.proof.clone(),
    };
    assert_eq!(
        verify_refresh_request(&auth, &tampered, fixtures.now)
            .unwrap_err()
            .detail_message(),
        Some("Desktop login has expired")
    );
    let other = fixtures
        .cases
        .iter()
        .find(|case| case.name == "missing_exp")
        .unwrap();
    let substituted = WeworkTokenRefreshRequest {
        refresh_token: other.request.refresh_token.clone(),
        proof: case.request.proof.clone(),
    };
    assert_eq!(
        verify_refresh_request(&auth, &substituted, fixtures.now)
            .unwrap_err()
            .detail_message(),
        Some("Invalid desktop device proof")
    );
}
