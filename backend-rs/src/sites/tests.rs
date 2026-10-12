// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the `GET /api/sites` migration: the FastAPI query
//! validation, the application-type projections, the page guards, and the
//! source error bodies.
use std::time::Duration;

use brz_http_server::StatusCode;
use serde_json::json;

use super::application_types::AppType;
use super::upstream::{SitesClient, SitesError};
use super::*;

fn query(
    app_type: Option<&str>,
    q: Option<&str>,
    offset: Option<&str>,
    limit: Option<&str>,
) -> ListSitesQuery {
    ListSitesQuery {
        app_type: app_type.map(str::to_owned),
        q: q.map(str::to_owned),
        offset: offset.map(str::to_owned),
        limit: limit.map(str::to_owned),
    }
}

#[test]
fn query_defaults_match_the_source_signature() {
    let params = query(None, None, None, None)
        .validated()
        .expect("defaults valid");
    assert_eq!(params.app_type, AppType::Web);
    assert_eq!(params.query, None);
    assert_eq!(params.offset, 0);
    assert_eq!(params.limit, 20);
}

#[test]
fn query_normalizes_aliases_and_strips_q() {
    let params = query(Some("mini_program"), Some("  report  "), None, None)
        .validated()
        .expect("alias valid");
    assert_eq!(params.app_type, AppType::MiniProgram);
    assert_eq!(params.query.as_deref(), Some("report"));

    let params = query(Some("site"), Some("   "), None, None)
        .validated()
        .expect("alias valid");
    assert_eq!(params.app_type, AppType::Web);
    assert_eq!(params.query, None);
}

#[test]
fn query_errors_follow_declaration_order() {
    let error = query(Some("unknown"), None, Some("-1"), Some("0"))
        .validated()
        .expect_err("rejected");
    assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let detail: serde_json::Value =
        serde_json::from_str(&error.validation_detail()).expect("detail is JSON");
    let entries = detail.as_array().expect("detail array");
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0]["type"], "literal_error");
    assert_eq!(entries[0]["loc"], json!(["query", "app_type"]));
    assert_eq!(
        entries[0]["msg"],
        "Input should be 'web', 'miniapp', 'site' or 'mini_program'"
    );
    assert_eq!(entries[1]["type"], "greater_than_equal");
    assert_eq!(entries[1]["loc"], json!(["query", "offset"]));
    assert_eq!(entries[1]["input"], json!(-1));
    assert_eq!(entries[2]["type"], "greater_than_equal");
    assert_eq!(entries[2]["loc"], json!(["query", "limit"]));
}

#[test]
fn query_rejects_non_integer_and_over_max_limit() {
    let error = query(None, None, Some("abc"), None)
        .validated()
        .expect_err("rejected");
    let detail: serde_json::Value =
        serde_json::from_str(&error.validation_detail()).expect("detail is JSON");
    assert_eq!(detail[0]["type"], "int_parsing");
    assert_eq!(detail[0]["input"], "abc");

    let error = query(None, None, None, Some("101"))
        .validated()
        .expect_err("rejected");
    let detail: serde_json::Value =
        serde_json::from_str(&error.validation_detail()).expect("detail is JSON");
    assert_eq!(detail[0]["type"], "less_than_equal");
    assert_eq!(
        detail[0]["msg"],
        "Input should be less than or equal to 100"
    );
}

#[test]
fn app_type_matches_accepts_contract_aliases() {
    let project = json!({"app_type": "mini_program"});
    assert!(AppType::MiniProgram.matches(&project));
    assert!(!AppType::Web.matches(&project));

    let project = json!({"project_type": "site"});
    assert!(AppType::Web.matches(&project));

    // A missing or non-string type normalizes to `web`.
    assert!(AppType::Web.matches(&json!({})));
    assert!(AppType::Web.matches(&json!({"app_type": 7})));
}

#[test]
fn parse_site_projects_a_web_project() {
    let project = json!({
        "id": "site-123",
        "title": "My Site",
        "url": "https://wegent.example.com/site-123",
        "network": "outer",
        "owner_username": "example-user",
        "access_role": "owner",
        "version_status": "ready",
        "created_at": "2026-10-07T07:33:28.456994Z",
        "snapshot": "https://cdn.example.com/shot.png",
        "slug": "my-site",
        "custom_domain_prefix": "my-site",
        "app_type": "web",
    });
    let item = AppType::Web.parse(&project).expect("parsed");
    let rendered = serde_json::to_value(&item).expect("serializes");
    assert_eq!(rendered["app_type"], "web");
    assert_eq!(rendered["siteid"], "site-123");
    assert_eq!(rendered["taskid"], "site-123");
    assert_eq!(rendered["slug"], "my-site");
    assert_eq!(rendered["network"], "outer");
    assert_eq!(rendered["publish_status"], "published");
    assert_eq!(
        rendered["internal_url"],
        "https://wegent.example.com/site-123"
    );
    assert_eq!(
        rendered["external_url"],
        "https://wegent.example.com/site-123"
    );
    assert_eq!(
        rendered["thumbnail_url"],
        "https://cdn.example.com/shot.png"
    );
    assert_eq!(rendered["created_at"], "2026-10-07T07:33:28.456994Z");
    assert_eq!(rendered["published_at"], serde_json::Value::Null);
}

