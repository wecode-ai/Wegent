// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/v1/attachments/upload` — the OpenAPI attachment upload
//! (`app/api/endpoints/attachments_open.py:119` `upload_attachment_open`,
//! router mounted at `/v1/attachments` by `app/api/api.py:337-341`).
//!
//! The endpoint shares the attachment lifecycle with `POST
//! /api/attachments/upload` (`super::upload_attachment`): both call
//! `context_service.upload_attachment`, here with `subtask_id=0` and no extra
//! `type_data`. Its distinguishing traits are its authentication and its
//! response:
//!
//! 1. `get_auth_context` (`app/core/security.py`), not the download route's
//!    `get_api_key_auth_context`: a personal key, a service key with
//!    `wegent-username`, or a JWT/task token without an API key. The port
//!    reuses the `knowledge-open` family's implementation
//!    (`knowledge_documents_content::auth::get_auth_context`), whose `users`
//!    read goes through the deployment `userReader` (the internal
//!    `CachedUserReader`, so a name lookup hits `user:v2:idx:name:{name}` and
//!    writes the data/index keys back on a miss) and which emits the source's
//!    `COMMIT`.
//! 2. The bounded read loop (`UPLOAD_CHUNK_SIZE_BYTES`) and the filename gate
//!    (`400 "Filename is required"`).
//! 3. `context_service.upload_attachment(subtask_id=0)` — insert, store,
//!    parse and commit — followed by its own `db.refresh(context)`.
//! 4. `_build_attachment_response` rendered as `201 application/json`.
//!
//! Unlike `upload_attachment`, this endpoint never runs the chat adapter's
//! best-effort source image upload and never accepts `overwrite_attachment_id`
//! or `storage_purpose`: the source calls the context service directly.
use std::sync::Arc;

use brz_http_server::{Multipart, Response, StatusCode};

use crate::headers::Headers as _;

use super::document;
use super::response::AttachmentResponse;
use super::{UploadOutcome, refresh_context, upload_new_attachment};
use crate::AttachmentState;
use crate::http_compat::FastApiError;
use wegent_knowledge_access::open_auth::ApiFailure;

/// `API_KEY_PREFIX` (`app.core.auth_utils`): `api_key#username` splitting.
const API_KEY_PREFIX: &str = "wg-";

/// `BYTES_PER_MIB` (`attachments_open.py:42`), used by the size-limit message.
///
/// The source reads the upload in `UPLOAD_CHUNK_SIZE_BYTES` (8 KiB) chunks and
/// rejects once the accumulated length passes the maximum, so the gate applies
/// to the whole body; the chunk loop only bounds the buffer.
const BYTES_PER_MIB: f64 = 1024.0 * 1024.0;

/// `get_auth_context`'s principal for this endpoint. The handler reads
/// `current_user.id` only.
pub struct ApiKeyAuthUser(pub CurrentUser);

impl std::ops::Deref for ApiKeyAuthUser {
    type Target = CurrentUser;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

/// This endpoint's principal type is the knowledge-open family's.
type CurrentUser = wegent_knowledge_access::open_auth::CurrentUser;

/// The `knowledge-open` family's `get_auth_context` challenge names. The
/// upload reuses that authenticated principal, so the whole flow is the
/// source `get_auth_context`: the `api_keys` select, the `last_used_at`
/// write, the `COMMIT`, the ORM reload by primary key, and the deployment
/// `userReader` read (the internal `CachedUserReader`).
const OPEN_AUTH_REQUIRED: &str = "Wegent-Knowledge-Auth-Required";
const OPEN_INVALID_API_KEY: &str = "Wegent-Knowledge-Auth-Invalid-Key";
const OPEN_API_KEY_EXPIRED: &str = "Wegent-Knowledge-Auth-Expired-Key";
const OPEN_USER_NOT_FOUND: &str = "Wegent-Knowledge-Auth-User-Not-Found";
const OPEN_USERNAME_REQUIRED: &str = "Wegent-Knowledge-Auth-Username-Required";
const OPEN_INVALID_USERNAME: &str = "Wegent-Knowledge-Auth-Invalid-Username";
const OPEN_USER_INACTIVE: &str = "Wegent-Knowledge-Auth-Inactive";
const OPEN_INVALID_AUTH: &str = "Wegent-Knowledge-Auth-Invalid";

impl brz_http_server::Authenticator<ApiKeyAuthUser> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<ApiKeyAuthUser, brz_http_server::AuthFailure> {
        let headers = request_headers(request);
        wegent_knowledge_access::open_auth::get_auth_context(self.state(), &headers.view())
            .await
            .map(ApiKeyAuthUser)
            .map_err(auth_failure)
    }

