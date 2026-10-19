// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wework transcript listing for `GET /api/wework-transcripts`, the per-user
//! segment key for
//! `GET /api/wework-transcripts/{transcript_id}/encryption-key`, and the
//! archive download for
//! `GET /api/wework-transcripts/{transcript_id}/archives/{archive_id}/download`.
//!
//! Mirrors `app.api.endpoints.wework_transcripts` (router prefix
//! `/wework-transcripts`, mounted under the app prefix `/api`):
//! authenticate the bearer token, then list the user's transcripts ordered by
//! `updated_at` descending while loading each transcript's retained archives
//! ordered by `to_sequence`, or resolve one transcript for the requesting user
//! before returning that user's encryption key. The download handler resolves
//! the transcript, then the archive row for that transcript, applies the
//! retained-archive floor check, and streams the archive object from the
//! configured object store. The listing response follows the
//! `TranscriptListResponse` pydantic model with `by_alias=True` so fields
//! render in camelCase; the key response renders the source
//! `TranscriptEncryptionKeyResponse` fields unchanged.
//! Column aliases (`wework_transcripts_<column>`,
//! `wework_transcript_archives_<column>`) mirror the source SQLAlchemy
//! labeled rendering so the prepared statements match the recorded exchanges.
//!
//! The source `turns` route
//! (`GET /api/wework-transcripts/{transcript_id}/turns`,
//! `app/api/endpoints/wework_transcripts.py:205`) allows only `GET`, so the
//! recorded `POST /api/wework-transcripts/*/turns` group is a method mismatch:
//! FastAPI answers it with `405 {"detail":"Method Not Allowed"}` plus
//! `Allow: GET`. The recorded group only exercises `POST`, so the target owns
//! that method and reproduces the source framework response.
use brz_http_server::{Binary, HttpResponse};
use brz_mysql::FromMysqlRow;
use serde::Deserialize;
#[cfg(test)]
use serde_json::{Value, json};

use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::wework_transcript_archive_storage::{self, ArchiveReadError};

/// `EPOCH_TIME` (`app.models.wework_transcript`): the sentinel naive datetime
/// that means "no value" for `writer_lease_expires_at` and `archived_at`.
/// The source uses `datetime(1970, 1, 1)`.
pub(crate) const EPOCH_TIME: chrono::NaiveDateTime = chrono::NaiveDate::from_ymd_opt(1970, 1, 1)
    .unwrap()
    .and_hms_opt(0, 0, 0)
    .unwrap();

/// Query parameters (`includeArchived` bool, default `true`).
///
/// The source declares `include_archived: bool = Query(default=True,
/// alias="includeArchived")`; `serde(rename = "includeArchived")` maps the
/// wire name to the field, and `#[serde(default)]` supplies `true` when the
/// parameter is absent.
#[derive(Debug, Deserialize)]
pub struct TranscriptListQuery {
    #[serde(default = "default_include_archived", rename = "includeArchived")]
    pub include_archived: bool,
}

fn default_include_archived() -> bool {
    true
}

/// One `wework_transcripts` row, selected with the full labeled source
/// column list. The result columns carry the `wework_transcripts_<column>`
/// aliases, so every field is renamed.
#[derive(Debug, FromMysqlRow)]
pub(crate) struct TranscriptRow {
    #[mysql(rename = "wework_transcripts_id")]
    pub(crate) id: i64,
    #[mysql(rename = "wework_transcripts_transcript_id")]
    pub(crate) transcript_id: String,
    #[mysql(rename = "wework_transcripts_parent_transcript_id")]
    pub(crate) parent_transcript_id: String,
    #[mysql(rename = "wework_transcripts_forked_at_sequence")]
    pub(crate) forked_at_sequence: i64,
    #[mysql(rename = "wework_transcripts_title")]
    pub(crate) title: String,
    #[mysql(rename = "wework_transcripts_state")]
    pub(crate) state: String,
    #[mysql(rename = "wework_transcripts_current_sequence")]
    pub(crate) current_sequence: i64,
    #[mysql(rename = "wework_transcripts_archived_through_sequence")]
    pub(crate) archived_through_sequence: i64,
    #[mysql(rename = "wework_transcripts_writer_client_id")]
    pub(crate) writer_client_id: String,
    #[mysql(rename = "wework_transcripts_writer_fencing_token")]
    pub(crate) writer_fencing_token: i64,
    #[mysql(rename = "wework_transcripts_writer_lease_expires_at")]
    pub(crate) writer_lease_expires_at: chrono::NaiveDateTime,
    #[mysql(rename = "wework_transcripts_archived_at")]
    pub(crate) archived_at: chrono::NaiveDateTime,
    #[mysql(rename = "wework_transcripts_created_at")]
    pub(crate) created_at: chrono::NaiveDateTime,
    #[mysql(rename = "wework_transcripts_updated_at")]
    pub(crate) updated_at: chrono::NaiveDateTime,
}

