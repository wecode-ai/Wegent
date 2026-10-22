// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the submitter plugin-publication list.

use chrono::NaiveDateTime;

use brz_json::OpaqueJson;
use brz_mysql::Json;

use super::query::{ListParams, ListQuery};
use super::*;
use crate::plugin_publications::sql;

/// The recorded `plugin_publication_requests` projection, copied literally so
/// an accidental change to the production constants fails these tests.
const RECORDED_REQUEST_COLUMNS: &str = "plugin_publication_requests.id AS plugin_publication_requests_id, plugin_publication_requests.source_plugin_id AS plugin_publication_requests_source_plugin_id, plugin_publication_requests.target_plugin_id AS plugin_publication_requests_target_plugin_id, plugin_publication_requests.submitter_user_id AS plugin_publication_requests_submitter_user_id, plugin_publication_requests.current_revision_id AS plugin_publication_requests_current_revision_id, plugin_publication_requests.current_revision AS plugin_publication_requests_current_revision, plugin_publication_requests.aggregate_status AS plugin_publication_requests_aggregate_status, plugin_publication_requests.risk_level AS plugin_publication_requests_risk_level, plugin_publication_requests.submitted_at AS plugin_publication_requests_submitted_at, plugin_publication_requests.created_at AS plugin_publication_requests_created_at, plugin_publication_requests.updated_at AS plugin_publication_requests_updated_at";

fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The recorded request: `GET /api/plugins/publication-requests?page=1&limit=100`
/// scoped to the authenticated submitter.
fn recorded_params() -> ListParams {
    ListParams {
        page: 1,
        limit: 100,
        source_plugin_id: None,
        active_only: false,
        submitted_after: None,
        submitted_before: None,
    }
}

/// The recorded `count(*)` exchange (`f1f2a8b4`, query_sequence 4006).
#[test]
fn recorded_count_renders_the_captured_statement() {
    let (statement, args) = sql::count_sql(&user_conditions_test(60, &recorded_params()));
    let expected = format!(
        "SELECT count(*) AS count_1 FROM (SELECT {RECORDED_REQUEST_COLUMNS} \
         FROM plugin_publication_requests \
         WHERE plugin_publication_requests.submitter_user_id = 60) AS anon_1"
    );
    assert_eq!(normalize(&statement), normalize(&expected));
    assert!(args.is_empty());
}

/// The recorded ordered page exchange (query_sequence 4007). The rendered
/// statement keeps the driver's inline `LIMIT 0, 100` values, matching the
/// captured COM_QUERY exactly.
#[test]
fn recorded_select_renders_the_captured_statement() {
    let (statement, args) = sql::select_sql(&user_conditions_test(60, &recorded_params()), 1, 100);
    let expected = format!(
        "SELECT {RECORDED_REQUEST_COLUMNS} FROM plugin_publication_requests \
         WHERE plugin_publication_requests.submitter_user_id = 60 \
         ORDER BY CASE WHEN (plugin_publication_requests.aggregate_status IN ('published', 'withdrawn', 'closed')) THEN 1 ELSE 0 END ASC, \
         CASE WHEN (plugin_publication_requests.aggregate_status IN ('published', 'withdrawn', 'closed')) THEN NULL ELSE CASE WHEN (plugin_publication_requests.submitted_at = '1970-01-01 00:00:00') THEN plugin_publication_requests.created_at ELSE plugin_publication_requests.submitted_at END END ASC, \
         CASE WHEN (plugin_publication_requests.aggregate_status IN ('published', 'withdrawn', 'closed')) THEN CASE WHEN (plugin_publication_requests.submitted_at = '1970-01-01 00:00:00') THEN plugin_publication_requests.created_at ELSE plugin_publication_requests.submitted_at END END DESC, \
         plugin_publication_requests.id ASC \
         LIMIT 0, 100"
    );
    let rendered = render_limit(statement, &args);
    assert_eq!(normalize(&rendered), normalize(&expected));
    assert_eq!(args.len(), 2);
    assert!(matches!(&args[0], sql::SqlArg::Int(0)));
    assert!(matches!(&args[1], sql::SqlArg::Int(100)));
}

/// Substitute the `LIMIT ?, ?` placeholders with the bound integer values,
/// mirroring the driver's inline rendering of the captured exchange.
fn render_limit(mut statement: String, args: &[sql::SqlArg]) -> String {
    for sql::SqlArg::Int(value) in args {
        statement = statement.replacen('?', &value.to_string(), 1);
    }
    assert!(!statement.contains('?'), "every placeholder is consumed");
    statement
}

