// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/users/me/wegent-runtime` — encrypted user information for a
//! Wegent task token (`app.api.endpoints.users.read_wegent_runtime_user`).
//!
//! The source reads the raw `Authorization` header
//! (`authorization: Optional[str] = Header(default=None)`) and treats it as a
//! task token: `extract_token_from_header` keeps only the credential of a
//! `Bearer <token>` pair, `verify_task_token` decodes a `type=task_token` JWT,
//! and any failure answers `401 {"detail": "Invalid Wegent token"}` with
//! `WWW-Authenticate: Bearer`. The active `users` row is then loaded by `id`
//! (`is_active IS true`); a missing row answers
//! `404 {"detail": "User not found"}`. The success body is
//! `WegentRuntimeUserResponse { user }`, where `user` is
//! `shared.utils.crypto.encrypt_sensitive_data_with_embedded_iv` of the JSON
//! payload `{"employee_id", "email", "name", "uid", "expire_at"}`.
//!
//! Serving this route from Rust lets the hybrid gateway stop answering the
//! recorded 502 `fallback upstream unavailable` for the Python fallback and
//! return the source's runtime-user response instead.
use aes::{Aes128, Aes192, Aes256};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use brz_http_server::{
    AuthFailure, AuthRequest, Authenticator, EphemeralBytesArena, IntoHttpError, Response,
    StatusCode,
};
use brz_mysql::Mysql;
use cbc::Encryptor;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockEncryptMut, KeyIvInit};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::{Deserialize, Serialize};

use crate::auth::{AppAuthenticator, UserRow};
use crate::config::AuthConfig;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `verify_task_token`'s required `type` claim value.
const TASK_TOKEN_TYPE: &str = "task_token";

/// The `HTTPException(401)` detail for a rejected task token.
const INVALID_TOKEN_DETAIL: &str = "Invalid Wegent token";

/// `HTTPException(404)` detail when the token's user row is absent.
const USER_NOT_FOUND_DETAIL: &str = "User not found";

/// `USER_AES_KEY` default (`_get_embedded_iv_encryption_key`).
const DEFAULT_USER_AES_KEY: &str = "12345678901234567890123456789012";

/// AES block size, also the PKCS#7 block size and the embedded-IV length.
const BLOCK_SIZE: usize = 16;
const _: () = assert!(BLOCK_SIZE == 16, "embedded IV is one AES block");

/// The authenticated identity carried by the request's task token.
///
/// The source needs only `user_id` (for the `users` lookup) and `expire_at`
/// (for the payload); `user_id` is the token's claim, not the loaded row's id.
pub struct WegentRuntimeTaskUser {
    /// `token_info.user_id` (the `users.id` predicate).
    pub user_id: i64,
    /// `token_info.expire_at` (`payload["exp"]`, `0` when absent).
    pub expire_at: i64,
}

/// `verify_task_token`'s required/optional claims.
///
/// `task_id`, `subtask_id`, `user_id` and `user_name` are read with `[]` in the
/// source, so a missing one raises `KeyError` and the token is rejected;
/// `exp` is read with `.get`, so it stays optional and defaults to `0`.
#[derive(Debug, Deserialize)]
struct TaskTokenClaims {
    #[serde(rename = "type")]
    token_type: Option<String>,
    #[allow(dead_code, reason = "required claim; its presence is the check")]
    task_id: i64,
    #[allow(dead_code, reason = "required claim; its presence is the check")]
    subtask_id: i64,
    user_id: i64,
    #[allow(dead_code, reason = "required claim; its presence is the check")]
    user_name: String,
    exp: Option<i64>,
}

impl Authenticator<WegentRuntimeTaskUser> for AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: AuthRequest<'a>,
    ) -> Result<WegentRuntimeTaskUser, AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|value| std::str::from_utf8(value).ok());
        verify_task_token(&self.state().auth, authorization)
            .ok_or_else(|| AuthFailure::invalid_credentials("Bearer"))
    }

    fn reject(
        &self,
        _request: AuthRequest<'_>,
        _failure: AuthFailure,
        arena: &EphemeralBytesArena,
    ) -> Response {
        FastApiError::unauthorized(INVALID_TOKEN_DETAIL).into_http_error(arena)
    }
}