/// One `wework_transcript_archives` row, selected with the full labeled
/// source column list. The result columns carry the
/// `wework_transcript_archives_<column>` aliases, so every field is renamed.
#[derive(Debug, FromMysqlRow)]
pub(crate) struct ArchiveRow {
    #[mysql(rename = "wework_transcript_archives_id")]
    pub(crate) id: i64,
    #[mysql(rename = "wework_transcript_archives_from_sequence")]
    pub(crate) from_sequence: i64,
    #[mysql(rename = "wework_transcript_archives_to_sequence")]
    pub(crate) to_sequence: i64,
    #[mysql(rename = "wework_transcript_archives_storage_key")]
    pub(crate) storage_key: String,
    #[mysql(rename = "wework_transcript_archives_sha256")]
    pub(crate) sha256: String,
    #[mysql(rename = "wework_transcript_archives_size_bytes")]
    pub(crate) size_bytes: i64,
    #[mysql(rename = "wework_transcript_archives_format")]
    pub(crate) format: String,
    #[mysql(rename = "wework_transcript_archives_created_at")]
    pub(crate) created_at: chrono::NaiveDateTime,
}

/// The source `wework_transcripts` query
/// (`wework_transcript_service.list_transcripts`): filter by `user_id`, and
/// when `include_archived` is false add `state = 'active'`. The projection
/// mirrors the source SQLAlchemy labeled rendering
/// (`wework_transcripts.<column> AS wework_transcripts_<column>`) so the
/// prepared statement matches the recorded exchange. The source SQLAlchemy
/// query uses inline literal values (COM_QUERY) because the user_id is bound
/// by the ORM as a literal in the rendered SQL; the recorded SQL confirms
/// this with `WHERE wework_transcripts.user_id = 148` as a literal.
const TRANSCRIPTS_QUERY: &str = "SELECT wework_transcripts.id AS wework_transcripts_id, \
     wework_transcripts.user_id AS wework_transcripts_user_id, \
     wework_transcripts.transcript_id AS wework_transcripts_transcript_id, \
     wework_transcripts.parent_transcript_id AS wework_transcripts_parent_transcript_id, \
     wework_transcripts.forked_at_sequence AS wework_transcripts_forked_at_sequence, \
     wework_transcripts.title AS wework_transcripts_title, \
     wework_transcripts.state AS wework_transcripts_state, \
     wework_transcripts.current_sequence AS wework_transcripts_current_sequence, \
     wework_transcripts.archived_through_sequence AS wework_transcripts_archived_through_sequence, \
     wework_transcripts.writer_client_id AS wework_transcripts_writer_client_id, \
     wework_transcripts.writer_fencing_token AS wework_transcripts_writer_fencing_token, \
     wework_transcripts.writer_lease_expires_at AS wework_transcripts_writer_lease_expires_at, \
     wework_transcripts.archived_at AS wework_transcripts_archived_at, \
     wework_transcripts.created_at AS wework_transcripts_created_at, \
     wework_transcripts.updated_at AS wework_transcripts_updated_at \
     FROM wework_transcripts \
     WHERE wework_transcripts.user_id = ? \
     ORDER BY wework_transcripts.updated_at DESC";

/// The `wework_transcripts` query with the `state = 'active'` filter applied
/// (used when `include_archived` is false).
const TRANSCRIPTS_QUERY_ACTIVE_ONLY: &str = "SELECT wework_transcripts.id AS wework_transcripts_id, \
     wework_transcripts.user_id AS wework_transcripts_user_id, \
     wework_transcripts.transcript_id AS wework_transcripts_transcript_id, \
     wework_transcripts.parent_transcript_id AS wework_transcripts_parent_transcript_id, \
     wework_transcripts.forked_at_sequence AS wework_transcripts_forked_at_sequence, \
     wework_transcripts.title AS wework_transcripts_title, \
     wework_transcripts.state AS wework_transcripts_state, \
     wework_transcripts.current_sequence AS wework_transcripts_current_sequence, \
     wework_transcripts.archived_through_sequence AS wework_transcripts_archived_through_sequence, \
     wework_transcripts.writer_client_id AS wework_transcripts_writer_client_id, \
     wework_transcripts.writer_fencing_token AS wework_transcripts_writer_fencing_token, \
     wework_transcripts.writer_lease_expires_at AS wework_transcripts_writer_lease_expires_at, \
     wework_transcripts.archived_at AS wework_transcripts_archived_at, \
     wework_transcripts.created_at AS wework_transcripts_created_at, \
     wework_transcripts.updated_at AS wework_transcripts_updated_at \
     FROM wework_transcripts \
     WHERE wework_transcripts.user_id = ? AND wework_transcripts.state = 'active' \
     ORDER BY wework_transcripts.updated_at DESC";

