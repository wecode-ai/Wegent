// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/v1/token-issuers/{issuer_id}/issue` — issue one outbound skill
//! token for an enabled `TokenIssuer`.
//!
//! Mirrors `app.api.endpoints.token_issuers.issue_outbound_token`
//! (`backend/app/api/endpoints/token_issuers.py:24`) and
//! `OutboundTokenService.issue_token`
//! (`backend/app/services/auth/outbound_token_service.py:443`).
//!
//! Source dependency topology:
//! 1. `get_current_user_jwt_apikey_tasktoken` — one `users` row by id.
//! 2. `_get_kind_or_raise(db, "TokenIssuer", issuer_id)` — one `kinds` row
//!    filtered by `id, kind, user_id=0, namespace='system'`.
//! 3. `_resolve_signing_key_for_issuance` — one `kinds` row for the referenced
//!    `SigningKey`, whose `privateKeyEncrypted` is decrypted with the shared
//!    `GIT_TOKEN_AES_KEY` / `GIT_TOKEN_AES_IV` material.
//! 4. `jwt.encode(..., algorithm="RS256", headers={"kid": ...})` — no
//!    dependency I/O.
//!
//! The endpoint renders `TokenIssueResponse`; `issued_at`/`expires_at` are the
//! token's NumericDate claims and `jti` a fresh UUIDv4, so the `access_token`
//! itself is generated per request. Extra JWT claims come from the
//! `OutboundTokenExtraClaims` seam, matching the source's
//! `_collect_extra_claims` extension point (the internal deployment patches it
//! to inject `employee_id`).

use base64::Engine as _;
use brz_json::OpaqueJson;
use brz_mysql::{FromMysqlRow, Json, MysqlService};
use jsonwebtoken::{Algorithm, EncodingKey};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::attachments_task_all::auth::AuthenticatedUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `SYSTEM_NAMESPACE` (`app/services/auth/outbound_token_service.py:41`).
const SYSTEM_NAMESPACE: &str = "system";
/// `SYSTEM_USER_ID` (`:42`): every token-issuer CRD belongs to the system user.
const SYSTEM_USER_ID: i64 = 0;
/// `TOKEN_ISSUER_KIND` (`:44`).
const TOKEN_ISSUER_KIND: &str = "TokenIssuer";
/// `SIGNING_KEY_KIND` (`:43`).
const SIGNING_KEY_KIND: &str = "SigningKey";

/// `_get_kind_or_raise(db, TOKEN_ISSUER_KIND, issuer_id, ...)`: the source
/// filter order is `id`, `kind`, `user_id`, `namespace`, then `LIMIT 1`.
const TOKEN_ISSUER_BY_ID_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
     WHERE kinds.id = ? AND kinds.kind = 'TokenIssuer' \
     AND kinds.user_id = ? AND kinds.namespace = ? \n LIMIT 1";

/// `_resolve_signing_key_for_issuance` -> `_get_kind_or_raise(db,
/// SIGNING_KEY_KIND, kindId, ...)`.
const SIGNING_KEY_BY_ID_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
     WHERE kinds.id = ? AND kinds.kind = 'SigningKey' \
     AND kinds.user_id = ? AND kinds.namespace = ? \n LIMIT 1";

/// One `kinds` row selected with the full labeled projection; only the fields
/// the service reads are consumed.
#[derive(Debug, FromMysqlRow)]
struct KindRow {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[mysql(rename = "kinds_is_active")]
    is_active: i8,
    #[mysql(rename = "kinds_json")]
    json: Json<OpaqueJson>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "kinds_user_id")]
    user_id: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "kinds_kind")]
    kind: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "kinds_name")]
    name: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "kinds_namespace")]
    namespace: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "kinds_created_at")]
    created_at: chrono::NaiveDateTime,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "kinds_updated_at")]
    updated_at: chrono::NaiveDateTime,
}

/// `TokenIssuerKind` (`app/schemas/token_issuer.py`): only `spec` is read.
///
/// The document is stored as a CRD payload, so unknown sibling keys (and
/// `status`) must not fail the projection.
#[derive(Debug, Deserialize)]
struct TokenIssuerKindDocument {
    spec: TokenIssuerSpec,
}

