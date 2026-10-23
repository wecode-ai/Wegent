// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/wework-transcripts/{transcript_id}/lease` — acquire or renew a
//! cross-device Wework transcript write lease.
//!
//! Mirrors `app.api.endpoints.wework_transcripts.acquire_lease_endpoint` and
//! `app.services.wework_transcript_service.acquire_lease` (router prefix
//! `/wework-transcripts`, mounted under the app prefix `/api`):
//! authenticate the bearer token, validate the fork request, load the owned row
//! under `SELECT ... FOR UPDATE`, resolve an optional parent fork point,
//! create the transcript when it does not exist, enforce the fork-identity and
//! lease-holder rules, write only the columns SQLAlchemy marked dirty, commit,
//! and re-read the row with `db.refresh`. The response renders the refreshed
//! row as `TranscriptLeaseResponse` with `by_alias=True` (camelCase).
//!
//! SQLAlchemy holds the row lock from `get_transcript(for_update=True)` until
//! `db.commit()` and rolls the session back when the endpoint raises. The
//! target keeps those statements on one writer transaction for the same
//! reason: the lock must span the flush, and `brz-mysql` rejects a pool-level
//! `FOR UPDATE` read. The `db.refresh` re-read follows the commit on the shared
//! pool, exactly where the source issues it.

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, MysqlRouteValue, MysqlTransaction, MysqlValue, MysqlValueWriter};
use chrono::{NaiveDateTime, Utc};
#[cfg(test)]
use serde_json::Value;
use serde_json::json;

use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::wework_transcript_lease_transaction::{self as transaction, Completion};
use crate::wework_transcripts::{
    EPOCH_TIME, TRANSCRIPT_BY_ID_QUERY, TranscriptRow, format_datetime, transcript_error,
    transcript_not_found,
};

/// `TranscriptLeaseRequest.ttl_seconds` default (`Field(default=60, ...)`).
const DEFAULT_TTL_SECONDS: i64 = 60;
/// `TranscriptLeaseRequest.ttl_seconds` bounds (`ge=15, le=300`).
const MIN_TTL_SECONDS: i64 = 15;
const MAX_TTL_SECONDS: i64 = 300;
/// `TranscriptLeaseRequest.client_id` bounds (`min_length=1, max_length=100`)
/// and the `parent_transcript_id` bounds.
const MAX_CLIENT_ID_CHARS: usize = 100;
const MAX_PARENT_ID_CHARS: usize = 100;
/// `TranscriptLeaseRequest.title` bound (`max_length=512`).
const MAX_TITLE_CHARS: usize = 512;

/// `db.refresh(transcript)` — the ORM re-selects the row by primary key with
/// unaliased columns after the committed update. Recorded immediately after
/// `COMMIT` in the lease exchange.
pub(crate) const REFRESH_TRANSCRIPT_QUERY: &str = "SELECT wework_transcripts.id, wework_transcripts.user_id, \
     wework_transcripts.transcript_id, wework_transcripts.parent_transcript_id, \
     wework_transcripts.forked_at_sequence, wework_transcripts.title, \
     wework_transcripts.state, wework_transcripts.current_sequence, \
     wework_transcripts.archived_through_sequence, wework_transcripts.writer_client_id, \
     wework_transcripts.writer_fencing_token, wework_transcripts.writer_lease_expires_at, \
     wework_transcripts.archived_at, wework_transcripts.created_at, \
     wework_transcripts.updated_at \nFROM wework_transcripts \nWHERE wework_transcripts.id = ?";

/// `db.add(transcript); db.flush()` for a transcript that does not exist yet.
/// SQLAlchemy renders every column that has a Python-side default, so the row
/// is inserted with the model's `state`/sequence/writer defaults inline and
/// the request-supplied identity columns plus the two audit timestamps bound.
const INSERT_TRANSCRIPT_QUERY: &str = "INSERT INTO wework_transcripts \
     (user_id, transcript_id, parent_transcript_id, forked_at_sequence, title, state, \
     current_sequence, archived_through_sequence, writer_client_id, writer_fencing_token, \
     writer_lease_expires_at, archived_at, created_at, updated_at) \
     VALUES (?, ?, ?, ?, ?, 'active', 0, 0, '', 0, '1970-01-01 00:00:00.000000', \
     '1970-01-01 00:00:00.000000', ?, ?)";

