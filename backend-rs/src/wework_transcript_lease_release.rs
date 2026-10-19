// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/wework-transcripts/{transcript_id}/lease/release` — release the
//! caller's write lease (`app.api.endpoints.wework_transcripts.release_lease_endpoint`
//! -> `app.services.wework_transcript_service.release_lease`).
//!
//! The source resolves the owned transcript under a row lock
//! (`get_transcript(..., for_update=True)`), requires the caller's client id and
//! fencing token to match the stored writer while the lease is still active
//! (`_require_lease`), then sets `writer_lease_expires_at = EPOCH_TIME` and
//! `updated_at = utcnow()` and commits. It re-reads the row with `db.refresh`
//! before returning the fixed `{"released": true}` body.
//!
//! This module owns only that responsibility; the list and encryption-key
//! handlers share `wework_transcripts`' error renderers. The prepared
//! statements mirror the recorded SQLAlchemy rendering: the locked lookup
//! carries the labeled projection and `LIMIT 1 FOR UPDATE`, the flush updates
//! `writer_lease_expires_at` then `updated_at` by primary key, and the refresh
//! re-reads every mapped column unlabeled by primary key.
use brz_mysql::{FromMysqlRow, MysqlTransaction as _};

use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::wework_transcripts::{internal_error, transcript_error};

/// `EPOCH_TIME` (`app.models.wework_transcript`) rendered as the MySQL datetime
/// SQLAlchemy writes for `datetime(1970, 1, 1)` (zero sub-second part).
const EPOCH_TIME_SQL: &str = "1970-01-01 00:00:00";

/// `get_transcript(..., for_update=True)` in `release_lease`: the owned row
/// under the source `with_for_update()` lock. The labeled projection mirrors
/// the source SQLAlchemy rendering so the prepared statement matches the
/// recorded exchange.
const TRANSCRIPT_BY_ID_FOR_UPDATE_QUERY: &str = "SELECT wework_transcripts.id AS wework_transcripts_id, \
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
     LIMIT 1 FOR UPDATE";

/// `db.commit()`'s flush of the dirty `WeworkTranscript` in `release_lease`:
/// `writer_lease_expires_at = EPOCH_TIME` and the Python-side
/// `updated_at = utcnow()`, keyed by the primary key. SQLAlchemy renders the
/// two changed columns in mapper order.
const UPDATE_LEASE_RELEASED_QUERY: &str = "UPDATE wework_transcripts SET writer_lease_expires_at=?, updated_at=? \
     WHERE wework_transcripts.id = ?";

/// `db.refresh(transcript)` after the release commits: the row re-read by
/// primary key. SQLAlchemy renders every mapped column without labels and
/// carries no user/transcript filter and no `LIMIT`.
const TRANSCRIPT_REFRESH_QUERY: &str = "SELECT wework_transcripts.id, wework_transcripts.user_id, \
     wework_transcripts.transcript_id, wework_transcripts.parent_transcript_id, \
     wework_transcripts.forked_at_sequence, wework_transcripts.title, wework_transcripts.state, \
     wework_transcripts.current_sequence, wework_transcripts.archived_through_sequence, \
     wework_transcripts.writer_client_id, wework_transcripts.writer_fencing_token, \
     wework_transcripts.writer_lease_expires_at, wework_transcripts.archived_at, \
     wework_transcripts.created_at, wework_transcripts.updated_at \
     FROM wework_transcripts \
     WHERE wework_transcripts.id = ?";

/// The locked lookup result: only the fields `_require_lease` needs. The
/// decoder ignores the remaining labeled columns the statement selects.
#[derive(Debug, FromMysqlRow)]
struct LeaseRow {
    #[mysql(rename = "wework_transcripts_id")]
    id: i64,
    #[mysql(rename = "wework_transcripts_writer_client_id")]
    writer_client_id: String,
    #[mysql(rename = "wework_transcripts_writer_fencing_token")]
    writer_fencing_token: i64,
    #[mysql(rename = "wework_transcripts_writer_lease_expires_at")]
    writer_lease_expires_at: chrono::NaiveDateTime,
}

/// `TranscriptLeaseReleaseRequest` (`app.schemas.wework_transcript`): the two
/// required fields, whose camelCase aliases are the wire names.
#[derive(Debug)]
struct LeaseReleaseRequest {
    client_id: String,
    fencing_token: i64,
}

