// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/wework-transcripts/{transcript_id}/segments` — commit one
//! encrypted transcript segment together with its finalized turn summary.
//!
//! Mirrors `app.api.endpoints.wework_transcripts.upload_segment_endpoint` and
//! `app.services.wework_transcript_service.upload_segment` (router prefix
//! `/wework-transcripts`, mounted under the app prefix `/api`): authenticate
//! the bearer token, bind the multipart `metadata` and `file` parts, validate
//! the manifest as `TranscriptSegmentCommitRequest`, load the owned transcript
//! under `SELECT ... FOR UPDATE`, enforce the write lease, detect an
//! idempotent re-upload, validate the sequence, verify the restorable
//! snapshot/delta chain in object storage, stage and store the segment object,
//! flush the transcript update plus the archive and turn inserts, commit,
//! refresh the row, and prune obsolete segments.
//!
//! SQLAlchemy commits the request-scoped transaction only on success and rolls
//! it back when the endpoint raises; the target issues those terminal
//! `COMMIT`/`ROLLBACK` statements explicitly so the recorded session lifecycle
//! is preserved. Dirty-column updates mirror the mapper (declaration) order.

use brz_http_server::Multipart;
use brz_mysql::{FromMysqlRow, MysqlRouteValue, MysqlValue, MysqlValueWriter};
use chrono::NaiveDateTime;
use serde_json::{Value, json};

use crate::http_compat::FastApiError;
use crate::json_compat::python_json_value;
use crate::state::AppState;
use crate::wework_transcript_archive_storage::{self, ArchiveReadError};
use crate::wework_transcript_segment_manifest::{
    SegmentRequest, parse_segment_request, pydantic_error,
};
use crate::wework_transcripts::{
    ARCHIVES_QUERY, ArchiveRow, EPOCH_TIME, TRANSCRIPT_BY_ID_QUERY, TranscriptRow, internal_error,
    retained_archive_floor, storage_unavailable, transcript_error, transcript_not_found,
};
use crate::wework_transcripts_lease::REFRESH_TRANSCRIPT_QUERY;

/// `MAX_SEGMENTS_PRUNED_PER_COMMIT`
/// (`app.services.wework_transcript_service`).
const MAX_SEGMENTS_PRUNED_PER_COMMIT: i64 = 20;

/// `upload_segment`'s `existing_archive` lookup: the archive row already
/// committed at this transcript and `to_sequence`, with `query.first()`'s
/// `LIMIT 1`.
const EXISTING_ARCHIVE_QUERY: &str = "SELECT wework_transcript_archives.id AS wework_transcript_archives_id, \
     wework_transcript_archives.transcript_db_id AS wework_transcript_archives_transcript_db_id, \
     wework_transcript_archives.from_sequence AS wework_transcript_archives_from_sequence, \
     wework_transcript_archives.to_sequence AS wework_transcript_archives_to_sequence, \
     wework_transcript_archives.storage_key AS wework_transcript_archives_storage_key, \
     wework_transcript_archives.sha256 AS wework_transcript_archives_sha256, \
     wework_transcript_archives.size_bytes AS wework_transcript_archives_size_bytes, \
     wework_transcript_archives.format AS wework_transcript_archives_format, \
     wework_transcript_archives.created_at AS wework_transcript_archives_created_at \
     FROM wework_transcript_archives \
     WHERE wework_transcript_archives.transcript_db_id = ? AND wework_transcript_archives.to_sequence = ? \
     LIMIT 1";

/// `upload_segment`'s `existing_turn` lookup: the turn matched by sequence or
/// by turn identity, with `query.first()`'s `LIMIT 1`.
const EXISTING_TURN_QUERY: &str = "SELECT wework_transcript_turns.id AS wework_transcript_turns_id, \
     wework_transcript_turns.transcript_db_id AS wework_transcript_turns_transcript_db_id, \
     wework_transcript_turns.sequence AS wework_transcript_turns_sequence, \
     wework_transcript_turns.turn_id AS wework_transcript_turns_turn_id, \
     wework_transcript_turns.payload AS wework_transcript_turns_payload, \
     wework_transcript_turns.created_at AS wework_transcript_turns_created_at \
     FROM wework_transcript_turns \
     WHERE wework_transcript_turns.transcript_db_id = ? \
     AND (wework_transcript_turns.sequence = ? OR wework_transcript_turns.turn_id = ?) \
     LIMIT 1";