/// The single-transcript lookup
/// (`wework_transcript_service.get_transcript`): the same labeled projection
/// as the listing, filtered by the requesting `user_id` and the
/// `transcript_id`, with the source `query.first()`'s `LIMIT 1`. Recorded
/// exchanges render both filters as row values, so the projection mirrors the
/// listing query and the conditions stay separate AND branches.
pub(crate) const TRANSCRIPT_BY_ID_QUERY: &str = "SELECT wework_transcripts.id AS wework_transcripts_id, \
     wework_transcripts.user_id AS wework_transcripts_user_id, \
     wework_transcripts.transcript_id AS wework_transcripts_transcript_id, \
     wework_transcripts.parent_transcript_id AS wework_transcripts_parent_transcript_id, \
     wework_transcripts.forked_at_sequence AS wework_transcripts_forked_at_sequence, \
     wework_transcripts.title AS wework_transcripts_title, \
     wework_transcripts.state AS wework_transcripts_state, \
     wework_transcripts.current_sequence AS wework_transcripts_current_sequence, \
     wework_transcripts.archived_through_sequence AS wework_transcripts_archived_through_sequence, \
     wework_transcripts.writer_client_id AS wework_transcripts_writer_client_id, \
     wework_transcripts.writer_fencing_token AS wework_transcripts_writer_fencing_token, \
     wework_transcripts.writer_lease_expires_at AS wework_transcripts_writer_lease_expires_at, \
     wework_transcripts.archived_at AS wework_transcripts_archived_at, \
     wework_transcripts.created_at AS wework_transcripts_created_at, \
     wework_transcripts.updated_at AS wework_transcripts_updated_at \
     FROM wework_transcripts \
     WHERE wework_transcripts.user_id = ? AND wework_transcripts.transcript_id = ? \
     LIMIT 1";

/// The `wework_transcript_archives` retained-floor query
/// (`wework_transcript_service._retained_archive_floor`): the two newest
/// snapshot `to_sequence` values (`from_sequence = 0`, ordered by
/// `to_sequence` descending, limited to 2). The floor is the second value, or
/// `0` when fewer than two snapshots exist. The projection mirrors the source
/// SQLAlchemy labeled rendering.
const ARCHIVES_FLOOR_QUERY: &str = "SELECT wework_transcript_archives.to_sequence AS wework_transcript_archives_to_sequence \
     FROM wework_transcript_archives \
     WHERE wework_transcript_archives.transcript_db_id = ? AND wework_transcript_archives.from_sequence = 0 \
     ORDER BY wework_transcript_archives.to_sequence DESC \
     LIMIT 2";

/// The source `wework_transcript_archives` query
/// (`wework_transcript_service.list_archives`): filter by
/// `transcript_db_id` and `to_sequence >= retained_floor`, ordered by
/// `to_sequence`. The projection mirrors the source SQLAlchemy labeled
/// rendering.
pub(crate) const ARCHIVES_QUERY: &str = "SELECT wework_transcript_archives.id AS wework_transcript_archives_id, \
     wework_transcript_archives.transcript_db_id AS wework_transcript_archives_transcript_db_id, \
     wework_transcript_archives.from_sequence AS wework_transcript_archives_from_sequence, \
     wework_transcript_archives.to_sequence AS wework_transcript_archives_to_sequence, \
     wework_transcript_archives.storage_key AS wework_transcript_archives_storage_key, \
     wework_transcript_archives.sha256 AS wework_transcript_archives_sha256, \
     wework_transcript_archives.size_bytes AS wework_transcript_archives_size_bytes, \
     wework_transcript_archives.format AS wework_transcript_archives_format, \
     wework_transcript_archives.created_at AS wework_transcript_archives_created_at \
     FROM wework_transcript_archives \
     WHERE wework_transcript_archives.transcript_db_id = ? AND wework_transcript_archives.to_sequence >= ? \
     ORDER BY wework_transcript_archives.to_sequence";

/// The single-archive lookup (`wework_transcript_service.get_archive`): the
/// full labeled projection filtered by the archive `id` and the transcript's
/// database id, with the source `query.first()`'s `LIMIT 1` and no ordering.
const ARCHIVE_BY_ID_QUERY: &str = "SELECT wework_transcript_archives.id AS wework_transcript_archives_id, \
     wework_transcript_archives.transcript_db_id AS wework_transcript_archives_transcript_db_id, \
     wework_transcript_archives.from_sequence AS wework_transcript_archives_from_sequence, \
     wework_transcript_archives.to_sequence AS wework_transcript_archives_to_sequence, \
     wework_transcript_archives.storage_key AS wework_transcript_archives_storage_key, \
     wework_transcript_archives.sha256 AS wework_transcript_archives_sha256, \
     wework_transcript_archives.size_bytes AS wework_transcript_archives_size_bytes, \
     wework_transcript_archives.format AS wework_transcript_archives_format, \
     wework_transcript_archives.created_at AS wework_transcript_archives_created_at \
     FROM wework_transcript_archives \
     WHERE wework_transcript_archives.id = ? AND wework_transcript_archives.transcript_db_id = ? \
     LIMIT 1";

/// Pydantic v2 naive-datetime serialization: `YYYY-MM-DDTHH:MM:SS` plus
/// fractional seconds (microseconds) when nonzero. The source `TranscriptResponse`
/// model serializes `created_at`, `updated_at` as naive datetimes and
/// `writer_lease_expires_at`, `archived_at` as `Optional[datetime]`.
pub(crate) fn format_datetime(value: &chrono::NaiveDateTime) -> String {
    let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        base
    } else {
        format!("{base}.{:06}", value.and_utc().timestamp_subsec_micros())
    }
}

