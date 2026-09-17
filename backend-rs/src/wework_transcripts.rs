// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wework transcript listing for `GET /api/wework-transcripts`.
//!
//! Mirrors `app.api.endpoints.wework_transcripts.list_transcripts_endpoint`
//! (router prefix `/wework-transcripts`, mounted under the app prefix
//! `/api`): authenticate the bearer token, list the user's transcripts
//! ordered by `updated_at` descending, and for each transcript load its
//! archives ordered by `from_sequence`. The response follows the
//! `TranscriptListResponse` pydantic model with `by_alias=True` so fields
//! render in camelCase.
//! Column aliases (`wework_transcripts_<column>`,
//! `wework_transcript_archives_<column>`) mirror the source SQLAlchemy
//! labeled rendering so the prepared statements match the recorded exchanges.
use brz_mysql::FromMysqlRow;
use serde::Deserialize;
#[cfg(test)]
use serde_json::{Value, json};

use crate::auth::{AuthFailure, UserRow, get_current_user};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `EPOCH_TIME` (`app.models.wework_transcript`): the sentinel naive datetime
/// that means "no value" for `writer_lease_expires_at` and `archived_at`.
/// The source uses `datetime(1970, 1, 1)`.
const EPOCH_TIME: chrono::NaiveDateTime = chrono::NaiveDate::from_ymd_opt(1970, 1, 1)
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
struct TranscriptRow {
    #[mysql(rename = "wework_transcripts_id")]
    id: i64,
    #[mysql(rename = "wework_transcripts_transcript_id")]
    transcript_id: String,
    #[mysql(rename = "wework_transcripts_parent_transcript_id")]
    parent_transcript_id: String,
    #[mysql(rename = "wework_transcripts_forked_at_sequence")]
    forked_at_sequence: i64,
    #[mysql(rename = "wework_transcripts_title")]
    title: String,
    #[mysql(rename = "wework_transcripts_state")]
    state: String,
    #[mysql(rename = "wework_transcripts_current_sequence")]
    current_sequence: i64,
    #[mysql(rename = "wework_transcripts_archived_through_sequence")]
    archived_through_sequence: i64,
    #[mysql(rename = "wework_transcripts_writer_client_id")]
    writer_client_id: String,
    #[mysql(rename = "wework_transcripts_writer_lease_expires_at")]
    writer_lease_expires_at: chrono::NaiveDateTime,
    #[mysql(rename = "wework_transcripts_archived_at")]
    archived_at: chrono::NaiveDateTime,
    #[mysql(rename = "wework_transcripts_created_at")]
    created_at: chrono::NaiveDateTime,
    #[mysql(rename = "wework_transcripts_updated_at")]
    updated_at: chrono::NaiveDateTime,
}

/// One `wework_transcript_archives` row, selected with the full labeled
/// source column list. The result columns carry the
/// `wework_transcript_archives_<column>` aliases, so every field is renamed.
#[derive(Debug, FromMysqlRow)]
struct ArchiveRow {
    #[mysql(rename = "wework_transcript_archives_id")]
    id: i64,
    #[mysql(rename = "wework_transcript_archives_from_sequence")]
    from_sequence: i64,
    #[mysql(rename = "wework_transcript_archives_to_sequence")]
    to_sequence: i64,
    #[mysql(rename = "wework_transcript_archives_sha256")]
    sha256: String,
    #[mysql(rename = "wework_transcript_archives_size_bytes")]
    size_bytes: i64,
    #[mysql(rename = "wework_transcript_archives_format")]
    format: String,
    #[mysql(rename = "wework_transcript_archives_created_at")]
    created_at: chrono::NaiveDateTime,
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

/// The source `wework_transcript_archives` query
/// (`wework_transcript_service.list_archives`): filter by
/// `transcript_db_id`, ordered by `from_sequence`. The projection mirrors
/// the source SQLAlchemy labeled rendering.
const ARCHIVES_QUERY: &str = "SELECT wework_transcript_archives.id AS wework_transcript_archives_id, \
     wework_transcript_archives.transcript_db_id AS wework_transcript_archives_transcript_db_id, \
     wework_transcript_archives.from_sequence AS wework_transcript_archives_from_sequence, \
     wework_transcript_archives.to_sequence AS wework_transcript_archives_to_sequence, \
     wework_transcript_archives.storage_key AS wework_transcript_archives_storage_key, \
     wework_transcript_archives.sha256 AS wework_transcript_archives_sha256, \
     wework_transcript_archives.size_bytes AS wework_transcript_archives_size_bytes, \
     wework_transcript_archives.format AS wework_transcript_archives_format, \
     wework_transcript_archives.created_at AS wework_transcript_archives_created_at \
     FROM wework_transcript_archives \
     WHERE wework_transcript_archives.transcript_db_id = ? \
     ORDER BY wework_transcript_archives.from_sequence";

/// Pydantic v2 naive-datetime serialization: `YYYY-MM-DDTHH:MM:SS` plus
/// fractional seconds (microseconds) when nonzero. The source `TranscriptResponse`
/// model serializes `created_at`, `updated_at` as naive datetimes and
/// `writer_lease_expires_at`, `archived_at` as `Optional[datetime]`.
fn format_datetime(value: &chrono::NaiveDateTime) -> String {
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
    #[header] authorization: Option<&str>,
    query: brz_http_server::Query<TranscriptListQuery>,
) -> Result<TranscriptListResponse, FastApiError> {
    transcripts_list(state, authorization, &query).await
}

/// Handler body for `GET /api/wework-transcripts`.
async fn transcripts_list(
    state: &AppState,
    authorization: Option<&str>,
    query: &TranscriptListQuery,
) -> Result<TranscriptListResponse, FastApiError> {
    let user: UserRow = match get_current_user(&state.auth, &state.mysql, authorization).await {
        Ok(user) => user,
        Err(AuthFailure::InvalidCredentials) => {
            return Err(FastApiError::unauthorized("Could not validate credentials"));
        }
        Err(AuthFailure::UserNotActivated) => {
            return Err(FastApiError::unauthorized("User not activated"));
        }
    };

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
        let archives: Vec<ArchiveRow> = state
            .mysql
            .fetch_all(ARCHIVES_QUERY, (row.id,))
            .await
            .unwrap_or_else(|error| {
                tracing::error!(%error, "wework_transcript_archives database dependency failure");
                Vec::new()
            });
        items.push(transcript_response(row, &archives));
    }

    Ok(TranscriptListResponse { items })
}

/// Source `python_exception_handler` 500 response shape.
fn internal_error() -> FastApiError {
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
}