/// `TranscriptLeaseRequest` (`app.schemas.wework_transcript`), camelCase wire
/// names with the source defaults. `populate_by_name=True` only adds the
/// snake_case aliases, which the recording never sends.
#[derive(Debug, Clone, PartialEq)]
struct LeaseRequest {
    client_id: String,
    ttl_seconds: i64,
    title: Option<String>,
    parent_transcript_id: Option<String>,
    forked_at_sequence: Option<i64>,
}

/// `TranscriptLeaseResponse` (`app.schemas.wework_transcript`), rendered with
/// the source field order so the serialized bytes match the recording.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptLeaseResponse {
    transcript_id: String,
    client_id: String,
    fencing_token: i64,
    expires_at: String,
    current_sequence: i64,
}

/// The refreshed `wework_transcripts` row, decoded from
/// [`REFRESH_TRANSCRIPT_QUERY`]'s unaliased projection. Only the fields the
/// lease response renders are read.
#[derive(Debug, FromMysqlRow)]
struct RefreshedRow {
    #[mysql(rename = "transcript_id")]
    transcript_id: String,
    #[mysql(rename = "writer_client_id")]
    writer_client_id: String,
    #[mysql(rename = "writer_fencing_token")]
    writer_fencing_token: i64,
    #[mysql(rename = "writer_lease_expires_at")]
    writer_lease_expires_at: NaiveDateTime,
    #[mysql(rename = "current_sequence")]
    current_sequence: i64,
}

/// One SQL bind value whose concrete type varies with the dirty-column set:
/// the fencing token is an integer column while the two audit columns bind as
/// `'%Y-%m-%d %H:%M:%S.%f'` strings, exactly like every other migrated write.
#[derive(Debug, PartialEq)]
enum LeaseBind {
    Int(i64),
    Text(String),
}

impl MysqlValue for LeaseBind {
    fn write(self, writer: &mut MysqlValueWriter) -> brz_mysql::MysqlResult<()> {
        match self {
            LeaseBind::Int(value) => writer.push(value),
            LeaseBind::Text(value) => writer.push(value),
        }
    }

    fn route_value(&self) -> MysqlRouteValue<'_> {
        match self {
            LeaseBind::Int(value) => MysqlRouteValue::I64(*value),
            LeaseBind::Text(value) => MysqlRouteValue::String(value.as_str()),
        }
    }
}

/// The loaded transcript state the lease rules branch on.
#[derive(Debug, Clone)]
struct StoredLease {
    row_id: i64,
    parent_transcript_id: String,
    forked_at_sequence: i64,
    title: String,
    writer_client_id: String,
    writer_fencing_token: i64,
    writer_lease_expires_at: NaiveDateTime,
}

/// The write SQLAlchemy would flush for this acquire: the dirty column list in
/// mapper order plus the corresponding bind values and the row id.
#[derive(Debug, PartialEq)]
struct UpdatePlan {
    set_clause: String,
    binds: Vec<LeaseBind>,
    row_id: i64,
}

/// `WeworkTranscriptError` raised by `acquire_lease` before `db.commit()`.
#[derive(Debug, PartialEq)]
enum LeaseError {
    InvalidFork,
    ForkIdentityConflict,
    LeaseHeld,
}

impl LeaseError {
    fn into_http(self) -> FastApiError {
        match self {
            LeaseError::InvalidFork => transcript_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_fork",
                "Wework transcript parent and fork point must be provided together",
            ),
            LeaseError::ForkIdentityConflict => transcript_error(
                StatusCode::CONFLICT,
                "fork_identity_conflict",
                "Wework transcript already exists with a different parent",
            ),
            LeaseError::LeaseHeld => transcript_error(
                StatusCode::CONFLICT,
                "lease_held",
                "Wework transcript is being edited on another device",
            ),
        }
    }
}

/// POST /api/wework-transcripts/{transcript_id}/lease: the lease free
/// function, injecting the process-lifetime application state.
#[brz_http_server::post("/api/wework-transcripts/:transcript_id/lease")]
async fn acquire_lease(
    #[inject(state)] state: &AppState,
    transcript_id: &str,
    #[auth] user: crate::auth::TransactionSessionUser,
    body: serde_json::Value,
) -> Result<TranscriptLeaseResponse, FastApiError> {
    acquire_lease_impl(state, &user.user_name, transcript_id, &body).await
}