/// `_prune_obsolete_segments`' snapshot list: every snapshot archive ordered
/// newest first. Unlike the retained-floor query this one has no `LIMIT`.
const PRUNE_SNAPSHOTS_QUERY: &str = "SELECT wework_transcript_archives.id AS wework_transcript_archives_id, \
     wework_transcript_archives.transcript_db_id AS wework_transcript_archives_transcript_db_id, \
     wework_transcript_archives.from_sequence AS wework_transcript_archives_from_sequence, \
     wework_transcript_archives.to_sequence AS wework_transcript_archives_to_sequence, \
     wework_transcript_archives.storage_key AS wework_transcript_archives_storage_key, \
     wework_transcript_archives.sha256 AS wework_transcript_archives_sha256, \
     wework_transcript_archives.size_bytes AS wework_transcript_archives_size_bytes, \
     wework_transcript_archives.format AS wework_transcript_archives_format, \
     wework_transcript_archives.created_at AS wework_transcript_archives_created_at \
     FROM wework_transcript_archives \
     WHERE wework_transcript_archives.transcript_db_id = ? AND wework_transcript_archives.from_sequence = 0 \
     ORDER BY wework_transcript_archives.to_sequence DESC";

/// `_prune_obsolete_segments`' bounded obsolete list: segments below the
/// retained snapshot floor, oldest first.
const PRUNE_OBSOLETE_QUERY: &str = "SELECT wework_transcript_archives.id AS wework_transcript_archives_id, \
     wework_transcript_archives.transcript_db_id AS wework_transcript_archives_transcript_db_id, \
     wework_transcript_archives.from_sequence AS wework_transcript_archives_from_sequence, \
     wework_transcript_archives.to_sequence AS wework_transcript_archives_to_sequence, \
     wework_transcript_archives.storage_key AS wework_transcript_archives_storage_key, \
     wework_transcript_archives.sha256 AS wework_transcript_archives_sha256, \
     wework_transcript_archives.size_bytes AS wework_transcript_archives_size_bytes, \
     wework_transcript_archives.format AS wework_transcript_archives_format, \
     wework_transcript_archives.created_at AS wework_transcript_archives_created_at \
     FROM wework_transcript_archives \
     WHERE wework_transcript_archives.transcript_db_id = ? AND wework_transcript_archives.to_sequence < ? \
     ORDER BY wework_transcript_archives.to_sequence \
     LIMIT 20";

/// `db.delete(segment)` for one pruned archive row.
const DELETE_ARCHIVE_QUERY: &str =
    "DELETE FROM wework_transcript_archives WHERE wework_transcript_archives.id = ?";

/// `db.add(WeworkTranscriptArchive(...))` with every request column and the
/// Python-side `created_at` default bound explicitly.
const INSERT_ARCHIVE_QUERY: &str = "INSERT INTO wework_transcript_archives \
     (transcript_db_id, from_sequence, to_sequence, storage_key, sha256, size_bytes, format, created_at) \
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

/// `db.add(WeworkTranscriptTurn(...))` with the Python-side `created_at`
/// default bound explicitly.
const INSERT_TURN_QUERY: &str = "INSERT INTO wework_transcript_turns \
     (transcript_db_id, sequence, turn_id, payload, created_at) \
     VALUES (?, ?, ?, ?, ?)";

/// `TranscriptAppendResponse` (`app.schemas.wework_transcript`) rendered with
/// `by_alias=True`: `currentSequence` and the int-cast `appended` flag.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptAppendResponse {
    current_sequence: i64,
    appended: i64,
}

/// One `wework_transcript_turns` row matched by sequence or turn identity.
#[derive(Debug, FromMysqlRow)]
struct TurnRow {
    #[mysql(rename = "wework_transcript_turns_sequence")]
    sequence: i64,
    #[mysql(rename = "wework_transcript_turns_turn_id")]
    turn_id: String,
    #[mysql(rename = "wework_transcript_turns_payload")]
    payload: Value,
}

/// The refreshed `wework_transcripts` row (unlabeled projection by primary
/// key); only `current_sequence` feeds the response.
#[derive(Debug, FromMysqlRow)]
struct RefreshedRow {
    #[mysql(rename = "current_sequence")]
    current_sequence: i64,
}

/// One UPDATE bind value: sequence columns bind as integers while the audit
/// timestamps bind as `'%Y-%m-%d %H:%M:%S.%f'` strings.
#[derive(Debug, PartialEq)]
enum SegmentBind {
    Int(i64),
    Text(String),
}