    fn api_log_id<'a>(
        &'a self,
        principal: &'a ApiKeyAuthUser,
    ) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.0.user_name)
    }

    fn reject(
        &self,
        request: brz_http_server::AuthRequest<'_>,
        failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        use brz_http_server::IntoHttpError as _;
        auth_error_response(failure, request_username(request)).into_http_error(arena)
    }
}

/// The four authentication headers `get_auth_context` inspects.
fn request_headers(request: brz_http_server::AuthRequest<'_>) -> crate::headers::OwnedHeaders {
    let value = |name| {
        request
            .header(name)
            .and_then(|header| std::str::from_utf8(header).ok())
    };
    crate::headers::OwnedHeaders::from_pairs([
        ("authorization", value("authorization")),
        ("x-api-key", value("x-api-key")),
        ("wegent-source", value("wegent-source")),
        ("wegent-username", value("wegent-username")),
    ])
}

/// `ApiFailure` -> challenge for this endpoint. Every rejection keeps
/// `get_auth_context`'s shared detail text and status.
fn auth_failure(error: ApiFailure) -> brz_http_server::AuthFailure {
    use brz_http_server::AuthFailure;
    if error.status() == StatusCode::INTERNAL_SERVER_ERROR {
        return AuthFailure::Internal;
    }
    let challenge = match error.detail() {
        "API key is required" => OPEN_AUTH_REQUIRED,
        "Invalid API key" => OPEN_INVALID_API_KEY,
        "API key has expired" => OPEN_API_KEY_EXPIRED,
        "User not found or inactive" => OPEN_USER_NOT_FOUND,
        "Username is required for service key authentication (use wegent-username header)" => {
            OPEN_USERNAME_REQUIRED
        }
        "Username can only contain letters, numbers, underscores, and hyphens" => {
            OPEN_INVALID_USERNAME
        }
        detail if detail.starts_with("User '") && detail.ends_with("' is inactive") => {
            OPEN_USER_INACTIVE
        }
        _ => OPEN_INVALID_AUTH,
    };
    AuthFailure::invalid_credentials(challenge)
}