/// Handler body for `POST /api/wework-transcripts/{transcript_id}/lease`.
///
/// The source endpoint and `get_current_user` share one `Depends(get_db)`
/// session, so `get_current_user`'s user read opens the very transaction the
/// lease write commits: `SELECT users`, `SELECT ... FOR UPDATE`, `UPDATE`,
/// `COMMIT` all run on the request's connection. The session lookup therefore
/// runs inside this transaction, before the fork validation and the row lock.
async fn acquire_lease_impl(
    state: &AppState,
    user_name: &str,
    transcript_id: &str,
    body: &serde_json::Value,
) -> Result<TranscriptLeaseResponse, FastApiError> {
    let (user_id, request, first) = transaction::run(
        &state.mysql,
        async |transaction| {
            let user = crate::auth::session_user_in_transaction(transaction, user_name)
                .await
                .map_err(crate::auth::session_auth_error)?;
            // `_validate_fork_request`: a parent without a fork point (or the
            // reverse) is rejected after authentication and before the lock.
            let request = parse_lease_request(body)?;
            if request.parent_transcript_id.is_some() != request.forked_at_sequence.is_some() {
                return Err(LeaseError::InvalidFork.into_http());
            }

            let attempt =
                acquire_lease_on(transaction, user.id, transcript_id, &request, None).await?;
            Ok(match attempt {
                LeaseAttempt::Granted(_) => Completion::Commit((user.id, request, attempt)),
                LeaseAttempt::ConcurrentCreation(_) => {
                    Completion::Rollback((user.id, request, attempt))
                }
            })
        },
        FastApiError::unhandled,
    )
    .await?;

    let row_id = match first {
        LeaseAttempt::Granted(row_id) => row_id,
        // `except IntegrityError: db.rollback()`: the aborted transaction is
        // gone, so the concurrently created row is locked again in a new one.
        LeaseAttempt::ConcurrentCreation(context) => {
            transaction::run(
                &state.mysql,
                async |transaction| {
                    let attempt = acquire_lease_on(
                        transaction,
                        user_id,
                        transcript_id,
                        &request,
                        Some(context),
                    )
                    .await?;
                    match attempt {
                        LeaseAttempt::Granted(row_id) => Ok(Completion::Commit(row_id)),
                        // `query.one()` raises `NoResultFound` when the row is
                        // removed again before the re-lock.
                        LeaseAttempt::ConcurrentCreation(_) => Err(FastApiError::unhandled()),
                    }
                },
                FastApiError::unhandled,
            )
            .await?
        }
    };

    // `db.refresh(transcript)`: after the commit SQLAlchemy re-selects the
    // committed row by primary key in a new implicit read transaction.
    let refreshed: Option<RefreshedRow> = state
        .mysql
        .fetch_optional(REFRESH_TRANSCRIPT_QUERY, (row_id,))
        .await
        .map_err(|error| {
            tracing::error!(%error, "wework_transcripts database dependency failure");
            FastApiError::unhandled()
        })?;
    let Some(refreshed) = refreshed else {
        return Err(FastApiError::unhandled());
    };

    Ok(TranscriptLeaseResponse {
        transcript_id: refreshed.transcript_id,
        client_id: refreshed.writer_client_id,
        fencing_token: refreshed.writer_fencing_token,
        expires_at: format_datetime(&refreshed.writer_lease_expires_at),
        current_sequence: refreshed.current_sequence,
    })
}

/// One locked attempt at acquiring the lease: everything `acquire_lease` runs
/// between `get_transcript(..., for_update=True)` and `db.commit()`.
enum LeaseAttempt {
    /// The flush is written and the transaction commits the row id.
    Granted(i64),
    /// The INSERT hit the transcript uniqueness constraint; the source rolls
    /// back and re-locks the concurrently created row with `context`.
    ConcurrentCreation(LeaseContext),
}

/// The values `acquire_lease` computes once, before it can lose the creation
/// race, and reuses for the retried attempt.
struct LeaseContext {
    now: NaiveDateTime,
    parent_transcript_id: String,
    forked_at_sequence: i64,
}