/// The release success body (`{"released": true}`).
#[derive(serde::Serialize)]
struct LeaseReleased {
    released: bool,
}

/// POST /api/wework-transcripts/{transcript_id}/lease/release: the source
/// handler validates `TranscriptLeaseReleaseRequest`, releases the caller's
/// write lease, and answers the fixed `{"released": true}` body.
#[brz_http_server::post("/api/wework-transcripts/:transcript_id/lease/release")]
async fn release_transcript_lease(
    #[inject(state)] state: &AppState,
    transcript_id: &str,
    #[auth] user: crate::auth::SessionUser,
    body: serde_json::Value,
) -> Result<LeaseReleased, FastApiError> {
    let request = parse_lease_release(&body)?;
    release_lease_response(state, user.id, transcript_id, &request).await
}

/// Handler body for `POST /api/wework-transcripts/{transcript_id}/lease/release`:
/// `get_transcript(for_update=True)`, `_require_lease`, then
/// `writer_lease_expires_at = EPOCH_TIME; updated_at = utcnow(); db.commit()`
/// and `db.refresh()`.
async fn release_lease_response(
    state: &AppState,
    user_id: i32,
    transcript_id: &str,
    request: &LeaseReleaseRequest,
) -> Result<LeaseReleased, FastApiError> {
    let transcript: Option<LeaseRow> = match state
        .mysql
        .fetch_optional(TRANSCRIPT_BY_ID_FOR_UPDATE_QUERY, (user_id, transcript_id))
        .await
    {
        Ok(row) => row,
        Err(error) => {
            tracing::error!(%error, "wework_transcripts database dependency failure");
            return Err(internal_error());
        }
    };
    let Some(transcript) = transcript else {
        return Err(transcript_error(
            brz_http_server::StatusCode::NOT_FOUND,
            "transcript_not_found",
            "Wework transcript not found",
        ));
    };

    // `_require_lease`: the caller's client id and fencing token must match the
    // stored writer and the lease must still be active.
    if transcript.writer_client_id != request.client_id
        || transcript.writer_fencing_token != request.fencing_token
        || transcript.writer_lease_expires_at <= utcnow()
    {
        return Err(transcript_error(
            brz_http_server::StatusCode::CONFLICT,
            "lease_invalid",
            "Wework transcript write lease is missing, expired, or stale",
        ));
    }

    // `transcript.writer_lease_expires_at = EPOCH_TIME; transcript.updated_at =
    // utcnow(); db.commit()`: one flushed update, then the session commit. Both
    // statements run on the single pooled connection a scoped transaction
    // pins, so the business UPDATE and its COMMIT share one connection the way
    // the source's SQLAlchemy session does; a bare pool-level COMMIT can land
    // on a different connection and cannot end another connection's write.
    let updated_at = utcnow().format("%Y-%m-%d %H:%M:%S%.6f").to_string();
    if let Err(error) = state
        .mysql
        .with_transaction(async |transaction| {
            transaction
                .execute(
                    UPDATE_LEASE_RELEASED_QUERY,
                    (EPOCH_TIME_SQL, updated_at.as_str(), transcript.id),
                )
                .await
        })
        .await
    {
        tracing::error!(%error, "wework_transcripts database dependency failure");
        return Err(internal_error());
    }
    // The request-scoped SQLAlchemy session closes right after the commit;
    // the driver rolls the freshly opened idle transaction back.
    if let Err(error) = state.mysql.execute("ROLLBACK", ()).await {
        tracing::error!(%error, "wework_transcripts database dependency failure");
        return Err(internal_error());
    }

    // `db.refresh(transcript)`: the source re-reads the committed row, but the
    // endpoint renders none of it.
    if let Err(error) = state
        .mysql
        .fetch_optional::<_, _, brz_mysql::MysqlRow>(TRANSCRIPT_REFRESH_QUERY, (transcript.id,))
        .await
    {
        tracing::error!(%error, "wework_transcripts database dependency failure");
        return Err(internal_error());
    }

    Ok(LeaseReleased { released: true })
}

/// `wework_transcript_service.utcnow`: the current naive UTC timestamp that
/// every lease comparison and write derives from.
fn utcnow() -> chrono::NaiveDateTime {
    chrono::Utc::now().naive_utc()
}