/// The owner filter stays first and the route's own filters follow, matching
/// the source `rows_query` chain order.
#[test]
fn user_conditions_chain_in_the_source_order() {
    let params = ListParams {
        page: 2,
        limit: 5,
        source_plugin_id: Some(24),
        active_only: true,
        submitted_after: Some(datetime("2026-10-01 00:00:00")),
        submitted_before: Some(datetime("2026-10-16 00:00:00")),
    };
    let conditions = user_conditions_test(7, &params);
    assert_eq!(
        conditions[0],
        "plugin_publication_requests.submitter_user_id = 7"
    );
    assert_eq!(
        conditions[1],
        "plugin_publication_requests.source_plugin_id = 24"
    );
    assert_eq!(
        conditions[2],
        "(plugin_publication_requests.aggregate_status NOT IN ('published', 'withdrawn', 'closed'))"
    );
    assert!(conditions[3].starts_with(
        "CASE WHEN (plugin_publication_requests.submitted_at = '1970-01-01 00:00:00')"
    ));
    assert!(conditions[3].ends_with(">= '2026-10-01 00:00:00'"));
    assert!(conditions[4].ends_with("<= '2026-10-16 00:00:00'"));
}

/// Expose the submitter `WHERE` chain for the statement tests.
fn user_conditions_test(user_id: i32, params: &ListParams) -> Vec<String> {
    crate::plugin_publications::sql::user_conditions(user_id, params)
}

fn datetime(value: &str) -> NaiveDateTime {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S"))
        .expect("valid datetime")
}

#[test]
fn list_query_applies_fastapi_defaults_and_bounds() {
    let params = ListQuery::default()
        .validated()
        .expect("defaults are valid");
    assert_eq!(params.page, 1);
    assert_eq!(params.limit, 20);
    assert_eq!(params.source_plugin_id, None);
    assert!(!params.active_only);

    for page in ["0", "-3", "abc"] {
        let query = ListQuery {
            page: Some(page.to_string()),
            ..ListQuery::default()
        };
        assert!(query.validated().is_err(), "page {page} must be rejected");
    }
    for limit in ["0", "101"] {
        let query = ListQuery {
            limit: Some(limit.to_string()),
            ..ListQuery::default()
        };
        assert!(query.validated().is_err(), "limit {limit} must be rejected");
    }
    let query = ListQuery {
        limit: Some("100".to_string()),
        ..ListQuery::default()
    };
    assert_eq!(query.validated().expect("100 is allowed").limit, 100);
}

#[test]
fn source_plugin_id_must_be_positive() {
    for raw in ["0", "-1", "abc"] {
        let query = ListQuery {
            source_plugin_id: Some(raw.to_string()),
            ..ListQuery::default()
        };
        let error = query
            .validated()
            .expect_err("sourcePluginId must be rejected");
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
    }
}

#[test]
fn active_only_parses_pydantic_booleans() {
    for (raw, expected) in [
        ("true", true),
        ("1", true),
        ("YES", true),
        ("false", false),
        ("0", false),
        ("Off", false),
    ] {
        let query = ListQuery {
            active_only: Some(raw.to_string()),
            ..ListQuery::default()
        };
        assert_eq!(query.validated().expect("boolean").active_only, expected);
    }
    let query = ListQuery {
        active_only: Some("maybe".to_string()),
        ..ListQuery::default()
    };
    let error = query.validated().expect_err("a non-boolean is rejected");
    assert_eq!(
        error.status(),
        brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[test]
fn list_query_rejects_an_inverted_submitted_window() {
    let query = ListQuery {
        submitted_after: Some("2026-10-02T00:00:00".to_string()),
        submitted_before: Some("2026-10-01T00:00:00".to_string()),
        ..ListQuery::default()
    };
    let error = query
        .validated()
        .expect_err("an inverted window is rejected");
    assert_eq!(
        error.status(),
        brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        error.detail_message(),
        Some("submittedAfter must be earlier than or equal to submittedBefore")
    );
}

#[test]
fn list_query_normalizes_aware_datetimes_to_utc() {
    let query = ListQuery {
        submitted_after: Some("2026-10-01T08:00:00+08:00".to_string()),
        ..ListQuery::default()
    };
    let params = query.validated().expect("aware datetimes are valid");
    assert_eq!(
        params.submitted_after,
        Some(datetime("2026-10-01 00:00:00"))
    );
}

/// The response of the recorded case: an empty page.
#[test]
fn empty_response_body_matches_the_recorded_case() {
    let response = ListResponse {
        items: Vec::new(),
        total: 0,
        page: 1,
        limit: 100,
    };
    let body = OpaqueJson::from_serializable(&response);
    assert_eq!(
        body.to_raw_value().get(),
        "{\"items\":[],\"total\":0,\"page\":1,\"limit\":100}"
    );
}

/// `unused import` guard for test-only fixtures kept for future row tests.
#[allow(dead_code)]
fn opaque_fixture() -> Json<OpaqueJson> {
    Json(OpaqueJson::from_serializable(EmptyObject {}))
}

#[derive(serde::Serialize)]
struct EmptyObject {}