/// `_optional_datetime`: `None` when the value equals `EPOCH_TIME`,
/// otherwise the datetime. Mirrors
/// `app.api.endpoints.wework_transcripts._optional_datetime`.
fn optional_datetime(value: &chrono::NaiveDateTime) -> Option<String> {
    (*value != EPOCH_TIME).then(|| format_datetime(value))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptResponse {
    transcript_id: String,
    parent_transcript_id: Option<String>,
    forked_at_sequence: Option<i64>,
    title: String,
    state: String,
    current_sequence: i64,
    archived_through_sequence: i64,
    writer_client_id: Option<String>,
    writer_lease_expires_at: Option<String>,
    archives: Vec<ArchiveResponse>,
    created_at: String,
    updated_at: String,
    archived_at: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveResponse {
    id: i64,
    from_sequence: i64,
    to_sequence: i64,
    sha256: String,
    size_bytes: i64,
    format: String,
    created_at: String,
}

#[derive(serde::Serialize)]
struct TranscriptListResponse {
    items: Vec<TranscriptResponse>,
}

fn transcript_response(row: &TranscriptRow, archives: &[ArchiveRow]) -> TranscriptResponse {
    TranscriptResponse {
        transcript_id: row.transcript_id.clone(),
        parent_transcript_id: (!row.parent_transcript_id.is_empty())
            .then(|| row.parent_transcript_id.clone()),
        forked_at_sequence: (!row.parent_transcript_id.is_empty())
            .then_some(row.forked_at_sequence),
        title: row.title.clone(),
        state: row.state.clone(),
        current_sequence: row.current_sequence,
        archived_through_sequence: row.archived_through_sequence,
        writer_client_id: (!row.writer_client_id.is_empty()).then(|| row.writer_client_id.clone()),
        writer_lease_expires_at: optional_datetime(&row.writer_lease_expires_at),
        archives: archives
            .iter()
            .map(|a| ArchiveResponse {
                id: a.id,
                from_sequence: a.from_sequence,
                to_sequence: a.to_sequence,
                sha256: a.sha256.clone(),
                size_bytes: a.size_bytes,
                format: a.format.clone(),
                created_at: format_datetime(&a.created_at),
            })
            .collect(),
        created_at: format_datetime(&row.created_at),
        updated_at: format_datetime(&row.updated_at),
        archived_at: optional_datetime(&row.archived_at),
    }
}

/// GET /api/wework-transcripts: the transcript listing free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/wework-transcripts")]
async fn list_transcripts(
    #[inject(state)] state: &AppState,
    #[auth] user: crate::auth::SessionUser,
    query: brz_http_server::Query<TranscriptListQuery>,
) -> Result<TranscriptListResponse, FastApiError> {
    transcripts_list(state, &user, &query).await
}

/// Handler body for `GET /api/wework-transcripts`.
async fn transcripts_list(
    state: &AppState,
    user: &crate::auth::SessionUser,
    query: &TranscriptListQuery,
) -> Result<TranscriptListResponse, FastApiError> {
    let sql = if query.include_archived {
        TRANSCRIPTS_QUERY
    } else {
        TRANSCRIPTS_QUERY_ACTIVE_ONLY
    };
    let transcripts: Vec<TranscriptRow> = match state.mysql.fetch_all(sql, (user.id,)).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "wework_transcripts database dependency failure");
            return Err(internal_error());
        }
    };

    let mut items: Vec<TranscriptResponse> = Vec::with_capacity(transcripts.len());
    for row in &transcripts {
        let floor: i64 = match retained_archive_floor(&state.mysql, row.id).await {
            Ok(floor) => floor,
            Err(error) => {
                tracing::error!(%error, "wework_transcript_archives database dependency failure");
                return Err(internal_error());
            }
        };
        let archives: Vec<ArchiveRow> = match state
            .mysql
            .fetch_all(ARCHIVES_QUERY, (row.id, floor))
            .await
        {
            Ok(rows) => rows,
            Err(error) => {
                tracing::error!(%error, "wework_transcript_archives database dependency failure");
                return Err(internal_error());
            }
        };
        items.push(transcript_response(row, &archives));
    }

    Ok(TranscriptListResponse { items })
}

/// POST /api/wework-transcripts/{transcript_id}/turns: the source route
/// (`app/api/endpoints/wework_transcripts.py:205`) allows only `GET`, so
/// FastAPI answers `POST` with `405 {"detail":"Method Not Allowed"}` plus
/// `Allow: GET` before authentication runs. The recorded group exercises this
/// method, so the target owns the `POST` request and reproduces the source
/// framework response; `config/routes.toml` selects it for the Rust listener.
#[brz_http_server::post(
    "/api/wework-transcripts/:transcript_id/turns",
    access = public
)]
async fn turns_method_not_allowed(transcript_id: &str) -> Result<(), FastApiError> {
    // The source rejects the method before it resolves the path parameter.
    let _ = transcript_id;
    Err(turns_method_not_allowed_error())
}