/// GET /api/users/me/wegent-runtime: the runtime-user free function, injecting
/// the process-lifetime application state.
#[brz_http_server::get("/api/users/me/wegent-runtime")]
async fn read_wegent_runtime_user(
    #[inject(state)] state: &AppState,
    #[auth] actor: WegentRuntimeTaskUser,
) -> Result<WegentRuntimeUserResponse, FastApiError> {
    runtime_user_response(&state.mysql, state.user_profile.as_ref(), &actor).await
}

/// `WegentRuntimeUserResponse`: a single `user` field.
#[derive(Serialize)]
struct WegentRuntimeUserResponse {
    user: String,
}

/// The endpoint body after authentication: load the active user, build the
/// payload JSON, and encrypt it with an embedded IV.
async fn runtime_user_response(
    mysql: &impl Mysql,
    user_profile: &dyn crate::user_profile::UserViewExtension,
    actor: &WegentRuntimeTaskUser,
) -> Result<WegentRuntimeUserResponse, FastApiError> {
    // `db.query(User).filter(User.id == ..., User.is_active.is_(True)).first()`.
    let user: Option<UserRow> = mysql
        .fetch_optional(ACTIVE_USER_BY_ID, (actor.user_id,))
        .await
        .map_err(|_| FastApiError::unhandled())?;
    let Some(user) = user else {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            USER_NOT_FOUND_DETAIL,
        ));
    };
    let fields = user_profile.runtime_user_payload_fields(&user);
    let payload = runtime_user_payload(&user, &fields, actor.expire_at);
    let encrypted =
        encrypt_sensitive_data_with_embedded_iv(&payload).map_err(|_| FastApiError::unhandled())?;
    Ok(WegentRuntimeUserResponse { user: encrypted })
}

/// `extract_token_from_header`: the credential of a two-token
/// `Bearer <token>` header (`str.split()` collapses runs of whitespace and
/// drops empty tokens), or `None` for any other shape.
fn extract_token_from_header(authorization: &str) -> Option<&str> {
    let mut parts = authorization.split_whitespace();
    let scheme = parts.next()?;
    let token = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    scheme.eq_ignore_ascii_case("bearer").then_some(token)
}

/// `verify_task_token`: decode the JWT (active key then legacy keys, `exp`
/// validated with no leeway), require `type=task_token`, and yield the task
/// identity. Any failure returns `None`, which the caller maps to the 401.
fn verify_task_token(
    config: &AuthConfig,
    authorization: Option<&str>,
) -> Option<WegentRuntimeTaskUser> {
    let token = extract_token_from_header(authorization?)?;
    let claims = decode_task_token(config, token)?;
    if claims.token_type.as_deref() != Some(TASK_TOKEN_TYPE) {
        return None;
    }
    Some(WegentRuntimeTaskUser {
        user_id: claims.user_id,
        expire_at: claims.exp.unwrap_or(0),
    })
}

/// Decode a task token with the active key, then each legacy key
/// (`jwt_compat.decode_pyjwt`).
fn decode_task_token(config: &AuthConfig, token: &str) -> Option<TaskTokenClaims> {
    let mut validation = Validation::new(algorithm(config));
    // python-jose/PyJWT defaults: signature and `exp` when present, no audience,
    // no required claims, and no leeway.
    validation.validate_aud = false;
    validation.validate_exp = true;
    validation.validate_nbf = true;
    validation.leeway = 0;
    validation.required_spec_claims.clear();
    decoding_keys(config).into_iter().find_map(|key_bytes| {
        decode::<TaskTokenClaims>(token, &DecodingKey::from_secret(&key_bytes), &validation)
            .ok()
            .map(|data| data.claims)
    })
}

/// Decode keys derived from the active key and legacy decode-only keys.
fn decoding_keys(config: &AuthConfig) -> Vec<Vec<u8>> {
    let mut keys = vec![config.jwt_key.as_bytes().to_vec()];
    for key in &config.legacy_jwt_keys {
        if !keys.iter().any(|existing| existing == key.as_bytes()) {
            keys.push(key.as_bytes().to_vec());
        }
    }
    keys
}