/// `TokenIssuerSpec`: the fields `issue_token` reads.
#[derive(Debug, Clone, Deserialize)]
pub struct TokenIssuerSpec {
    pub issuer: String,
    pub audience: String,
    #[serde(rename = "signingKeyRef")]
    pub signing_key_ref: SigningKeyRef,
    #[serde(rename = "defaultTtlSeconds")]
    pub default_ttl_seconds: i64,
    #[serde(rename = "maxTtlSeconds")]
    pub max_ttl_seconds: i64,
    pub enabled: bool,
}

/// `SigningKeyRef` (`app/schemas/token_issuer.py:76`).
#[derive(Debug, Clone, Deserialize)]
pub struct SigningKeyRef {
    #[serde(rename = "kindId")]
    pub kind_id: i64,
}

/// `SigningKeyKind`: the fields `_resolve_signing_key_for_issuance` reads.
#[derive(Debug, Deserialize)]
struct SigningKeyKindDocument {
    spec: SigningKeySpec,
}

/// `SigningKeySpec` (`app/schemas/token_issuer.py:15`).
#[derive(Debug, Deserialize)]
struct SigningKeySpec {
    kid: String,
    #[serde(rename = "privateKeyEncrypted")]
    private_key_encrypted: String,
}

/// `TokenIssueRequest` (`app/schemas/token_issuer.py:185`): `expires_in` is
/// optional with `ge=60, le=86400`, and unknown fields are allowed so
/// downstream deployments can carry extra opt-in options consumed by
/// `_collect_extra_claims`.
#[derive(Debug, Default)]
struct TokenIssueRequest {
    expires_in: Option<i64>,
}

/// Parsed public issue request: the validated field plus the raw body the
/// extra-claims seam consumes.
#[derive(Debug)]
struct ParsedIssueRequest<'a> {
    request: TokenIssueRequest,
    body: &'a Map<String, Value>,
}

/// `TokenIssueResponse` (`app/schemas/token_issuer.py:198`): declaration order
/// is the rendered body order.
#[derive(Debug, Serialize)]
struct TokenIssueResponse {
    access_token: String,
    token_type: &'static str,
    expires_in: i64,
    issuer_id: i64,
    kid: String,
    issued_at: i64,
    expires_at: i64,
}

/// `OutboundTokenService._collect_extra_claims`: deployment-specific extra JWT
/// claims for the public issue endpoint.
///
/// The open-source core contributes none (`_collect_extra_claims` returns `{}`).
/// A deployment that injects claims registers its own implementation on
/// [`AppState::token_issuer_extra_claims`] before route construction. The
/// caller merges the result into the token but never lets it override the
/// standard reserved claims.
#[async_trait::async_trait]
pub trait OutboundTokenExtraClaims: Send + Sync {
    /// The extra claims for one issuance. Failures must be handled by the
    /// implementation (the source patch swallows a `SQLAlchemyError` and issues
    /// the token without the claim).
    async fn extra_claims(&self, context: ExtraClaimsContext<'_>) -> Map<String, Value>;
}

/// The `_collect_extra_claims(self, db, *, user, issuer, request)` arguments.
pub struct ExtraClaimsContext<'a> {
    /// The request's MySQL session (`db`).
    pub mysql: &'a MysqlService,
    /// `user.id`.
    pub user_id: i64,
    /// `user.user_name`.
    pub user_name: &'a str,
    /// The resolved `TokenIssuer` spec.
    pub issuer: &'a TokenIssuerSpec,
    /// The parsed `TokenIssueRequest`, or the raw body when the source passed
    /// no request object.
    pub request: Option<&'a Map<String, Value>>,
}

/// The open-source default: no extra claims.
pub struct NoExtraClaims;

#[async_trait::async_trait]
impl OutboundTokenExtraClaims for NoExtraClaims {
    async fn extra_claims(&self, _context: ExtraClaimsContext<'_>) -> Map<String, Value> {
        Map::new()
    }
}

/// POST /api/v1/token-issuers/{issuer_id}/issue.
#[brz_http_server::post("/api/v1/token-issuers/:issuer_id/issue")]
async fn issue_outbound_token(
    #[inject(state)] state: &AppState,
    issuer_id: &str,
    #[auth] user: AuthenticatedUser,
    body: Value,
) -> Result<TokenIssueResponse, FastApiError> {
    let issuer_id = parse_int_path("issuer_id", issuer_id)?;
    let parsed = parse_issue_request(&body)?;
    issue_token(
        state,
        &user.0,
        issuer_id,
        parsed.request.expires_in,
        Some(parsed.body),
    )
    .await
}