/// The source framework's `405` body and `Allow` header for the `turns` path.
/// The `Allow` value is the source route's only method (`GET`), not the target
/// router's method set.
fn turns_method_not_allowed_error() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::METHOD_NOT_ALLOWED,
        "Method Not Allowed",
    )
    .with_header("allow", "GET")
}

/// `TranscriptEncryptionKeyResponse` (`app.schemas.wework_transcript`):
/// `algorithm` is the source `KEY_ALGORITHM` constant and `key` is the
/// requesting user's derived segment key. The model declares no aliases, so
/// both fields render unchanged.
#[derive(serde::Serialize)]
struct TranscriptEncryptionKeyResponse {
    algorithm: &'static str,
    key: String,
}

/// GET /api/wework-transcripts/{transcript_id}/encryption-key: the source
/// handler resolves the transcript for the authenticated user before it
/// returns the key, so an unknown or foreign transcript id is a 404.
#[brz_http_server::get("/api/wework-transcripts/:transcript_id/encryption-key")]
async fn get_transcript_encryption_key(
    #[inject(state)] state: &AppState,
    transcript_id: &str,
    #[auth] user: crate::auth::SessionUser,
) -> Result<TranscriptEncryptionKeyResponse, FastApiError> {
    encryption_key_response(state, user.id, transcript_id).await
}

/// Handler body for `GET /api/wework-transcripts/{transcript_id}/encryption-key`:
/// `_translate(wework_transcript_service.get_transcript(...))` followed by
/// `transcript_encryption_key(current_user.id)`. The lookup is a read-only
/// existence check, so the loaded row is not rendered.
async fn encryption_key_response(
    state: &AppState,
    user_id: i32,
    transcript_id: &str,
) -> Result<TranscriptEncryptionKeyResponse, FastApiError> {
    let transcript: Option<TranscriptRow> = match state
        .mysql
        .fetch_optional(TRANSCRIPT_BY_ID_QUERY, (user_id, transcript_id))
        .await
    {
        Ok(row) => row,
        Err(error) => {
            tracing::error!(%error, "wework_transcripts database dependency failure");
            return Err(internal_error());
        }
    };
    if transcript.is_none() {
        return Err(transcript_not_found());
    }

    Ok(TranscriptEncryptionKeyResponse {
        algorithm: crate::wework_transcript_encryption::KEY_ALGORITHM,
        key: crate::wework_transcript_encryption::transcript_encryption_key(
            &configured_master_key(state),
            user_id,
        ),
    })
}

/// GET /api/wework-transcripts/{transcript_id}/archives/{archive_id}/download:
/// the archive download free function, injecting the process-lifetime
/// application state.
#[brz_http_server::get("/api/wework-transcripts/:transcript_id/archives/:archive_id/download")]
async fn download_transcript_archive(
    #[inject(state)] state: &AppState,
    transcript_id: &str,
    archive_id: i64,
    #[auth] user: crate::auth::SessionUser,
) -> Result<HttpResponse<Binary>, FastApiError> {
    download_archive(state, user.id, transcript_id, archive_id).await
}

/// Handler body for
/// `GET /api/wework-transcripts/{transcript_id}/archives/{archive_id}/download`:
/// `_translate` resolves the transcript for the requesting user, then
/// `wework_transcript_service.get_archive` (archive id + transcript database id
/// with the retained-archive floor), then
/// `wework_transcript_storage.stream(archive.storage_key)`. A missing transcript
/// is 404 `transcript_not_found`; a missing or pruned archive, or an absent
/// stored object, is 404 `archive_not_found`; an unavailable store is 503
/// `transcript_storage_unavailable`. The success body streams the object with
/// `application/octet-stream` and `archive.size_bytes` as its length.
async fn download_archive(
    state: &AppState,
    user_id: i32,
    transcript_id: &str,
    archive_id: i64,
) -> Result<HttpResponse<Binary>, FastApiError> {
    let transcript: Option<TranscriptRow> = match state
        .mysql
        .fetch_optional(TRANSCRIPT_BY_ID_QUERY, (user_id, transcript_id))
        .await
    {
        Ok(row) => row,
        Err(error) => {
            tracing::error!(%error, "wework_transcripts database dependency failure");
            return Err(internal_error());
        }
    };
    let Some(transcript) = transcript else {
        return Err(transcript_not_found());
    };

    let archive: Option<ArchiveRow> = match state
        .mysql
        .fetch_optional(ARCHIVE_BY_ID_QUERY, (archive_id, transcript.id))
        .await
    {
        Ok(row) => row,
        Err(error) => {
            tracing::error!(%error, "wework_transcript_archives database dependency failure");
            return Err(internal_error());
        }
    };
    let Some(archive) = archive else {
        return Err(archive_not_found());
    };

    let floor = match retained_archive_floor(&state.mysql, transcript.id).await {
        Ok(floor) => floor,
        Err(error) => {
            tracing::error!(%error, "wework_transcript_archives database dependency failure");
            return Err(internal_error());
        }
    };
    if archive.to_sequence < floor {
        return Err(archive_not_found());
    }

    let Some(config) = wework_transcript_archive_storage::config_from_env() else {
        return Err(storage_unavailable());
    };
    let bytes = match wework_transcript_archive_storage::read_object(
        &state.attachment_http,
        &config,
        &archive.storage_key,
    )
    .await
    {
        Ok(bytes) => bytes,
        Err(ArchiveReadError::NotFound) => return Err(archive_not_found()),
        Err(ArchiveReadError::Unavailable) => return Err(storage_unavailable()),
    };

    // `StreamingResponse(media_type="application/octet-stream",
    // headers={"Content-Length": str(archive.size_bytes)})`: the source streams
    // the object with the archived size as the declared length. `Binary`
    // carries the exact object bytes and derives the same `Content-Length`.
    Ok(HttpResponse::new(Binary::new(bytes)))
}