#[test]
fn parse_site_requires_valid_membership_and_url() {
    let base = json!({
        "id": "site-123",
        "title": "My Site",
        "url": "https://wegent.example.com/site-123",
        "owner_username": "example-user",
        "access_role": "owner",
        "created_at": "2026-10-07T07:33:28Z",
        "app_type": "web",
    });
    assert!(AppType::Web.parse(&base).is_ok());

    let mut missing_role = base.clone();
    missing_role["access_role"] = json!("viewer");
    assert!(AppType::Web.parse(&missing_role).is_err());

    let mut missing_url = base.clone();
    missing_url["url"] = json!("");
    assert!(AppType::Web.parse(&missing_url).is_err());

    let mut bad_title = base.clone();
    bad_title["title"] = serde_json::Value::Null;
    assert!(AppType::Web.parse(&bad_title).is_err());
}

#[test]
fn parse_mini_program_derives_status_and_defaults() {
    let project = json!({
        "id": "mp-1",
        "title": "Mini",
        "owner_username": "example-user",
        "access_role": "collaborator",
        "network": "inner",
        "created_at": "2026-10-07T07:33:28",
        "app_type": "miniapp",
    });
    let item = AppType::MiniProgram.parse(&project).expect("parsed");
    let rendered = serde_json::to_value(&item).expect("serializes");
    assert_eq!(rendered["app_type"], "miniapp");
    assert_eq!(rendered["slug"], "mp-1");
    assert_eq!(rendered["status"], "experience");
    assert_eq!(rendered["experience_url"], serde_json::Value::Null);
    assert_eq!(rendered["version"], serde_json::Value::Null);
    assert_eq!(rendered["updated_at"], "2026-10-07T07:33:28");
}

#[test]
fn datetimes_render_like_pydantic() {
    for (input, expected) in [
        ("2026-10-07T07:33:28Z", "2026-10-07T07:33:28Z"),
        ("2026-10-07T07:33:28+08:00", "2026-10-07T07:33:28+08:00"),
        ("2026-10-07T07:33:28-05:30", "2026-10-07T07:33:28-05:30"),
        ("2026-10-07T07:33:28", "2026-10-07T07:33:28"),
        ("2026-10-07 07:33:28", "2026-10-07T07:33:28"),
        ("2026-10-07T07:33:28.456994Z", "2026-10-07T07:33:28.456994Z"),
    ] {
        assert_eq!(
            super::application_types::render_datetime(&json!(input)).as_deref(),
            Some(expected),
            "input {input}"
        );
    }
    let epoch = json!(1_791_358_408_i64);
    assert_eq!(
        super::application_types::render_datetime(&epoch).as_deref(),
        Some("2026-10-07T07:33:28Z")
    );
    assert!(super::application_types::render_datetime(&json!("not a date")).is_none());
}

#[test]
fn page_guards_match_the_source_isinstance_checks() {
    assert!(page_items(Some(&json!({"items": []}))).unwrap().is_empty());
    assert!(page_items(Some(&json!({"items": null}))).is_err());
    assert!(page_items(Some(&json!({"items": "x"}))).is_err());
    assert_eq!(
        page_items(Some(&json!({"items": [1, 2]}))).unwrap().len(),
        2
    );
    assert!(page_items(None).unwrap().is_empty());

    assert_eq!(
        next_cursor(Some(&json!({"next_cursor": null}))).unwrap(),
        None
    );
    assert_eq!(
        next_cursor(Some(&json!({"next_cursor": "5"}))).unwrap(),
        Some("5".to_owned())
    );
    assert!(next_cursor(Some(&json!({"next_cursor": 5}))).is_err());
    assert_eq!(next_cursor(None).unwrap(), None);
}

#[test]
fn project_query_matches_title_case_insensitively() {
    let project = json!({"title": "Weekly Report"});
    assert!(project_matches_query(&project, "report"));
    assert!(!project_matches_query(&project, "missing"));
    assert!(!project_matches_query(&json!({"title": 5}), "report"));
}

#[test]
fn sites_errors_render_the_source_bodies() {
    let error = SitesError::NotAvailable.into_fastapi_error();
    assert_eq!(error.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        error.validation_detail(),
        r#"{"code":"sites_not_available","message":"Sites is not available yet"}"#
    );

    let error = SitesError::UpstreamUnavailable.into_fastapi_error();
    assert_eq!(error.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(
        error.validation_detail(),
        r#"{"code":"sites_upstream_unavailable","message":"Sites service is unavailable"}"#
    );

    let error = SitesError::UpstreamResponse {
        status: 404,
        detail: json!({"detail": "missing"}),
    }
    .into_fastapi_error();
    assert_eq!(error.status(), StatusCode::NOT_FOUND);

    assert_eq!(
        SitesError::InvalidUrl.into_fastapi_error().status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
}

#[tokio::test]
async fn missing_base_url_short_circuits_before_any_request() {
    let client =
        SitesClient::with_settings("  ", "", Duration::from_secs(1)).expect("client builds");
    let error = client
        .get_json("/api/v1/projects/search", &[], "example-user")
        .await
        .expect_err("no base URL");
    assert!(matches!(error, SitesError::NotAvailable));
}