/// The rejection body (`get_auth_context`'s `HTTPException`s: `{"detail":
/// ...}`, with `WWW-Authenticate: Bearer` on 401).
fn auth_error_response(
    failure: brz_http_server::AuthFailure,
    username: Option<String>,
) -> FastApiError {
    use brz_http_server::AuthFailure;
    match failure {
        AuthFailure::MissingCredentials { .. }
        | AuthFailure::InvalidCredentials {
            challenge: OPEN_AUTH_REQUIRED,
        } => FastApiError::unauthorized("API key is required"),
        AuthFailure::InvalidCredentials {
            challenge: OPEN_INVALID_API_KEY,
        } => FastApiError::unauthorized("Invalid API key"),
        AuthFailure::InvalidCredentials {
            challenge: OPEN_API_KEY_EXPIRED,
        } => FastApiError::unauthorized("API key has expired"),
        AuthFailure::InvalidCredentials {
            challenge: OPEN_USER_NOT_FOUND,
        } => FastApiError::unauthorized("User not found or inactive"),
        AuthFailure::InvalidCredentials {
            challenge: OPEN_USERNAME_REQUIRED,
        } => FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Username is required for service key authentication (use wegent-username header)",
        ),
        AuthFailure::InvalidCredentials {
            challenge: OPEN_INVALID_USERNAME,
        } => FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Username can only contain letters, numbers, underscores, and hyphens",
        ),
        AuthFailure::InvalidCredentials {
            challenge: OPEN_USER_INACTIVE,
        } => FastApiError::unauthorized(format!(
            "User '{}' is inactive",
            username.unwrap_or_default()
        )),
        AuthFailure::InvalidCredentials { .. } => {
            FastApiError::unauthorized("Invalid authentication credentials")
        }
        AuthFailure::Internal | AuthFailure::Unavailable => {
            FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

/// The username the `UserInactive` branch reports: `api_key#username`, else
/// the `wegent-username` header.
fn request_username(request: brz_http_server::AuthRequest<'_>) -> Option<String> {
    let headers = request_headers(request);
    let headers = headers.view();
    let username_from_key = headers
        .header("x-api-key")
        .map(str::trim)
        .filter(|key| key.starts_with(API_KEY_PREFIX))
        .or_else(|| {
            headers.header("authorization").and_then(|value| {
                let mut parts = value.splitn(2, char::is_whitespace);
                let scheme = parts.next().unwrap_or("");
                parts.next().map(str::trim).filter(|token| {
                    scheme.eq_ignore_ascii_case("bearer") && token.starts_with(API_KEY_PREFIX)
                })
            })
        })
        .and_then(|key| key.split_once('#'))
        .and_then(|(_, username)| (!username.is_empty()).then(|| username.to_string()));
    username_from_key.or_else(|| {
        headers
            .header("wegent-username")
            .map(str::trim)
            .filter(|username| !username.is_empty())
            .map(str::to_owned)
    })
}

/// `POST /api/v1/attachments/upload`: the OpenAPI upload answers `201`.
#[brz_http_server::post("/api/v1/attachments/upload")]
async fn upload_attachment_open(
    #[inject(state)] state: &Arc<AttachmentState>,
    #[auth] user: ApiKeyAuthUser,
    multipart: Multipart,
) -> Result<Response, FastApiError> {
    let (filename, binary_data) = bind_upload_file(&multipart)?;
    tracing::info!(
        user_id = user.id,
        filename = %filename,
        "[attachments_open] upload_attachment_open"
    );

    let outcome = upload_new_attachment(
        state.upload_services(),
        user.id,
        filename,
        binary_data,
        super::UNLINKED_SUBTASK_ID,
        &serde_json::Map::new(),
        "default",
    )
    .await?;

    let (row, truncation_info) = match outcome {
        // The source commits the failed row before re-raising the
        // `DocumentParseError`, which the endpoint renders as `400
        // {"detail": {"message": ..., "error_code": ...}}`.
        UploadOutcome::ParseFailed { body } => {
            return Err(FastApiError::json_body(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "detail": body }),
            ));
        }
        // `ContextService.upload_attachment`'s own `db.refresh(context)`.
        UploadOutcome::Parsed {
            context_id,
            truncation_info,
        } => (
            refresh_context(&state.mysql, context_id)
                .await
                .map_err(dependency_error)?,
            truncation_info,
        ),
        // The overwrite stage is unreachable here: this endpoint passes no
        // `overwrite_attachment_id`.
        UploadOutcome::Overwritten { .. } => unreachable!("open upload never overwrites"),
    };

    let row = row.ok_or_else(attachment_not_found)?;
    let body = serde_json::to_string(&AttachmentResponse::from_context(&row, truncation_info))
        .map_err(|_| internal_error())?;
    // The endpoint renders the refreshed context before its success log; the
    // log's `current_user.id` read is what reloads the expired owner row, and
    // it runs only on the success path.
    reload_owner(state, user.id).await?;
    Ok(Response::owned_bytes(StatusCode::CREATED, body).content_type("application/json"))
}

/// The `users` reload the success log triggers after the upload commit:
/// `SELECT {labeled users} FROM users WHERE users.id = ?` with no `LIMIT`,
/// the ORM expired-object refresh the recorded statement carries.
async fn reload_owner(state: &Arc<AttachmentState>, user_id: i64) -> Result<(), FastApiError> {
    let row: Option<brz_mysql::MysqlRow> = state
        .mysql
        .fetch_optional(
            &format!(
                "SELECT {} \nFROM users \nWHERE users.id = ?",
                crate::user_reader::users_projection()
            ),
            (user_id,),
        )
        .await
        .map_err(dependency_error)?;
    if row.is_none() {
        tracing::warn!(
            user_id,
            "the attachment owner disappeared before the success log"
        );
    }
    Ok(())
}

/// The multipart `file` field and the source's validation order: a missing
/// field is FastAPI's 422, an empty filename is the endpoint's own 400.
fn bind_upload_file(multipart: &Multipart) -> Result<(&str, &[u8]), FastApiError> {
    let Some(file) = multipart.get("file") else {
        return Err(FastApiError::validation(serde_json::json!([{
            "type": "missing",
            "loc": ["body", "file"],
            "msg": "Field required",
        }])));
    };
    let Some(filename) = file.filename.as_deref().filter(|name| !name.is_empty()) else {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Filename is required",
        ));
    };
    let max_file_size = document::max_file_size();
    if file.bytes.len() as i64 > max_file_size {
        let max_size_mb = max_file_size as f64 / BYTES_PER_MIB;
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("File size exceeds maximum limit ({max_size_mb:.1} MB)"),
        ));
    }
    Ok((filename, &file.bytes))
}