/// The endpoint body: resolve the `TokenIssuer`, apply the TTL policy, resolve
/// and decrypt the signing key, then sign the claims.
async fn issue_token(
    state: &AppState,
    user: &crate::attachments_task_all::auth::CurrentUser,
    issuer_id: i64,
    expires_in: Option<i64>,
    request_body: Option<&Map<String, Value>>,
) -> Result<TokenIssueResponse, FastApiError> {
    let issuer_row: Option<KindRow> = state
        .mysql
        .fetch_optional(
            TOKEN_ISSUER_BY_ID_QUERY,
            (issuer_id, SYSTEM_USER_ID, SYSTEM_NAMESPACE),
        )
        .await
        .map_err(|error| {
            tracing::error!(%error, "token issuer lookup failed");
            FastApiError::unhandled()
        })?;
    let Some(issuer_row) = issuer_row else {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::NOT_FOUND,
            format!("{TOKEN_ISSUER_KIND} '{issuer_id}' not found"),
        ));
    };
    let issuer = project_spec::<TokenIssuerKindDocument>(&issuer_row.json)?.spec;
    if !issuer.enabled || issuer_row.is_active == 0 {
        return Err(validation_error("Token issuer is disabled"));
    }

    let ttl = expires_in.unwrap_or(issuer.default_ttl_seconds);
    if ttl <= 0 {
        return Err(validation_error("Requested TTL must be positive"));
    }
    if ttl > issuer.max_ttl_seconds {
        return Err(validation_error("Requested TTL exceeds issuer policy"));
    }

    let signing_key_row: Option<KindRow> = state
        .mysql
        .fetch_optional(
            SIGNING_KEY_BY_ID_QUERY,
            (
                issuer.signing_key_ref.kind_id,
                SYSTEM_USER_ID,
                SYSTEM_NAMESPACE,
            ),
        )
        .await
        .map_err(|error| {
            tracing::error!(%error, "signing key lookup failed");
            FastApiError::unhandled()
        })?;
    let Some(signing_key_row) = signing_key_row else {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::FORBIDDEN,
            format!(
                "{SIGNING_KEY_KIND} '{}' not found",
                issuer.signing_key_ref.kind_id
            ),
        ));
    };
    if signing_key_row.is_active == 0 {
        return Err(validation_error("Signing key is disabled"));
    }
    let signing_key = project_spec::<SigningKeyKindDocument>(&signing_key_row.json)?.spec;
    let private_key_pem = crate::subscriptions_item::crypto::decrypt_sensitive_data(
        &signing_key.private_key_encrypted,
    )
    .map_err(|error| {
        tracing::error!(%error, "signing key decryption configuration failure");
        FastApiError::unhandled()
    })?;
    if private_key_pem.is_empty() {
        return Err(validation_error("Signing key private key is unavailable"));
    }

    let issued_at = chrono::Utc::now().timestamp();
    let expires_at = issued_at + ttl;
    let jti = crate::wework_auth_tokens::uuid4_hex()?;
    let mut claims = Map::new();
    claims.insert("iss".to_owned(), Value::String(issuer.issuer.clone()));
    claims.insert("sub".to_owned(), Value::String(format!("user:{}", user.id)));
    claims.insert("aud".to_owned(), Value::String(issuer.audience.clone()));
    claims.insert("iat".to_owned(), Value::from(issued_at));
    claims.insert("exp".to_owned(), Value::from(expires_at));
    claims.insert("jti".to_owned(), Value::String(jti));
    claims.insert("user_id".to_owned(), Value::from(user.id));
    claims.insert(
        "user_name".to_owned(),
        Value::String(user.user_name.clone()),
    );
    claims.insert("issuer_id".to_owned(), Value::from(issuer_row.id));

    let extra_claims = state
        .token_issuer_extra_claims
        .extra_claims(ExtraClaimsContext {
            mysql: &state.mysql,
            user_id: user.id,
            user_name: &user.user_name,
            issuer: &issuer,
            request: request_body,
        })
        .await;
    // Standard reserved claims are never overridden.
    merge_extra_claims(&mut claims, extra_claims);

    let access_token = encode_rs256_jws(&signing_key.kid, &claims, &private_key_pem)?;
    tracing::info!(
        issuer_id = issuer_row.id,
        kid = %signing_key.kid,
        aud = %issuer.audience,
        user_id = user.id,
        user_name = %user.user_name,
        exp = expires_at,
        "Issued outbound token"
    );

    Ok(TokenIssueResponse {
        access_token,
        token_type: "Bearer",
        expires_in: ttl,
        issuer_id: issuer_row.id,
        kid: signing_key.kid,
        issued_at,
        expires_at,
    })
}