/// Algorithm from settings (`ALGORITHM`, default `HS256`).
fn algorithm(config: &AuthConfig) -> Algorithm {
    match config.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    }
}

/// The active user by id, mirroring the source SQLAlchemy rendering
/// (`WHERE users.id = ? AND users.is_active IS true`).
const ACTIVE_USER_BY_ID: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.id = ? AND users.is_active IS true \
     LIMIT 1";

/// The encrypted payload JSON (`json.dumps(payload, ensure_ascii=False)`).
///
/// The source dict order is `employee_id`, `email`, `name`, `uid`,
/// `expire_at`; `json.dumps` renders the default `", "` / `": "` separators,
/// so the plaintext is reproduced byte-for-byte before encryption. The
/// application extension supplies `employee_id`, `name`, and `uid`; `email`
/// stays the row's value with its `""` default.
fn runtime_user_payload(
    user: &UserRow,
    fields: &crate::user_profile::RuntimeUserPayloadFields,
    expire_at: i64,
) -> String {
    format!(
        "{{\"employee_id\": {}, \"email\": {}, \"name\": {}, \"uid\": {}, \"expire_at\": {}}}",
        json_string(&fields.employee_id),
        json_string(user.email.as_deref().unwrap_or("")),
        json_string(&fields.name),
        json_string(&fields.uid),
        expire_at,
    )
}

/// `json.dumps` for one string with `ensure_ascii=False` (raw UTF-8, no
/// `\uXXXX` escaping of non-ASCII).
fn json_string(value: &str) -> String {
    serde_json::to_string(value).expect("a &str always serializes")
}

/// The embedded-IV encryption key is misconfigured or the cipher rejected it;
/// the source raises and the request fails with a 500.
#[derive(Debug)]
struct CryptoConfigError;

/// `encrypt_sensitive_data_with_embedded_iv`: AES-CBC with PKCS#7 padding, a
/// fresh random 16-byte IV, and `base64(iv + ciphertext)`. `""` and `"***"`
/// pass through unchanged, matching `shared.utils.crypto`.
fn encrypt_sensitive_data_with_embedded_iv(plain: &str) -> Result<String, CryptoConfigError> {
    if plain.is_empty() {
        return Ok(String::new());
    }
    if plain == "***" {
        return Ok("***".to_string());
    }
    let key = crate::config::env_or_dotenv("USER_AES_KEY")
        .map(|raw| parse_aes_key(&raw))
        .unwrap_or_else(|| Ok(DEFAULT_USER_AES_KEY.as_bytes().to_vec()))?;
    let mut iv = [0u8; BLOCK_SIZE];
    getrandom::getrandom(&mut iv).expect("the OS RNG always provides entropy");
    let mut out = Vec::with_capacity(BLOCK_SIZE + plain.len() + BLOCK_SIZE);
    out.extend_from_slice(&iv);
    out.extend_from_slice(&encrypt_cbc(&key, &iv, plain)?);
    Ok(STANDARD.encode(out))
}

/// `_parse_aes_key`: a `base64:` prefix decodes the remainder; anything else is
/// used as raw UTF-8 bytes.
fn parse_aes_key(key: &str) -> Result<Vec<u8>, CryptoConfigError> {
    match key.strip_prefix("base64:") {
        Some(encoded) => STANDARD.decode(encoded).map_err(|_| CryptoConfigError),
        None => Ok(key.as_bytes().to_vec()),
    }
}