/// `TranscriptLeaseReleaseRequest` body validation: `clientId` is a required
/// `1..=100` character string and `fencingToken` a required integer `>= 1`.
/// The source model sets `populate_by_name`, so the snake_case field names are
/// also accepted. FastAPI validates the body before the endpoint runs, so a
/// failure renders a 422 without dependency traffic.
fn parse_lease_release(body: &serde_json::Value) -> Result<LeaseReleaseRequest, FastApiError> {
    let serde_json::Value::Object(object) = body else {
        return Err(FastApiError::validation(serde_json::json!([
            {
                "type": "model_attributes_type",
                "loc": ["body"],
                "msg": "Input should be a valid dictionary or object to extract fields from",
                "input": body,
            }
        ])));
    };

    // `client_id: str = Field(alias="clientId", min_length=1, max_length=100)`
    let Some(client_value) = present_field(object, &["clientId", "client_id"]) else {
        return Err(body_error(
            "missing",
            "Field required",
            "clientId",
            body,
            None,
        ));
    };
    let serde_json::Value::String(client_id) = client_value else {
        return Err(body_error(
            "string_type",
            "Input should be a valid string",
            "clientId",
            client_value,
            None,
        ));
    };
    if client_id.is_empty() {
        return Err(body_error(
            "string_too_short",
            "String should have at least 1 character",
            "clientId",
            client_value,
            Some(serde_json::json!({"min_length": 1})),
        ));
    }
    if client_id.chars().count() > 100 {
        return Err(body_error(
            "string_too_long",
            "String should have at most 100 characters",
            "clientId",
            client_value,
            Some(serde_json::json!({"max_length": 100})),
        ));
    }

    // `fencing_token: int = Field(alias="fencingToken", ge=1)`
    let Some(token_value) = present_field(object, &["fencingToken", "fencing_token"]) else {
        return Err(body_error(
            "missing",
            "Field required",
            "fencingToken",
            body,
            None,
        ));
    };
    let fencing_token = match token_value {
        serde_json::Value::Number(number) => match number.as_i64() {
            Some(value) => value,
            None => {
                let kind = if number.as_f64().is_some() {
                    "int_from_float"
                } else {
                    "int_parsing"
                };
                return Err(body_error(
                    kind,
                    "Input should be a valid integer",
                    "fencingToken",
                    token_value,
                    None,
                ));
            }
        },
        _ => {
            return Err(body_error(
                "int_parsing",
                "Input should be a valid integer",
                "fencingToken",
                token_value,
                None,
            ));
        }
    };
    if fencing_token < 1 {
        return Err(body_error(
            "greater_than_equal",
            "Input should be greater than or equal to 1",
            "fencingToken",
            token_value,
            Some(serde_json::json!({"ge": 1})),
        ));
    }

    Ok(LeaseReleaseRequest {
        client_id: client_id.clone(),
        fencing_token,
    })
}

/// The first present body key among the field's wire alias and snake_case name.
fn present_field<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    names: &[&str],
) -> Option<&'a serde_json::Value> {
    names.iter().find_map(|name| object.get(*name))
}