/// `HTTPException(status_code=400, detail=str(exc))` for the service's
/// `OutboundTokenValidationError` branches (no `error_code` in the body).
fn validation_error(message: impl Into<String>) -> FastApiError {
    FastApiError::detail(brz_http_server::StatusCode::BAD_REQUEST, message)
}

/// `for key, value in extra_claims.items(): if key not in claims: claims[key]
/// = value` — a deployment claim never replaces a reserved claim.
fn merge_extra_claims(claims: &mut Map<String, Value>, extra_claims: Map<String, Value>) {
    for (key, value) in extra_claims {
        if !claims.contains_key(&key) {
            claims.insert(key, value);
        }
    }
}

/// Project one CRD `spec`; a document that fails validation is the source's
/// Pydantic `ValidationError`, which the application's exception handler
/// renders as `500 {"error_code": 500, "detail": "Internal server error"}`.
fn project_spec<T: serde::de::DeserializeOwned>(
    json: &Json<OpaqueJson>,
) -> Result<T, FastApiError> {
    json.0.project::<T>().ok_or_else(|| {
        tracing::error!("token issuer CRD failed validation");
        FastApiError::unhandled()
    })
}

/// Encode the RS256 JWS exactly like the source's `jwt.encode`.
///
/// PyJWT renders the header with `sort_keys=True` (so the compact header is
/// `{"alg":"RS256","kid":...,"typ":"JWT"}`) and the payload with
/// `separators=(",", ":")` while preserving the claims dict order. The
/// signature is PKCS#1 v1.5 over SHA-256 of the signing input, which is
/// deterministic for a given key and payload.
fn encode_rs256_jws(
    kid: &str,
    claims: &Map<String, Value>,
    private_key_pem: &str,
) -> Result<String, FastApiError> {
    let der = rsa_signing_key_der(private_key_pem).ok_or_else(|| {
        tracing::error!("signing key is not a supported PEM-encoded RSA private key");
        FastApiError::unhandled()
    })?;
    let header = format!(
        "{{\"alg\":\"RS256\",\"kid\":{},\"typ\":\"JWT\"}}",
        crate::json_compat::python_json_string(kid)
    );
    let payload = crate::json_compat::python_json_compact(&Value::Object(claims.clone()));
    let signed = format!(
        "{}.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(header.as_bytes()),
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.as_bytes())
    );
    let signature = jsonwebtoken::crypto::sign(
        signed.as_bytes(),
        &EncodingKey::from_rsa_der(&der),
        Algorithm::RS256,
    )
    .map_err(|error| {
        tracing::error!(%error, "outbound token signing failed");
        FastApiError::unhandled()
    })?;
    Ok(format!("{signed}.{signature}"))
}

/// The RSA signing key in the DER form [`EncodingKey::from_rsa_der`] expects.
///
/// PyJWT hands the PEM straight to `cryptography`, which accepts both PEM
/// shapes. `EncodingKey::from_rsa_der` instead forwards its bytes to ring's
/// `RsaKeyPair::from_der`, which parses a bare PKCS#1 `RSAPrivateKey`
/// (RFC 3447 A.1.2) and rejects a PKCS#8 wrapper. jsonwebtoken's own
/// `from_rsa_pem` path unwraps PKCS#8 for exactly this reason, so a
/// `PRIVATE KEY` body has its inner `privateKey` extracted here and an
/// `RSA PRIVATE KEY` body is already in the expected form.
fn rsa_signing_key_der(pem: &str) -> Option<Vec<u8>> {
    let der = pem_to_der(pem)?;
    match pem_label(pem)? {
        "RSA PRIVATE KEY" => Some(der),
        "PRIVATE KEY" => pkcs1_from_pkcs8(&der),
        _ => None,
    }
}

/// The PEM label between `BEGIN` and `-----` (`PRIVATE KEY` for PKCS#8).
fn pem_label(pem: &str) -> Option<&str> {
    let rest = pem.trim_start().strip_prefix("-----BEGIN ")?;
    let end = rest.find("-----")?;
    Some(rest[..end].trim())
}