impl MysqlValue for SegmentBind {
    fn write(self, writer: &mut MysqlValueWriter) -> brz_mysql::MysqlResult<()> {
        match self {
            SegmentBind::Int(value) => writer.push(value),
            SegmentBind::Text(value) => writer.push(value),
        }
    }

    fn route_value(&self) -> MysqlRouteValue<'_> {
        match self {
            SegmentBind::Int(value) => MysqlRouteValue::I64(*value),
            SegmentBind::Text(value) => MysqlRouteValue::String(value.as_str()),
        }
    }
}

/// The dirty-column UPDATE SQLAlchemy flushes for this commit: mapper-order
/// columns plus their bind values and the row id.
#[derive(Debug, PartialEq)]
struct UpdatePlan {
    set_clause: String,
    binds: Vec<SegmentBind>,
    row_id: i64,
}

/// POST /api/wework-transcripts/{transcript_id}/segments: bind the multipart
/// manifest and file, then commit the segment for the authenticated user.
#[brz_http_server::post("/api/wework-transcripts/:transcript_id/segments")]
async fn upload_segment(
    #[inject(state)] state: &AppState,
    transcript_id: &str,
    #[auth] user: crate::auth::SessionUser,
    multipart: Multipart,
) -> Result<TranscriptAppendResponse, FastApiError> {
    let (metadata, file_bytes) = bind_multipart(&multipart)?;
    let request = parse_segment_request(metadata)?;
    upload_segment_impl(state, user.id, transcript_id, &request, file_bytes).await
}

/// FastAPI's `Form(...)`/`File(...)` binding: both parts are required and a
/// missing part renders the 422 `{"type": "missing"}` entry before the handler
/// body runs.
fn bind_multipart(multipart: &Multipart) -> Result<(&str, &[u8]), FastApiError> {
    let mut errors: Vec<Value> = Vec::with_capacity(2);
    let metadata = multipart.get("metadata");
    let file = multipart.get("file");
    if metadata.is_none() {
        errors.push(json!({
            "type": "missing",
            "loc": ["body", "metadata"],
            "msg": "Field required",
            "input": Value::Null,
        }));
    }
    if file.is_none() {
        errors.push(json!({
            "type": "missing",
            "loc": ["body", "file"],
            "msg": "Field required",
            "input": Value::Null,
        }));
    }
    if !errors.is_empty() {
        return Err(FastApiError::validation(errors));
    }
    let metadata = metadata.expect("checked above");
    let file = file.expect("checked above");
    let Ok(metadata) = metadata.text() else {
        return Err(FastApiError::validation(vec![pydantic_error(
            "string_type",
            &["metadata"],
            "Input should be a valid string",
            &Value::String(String::new()),
            None,
        )]));
    };
    Ok((metadata, &file.bytes))
}