/// `settings.WEWORK_TRANSCRIPT_ENCRYPTION_KEY or settings.SECRET_KEY`:
/// the configured master secret the per-user key derives from. The source
/// `or` treats an unset (empty) encryption key as absent and then uses the JWT
/// signing key, which the target already loaded at startup.
fn configured_master_key(state: &AppState) -> String {
    crate::config::env_or_dotenv("WEWORK_TRANSCRIPT_ENCRYPTION_SECRET")
        .unwrap_or_else(|| state.auth.jwt_key.clone())
}

/// `WeworkTranscriptError` rendered by `_translate`:
/// `{"detail": {"code", "message"}}` with the error's status code. Shared by
/// every handler in the wework-transcripts group.
pub(crate) fn transcript_error(
    status: brz_http_server::StatusCode,
    code: &'static str,
    message: &'static str,
) -> FastApiError {
    FastApiError::json_body(
        status,
        TranscriptErrorResponse {
            detail: TranscriptErrorBody { code, message },
        },
    )
}

/// `wework_transcript_service.get_transcript`'s missing-row error:
/// `404 {"detail": {"code": "transcript_not_found", "message": ...}}`.
pub(crate) fn transcript_not_found() -> FastApiError {
    transcript_error(
        brz_http_server::StatusCode::NOT_FOUND,
        "transcript_not_found",
        "Wework transcript not found",
    )
}

/// `WeworkTranscriptError("archive_not_found", ...)` rendered by `_translate`:
/// `404 {"detail": {"code": "archive_not_found", "message": ...}}`. Raised both
/// for a missing/pruned archive row and for a missing stored object.
fn archive_not_found() -> FastApiError {
    FastApiError::json_body(
        brz_http_server::StatusCode::NOT_FOUND,
        TranscriptErrorResponse {
            detail: TranscriptErrorBody {
                code: "archive_not_found",
                message: "Wework transcript segment not found",
            },
        },
    )
}

/// `WeworkTranscriptStorageError` rendered by `_translate`:
/// `503 {"detail": {"code": "transcript_storage_unavailable", "message": ...}}`.
pub(crate) fn storage_unavailable() -> FastApiError {
    FastApiError::json_body(
        brz_http_server::StatusCode::SERVICE_UNAVAILABLE,
        TranscriptErrorResponse {
            detail: TranscriptErrorBody {
                code: "transcript_storage_unavailable",
                message: "Wework transcript object storage is unavailable",
            },
        },
    )
}

/// The `_translate` error body (`{"detail": {"code", "message"}}`).
#[derive(serde::Serialize)]
struct TranscriptErrorResponse {
    detail: TranscriptErrorBody,
}

#[derive(serde::Serialize)]
struct TranscriptErrorBody {
    code: &'static str,
    message: &'static str,
}

/// `wework_transcript_service._retained_archive_floor`: the two newest
/// snapshot `to_sequence` values for the transcript; the floor is the second
/// value, or `0` when fewer than two snapshots exist. A database failure here
/// surfaces as the source global exception handler's 500 response.
pub(crate) async fn retained_archive_floor<M: brz_mysql::Mysql>(
    mysql: &M,
    transcript_db_id: i64,
) -> brz_mysql::MysqlResult<i64> {
    let snapshots: Vec<(i64,)> = mysql
        .fetch_all(ARCHIVES_FLOOR_QUERY, (transcript_db_id,))
        .await?;
    Ok(snapshots
        .get(1)
        .map(|(to_sequence,)| *to_sequence)
        .unwrap_or(0))
}

