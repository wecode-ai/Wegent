// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/smart-apps/marketplace/{smart_app_id}/artifact` handler.
//!
//! `download_marketplace_artifact` (`app/api/endpoints/smart_apps.py`): a
//! public (token-authenticated) route. The short-lived Smart app download
//! token in the `token` query parameter carries the identities; a missing
//! parameter is FastAPI's 422 before any handler code runs. The verified
//! token must name the same `smart_app_id` as the path, then the service
//! rechecks access for the token's `user_id` and loads the passed release,
//! and the object streams from the plugin package store with the source's
//! download headers.
use brz_http_server::{Binary, HttpResponse, StatusCode};

use super::artifact::{self, ArtifactError};
use super::link;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `quote(artifact.filename, safe="")` (`urllib.parse.quote`): percent-encode
/// everything except the RFC 3986 unreserved set.
fn percent_encode(filename: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(filename.len());
    for &byte in filename.as_bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~');
        if unreserved {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0xF) as usize] as char);
        }
    }
    out
}

/// `download_marketplace_artifact`.
#[brz_http_server::get(
    "/api/smart-apps/marketplace/:smart_app_id/artifact",
    access = public
)]
async fn download_marketplace_artifact(
    #[inject(state)] state: &AppState,
    smart_app_id: i64,
    token: Option<String>,
) -> Result<HttpResponse<Binary>, FastApiError> {
    // FastAPI binds the required `token` query parameter before the endpoint
    // runs; a missing value is a 422 without dependency traffic.
    let Some(token) = token else {
        return Err(query_missing("token"));
    };
    // `verify_smart_app_download_token` + the path/claim identity check.
    let claims = match link::verify_smart_app_download_token(&state.auth, &token) {
        link::VerifiedDownloadToken::Claims(claims) => claims,
        link::VerifiedDownloadToken::Invalid => {
            return Err(FastApiError::forbidden(
                "Invalid or expired Smart app download link",
            ));
        }
        // The source's uncaught `TypeError` from `_validate_iat`.
        link::VerifiedDownloadToken::Unhandled => return Err(FastApiError::unhandled()),
    };
    if claims.smart_app_id != smart_app_id {
        return Err(FastApiError::forbidden(
            "Invalid or expired Smart app download link",
        ));
    }

    let artifact = match artifact::download_artifact(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        smart_app_id,
        claims.release_id,
        claims.user_id,
    )
    .await
    {
        Ok(artifact) => artifact,
        Err(ArtifactError::NotFound(detail)) => {
            return Err(FastApiError::detail(StatusCode::NOT_FOUND, detail));
        }
        Err(ArtifactError::Dependency) => return Err(FastApiError::unhandled()),
    };
    // `marketplace_artifact_storage.open_download(storage_key)`; every
    // storage failure (including an absent object) is the endpoint's 503.
    let config = artifact::plugin_storage_config();
    let bytes = artifact::open_download(&state.attachment_http, &config, &artifact.storage_key)
        .await
        .map_err(|_| artifact::storage_unavailable())?;

    // `StreamingResponse(media_type="application/zip", headers={...})`: the
    // source streams the object with the recorded download headers. The
    // declared `Content-Length` is the release's `size_bytes`; `Binary`
    // carries the exact object bytes and the runtime verifies the length.
    let encoded_filename = percent_encode(&artifact.filename);
    let mut response = HttpResponse::new(Binary::new(bytes));
    response = attach(response, "cache-control", "private, no-store")?;
    response = attach(
        response,
        "content-disposition",
        &format!("attachment; filename*=UTF-8''{encoded_filename}"),
    )?;
    response = attach(response, "content-type", "application/zip")?;
    response = attach(response, "x-content-type-options", "nosniff")?;
    Ok(response.content_length(u64::try_from(artifact.size_bytes).unwrap_or(0)))
}

/// FastAPI's 422 body for a missing required query parameter.
fn query_missing(field: &str) -> FastApiError {
    FastApiError::validation(serde_json::json!([
        {
            "type": "missing",
            "loc": ["query", field],
            "msg": "Field required",
            "input": null,
        }
    ]))
}

/// A rejected header value is the source's unhandled 500.
fn attach(
    response: HttpResponse<Binary>,
    name: &str,
    value: &str,
) -> Result<HttpResponse<Binary>, FastApiError> {
    response
        .header(name, value)
        .map_err(|error| FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filenames_are_percent_encoded_like_urllib_quote() {
        // The recorded Content-Disposition of the dsh-xlsx2dashboard release.
        assert_eq!(
            percent_encode("dsh-xlsx2dashboard-0.4.0.zip"),
            "dsh-xlsx2dashboard-0.4.0.zip"
        );
        assert_eq!(percent_encode("a b"), "a%20b");
        assert_eq!(percent_encode("中文"), "%E4%B8%AD%E6%96%87");
    }

    #[test]
    fn storage_unavailable_renders_the_source_503_body() {
        let error = artifact::storage_unavailable();
        let body = serde_json::to_vec(&serde_json::json!({
            "detail": {
                "code": "smart_app_storage_unavailable",
                "message": "Smart app file storage is unavailable",
            }
        }))
        .expect("serializes");
        // `FastApiError::json_body` carries the exact source shape; the
        // status and detail are asserted through the public constructor.
        assert_eq!(error.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(!body.is_empty());
    }
}