fn attachment_not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Attachment not found")
}

fn internal_error() -> FastApiError {
    FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Failed to upload attachment",
    )
}

fn dependency_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "open attachment upload dependency failed");
    internal_error()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One multipart `file` field with `len` bytes of body content.
    #[test]
    fn upload_field_is_available_to_the_tests() {
        assert_eq!(upload_field("a.png", 3).bytes.len(), 3);
    }

    fn upload_field(filename: &str, len: usize) -> brz_http_server::Upload {
        brz_http_server::Upload {
            name: "file".to_string(),
            filename: Some(filename.to_string()),
            content_type: Some("application/octet-stream".to_string()),
            bytes: vec![0u8; len].into(),
        }
    }

    /// The OpenAPI upload is registered exactly once and its route entry
    /// selects POST, while the chat upload endpoint stays independent.
    #[test]
    fn the_open_upload_route_is_registered_once() {
        // `method_bit`: POST.
        const POST: u16 = 1 << 5;
        let methods: Vec<u16> =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .filter(|route| route.path == "/api/v1/attachments/upload")
                .map(|route| route.methods)
                .collect();
        assert_eq!(
            methods,
            [POST],
            "the open upload endpoint is registered once"
        );
    }

    /// The size gate reports the configured maximum, not a chunk size, and a
    /// body at the limit passes while one byte over fails.
    #[test]
    fn the_size_gate_uses_the_configured_maximum() {
        let max = document::max_file_size();
        let at_limit = Multipart {
            fields: vec![upload_field("a.png", max as usize)],
        };
        assert_eq!(
            bind_upload_file(&at_limit).map(|(name, _)| name).ok(),
            Some("a.png")
        );

        let over = Multipart {
            fields: vec![upload_field("a.png", max as usize + 1)],
        };
        let error = bind_upload_file(&over).unwrap_err();
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        let documented = max as f64 / BYTES_PER_MIB;
        assert_eq!(
            error.validation_detail(),
            format!("\"File size exceeds maximum limit ({documented:.1} MB)\"")
        );
    }

    /// The endpoint reuses `get_auth_context`: every rejection keeps the
    /// source `HTTPException` detail, and an inactive service-key user keeps
    /// the username the header named.
    #[test]
    fn the_auth_rejections_keep_the_source_details() {
        use brz_http_server::AuthFailure;
        let cases = [
            (
                auth_failure(ApiFailure::new(
                    StatusCode::UNAUTHORIZED,
                    "API key is required",
                )),
                "API key is required",
            ),
            (
                auth_failure(ApiFailure::new(StatusCode::UNAUTHORIZED, "Invalid API key")),
                "Invalid API key",
            ),
            (
                auth_failure(ApiFailure::new(
                    StatusCode::UNAUTHORIZED,
                    "API key has expired",
                )),
                "API key has expired",
            ),
            (
                auth_failure(ApiFailure::new(
                    StatusCode::UNAUTHORIZED,
                    "User not found or inactive",
                )),
                "User not found or inactive",
            ),
        ];
        for (failure, detail) in cases {
            let error = auth_error_response(failure, None);
            assert_eq!(error.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(error.validation_detail(), format!("\"{detail}\""));
        }

        // The service-key username gate is a 400 with the source message.
        let error = auth_error_response(
            auth_failure(ApiFailure::new(
                StatusCode::BAD_REQUEST,
                "Username can only contain letters, numbers, underscores, and hyphens",
            )),
            None,
        );
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);

        // The inactive user's challenge keeps the username it needs.
        let inactive = auth_failure(ApiFailure::new(
            StatusCode::UNAUTHORIZED,
            "User 'wenna3' is inactive",
        ));
        assert!(matches!(
            inactive,
            AuthFailure::InvalidCredentials {
                challenge: OPEN_USER_INACTIVE
            }
        ));
        assert_eq!(
            auth_error_response(inactive, Some("wenna3".to_string())).validation_detail(),
            "\"User 'wenna3' is inactive\""
        );

        // A dependency failure maps to the source's generic 500.
        assert!(matches!(
            auth_failure(ApiFailure::internal("boom")),
            AuthFailure::Internal
        ));
    }
}