/// Handler body for `POST /api/wework-transcripts/{transcript_id}/segments`.
async fn upload_segment_impl(
    state: &AppState,
    user_id: i32,
    transcript_id: &str,
    request: &SegmentRequest,
    file_bytes: &[u8],
) -> Result<TranscriptAppendResponse, FastApiError> {
    let lock_query = format!("{TRANSCRIPT_BY_ID_QUERY} FOR UPDATE");
    let transcript: Option<TranscriptRow> = match state
        .mysql
        .fetch_optional(lock_query.as_str(), (user_id, transcript_id))
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

    // `_require_lease`: the caller must hold the active write lease.
    if !lease_valid(&transcript, request, utcnow()) {
        rollback(state).await;
        return Err(lease_invalid());
    }

    let existing_archive: Option<ArchiveRow> = match state
        .mysql
        .fetch_optional(EXISTING_ARCHIVE_QUERY, (transcript.id, request.sequence))
        .await
    {
        Ok(row) => row,
        Err(error) => {
            rollback(state).await;
            tracing::error!(%error, "wework_transcript_archives database dependency failure");
            return Err(internal_error());
        }
    };
    let existing_turn: Option<TurnRow> = match state
        .mysql
        .fetch_optional(
            EXISTING_TURN_QUERY,
            (transcript.id, request.sequence, request.turn_id.as_str()),
        )
        .await
    {
        Ok(row) => row,
        Err(error) => {
            rollback(state).await;
            tracing::error!(%error, "wework_transcript_turns database dependency failure");
            return Err(internal_error());
        }
    };

    let from_sequence = if is_snapshot(request) {
        0
    } else {
        request.sequence
    };
    let object_key = segment_object_key(user_id, transcript_id, request);

    if existing_archive.is_some() || existing_turn.is_some() {
        return finish_idempotent(
            state,
            &transcript,
            request,
            existing_archive.as_ref(),
            existing_turn.as_ref(),
            from_sequence,
            &object_key,
            file_bytes,
        )
        .await;
    }

    // `_validate_segment_write`: the segment advances exactly one sequence.
    if request.sequence != request.base_sequence + 1 {
        rollback(state).await;
        return Err(transcript_error(
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_sequence",
            "A transcript segment must advance exactly one sequence",
        ));
    }
    if transcript.current_sequence != request.base_sequence {
        rollback(state).await;
        return Err(transcript_error(
            brz_http_server::StatusCode::CONFLICT,
            "sequence_conflict",
            "Transcript sequence has changed; create a full snapshot branch",
        ));
    }

    // `_require_restorable_base`: a delta needs a complete snapshot chain.
    if let Err(error) = require_restorable_base(state, &transcript, request).await {
        rollback(state).await;
        return Err(error);
    }

    // `_store_segment`: stage, verify the manifest, then store the object.
    if let Err(error) = store_segment(state, &object_key, request, file_bytes).await {
        rollback(state).await;
        return Err(error);
    }

    // `transcript.current_sequence = ...` and the audit columns, then the
    // archive and turn inserts; SQLAlchemy flushes updates before inserts.
    let now = utcnow();
    let plan = transcript_update_plan(&transcript, request, from_sequence, now);
    let update_query = format!(
        "UPDATE wework_transcripts SET {} WHERE wework_transcripts.id = ?",
        plan.set_clause
    );
    let mut binds = plan.binds;
    binds.push(SegmentBind::Int(plan.row_id));
    if let Err(error) = state.mysql.execute(update_query.as_str(), binds).await {
        tracing::error!(%error, "wework_transcripts database dependency failure");
        rollback(state).await;
        return Err(internal_error());
    }

    let archive_created_at = utcnow();
    if let Err(error) = state
        .mysql
        .execute(
            INSERT_ARCHIVE_QUERY,
            (
                transcript.id,
                from_sequence,
                request.sequence,
                object_key.as_str(),
                request.sha256.as_str(),
                request.size_bytes,
                request.format.as_str(),
                sql_datetime(archive_created_at),
            ),
        )
        .await
    {
        tracing::error!(%error, "wework_transcript_archives database dependency failure");
        rollback(state).await;
        return Err(internal_error());
    }

    let turn_created_at = utcnow();
    let payload = python_json_value(&request.summary);
    if let Err(error) = state
        .mysql
        .execute(
            INSERT_TURN_QUERY,
            (
                transcript.id,
                request.sequence,
                request.turn_id.as_str(),
                payload,
                sql_datetime(turn_created_at),
            ),
        )
        .await
    {
        tracing::error!(%error, "wework_transcript_turns database dependency failure");
        rollback(state).await;
        return Err(internal_error());
    }

    if let Err(error) = state.mysql.execute("COMMIT", ()).await {
        tracing::error!(%error, "wework_transcripts commit failed");
        rollback(state).await;
        discard_stored_segment(state, &object_key, transcript.id, request.sequence).await;
        return Err(internal_error());
    }

    // `db.refresh(transcript)` reads the committed row before the response and
    // the prune pass re-read the archive table.
    let refreshed: Option<RefreshedRow> = match state
        .mysql
        .fetch_optional(REFRESH_TRANSCRIPT_QUERY, (transcript.id,))
        .await
    {
        Ok(row) => row,
        Err(error) => {
            tracing::error!(%error, "wework_transcripts database dependency failure");
            return Err(internal_error());
        }
    };
    let Some(refreshed) = refreshed else {
        return Err(internal_error());
    };

    if let Err(error) = prune_obsolete_segments(state, transcript.id).await {
        tracing::error!(
            ?error,
            "wework_transcript_archives database dependency failure"
        );
        return Err(internal_error());
    }

    Ok(TranscriptAppendResponse {
        current_sequence: refreshed.current_sequence,
        appended: 1,
    })
}

