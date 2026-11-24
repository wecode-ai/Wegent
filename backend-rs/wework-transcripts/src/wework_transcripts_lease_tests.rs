// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tests for the wework transcript lease request parsing and lease rules.
#![cfg(test)]

use super::*;

use chrono::NaiveDate;

fn datetime(year: i32, month: u32, day: u32, hour: u32, minute: u32, second: u32) -> NaiveDateTime {
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
    let error = parse_lease_request(&json!({"clientId": "device", "ttlSeconds": 10})).unwrap_err();
    assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let detail: Value = serde_json::from_str(&error.validation_detail()).unwrap();
    assert_eq!(detail[0]["type"], "greater_than_equal");
    assert_eq!(detail[0]["loc"], json!(["body", "ttlSeconds"]));
}

#[test]
fn response_renders_camel_case_with_the_source_field_order() {
    let body = wegent_backend_test_support::serialized(TranscriptLeaseResponse {
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

fn response_bytes(response: &Response) -> &[u8] {
    match response.body() {
        brz_http_server::ResponseBody::Owned(bytes) => bytes,
        other => panic!("unexpected response body: {other:?}"),
    }
}

fn lease_body() -> TranscriptLeaseResponse {
    TranscriptLeaseResponse {
        transcript_id: "runtime-645857292".to_string(),
        client_id: "b51d310d-0c53-4d7d-86c6-5d5b0e0f2ea1".to_string(),
        fencing_token: 13296,
        expires_at: "2026-11-11T05:03:18.000000".to_string(),
        current_sequence: 7,
    }
}

/// The recorded lease cases carry no `Origin` header, and the source
/// `CORSMiddleware` returns before installing its response wrapper, so the
/// source answer carries no `Vary: Origin`. Both the `200` body and the
/// `409` error must leave the gateway CORS boundary for such a request.
#[test]
fn headerless_lease_responses_skip_the_gateway_cors_boundary() {
    let granted = lease_response(Ok(lease_body()), None).unwrap();
    assert_eq!(
        granted.cors_policy(),
        brz_http_server::ResponseCors::Skip,
        "a headerless 200 must not add Vary: Origin"
    );
    let rejected = lease_response(
        Err(transcript_error(
            StatusCode::CONFLICT,
            "fork_identity_conflict",
            "Wework transcript already exists with a different parent",
        )),
        None,
    )
    .unwrap();
    assert_eq!(rejected.status(), StatusCode::CONFLICT);
    assert_eq!(
        rejected.cors_policy(),
        brz_http_server::ResponseCors::Skip,
        "a headerless 409 must not add Vary: Origin"
    );
}

/// A cross-origin request keeps the source's CORS permission set, so the
/// skip above must be keyed on the request's `Origin`, not on the method.
#[test]
fn cross_origin_lease_responses_keep_the_source_cors_policy() {
    for reply in [
        Ok(lease_body()),
        Err(transcript_error(
            StatusCode::CONFLICT,
            "fork_identity_conflict",
            "Wework transcript already exists with a different parent",
        )),
    ] {
        let response = lease_response(reply, Some("https://app.example.test")).unwrap();
        assert_eq!(response.cors_policy(), brz_http_server::ResponseCors::Apply);
    }
}

/// Moving the success body to `Response` must not change its bytes: the
/// recorded answers are the camelCase `TranscriptLeaseResponse` fields.
#[test]
fn rendered_lease_response_keeps_the_model_bytes() {
    let rendered = lease_response(Ok(lease_body()), None).unwrap();
    assert_eq!(rendered.status(), StatusCode::OK);
    assert_eq!(
        String::from_utf8_lossy(response_bytes(&rendered)).as_ref(),
        "{\"transcriptId\":\"runtime-645857292\",\"clientId\":\"b51d310d-0c53-4d7d-86c6-5d5b0e0f2ea1\",\"fencingToken\":13296,\"expiresAt\":\"2026-11-11T05:03:18.000000\",\"currentSequence\":7}"
    );
}