/// Source `python_exception_handler` 500 response shape. Shared by every
/// handler in the wework-transcripts group.
pub(crate) fn internal_error() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
        serde_json::json!({"error_code": 500, "detail": "Internal server error"}).to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn transcript_response(row: &TranscriptRow, archives: &[ArchiveRow]) -> Value {
        crate::json_contract_tests::serialized(super::transcript_response(row, archives)).unwrap()
    }

    fn optional_datetime(value: &chrono::NaiveDateTime) -> Value {
        crate::json_contract_tests::serialized(super::optional_datetime(value)).unwrap()
    }

    fn transcript_row() -> TranscriptRow {
        TranscriptRow {
            id: 142,
            transcript_id: "runtime-165203783".to_string(),
            parent_transcript_id: String::new(),
            forked_at_sequence: 0,
            title: "test transcript".to_string(),
            state: "active".to_string(),
            current_sequence: 10,
            archived_through_sequence: 0,
            writer_client_id: String::new(),
            writer_fencing_token: 0,
            writer_lease_expires_at: EPOCH_TIME,
            archived_at: EPOCH_TIME,
            created_at: NaiveDate::from_ymd_opt(2026, 9, 10)
                .unwrap()
                .and_hms_micro_opt(2, 33, 57, 350276)
                .unwrap(),
            updated_at: NaiveDate::from_ymd_opt(2026, 9, 10)
                .unwrap()
                .and_hms_micro_opt(3, 13, 48, 444066)
                .unwrap(),
        }
    }

    #[test]
    fn format_datetime_renders_microseconds_when_nonzero() {
        let dt = NaiveDate::from_ymd_opt(2026, 9, 10)
            .unwrap()
            .and_hms_micro_opt(2, 33, 57, 350276)
            .unwrap();
        assert_eq!(format_datetime(&dt), "2026-09-10T02:33:57.350276");
    }

    #[test]
    fn format_datetime_renders_seconds_when_zero_subsec() {
        let dt = NaiveDate::from_ymd_opt(2026, 9, 10)
            .unwrap()
            .and_hms_opt(2, 33, 57)
            .unwrap();
        assert_eq!(format_datetime(&dt), "2026-09-10T02:33:57");
    }

    #[test]
    fn optional_datetime_returns_null_for_epoch() {
        assert_eq!(optional_datetime(&EPOCH_TIME), Value::Null);
    }

    #[test]
    fn optional_datetime_returns_string_for_real_time() {
        let dt = NaiveDate::from_ymd_opt(2026, 9, 10)
            .unwrap()
            .and_hms_micro_opt(2, 33, 57, 350276)
            .unwrap();
        let result = optional_datetime(&dt);
        assert_eq!(result, json!("2026-09-10T02:33:57.350276"));
    }

    #[test]
    fn transcript_response_with_no_archives() {
        let row = transcript_row();
        let body = transcript_response(&row, &[]);
        assert_eq!(body["transcriptId"], "runtime-165203783");
        assert_eq!(body["parentTranscriptId"], Value::Null);
        assert_eq!(body["forkedAtSequence"], Value::Null);
        assert_eq!(body["title"], "test transcript");
        assert_eq!(body["state"], "active");
        assert_eq!(body["currentSequence"], 10);
        assert_eq!(body["archivedThroughSequence"], 0);
        assert_eq!(body["writerClientId"], Value::Null);
        assert_eq!(body["writerLeaseExpiresAt"], Value::Null);
        assert_eq!(body["archives"], json!([]));
        assert_eq!(body["createdAt"], "2026-09-10T02:33:57.350276");
        assert_eq!(body["updatedAt"], "2026-09-10T03:13:48.444066");
        assert_eq!(body["archivedAt"], Value::Null);
    }

    #[test]
    fn transcript_response_with_archives() {
        let row = transcript_row();
        let archive = ArchiveRow {
            id: 1,
            from_sequence: 0,
            to_sequence: 5,
            storage_key: "users/1/transcripts/abc/0-1.tgz.aes256gcm".to_string(),
            sha256: "abc123".to_string(),
            size_bytes: 1024,
            format: "jsonl.zst".to_string(),
            created_at: NaiveDate::from_ymd_opt(2026, 9, 10)
                .unwrap()
                .and_hms_opt(2, 0, 0)
                .unwrap(),
        };
        let body = transcript_response(&row, &[archive]);
        let archives = body["archives"].as_array().unwrap();
        assert_eq!(archives.len(), 1);
        assert_eq!(archives[0]["id"], 1);
        assert_eq!(archives[0]["fromSequence"], 0);
        assert_eq!(archives[0]["toSequence"], 5);
        assert_eq!(archives[0]["sha256"], "abc123");
        assert_eq!(archives[0]["sizeBytes"], 1024);
        assert_eq!(archives[0]["format"], "jsonl.zst");
        assert_eq!(archives[0]["createdAt"], "2026-09-10T02:00:00");
    }

    #[test]
    fn default_include_archived_is_true() {
        assert!(default_include_archived());
    }

    #[test]
    fn archives_query_filters_by_retained_floor_and_orders_by_to_sequence() {
        let expected_tail = "WHERE wework_transcript_archives.transcript_db_id = ? \
             AND wework_transcript_archives.to_sequence >= ? \
             ORDER BY wework_transcript_archives.to_sequence";
        assert!(ARCHIVES_QUERY.trim().ends_with(expected_tail.trim()));
    }

    #[test]
    fn archives_floor_query_selects_two_newest_snapshots_descending() {
        let expected = "SELECT wework_transcript_archives.to_sequence AS wework_transcript_archives_to_sequence \
             FROM wework_transcript_archives \
             WHERE wework_transcript_archives.transcript_db_id = ? \
             AND wework_transcript_archives.from_sequence = 0 \
             ORDER BY wework_transcript_archives.to_sequence DESC \
             LIMIT 2";
        assert_eq!(ARCHIVES_FLOOR_QUERY, expected);
    }

    #[test]
    fn transcript_by_id_query_filters_the_user_and_transcript_with_limit_one() {
        let expected_tail = "WHERE wework_transcripts.user_id = ? \
             AND wework_transcripts.transcript_id = ? \
             LIMIT 1";
        assert!(
            TRANSCRIPT_BY_ID_QUERY
                .trim()
                .ends_with(expected_tail.trim())
        );
        assert!(
            TRANSCRIPT_BY_ID_QUERY.starts_with(TRANSCRIPTS_QUERY.split(" FROM ").next().unwrap())
        );
    }

    #[test]
    fn encryption_key_response_renders_the_source_model_fields() {
        let body = crate::json_contract_tests::serialized(TranscriptEncryptionKeyResponse {
            algorithm: crate::wework_transcript_encryption::KEY_ALGORITHM,
            key: crate::wework_transcript_encryption::transcript_encryption_key("master", 2095),
        })
        .unwrap();
        assert_eq!(body["algorithm"], json!("aes-256-gcm"));
        assert_eq!(
            body["key"],
            json!(crate::wework_transcript_encryption::transcript_encryption_key("master", 2095))
        );
    }

    #[test]
    fn encryption_key_missing_transcript_renders_the_translate_error_body() {
        let error = transcript_not_found();
        assert_eq!(error.status(), brz_http_server::StatusCode::NOT_FOUND);
        let detail: Value = serde_json::from_str(&error.validation_detail()).unwrap();
        assert_eq!(
            detail,
            json!({
                "code": "transcript_not_found",
                "message": "Wework transcript not found",
            })
        );
    }

    #[test]
    fn turns_post_error_is_the_source_method_not_allowed_body() {
        let error = turns_method_not_allowed_error();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::METHOD_NOT_ALLOWED
        );
        let detail: Value = serde_json::from_str(&error.validation_detail()).unwrap();
        assert_eq!(detail, json!("Method Not Allowed"));
    }

    // A dedicated test group (separate from the crate's real `http_apis`
    // group) so the probe's route does not collide with the real handler.
    mod probe {
        brz_http_server::registry!(group = turns_probe, dependencies());
    }

    #[brz_http_server::post(
        "/api/wework-transcripts/:transcript_id/turns",
        group = probe::turns_probe,
        access = public
    )]
    async fn probe_turns_post(transcript_id: &str) -> Result<(), FastApiError> {
        let _ = transcript_id;
        Err(turns_method_not_allowed_error())
    }

    /// Drives the registered route over a real socket so the status, `Allow`
    /// header, and body are asserted exactly as the runtime renders them.
    #[tokio::test]
    async fn turns_post_renders_405_with_allow_get_over_http() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let handler =
            brz_http_server::handlers!(; group = probe::turns_probe).expect("probe router");
        let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), handler)
            .await
            .expect("bind test server");
        let address = server.local_addr().expect("local address");
        let serve = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        let mut client = tokio::net::TcpStream::connect(address)
            .await
            .expect("connect");
        client
            .write_all(
                b"POST /api/wework-transcripts/runtime-1/turns HTTP/1.1\r\n\
                  Host: localhost\r\nConnection: close\r\n\r\n",
            )
            .await
            .expect("send");
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.expect("read");
        serve.abort();
        let raw = String::from_utf8_lossy(&raw);
        assert!(raw.starts_with("HTTP/1.1 405"), "{raw}");
        assert!(raw.contains("allow: GET"), "{raw}");
        assert!(raw.contains(r#"{"detail":"Method Not Allowed"}"#), "{raw}");
    }

    #[test]
    fn archive_by_id_query_filters_the_archive_and_transcript_with_limit_one() {
        let expected_tail = "WHERE wework_transcript_archives.id = ? \
             AND wework_transcript_archives.transcript_db_id = ? \
             LIMIT 1";
        assert!(ARCHIVE_BY_ID_QUERY.trim().ends_with(expected_tail.trim()));
        // `get_archive`'s `query.first()` has no ordering.
        assert!(!ARCHIVE_BY_ID_QUERY.contains("ORDER BY"));
        // The projection is the same labeled column list as the retained query.
        assert_eq!(
            ARCHIVE_BY_ID_QUERY.split(" FROM ").next().unwrap(),
            ARCHIVES_QUERY.split(" FROM ").next().unwrap()
        );
    }

    #[test]
    fn missing_archive_renders_the_translate_error_body() {
        let error = archive_not_found();
        assert_eq!(error.status(), brz_http_server::StatusCode::NOT_FOUND);
        let detail: Value = serde_json::from_str(&error.validation_detail()).unwrap();
        assert_eq!(
            detail,
            json!({
                "code": "archive_not_found",
                "message": "Wework transcript segment not found",
            })
        );
    }

    #[test]
    fn unavailable_storage_renders_the_translate_error_body() {
        let error = storage_unavailable();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::SERVICE_UNAVAILABLE
        );
        let detail: Value = serde_json::from_str(&error.validation_detail()).unwrap();
        assert_eq!(
            detail,
            json!({
                "code": "transcript_storage_unavailable",
                "message": "Wework transcript object storage is unavailable",
            })
        );
    }
}