/// `AES(key)` + `CBC(iv)` + PKCS#7: the variant follows the configured key
/// length, exactly as `cryptography`'s `algorithms.AES`.
fn encrypt_cbc(key: &[u8], iv: &[u8], plain: &str) -> Result<Vec<u8>, CryptoConfigError> {
    let iv: [u8; BLOCK_SIZE] = iv.try_into().map_err(|_| CryptoConfigError)?;
    match key.len() {
        16 => Ok(Encryptor::<Aes128>::new_from_slices(key, &iv)
            .map_err(|_| CryptoConfigError)?
            .encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes())),
        24 => Ok(Encryptor::<Aes192>::new_from_slices(key, &iv)
            .map_err(|_| CryptoConfigError)?
            .encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes())),
        32 => Ok(Encryptor::<Aes256>::new_from_slices(key, &iv)
            .map_err(|_| CryptoConfigError)?
            .encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes())),
        _ => Err(CryptoConfigError),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::user_profile::UserViewExtension as _;
    use chrono::NaiveDate;
    use jsonwebtoken::EncodingKey;

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        }
    }

    fn token_for(claims: serde_json::Value) -> String {
        let header = jsonwebtoken::Header::new(Algorithm::HS256);
        let key = EncodingKey::from_secret("test-key".as_bytes());
        jsonwebtoken::encode(&header, &claims, &key).unwrap()
    }

    fn task_claims() -> serde_json::Value {
        serde_json::json!({
            "task_id": 0,
            "subtask_id": 0,
            "user_id": 301,
            "user_name": "example-user",
            "exp": 1893456000,
            "type": "task_token",
        })
    }

    fn user() -> UserRow {
        UserRow {
            id: 301,
            user_name: "example-user".to_string(),
            users_password_hash: "hash".to_string(),
            email: Some("example-user@example.invalid".to_string()),
            git_info: brz_mysql::Json(serde_json::json!(null).into()),
            is_active: 1,
            role: "user".to_string(),
            auth_source: "oidc".to_string(),
            preferences: "{}".to_string(),
            created_at: NaiveDate::from_ymd_opt(2025, 12, 19)
                .unwrap()
                .and_hms_opt(14, 32, 37)
                .unwrap(),
            updated_at: NaiveDate::from_ymd_opt(2026, 10, 14)
                .unwrap()
                .and_hms_opt(10, 9, 56)
                .unwrap(),
        }
    }

    #[test]
    fn extracts_the_bearer_credential_only_for_a_two_token_header() {
        assert_eq!(extract_token_from_header("Bearer abc.def"), Some("abc.def"));
        assert_eq!(extract_token_from_header("bearer  abc"), Some("abc"));
        assert_eq!(extract_token_from_header("Bearer"), None);
        assert_eq!(extract_token_from_header("Basic abc"), None);
        assert_eq!(extract_token_from_header("Bearer a b"), None);
        assert_eq!(extract_token_from_header(""), None);
    }

    #[test]
    fn accepts_a_task_token_and_carries_the_identity() {
        let token = token_for(task_claims());
        let header = format!("Bearer {token}");
        let actor = verify_task_token(&config(), Some(&header)).expect("valid task token");
        assert_eq!(actor.user_id, 301);
        assert_eq!(actor.expire_at, 1893456000);
    }

    #[test]
    fn rejects_non_task_tokens_and_malformed_headers() {
        let mut session = task_claims();
        session["type"] = serde_json::json!("access");
        assert!(
            verify_task_token(&config(), Some(&format!("Bearer {}", token_for(session)))).is_none()
        );

        assert!(verify_task_token(&config(), None).is_none());
        assert!(verify_task_token(&config(), Some("Bearer")).is_none());
        assert!(verify_task_token(&config(), Some("Bearer not-a-jwt")).is_none());
    }

    #[test]
    fn rejects_a_missing_required_claim_and_a_wrong_signature() {
        let mut missing = task_claims();
        missing.as_object_mut().unwrap().remove("user_id");
        assert!(
            verify_task_token(&config(), Some(&format!("Bearer {}", token_for(missing)))).is_none()
        );

        let header = jsonwebtoken::Header::new(Algorithm::HS256);
        let key = EncodingKey::from_secret(b"other-key");
        let forged = jsonwebtoken::encode(&header, &task_claims(), &key).unwrap();
        assert!(verify_task_token(&config(), Some(&format!("Bearer {forged}"))).is_none());
    }

    #[test]
    fn rejects_an_expired_task_token() {
        let mut claims = task_claims();
        claims["exp"] = serde_json::json!(1);
        assert!(
            verify_task_token(&config(), Some(&format!("Bearer {}", token_for(claims)))).is_none()
        );
    }

    #[test]
    fn payload_matches_the_source_json_dumps_rendering() {
        let fields =
            crate::user_profile::DefaultUserViewExtension.runtime_user_payload_fields(&user());
        let payload = runtime_user_payload(&user(), &fields, 1893456000);
        assert_eq!(
            payload,
            r#"{"employee_id": "", "email": "example-user@example.invalid", "name": "example-user", "uid": "301", "expire_at": 1893456000}"#
        );
    }

    #[test]
    fn payload_keeps_unicode_raw_with_an_empty_email_default() {
        let mut user = user();
        user.email = None;
        user.user_name = "示例用户".to_string();
        let fields =
            crate::user_profile::DefaultUserViewExtension.runtime_user_payload_fields(&user);
        let payload = runtime_user_payload(&user, &fields, 0);
        assert!(payload.contains(r#""email": """#), "{payload}");
        assert!(payload.contains(r#""name": "示例用户""#), "{payload}");
        assert!(payload.contains(r#""expire_at": 0"#), "{payload}");
    }

    #[test]
    fn payload_applies_extension_resolved_fields_over_the_public_defaults() {
        let fields = crate::user_profile::RuntimeUserPayloadFields {
            employee_id: "220750".to_string(),
            name: "刘彦生".to_string(),
            uid: "3853506976".to_string(),
        };
        let payload = runtime_user_payload(&user(), &fields, 0);
        assert!(payload.contains(r#""employee_id": "220750""#), "{payload}");
        assert!(payload.contains(r#""name": "刘彦生""#), "{payload}");
        assert!(payload.contains(r#""uid": "3853506976""#), "{payload}");
    }

    /// Recovers the plaintext from `base64(iv + ciphertext)`.
    fn decrypt_embedded_iv(key: &[u8], encoded: &str) -> String {
        use cbc::Decryptor;
        use cbc::cipher::BlockDecryptMut;
        use cbc::cipher::block_padding::Pkcs7;
        let raw = STANDARD.decode(encoded).unwrap();
        assert!(raw.len() > BLOCK_SIZE && raw.len().is_multiple_of(BLOCK_SIZE));
        let (iv, ciphertext) = raw.split_at(BLOCK_SIZE);
        let plain = Decryptor::<Aes256>::new_from_slices(key, iv)
            .unwrap()
            .decrypt_padded_vec_mut::<Pkcs7>(ciphertext)
            .unwrap();
        String::from_utf8(plain).unwrap()
    }

    #[test]
    fn embedded_iv_encryption_round_trips_with_a_random_iv() {
        let key = DEFAULT_USER_AES_KEY.as_bytes();
        let first = encrypt_sensitive_data_with_embedded_iv("hello").unwrap();
        let second = encrypt_sensitive_data_with_embedded_iv("hello").unwrap();
        // A fresh random IV makes every response distinct (the source's
        // `os.urandom(16)`), so the recorded ciphertext can never be reproduced.
        assert_ne!(first, second);
        assert_eq!(decrypt_embedded_iv(key, &first), "hello");
        assert_eq!(decrypt_embedded_iv(key, &second), "hello");
    }

    #[test]
    fn empty_and_masked_payloads_pass_through() {
        assert_eq!(encrypt_sensitive_data_with_embedded_iv("").unwrap(), "");
        assert_eq!(
            encrypt_sensitive_data_with_embedded_iv("***").unwrap(),
            "***"
        );
    }

    #[test]
    fn parses_raw_and_base64_prefixed_keys() {
        assert_eq!(parse_aes_key("short").unwrap(), b"short".to_vec());
        let encoded = STANDARD.encode([7u8; 32]);
        assert_eq!(
            parse_aes_key(&format!("base64:{encoded}")).unwrap(),
            vec![7u8; 32]
        );
    }

    #[test]
    fn response_serializes_as_a_single_user_field() {
        let body = crate::json_contract_tests::serialized(WegentRuntimeUserResponse {
            user: "ciphertext".to_string(),
        })
        .unwrap();
        assert_eq!(body, serde_json::json!({"user": "ciphertext"}));
    }

    #[test]
    fn unauthorized_reject_matches_the_source_detail() {
        let error = FastApiError::unauthorized(INVALID_TOKEN_DETAIL);
        assert_eq!(error.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(error.detail_message(), Some("Invalid Wegent token"));
    }
}