/// One FastAPI body-validation entry for a named field.
fn body_error(
    kind: &str,
    message: &str,
    field: &'static str,
    input: &serde_json::Value,
    ctx: Option<serde_json::Value>,
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
    FastApiError::validation(serde_json::Value::Array(vec![entry]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn lease_released_body_matches_the_source_response() {
        let body =
            crate::json_contract_tests::serialized(LeaseReleased { released: true }).unwrap();
        assert_eq!(body, json!({"released": true}));
        assert_eq!(body.to_string(), r#"{"released":true}"#);
    }

    #[test]
    fn lease_invalid_renders_the_translate_error_body() {
        let error = transcript_error(
            brz_http_server::StatusCode::CONFLICT,
            "lease_invalid",
            "Wework transcript write lease is missing, expired, or stale",
        );
        assert_eq!(error.status(), brz_http_server::StatusCode::CONFLICT);
        let detail: Value = serde_json::from_str(&error.validation_detail()).unwrap();
        assert_eq!(
            detail,
            json!({
                "code": "lease_invalid",
                "message": "Wework transcript write lease is missing, expired, or stale",
            })
        );
    }

    #[test]
    fn lease_release_statements_match_the_recorded_shapes() {
        assert!(TRANSCRIPT_BY_ID_FOR_UPDATE_QUERY.trim().ends_with(
            "WHERE wework_transcripts.user_id = ? \
                    AND wework_transcripts.transcript_id = ? \
                    LIMIT 1 FOR UPDATE"
        ));
        assert_eq!(
            UPDATE_LEASE_RELEASED_QUERY,
            "UPDATE wework_transcripts SET writer_lease_expires_at=?, updated_at=? \
             WHERE wework_transcripts.id = ?"
        );
        assert!(
            TRANSCRIPT_REFRESH_QUERY
                .trim()
                .ends_with("FROM wework_transcripts WHERE wework_transcripts.id = ?")
        );
        assert_eq!(EPOCH_TIME_SQL, "1970-01-01 00:00:00");
    }

    /// The business UPDATE and its COMMIT run on the single connection a
    /// scoped transaction pins (the source SQLAlchemy session's shape): no
    /// bare pool-level `execute("COMMIT")` remains, the post-commit session
    /// close rolls back, and the `db.refresh` re-read follows.
    #[test]
    fn update_and_commit_share_one_transaction_connection() {
        let source = include_str!("wework_transcript_lease_release.rs");
        assert!(
            !source.contains("execute(\"COMMIT\", ()"),
            "the scoped transaction commits on return; no bare pool-level COMMIT call"
        );
        let scoped = source
            .find("with_transaction")
            .expect("scoped transaction around the update");
        let rollback = source[scoped..]
            .find("execute(\"ROLLBACK\"")
            .expect("session rollback after the scoped commit")
            + scoped;
        let refresh = source[scoped..]
            .find("TRANSCRIPT_REFRESH_QUERY")
            .expect("refresh after the rollback")
            + scoped;
        assert!(rollback < refresh, "refresh follows the session rollback");
    }

    #[test]
    fn lease_release_request_accepts_alias_and_field_names() {
        let camel = parse_lease_release(&json!({"clientId": "abc", "fencingToken": 7})).unwrap();
        assert_eq!(camel.client_id, "abc");
        assert_eq!(camel.fencing_token, 7);

        let snake = parse_lease_release(&json!({"client_id": "abc", "fencing_token": 7})).unwrap();
        assert_eq!(snake.client_id, "abc");
        assert_eq!(snake.fencing_token, 7);
    }

    fn body_validation_error(body: Value) -> Value {
        let error = parse_lease_release(&body).unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
        serde_json::from_str(&error.validation_detail()).unwrap()
    }

    #[test]
    fn lease_release_request_rejects_missing_fields() {
        let error = body_validation_error(json!({"fencingToken": 1}));
        assert_eq!(error[0]["type"], json!("missing"));
        assert_eq!(error[0]["loc"], json!(["body", "clientId"]));

        let error = body_validation_error(json!({"clientId": "abc"}));
        assert_eq!(error[0]["type"], json!("missing"));
        assert_eq!(error[0]["loc"], json!(["body", "fencingToken"]));
    }

    #[test]
    fn lease_release_request_validates_field_constraints() {
        let error = body_validation_error(json!({"clientId": 5, "fencingToken": 1}));
        assert_eq!(error[0]["type"], json!("string_type"));

        let error = body_validation_error(json!({"clientId": "", "fencingToken": 1}));
        assert_eq!(error[0]["type"], json!("string_too_short"));

        let long = "a".repeat(101);
        let error = body_validation_error(json!({"clientId": long, "fencingToken": 1}));
        assert_eq!(error[0]["type"], json!("string_too_long"));

        let error = body_validation_error(json!({"clientId": "abc", "fencingToken": 0}));
        assert_eq!(error[0]["type"], json!("greater_than_equal"));
        assert_eq!(error[0]["ctx"], json!({"ge": 1}));

        let error = body_validation_error(json!({"clientId": "abc", "fencingToken": "x"}));
        assert_eq!(error[0]["type"], json!("int_parsing"));
    }

    #[test]
    fn lease_release_request_rejects_a_non_object_body() {
        let error = body_validation_error(json!("nope"));
        assert_eq!(error[0]["type"], json!("model_attributes_type"));
        assert_eq!(error[0]["loc"], json!(["body"]));
    }

    #[test]
    fn utcnow_is_a_naive_current_timestamp() {
        assert!(utcnow().and_utc().timestamp() > 0);
    }
}