/// The `existing_archive`/`existing_turn` branch: a re-upload is accepted only
/// when the segment and turn metadata both match the committed rows; it stores
/// the object again and reports `appended: 0` without touching the database.
#[allow(clippy::too_many_arguments)]
async fn finish_idempotent(
    state: &AppState,
    transcript: &TranscriptRow,
    request: &SegmentRequest,
    existing_archive: Option<&ArchiveRow>,
    existing_turn: Option<&TurnRow>,
    from_sequence: i64,
    object_key: &str,
    file_bytes: &[u8],
) -> Result<TranscriptAppendResponse, FastApiError> {
    let archive_matches = existing_archive
        .is_some_and(|archive| segment_matches(archive, from_sequence, object_key, request));
    if existing_archive.is_some() && !archive_matches {
        rollback(state).await;
        return Err(transcript_error(
            brz_http_server::StatusCode::CONFLICT,
            "segment_conflict",
            "A different native segment already exists at this sequence",
        ));
    }
    let turn_matches = existing_turn.is_some_and(|turn| {
        turn.sequence == request.sequence
            && turn.turn_id == request.turn_id
            && turn.payload == request.summary
    });
    if existing_archive.is_none() || !turn_matches {
        rollback(state).await;
        return Err(transcript_error(
            brz_http_server::StatusCode::CONFLICT,
            "turn_conflict",
            "A different transcript summary already exists for this turn or sequence",
        ));
    }
    if let Err(error) = store_segment(state, object_key, request, file_bytes).await {
        rollback(state).await;
        return Err(error);
    }
    // The source returns without committing; the request-scoped session rolls
    // the lock transaction back at teardown.
    rollback(state).await;
    Ok(TranscriptAppendResponse {
        current_sequence: transcript.current_sequence,
        appended: 0,
    })
}

/// `_require_restorable_base`: a delta segment is accepted only when the
/// stored snapshot plus every following archive up to the current sequence is
/// present in object storage. A snapshot upload always restarts the chain.
async fn require_restorable_base(
    state: &AppState,
    transcript: &TranscriptRow,
    request: &SegmentRequest,
) -> Result<(), FastApiError> {
    if is_snapshot(request) || transcript.current_sequence == 0 {
        return Ok(());
    }
    let floor = match retained_archive_floor(&state.mysql, transcript.id).await {
        Ok(floor) => floor,
        Err(error) => {
            tracing::error!(%error, "wework_transcript_archives database dependency failure");
            return Err(internal_error());
        }
    };
    let archives: Vec<ArchiveRow> = match state
        .mysql
        .fetch_all(ARCHIVES_QUERY, (transcript.id, floor))
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "wework_transcript_archives database dependency failure");
            return Err(internal_error());
        }
    };
    let snapshot = archives
        .iter()
        .filter(|archive| {
            archive.from_sequence == 0 && archive.to_sequence <= transcript.current_sequence
        })
        .max_by_key(|archive| archive.to_sequence);
    let Some(snapshot) = snapshot else {
        return Err(snapshot_required());
    };
    let chain: Vec<&ArchiveRow> = archives
        .iter()
        .filter(|archive| {
            snapshot.to_sequence <= archive.to_sequence
                && archive.to_sequence <= transcript.current_sequence
        })
        .collect();
    let mut expected_sequence = snapshot.to_sequence;
    for archive in chain {
        if archive.to_sequence != expected_sequence {
            break;
        }
        match object_exists(state, &archive.storage_key).await {
            Ok(true) => expected_sequence += 1,
            Ok(false) => break,
            Err(error) => return Err(error),
        }
    }
    if expected_sequence <= transcript.current_sequence {
        return Err(snapshot_required());
    }
    Ok(())
}

/// `wework_transcript_storage.exists(archive.storage_key)` with the storage
/// error mapping `_translate` applies.
async fn object_exists(state: &AppState, object_key: &str) -> Result<bool, FastApiError> {
    let Some(config) = wework_transcript_archive_storage::config_from_env() else {
        return Err(storage_unavailable());
    };
    match wework_transcript_archive_storage::object_exists(
        &state.attachment_http,
        &config,
        object_key,
    )
    .await
    {
        Ok(exists) => Ok(exists),
        Err(ArchiveReadError::NotFound | ArchiveReadError::Unavailable) => {
            Err(storage_unavailable())
        }
    }
}