/// Extract the PKCS#1 `RSAPrivateKey` DER embedded in a PKCS#8
/// `PrivateKeyInfo` (RFC 5958):
/// `SEQUENCE { INTEGER version, AlgorithmIdentifier, OCTET STRING privateKey }`.
fn pkcs1_from_pkcs8(pkcs8: &[u8]) -> Option<Vec<u8>> {
    /// `06 09 2a 86 48 86 f7 0d 01 01 01`: OID 1.2.840.113549.1.1.1
    /// (`rsaEncryption`).
    const RSA_ENCRYPTION_OID: [u8; 11] = [
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    ];
    let (tag, body, _) = der_element(pkcs8)?;
    if tag != 0x30 {
        return None;
    }
    let (version_tag, _, rest) = der_element(body)?;
    if version_tag != 0x02 {
        return None;
    }
    let (algorithm_tag, algorithm, rest) = der_element(rest)?;
    if algorithm_tag != 0x30 || !algorithm.starts_with(&RSA_ENCRYPTION_OID) {
        return None;
    }
    let (key_tag, key, _) = der_element(rest)?;
    if key_tag != 0x04 {
        return None;
    }
    Some(key.to_vec())
}

/// One DER TLV triple: `(tag, contents, remainder)`.
fn der_element(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = input.split_first()?;
    let (&first, rest) = rest.split_first()?;
    let (length, rest) = if first < 0x80 {
        (usize::from(first), rest)
    } else {
        // Long form: `0x8n` is followed by `n` big-endian length bytes.
        let count = usize::from(first & 0x7f);
        if count == 0 || count > (usize::BITS as usize / 8) {
            return None;
        }
        let (bytes, rest) = rest.split_at_checked(count)?;
        let mut length = 0usize;
        for &byte in bytes {
            length = (length << 8) | usize::from(byte);
        }
        (length, rest)
    };
    let (contents, remainder) = rest.split_at_checked(length)?;
    Some((tag, contents, remainder))
}

/// Decode the DER payload of a PEM-encoded key the way PyJWT's `from_pem`
/// does: strip the `-----` armor lines and Base64-decode the remainder.
fn pem_to_der(pem: &str) -> Option<Vec<u8>> {
    let body: String = pem
        .lines()
        .filter(|line| !line.trim_start().starts_with("-----"))
        .collect::<Vec<_>>()
        .join("");
    if body.is_empty() {
        return None;
    }
    base64::engine::general_purpose::STANDARD.decode(body).ok()
}

/// `TokenIssueRequest` validation (`extra="allow"`), run before the endpoint
/// body like FastAPI's request validation.
fn parse_issue_request(body: &Value) -> Result<ParsedIssueRequest<'_>, FastApiError> {
    let Value::Object(object) = body else {
        return Err(FastApiError::validation([serde_json::json!({
            "type": "model_attributes_type",
            "loc": ["body"],
            "msg": "Input should be a valid dictionary or object to extract fields from",
            "input": body,
        })]));
    };
    let expires_in = match object.get("expires_in") {
        None | Some(Value::Null) => None,
        Some(Value::Number(number)) => match number.as_i64() {
            Some(value) => Some(value),
            None => {
                return Err(body_error(
                    if number.as_f64().is_some() {
                        "int_from_float"
                    } else {
                        "int_parsing"
                    },
                    "Input should be a valid integer",
                    "expires_in",
                    Value::Number(number.clone()),
                    None,
                ));
            }
        },
        Some(other) => {
            return Err(body_error(
                "int_parsing",
                "Input should be a valid integer",
                "expires_in",
                other.clone(),
                None,
            ));
        }
    };
    if let Some(value) = expires_in {
        if value < 60 {
            return Err(body_error(
                "greater_than_equal",
                "Input should be greater than or equal to 60",
                "expires_in",
                Value::from(value),
                Some(serde_json::json!({"ge": 60})),
            ));
        }
        if value > 86400 {
            return Err(body_error(
                "less_than_equal",
                "Input should be less than or equal to 86400",
                "expires_in",
                Value::from(value),
                Some(serde_json::json!({"le": 86400})),
            ));
        }
    }
    Ok(ParsedIssueRequest {
        request: TokenIssueRequest { expires_in },
        body: object,
    })
}

/// One FastAPI body-validation entry for `expires_in`.
fn body_error(
    kind: &str,
    message: &str,
    field: &'static str,
    input: Value,
    ctx: Option<Value>,
) -> FastApiError {
    let mut entry = serde_json::json!({
        "type": kind,
        "loc": ["body", field],
        "msg": message,
        "input": input,
    });
    if let Some(ctx) = ctx {
        entry["ctx"] = ctx;
    }
    FastApiError::validation(Value::Array(vec![entry]))
}