async fn acquire_lease_on<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i32,
    transcript_id: &str,
    request: &LeaseRequest,
    context: Option<LeaseContext>,
) -> Result<LeaseAttempt, FastApiError> {
    let lock_query = format!("{TRANSCRIPT_BY_ID_QUERY} FOR UPDATE");
    let stored: Option<TranscriptRow> = transaction
        .fetch_optional(lock_query.as_str(), (user_id, transcript_id))
        .await
        .map_err(|error| {
            tracing::error!(%error, "wework_transcripts database dependency failure");
            FastApiError::unhandled()
        })?;

    let allow_create = context.is_none();
    let context = match context {
        Some(context) => context,
        None => {
            // `now = utcnow()` — computed after the lock read and before the
            // parent read, and reused for the lease expiry and both audit
            // columns.
            let now = Utc::now().naive_utc();

            let parent_transcript_id = request.parent_transcript_id.clone().unwrap_or_default();
            let mut forked_at_sequence = request.forked_at_sequence.unwrap_or(0);
            if let Some(parent_id) = request.parent_transcript_id.as_deref() {
                let parent: Option<TranscriptRow> = transaction
                    .fetch_optional(lock_query.as_str(), (user_id, parent_id))
                    .await
                    .map_err(|error| {
                        tracing::error!(%error, "wework_transcripts database dependency failure");
                        FastApiError::unhandled()
                    })?;
                let Some(parent) = parent else {
                    // `get_transcript` raises `transcript_not_found`; the
                    // request-scoped session rolls the locked transaction back.
                    return Err(transcript_not_found());
                };
                forked_at_sequence = forked_at_sequence.min(parent.current_sequence);
            }

            LeaseContext {
                now,
                parent_transcript_id,
                forked_at_sequence,
            }
        }
    };
    let LeaseContext {
        now,
        parent_transcript_id,
        forked_at_sequence,
    } = context;

    let stored = match stored {
        Some(row) => StoredLease {
            row_id: row.id,
            parent_transcript_id: row.parent_transcript_id.clone(),
            forked_at_sequence: row.forked_at_sequence,
            title: row.title.clone(),
            writer_client_id: row.writer_client_id.clone(),
            writer_fencing_token: row.writer_fencing_token,
            writer_lease_expires_at: row.writer_lease_expires_at,
        },
        None if !allow_create => return Err(FastApiError::unhandled()),
        None => {
            let created_at = Utc::now().naive_utc();
            let updated_at = Utc::now().naive_utc();
            let title = request.title.clone().unwrap_or_default();
            let inserted = match transaction
                .execute(
                    INSERT_TRANSCRIPT_QUERY,
                    (
                        user_id,
                        transcript_id,
                        parent_transcript_id.clone(),
                        forked_at_sequence,
                        title.clone(),
                        sql_datetime(created_at),
                        sql_datetime(updated_at),
                    ),
                )
                .await
            {
                Ok(execution) => execution,
                // `except IntegrityError: db.rollback()` — another request
                // created the transcript first.
                Err(error) if error.is_duplicate_key() => {
                    return Ok(LeaseAttempt::ConcurrentCreation(LeaseContext {
                        now,
                        parent_transcript_id,
                        forked_at_sequence,
                    }));
                }
                Err(error) => {
                    tracing::error!(%error, "wework_transcripts database dependency failure");
                    return Err(FastApiError::unhandled());
                }
            };
            StoredLease {
                row_id: i64::try_from(inserted.last_insert_id).unwrap_or(0),
                parent_transcript_id: parent_transcript_id.clone(),
                forked_at_sequence,
                title,
                writer_client_id: String::new(),
                writer_fencing_token: 0,
                writer_lease_expires_at: EPOCH_TIME,
            }
        }
    };

    let plan = apply_lease_rules(
        &stored,
        request,
        &parent_transcript_id,
        forked_at_sequence,
        now,
    )
    .map_err(LeaseError::into_http)?;

    let update_query = format!(
        "UPDATE wework_transcripts SET {} WHERE wework_transcripts.id = ?",
        plan.set_clause
    );
    let mut binds = plan.binds;
    binds.push(LeaseBind::Int(plan.row_id));
    transaction
        .execute(update_query.as_str(), binds)
        .await
        .map_err(|error| {
            tracing::error!(%error, "wework_transcripts database dependency failure");
            FastApiError::unhandled()
        })?;
    Ok(LeaseAttempt::Granted(plan.row_id))
}