/// `_store_segment`: verify the uploaded bytes against the manifest and store
/// the object. A size or digest mismatch is the source's 422; a storage
/// failure is its 503.
async fn store_segment(
    state: &AppState,
    object_key: &str,
    request: &SegmentRequest,
    file_bytes: &[u8],
) -> Result<(), FastApiError> {
    if file_bytes.len() as i64 != request.size_bytes {
        return Err(transcript_error(
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
            "segment_size_mismatch",
            "Uploaded transcript segment size does not match its manifest",
        ));
    }
    let digest = crate::attachments::s3_signing::hex_sha256(file_bytes);
    if digest != request.sha256 {
        return Err(transcript_error(
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
            "segment_digest_mismatch",
            "Uploaded transcript segment digest does not match its manifest",
        ));
    }
    let Some(config) = wework_transcript_archive_storage::config_from_env() else {
        return Err(storage_unavailable());
    };
    wework_transcript_archive_storage::put_object(
        &state.attachment_http,
        &config,
        object_key,
        file_bytes,
    )
    .await
    .map_err(|_| storage_unavailable())
}

/// The commit failure path: SQLAlchemy rolls back and best-effort removes the
/// already-stored object before re-raising the database error.
async fn discard_stored_segment(
    state: &AppState,
    object_key: &str,
    transcript_db_id: i64,
    sequence: i64,
) {
    let Some(config) = wework_transcript_archive_storage::config_from_env() else {
        return;
    };
    if wework_transcript_archive_storage::delete_object(&state.attachment_http, &config, object_key)
        .await
        .is_err()
    {
        tracing::warn!(
            transcript_db_id,
            sequence,
            "Failed to remove uncommitted Wework transcript segment"
        );
    }
}

/// `_prune_obsolete_segments`: once a second snapshot exists, remove the
/// segments below the retainable snapshot floor (bounded per commit), deleting
/// the stored object before its metadata row.
async fn prune_obsolete_segments(
    state: &AppState,
    transcript_db_id: i64,
) -> Result<(), FastApiError> {
    let snapshots: Vec<ArchiveRow> = match state
        .mysql
        .fetch_all(PRUNE_SNAPSHOTS_QUERY, (transcript_db_id,))
        .await
    {
        Ok(rows) => rows,
        Err(error) => return Err(internal_error_for(error)),
    };
    if snapshots.len() < 2 {
        return Ok(());
    }
    let retained_snapshot_sequence = snapshots[1].to_sequence;
    let obsolete: Vec<ArchiveRow> = match state
        .mysql
        .fetch_all(
            PRUNE_OBSOLETE_QUERY,
            (transcript_db_id, retained_snapshot_sequence),
        )
        .await
    {
        Ok(rows) => rows,
        Err(error) => return Err(internal_error_for(error)),
    };
    debug_assert!(obsolete.len() as i64 <= MAX_SEGMENTS_PRUNED_PER_COMMIT);
    for segment in obsolete {
        let Some(config) = wework_transcript_archive_storage::config_from_env() else {
            tracing::warn!(
                transcript_db_id,
                sequence = segment.to_sequence,
                "Failed to prune obsolete Wework transcript segment"
            );
            continue;
        };
        if wework_transcript_archive_storage::delete_object(
            &state.attachment_http,
            &config,
            &segment.storage_key,
        )
        .await
        .is_err()
        {
            tracing::warn!(
                transcript_db_id,
                sequence = segment.to_sequence,
                "Failed to prune obsolete Wework transcript segment"
            );
            continue;
        }
        if let Err(error) = state
            .mysql
            .execute(DELETE_ARCHIVE_QUERY, (segment.id,))
            .await
        {
            tracing::warn!(
                %error,
                transcript_db_id,
                sequence = segment.to_sequence,
                "Failed to remove pruned Wework transcript metadata"
            );
            rollback(state).await;
            continue;
        }
        if let Err(error) = state.mysql.execute("COMMIT", ()).await {
            tracing::warn!(
                %error,
                transcript_db_id,
                sequence = segment.to_sequence,
                "Failed to remove pruned Wework transcript metadata"
            );
            rollback(state).await;
        }
    }
    Ok(())
}

fn internal_error_for(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "wework_transcript_archives database dependency failure");
    internal_error()
}

/// `_segment_matches`: the committed archive row carries exactly this
/// segment's range, object key, digest, size, and format.
fn segment_matches(
    archive: &ArchiveRow,
    from_sequence: i64,
    object_key: &str,
    request: &SegmentRequest,
) -> bool {
    archive.from_sequence == from_sequence
        && archive.storage_key == object_key
        && archive.sha256 == request.sha256
        && archive.size_bytes == request.size_bytes
        && archive.format == request.format
}