/// FastAPI's 422 for an unparsable integer path parameter.
fn parse_int_path(field: &'static str, value: &str) -> Result<i64, FastApiError> {
    value.parse().map_err(|_| {
        FastApiError::validation([serde_json::json!({
            "type": "int_parsing",
            "loc": ["path", field],
            "msg": "Input should be a valid integer, unable to parse string as an integer",
            "input": value,
        })])
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(id: i64, user_name: &str) -> crate::attachments_task_all::auth::CurrentUser {
        crate::attachments_task_all::auth::CurrentUser {
            id,
            user_name: user_name.to_owned(),
            preferences: "{}".to_owned(),
            subtask_id: None,
        }
    }

    /// Synthetic `TokenIssuer` and `SigningKey` documents with matching references.
    const TEST_ISSUER_JSON: &str = r#"{"kind": "TokenIssuer", "spec": {"issuer": "wegent", "enabled": true, "audience": "example-audience", "description": "Example authorization", "maxTtlSeconds": 1800, "signingKeyRef": {"kindId": 401}, "defaultTtlSeconds": 600}, "status": {"state": "Available", "message": null}, "metadata": {"name": "example-audience", "labels": null, "namespace": "system", "displayName": null}, "apiVersion": "agent.wecode.io/v1"}"#;
    const TEST_SIGNING_KEY_JSON: &str = r#"{"kind": "SigningKey", "spec": {"kid": "example-key-01", "algorithm": "RS256", "description": "Example signature verification", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----\n", "privateKeyEncrypted": "ciphertext"}, "status": {"state": "Available", "message": null}, "metadata": {"name": "example-audience-key", "labels": null, "namespace": "system", "displayName": null}, "apiVersion": "agent.wecode.io/v1"}"#;

    #[test]
    fn recorded_token_issuer_document_decodes_its_spec() {
        let document: TokenIssuerKindDocument =
            serde_json::from_str(TEST_ISSUER_JSON).expect("the recorded CRD decodes");
        let spec = document.spec;
        assert_eq!(spec.issuer, "wegent");
        assert_eq!(spec.audience, "example-audience");
        assert_eq!(spec.signing_key_ref.kind_id, 401);
        assert_eq!(spec.default_ttl_seconds, 600);
        assert_eq!(spec.max_ttl_seconds, 1800);
        assert!(spec.enabled);
    }

    #[test]
    fn recorded_signing_key_document_decodes_its_spec() {
        let document: SigningKeyKindDocument =
            serde_json::from_str(TEST_SIGNING_KEY_JSON).expect("the recorded CRD decodes");
        assert_eq!(document.spec.kid, "example-key-01");
        assert_eq!(document.spec.private_key_encrypted, "ciphertext");
    }

    /// Deferred APIs retain Python ownership and registered Rust implementations.
    #[test]
    fn deferred_route_keeps_python_ownership_and_handler_registration() {
        const PATH: &str = "/api/v1/token-issuers/:issuer_id/issue";
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & POST != 0);
        assert!(registered, "POST {PATH} must be registered by the router");

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).expect("the route file loads");
        let table = crate::RouteTable::compile(config).expect("the route table compiles");
        assert!(
            !table.matches(&http::Method::POST, "/api/v1/token-issuers/402/issue"),
            "POST {PATH} must remain on Python"
        );
        // Other methods also retain Python ownership.
        for method in [
            http::Method::GET,
            http::Method::PUT,
            http::Method::PATCH,
            http::Method::DELETE,
        ] {
            assert!(!table.matches(&method, "/api/v1/token-issuers/402/issue"));
        }
    }

    #[test]
    fn response_renders_the_declared_field_order() {
        let response = TokenIssueResponse {
            access_token: "token".to_owned(),
            token_type: "Bearer",
            expires_in: 600,
            issuer_id: 402,
            kid: "example-key-01".to_owned(),
            issued_at: 1792119498,
            expires_at: 1792120098,
        };
        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            "{\"access_token\":\"token\",\"token_type\":\"Bearer\",\"expires_in\":600,\
             \"issuer_id\":402,\"kid\":\"example-key-01\",\
             \"issued_at\":1792119498,\"expires_at\":1792120098}"
        );
    }

    #[test]
    fn request_accepts_unknown_fields_and_optional_expires_in() {
        let body = serde_json::json!({
            "include_custom_claim": true,
            "bogus": "x"
        });
        let parsed = parse_issue_request(&body).expect("extra fields are allowed");
        assert_eq!(parsed.request.expires_in, None);
        assert_eq!(parsed.body.get("bogus").and_then(Value::as_str), Some("x"));

        let body = serde_json::json!({"expires_in": 300});
        let parsed = parse_issue_request(&body).expect("expires_in in range");
        assert_eq!(parsed.request.expires_in, Some(300));

        let body = serde_json::json!({"expires_in": null});
        let parsed = parse_issue_request(&body).expect("explicit null is valid for Option");
        assert_eq!(parsed.request.expires_in, None);

        // The inclusive bounds themselves are valid (`ge=60, le=86400`).
        let body = serde_json::json!({"expires_in": 60});
        assert_eq!(
            parse_issue_request(&body).unwrap().request.expires_in,
            Some(60)
        );
        let body = serde_json::json!({"expires_in": 86400});
        assert_eq!(
            parse_issue_request(&body).unwrap().request.expires_in,
            Some(86400)
        );
    }

    #[test]
    fn request_rejects_out_of_range_and_non_integer_expires_in() {
        let body = serde_json::json!({"expires_in": 59});
        let error = parse_issue_request(&body).unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            error.validation_detail(),
            "[{\"type\":\"greater_than_equal\",\"loc\":[\"body\",\"expires_in\"],\
             \"msg\":\"Input should be greater than or equal to 60\",\"input\":59,\
             \"ctx\":{\"ge\":60}}]"
        );

        let body = serde_json::json!({"expires_in": 86401});
        let error = parse_issue_request(&body).unwrap_err();
        assert_eq!(
            error.validation_detail(),
            "[{\"type\":\"less_than_equal\",\"loc\":[\"body\",\"expires_in\"],\
             \"msg\":\"Input should be less than or equal to 86400\",\"input\":86401,\
             \"ctx\":{\"le\":86400}}]"
        );

        let body = serde_json::json!({"expires_in": "300"});
        let error = parse_issue_request(&body).unwrap_err();
        assert_eq!(
            error.validation_detail(),
            "[{\"type\":\"int_parsing\",\"loc\":[\"body\",\"expires_in\"],\
             \"msg\":\"Input should be a valid integer\",\"input\":\"300\"}]"
        );

        let body = serde_json::json!([]);
        let error = parse_issue_request(&body).unwrap_err();
        assert_eq!(
            error.validation_detail(),
            "[{\"type\":\"model_attributes_type\",\"loc\":[\"body\"],\
             \"msg\":\"Input should be a valid dictionary or object to extract fields from\",\
             \"input\":[]}]"
        );
    }

    #[test]
    fn unparsable_issuer_id_renders_the_fastapi_path_error() {
        let error = parse_int_path("issuer_id", "abc").unwrap_err();
        assert_eq!(
            error.validation_detail(),
            "[{\"type\":\"int_parsing\",\"loc\":[\"path\",\"issuer_id\"],\
             \"msg\":\"Input should be a valid integer, unable to parse string as an integer\",\
             \"input\":\"abc\"}]"
        );
    }

    #[test]
    fn pem_decoding_strips_the_armor_lines() {
        // `MTIzNA==` is Base64 for `1234`.
        let pem = "-----BEGIN PRIVATE KEY-----\nMTIzNA==\n-----END PRIVATE KEY-----\n";
        assert_eq!(pem_to_der(pem), Some(b"1234".to_vec()));
        assert_eq!(pem_to_der("not a pem"), None);
    }

    /// A PKCS#8 `PrivateKeyInfo` carrying `payload` as its `privateKey` OCTET
    /// STRING, built with the fixed DER framing (no key material).
    fn pkcs8_fixture(payload: &[u8]) -> Vec<u8> {
        let mut inner = vec![0x02, 0x01, 0x00];
        inner.extend_from_slice(&[
            0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05,
            0x00,
        ]);
        assert!(payload.len() < 0x80, "fixture uses a single-byte length");
        inner.extend_from_slice(&[0x04, payload.len() as u8]);
        inner.extend_from_slice(payload);
        let mut out = vec![0x30, inner.len() as u8];
        out.extend_from_slice(&inner);
        out
    }

    #[test]
    fn pkcs8_unwrapping_returns_the_inner_rsa_private_key() {
        let payload = b"PKCS#1 RSAPrivateKey payload";
        let pkcs8 = pkcs8_fixture(payload);
        assert_eq!(pkcs1_from_pkcs8(&pkcs8), Some(payload.to_vec()));

        // A non-SEQUENCE top level, a missing RSA OID, and a truncated body are
        // all rejected.
        assert_eq!(pkcs1_from_pkcs8(&[0x02, 0x01, 0x00]), None);
        assert_eq!(pkcs1_from_pkcs8(&[]), None);
        let mut wrong_oid = pkcs8_fixture(payload);
        wrong_oid[12] = 0x02;
        assert_eq!(pkcs1_from_pkcs8(&wrong_oid), None);
        assert_eq!(pkcs1_from_pkcs8(&pkcs8[..pkcs8.len() - 1]), None);
    }

    #[test]
    fn der_lengths_support_single_and_long_forms() {
        assert_eq!(
            der_element(&[0x04, 0x02, 0xaa, 0xbb]),
            Some((0x04, &[0xaa, 0xbb][..], &[][..]))
        );
        // `04 81 02 aa bb`: one length byte, value 2.
        assert_eq!(
            der_element(&[0x04, 0x81, 0x02, 0xaa, 0xbb]),
            Some((0x04, &[0xaa, 0xbb][..], &[][..]))
        );
        // A length past the end of the input, and an indefinite-length form.
        assert_eq!(der_element(&[0x04, 0x03, 0xaa]), None);
        assert_eq!(der_element(&[0x04, 0x80]), None);
    }

    #[test]
    fn pem_labels_select_the_expected_der_form() {
        let pkcs8 = pkcs8_fixture(b"inner");
        let pkcs8_pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            base64::engine::general_purpose::STANDARD.encode(&pkcs8)
        );
        assert_eq!(pem_label(&pkcs8_pem), Some("PRIVATE KEY"));
        // The PKCS#8 wrapper is removed before the bytes reach the signer.
        assert_eq!(rsa_signing_key_der(&pkcs8_pem), Some(b"inner".to_vec()));

        let rsa_label = "RSA PRIVATE KEY";
        let pkcs1_pem =
            format!("-----BEGIN {rsa_label}-----\nMTIzNA==\n-----END {rsa_label}-----\n");
        assert_eq!(pem_label(&pkcs1_pem), Some("RSA PRIVATE KEY"));
        // A PKCS#1 body is already in the expected form.
        assert_eq!(rsa_signing_key_der(&pkcs1_pem), Some(b"1234".to_vec()));

        assert_eq!(
            rsa_signing_key_der("-----BEGIN PUBLIC KEY-----\nMTIzNA==\n-----END PUBLIC KEY-----\n"),
            None
        );
        assert_eq!(rsa_signing_key_der("not a pem"), None);
    }

    #[test]
    fn header_and_payload_render_like_pyjwt() {
        let mut claims = Map::new();
        claims.insert("iss".to_owned(), Value::String("wegent".to_owned()));
        claims.insert(
            "user_name".to_owned(),
            Value::String("example-user".to_owned()),
        );
        // PyJWT sorts header keys and keeps the claims insertion order.
        let payload = crate::json_compat::python_json_compact(&Value::Object(claims));
        assert_eq!(
            payload,
            "{\"iss\":\"wegent\",\"user_name\":\"example-user\"}"
        );
    }

    #[test]
    fn current_user_exposes_the_claim_identity() {
        let user = user(301, "example-user");
        assert_eq!(format!("user:{}", user.id), "user:301");
        assert_eq!(user.user_name, "example-user");
    }

    #[test]
    fn reserved_claims_are_not_overridden_by_extra_claims() {
        let mut claims = Map::new();
        claims.insert("iss".to_owned(), Value::String("wegent".to_owned()));
        claims.insert(
            "aud".to_owned(),
            Value::String("example-audience".to_owned()),
        );
        let extra = serde_json::json!({
            "iss": "other",
            "employee_id": "13280"
        });
        let Value::Object(extra) = extra else {
            panic!("extra claims are an object");
        };
        merge_extra_claims(&mut claims, extra);
        assert_eq!(claims["iss"], Value::String("wegent".to_owned()));
        assert_eq!(claims["aud"], Value::String("example-audience".to_owned()));
        assert_eq!(claims["employee_id"], Value::String("13280".to_owned()));
    }
}