/// `acquire_lease`'s in-memory branch after the row is loaded or created:
/// the fork-identity check, the lease-holder check, and the exact dirty-column
/// set SQLAlchemy would flush. Mirrors
/// `app.services.wework_transcript_service.acquire_lease`.
fn apply_lease_rules(
    stored: &StoredLease,
    request: &LeaseRequest,
    parent_transcript_id: &str,
    forked_at_sequence: i64,
    now: NaiveDateTime,
) -> Result<UpdatePlan, LeaseError> {
    if stored.parent_transcript_id != parent_transcript_id
        || stored.forked_at_sequence != forked_at_sequence
    {
        return Err(LeaseError::ForkIdentityConflict);
    }

    let lease_active = stored.writer_lease_expires_at > now;
    if lease_active && stored.writer_client_id != request.client_id {
        return Err(LeaseError::LeaseHeld);
    }

    let expiry = now + chrono::Duration::seconds(request.ttl_seconds);
    let mut columns: Vec<&str> = Vec::with_capacity(5);
    let mut binds: Vec<LeaseBind> = Vec::with_capacity(5);
    // SQLAlchemy emits the dirty attributes in mapper (declaration) order.
    if let Some(title) = request.title.as_ref()
        && title != &stored.title
    {
        columns.push("title=?");
        binds.push(LeaseBind::Text(title.clone()));
    }
    if stored.writer_client_id != request.client_id {
        columns.push("writer_client_id=?");
        binds.push(LeaseBind::Text(request.client_id.clone()));
    }
    if stored.writer_client_id != request.client_id || !lease_active {
        columns.push("writer_fencing_token=?");
        binds.push(LeaseBind::Int(stored.writer_fencing_token + 1));
    }
    columns.push("writer_lease_expires_at=?");
    binds.push(LeaseBind::Text(sql_datetime(expiry)));
    columns.push("updated_at=?");
    binds.push(LeaseBind::Text(sql_datetime(now)));

    Ok(UpdatePlan {
        set_clause: columns.join(", "),
        binds,
        row_id: stored.row_id,
    })
}

/// `WEWORK_TRANSCRIPT` naive-UTC binding, matching the source
/// `utcnow()` value and the `DATETIME(6)` columns.
fn sql_datetime(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%d %H:%M:%S%.6f").to_string()
}

/// FastAPI validates the JSON body against `TranscriptLeaseRequest` before the
/// endpoint body runs; failures render the pydantic v2 error array with 422.
fn parse_lease_request(body: &serde_json::Value) -> Result<LeaseRequest, FastApiError> {
    let Some(object) = body.as_object() else {
        return Err(FastApiError::validation(json!([
            {
                "type": "model_attributes_type",
                "loc": ["body"],
                "msg": "Input should be a valid dictionary or object to extract fields from",
                "input": body,
            }
        ])));
    };

    let client_id = required_string(object, "clientId", body, 1, MAX_CLIENT_ID_CHARS)?;
    // `ttl_seconds: int = Field(default=60, ...)` is not optional, so a present
    // `null` is a type error while an absent field takes the default.
    let ttl_seconds = match object.get("ttlSeconds") {
        None => DEFAULT_TTL_SECONDS,
        Some(serde_json::Value::Null) => {
            return Err(int_type_error("ttlSeconds", &serde_json::Value::Null));
        }
        Some(value) => value
            .as_i64()
            .ok_or_else(|| int_type_error("ttlSeconds", value))?,
    };
    if ttl_seconds < MIN_TTL_SECONDS {
        return Err(field_error(
            "greater_than_equal",
            "ttlSeconds",
            format!("Input should be greater than or equal to {MIN_TTL_SECONDS}"),
            object.get("ttlSeconds").unwrap_or(&serde_json::Value::Null),
        ));
    }
    if ttl_seconds > MAX_TTL_SECONDS {
        return Err(field_error(
            "less_than_equal",
            "ttlSeconds",
            format!("Input should be less than or equal to {MAX_TTL_SECONDS}"),
            object.get("ttlSeconds").unwrap_or(&serde_json::Value::Null),
        ));
    }
    let title = optional_string(object, "title", 0, MAX_TITLE_CHARS)?;
    let parent_transcript_id =
        optional_string(object, "parentTranscriptId", 1, MAX_PARENT_ID_CHARS)?;
    // `forked_at_sequence: int | None = Field(default=None, ge=0)` accepts an
    // explicit `null` as absent.
    let forked_at_sequence = match object.get("forkedAtSequence") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => {
            let parsed = value
                .as_i64()
                .ok_or_else(|| int_type_error("forkedAtSequence", value))?;
            if parsed < 0 {
                return Err(field_error(
                    "greater_than_equal",
                    "forkedAtSequence",
                    "Input should be greater than or equal to 0".to_string(),
                    value,
                ));
            }
            Some(parsed)
        }
    };

    Ok(LeaseRequest {
        client_id,
        ttl_seconds,
        title,
        parent_transcript_id,
        forked_at_sequence,
    })
}