/// `_validate_segment_write`'s in-memory lease predicate (also
/// `_require_lease`).
fn lease_valid(transcript: &TranscriptRow, request: &SegmentRequest, now: NaiveDateTime) -> bool {
    transcript.writer_client_id == request.client_id
        && transcript.writer_fencing_token == request.fencing_token
        && transcript.writer_lease_expires_at > now
}

/// `"snapshot" in request.format`.
fn is_snapshot(request: &SegmentRequest) -> bool {
    request.format.contains("snapshot")
}

/// `_segment_object_key`: the per-user, per-transcript content-addressed key.
fn segment_object_key(user_id: i32, transcript_id: &str, request: &SegmentRequest) -> String {
    let transcript_key = crate::attachments::s3_signing::hex_sha256(transcript_id.as_bytes());
    let kind = if is_snapshot(request) {
        "snapshot"
    } else {
        "delta"
    };
    format!(
        "users/{user_id}/transcripts/{transcript_key}/\
         {sequence}-{kind}-{sha256}.tgz.aes256gcm",
        sequence = request.sequence,
        sha256 = request.sha256,
    )
}

/// The dirty-column UPDATE plan for `upload_segment`'s transcript mutations,
/// in mapper (declaration) order. SQLAlchemy omits columns whose assigned
/// value equals the stored one.
fn transcript_update_plan(
    transcript: &TranscriptRow,
    request: &SegmentRequest,
    from_sequence: i64,
    now: NaiveDateTime,
) -> UpdatePlan {
    let mut columns: Vec<&str> = Vec::with_capacity(6);
    let mut binds: Vec<SegmentBind> = Vec::with_capacity(6);
    if let Some(title) = request.title.as_ref()
        && title != &transcript.title
    {
        columns.push("title=?");
        binds.push(SegmentBind::Text(title.clone()));
    }
    if transcript.state != "active" {
        columns.push("state=?");
        binds.push(SegmentBind::Text("active".to_string()));
    }
    if transcript.current_sequence != request.sequence {
        columns.push("current_sequence=?");
        binds.push(SegmentBind::Int(request.sequence));
    }
    if from_sequence == 0 && transcript.archived_through_sequence != request.sequence {
        columns.push("archived_through_sequence=?");
        binds.push(SegmentBind::Int(request.sequence));
    }
    if transcript.archived_at != EPOCH_TIME {
        columns.push("archived_at=?");
        binds.push(SegmentBind::Text(sql_datetime(EPOCH_TIME)));
    }
    // `updated_at = utcnow()` marks the column dirty whenever any other
    // column is dirty, so the `onupdate=utcnow` value binds once in mapper
    // order even when it equals the stored timestamp.
    if !columns.is_empty() {
        columns.push("updated_at=?");
        binds.push(SegmentBind::Text(sql_datetime(now)));
    }
    debug_assert!(!columns.is_empty());
    UpdatePlan {
        set_clause: columns.join(", "),
        binds,
        row_id: transcript.id,
    }
}

/// `_require_lease`'s error body: 409 `lease_invalid`.
fn lease_invalid() -> FastApiError {
    transcript_error(
        brz_http_server::StatusCode::CONFLICT,
        "lease_invalid",
        "Wework transcript write lease is missing, expired, or stale",
    )
}

/// `_require_restorable_base`'s error body: 409 `snapshot_required`.
fn snapshot_required() -> FastApiError {
    transcript_error(
        brz_http_server::StatusCode::CONFLICT,
        "snapshot_required",
        "The cloud transcript recovery chain is incomplete; upload a full snapshot",
    )
}

/// The request-scoped session rolls back when the endpoint raises.
async fn rollback(state: &AppState) {
    if let Err(error) = state.mysql.execute("ROLLBACK", ()).await {
        tracing::warn!(%error, "wework_transcripts rollback failed");
    }
}

/// `wework_transcript_service.utcnow`: the current naive UTC timestamp every
/// write and lease comparison derives from.
fn utcnow() -> NaiveDateTime {
    chrono::Utc::now().naive_utc()
}

/// SQLAlchemy's `DATETIME(6)` literal rendering.
fn sql_datetime(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%d %H:%M:%S%.6f").to_string()
}

#[cfg(test)]
#[path = "wework_transcripts_segments_tests.rs"]
mod tests;