/// A required camelCase string field with `min_length`/`max_length` bounds.
fn required_string(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    body: &serde_json::Value,
    min: usize,
    max: usize,
) -> Result<String, FastApiError> {
    let Some(value) = object.get(field) else {
        return Err(field_error(
            "missing",
            field,
            "Field required".to_string(),
            body,
        ));
    };
    let Some(text) = value.as_str() else {
        return Err(field_error(
            "string_type",
            field,
            "Input should be a valid string".to_string(),
            value,
        ));
    };
    string_bounds(field, text, min, max)
}

/// An optional camelCase string field that accepts an explicit `null`.
fn optional_string(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    min: usize,
    max: usize,
) -> Result<Option<String>, FastApiError> {
    match object.get(field) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(value) => {
            let Some(text) = value.as_str() else {
                return Err(field_error(
                    "string_type",
                    field,
                    "Input should be a valid string".to_string(),
                    value,
                ));
            };
            string_bounds(field, text, min, max).map(Some)
        }
    }
}

fn string_bounds(field: &str, text: &str, min: usize, max: usize) -> Result<String, FastApiError> {
    let length = text.chars().count();
    if length < min {
        return Err(field_error(
            "string_too_short",
            field,
            format!("String should have at least {min} character{}", plural(min)),
            &json!(text),
        ));
    }
    if length > max {
        return Err(field_error(
            "string_too_long",
            field,
            format!("String should have at most {max} character{}", plural(max)),
            &json!(text),
        ));
    }
    Ok(text.to_string())
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

/// A camelCase field that is present but is not a valid integer.
fn int_type_error(field: &str, value: &serde_json::Value) -> FastApiError {
    field_error(
        "int_type",
        field,
        "Input should be a valid integer".to_string(),
        value,
    )
}

/// One pydantic v2 validation entry.
fn field_error(
    kind: &str,
    field: &str,
    message: String,
    input: &serde_json::Value,
) -> FastApiError {
    FastApiError::validation(json!([
        {"type": kind, "loc": ["body", field], "msg": message, "input": input}
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn datetime(
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        minute: u32,
        second: u32,
    ) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(year, month, day)
            .unwrap()
            .and_hms_opt(hour, minute, second)
            .unwrap()
    }

    fn request() -> LeaseRequest {
        LeaseRequest {
            client_id: "electron-716693d1-7392-4770-9212-bfc8bb04e2ea".to_string(),
            ttl_seconds: 300,
            title: Some("title".to_string()),
            parent_transcript_id: None,
            forked_at_sequence: None,
        }
    }

    fn stored() -> StoredLease {
        StoredLease {
            row_id: 307,
            parent_transcript_id: String::new(),
            forked_at_sequence: 0,
            title: "title".to_string(),
            writer_client_id: "electron-716693d1-7392-4770-9212-bfc8bb04e2ea".to_string(),
            writer_fencing_token: 13296,
            writer_lease_expires_at: EPOCH_TIME,
        }
    }

    fn now() -> NaiveDateTime {
        datetime(2026, 10, 10, 5, 58, 0)
    }

    #[test]
    fn expired_lease_increments_the_fencing_token_and_writes_three_columns() {
        let plan = apply_lease_rules(&stored(), &request(), "", 0, now()).unwrap();
        assert_eq!(
            plan.set_clause,
            "writer_fencing_token=?, writer_lease_expires_at=?, updated_at=?"
        );
        assert!(matches!(plan.binds[0], LeaseBind::Int(13297)));
        assert!(matches!(&plan.binds[1], LeaseBind::Text(v) if v == "2026-10-10 06:03:00.000000"));
        assert!(matches!(&plan.binds[2], LeaseBind::Text(v) if v == "2026-10-10 05:58:00.000000"));
        assert_eq!(plan.row_id, 307);
    }

    #[test]
    fn active_lease_for_the_same_client_writes_only_the_audit_columns() {
        let mut stored = stored();
        stored.writer_lease_expires_at = datetime(2026, 10, 10, 6, 11, 5);
        let plan = apply_lease_rules(&stored, &request(), "", 0, now()).unwrap();
        assert_eq!(plan.set_clause, "writer_lease_expires_at=?, updated_at=?");
        assert_eq!(plan.binds.len(), 2);
    }

    #[test]
    fn changed_client_and_title_are_written_in_mapper_order() {
        let mut stored = stored();
        stored.writer_client_id = "device-a".to_string();
        stored.title = "old".to_string();
        let mut request = request();
        request.title = Some("new".to_string());
        let plan = apply_lease_rules(&stored, &request, "", 0, now()).unwrap();
        assert_eq!(
            plan.set_clause,
            "title=?, writer_client_id=?, writer_fencing_token=?, \
             writer_lease_expires_at=?, updated_at=?"
        );
        assert!(matches!(&plan.binds[0], LeaseBind::Text(v) if v == "new"));
        assert!(matches!(&plan.binds[2], LeaseBind::Int(13297)));
    }

    #[test]
    fn active_lease_held_by_another_client_is_rejected() {
        let mut stored = stored();
        stored.writer_lease_expires_at = datetime(2026, 10, 10, 6, 11, 5);
        stored.writer_client_id = "device-a".to_string();
        assert_eq!(
            apply_lease_rules(&stored, &request(), "", 0, now()),
            Err(LeaseError::LeaseHeld)
        );
    }

    #[test]
    fn mismatched_fork_identity_is_rejected() {
        let mut stored = stored();
        stored.parent_transcript_id = "parent-a".to_string();
        stored.forked_at_sequence = 3;
        assert_eq!(
            apply_lease_rules(&stored, &request(), "", 0, now()),
            Err(LeaseError::ForkIdentityConflict)
        );
    }

    #[test]
    fn min_parent_sequence_limits_the_requested_fork_point() {
        let mut stored = stored();
        stored.parent_transcript_id = "parent-a".to_string();
        stored.forked_at_sequence = 4;
        let mut request = request();
        request.parent_transcript_id = Some("parent-a".to_string());
        request.forked_at_sequence = Some(10);
        let plan = apply_lease_rules(&stored, &request, "parent-a", 4, now()).unwrap();
        assert_eq!(
            plan.set_clause,
            "writer_fencing_token=?, \
             writer_lease_expires_at=?, updated_at=?"
        );
    }

    #[test]
    fn missing_client_id_renders_the_pydantic_422_body() {
        let error = parse_lease_request(&json!({"ttlSeconds": 300})).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let detail: Value = serde_json::from_str(&error.validation_detail()).unwrap();
        assert_eq!(detail[0]["type"], "missing");
        assert_eq!(detail[0]["loc"], json!(["body", "clientId"]));
        assert_eq!(detail[0]["msg"], "Field required");
    }

    #[test]
    fn valid_body_parses_with_the_source_defaults() {
        let parsed = parse_lease_request(&json!({"clientId": "device"})).unwrap();
        assert_eq!(parsed.client_id, "device");
        assert_eq!(parsed.ttl_seconds, DEFAULT_TTL_SECONDS);
        assert_eq!(parsed.title, None);
        assert_eq!(parsed.parent_transcript_id, None);
        assert_eq!(parsed.forked_at_sequence, None);
    }

    #[test]
    fn explicit_null_fork_fields_stay_absent() {
        let parsed = parse_lease_request(&json!({"clientId": "device", "title": null,
             "parentTranscriptId": null, "forkedAtSequence": null}))
        .unwrap();
        assert_eq!(parsed.title, None);
        assert_eq!(parsed.parent_transcript_id, None);
        assert_eq!(parsed.forked_at_sequence, None);
    }

    #[test]
    fn ttl_out_of_range_renders_a_422() {
        let error =
            parse_lease_request(&json!({"clientId": "device", "ttlSeconds": 10})).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let detail: Value = serde_json::from_str(&error.validation_detail()).unwrap();
        assert_eq!(detail[0]["type"], "greater_than_equal");
        assert_eq!(detail[0]["loc"], json!(["body", "ttlSeconds"]));
    }

    #[test]
    fn response_renders_camel_case_with_the_source_field_order() {
        let body = crate::json_contract_tests::serialized(TranscriptLeaseResponse {
            transcript_id: "runtime-255518794".to_string(),
            client_id: "electron".to_string(),
            fencing_token: 13297,
            expires_at: "2026-10-10T06:03:00.056044".to_string(),
            current_sequence: 0,
        })
        .unwrap();
        assert_eq!(body["transcriptId"], "runtime-255518794");
        assert_eq!(body["clientId"], "electron");
        assert_eq!(body["fencingToken"], 13297);
        assert_eq!(body["expiresAt"], "2026-10-10T06:03:00.056044");
        assert_eq!(body["currentSequence"], 0);
    }

    #[test]
    fn lock_query_appends_for_update_to_the_shared_lookup() {
        let lock_query = format!("{TRANSCRIPT_BY_ID_QUERY} FOR UPDATE");
        assert!(lock_query.ends_with("LIMIT 1 FOR UPDATE"));
    }

    /// The locked lookup, the insert, and the dirty flush run on one writer
    /// transaction: `brz-mysql` rejects a pool-level `FOR UPDATE` read, and the
    /// row lock has to span the flush. `db.refresh` follows the commit.
    #[test]
    fn locking_read_and_flush_run_on_the_writer_transaction() {
        let source = include_str!("wework_transcripts_lease.rs");
        assert!(
            !source.contains("execute(\"COMMIT\", ()"),
            "the scoped transaction commits on return; no bare pool-level COMMIT call"
        );
        let handler = source
            .split("async fn acquire_lease_impl")
            .nth(1)
            .unwrap()
            .split("enum LeaseAttempt")
            .next()
            .unwrap();
        assert!(handler.contains("transaction::run"));
        assert!(
            !handler.contains("FOR_UPDATE"),
            "a pool-level FOR UPDATE read is rejected before reaching MySQL"
        );
        assert!(handler.contains("REFRESH_TRANSCRIPT_QUERY"));
        // The source endpoint and `get_current_user` share one
        // `Depends(get_db)` session, so the user read is the transaction's
        // first statement, before the row lock.
        let session_read = handler
            .find("session_user_in_transaction")
            .expect("the source session user read belongs to the lease transaction");
        let lock = handler
            .find("acquire_lease_on")
            .expect("the locked attempt runs in the same transaction");
        assert!(
            session_read < lock,
            "the session user read must precede the business statements"
        );
        let worker = source
            .split("async fn acquire_lease_on")
            .nth(1)
            .unwrap()
            .split("fn apply_lease_rules")
            .next()
            .unwrap();
        assert!(worker.contains("TRANSCRIPT_BY_ID_QUERY} FOR UPDATE"));
        assert!(worker.contains("INSERT_TRANSCRIPT_QUERY"));
    }

    #[test]
    fn refresh_query_selects_the_unaliased_row_by_primary_key() {
        assert!(REFRESH_TRANSCRIPT_QUERY.starts_with("SELECT wework_transcripts.id,"));
        assert!(REFRESH_TRANSCRIPT_QUERY.ends_with("WHERE wework_transcripts.id = ?"));
    }

    #[test]
    fn insert_query_uses_the_model_defaults() {
        assert!(INSERT_TRANSCRIPT_QUERY.contains("'active', 0, 0, '', 0,"));
        assert!(INSERT_TRANSCRIPT_QUERY.ends_with(", ?, ?)"));
    }
}
