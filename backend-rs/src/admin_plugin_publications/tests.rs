// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the admin plugin-publication list.

use chrono::NaiveDateTime;

use brz_mysql::Json;

use super::sql::SqlArg;
use super::*;
use crate::json_compat::OpaqueJson;

/// The recorded `plugin_publication_requests` projection, copied literally so
/// an accidental change to the production constants fails these tests.
const RECORDED_REQUEST_COLUMNS: &str = "plugin_publication_requests.id AS plugin_publication_requests_id, plugin_publication_requests.source_plugin_id AS plugin_publication_requests_source_plugin_id, plugin_publication_requests.target_plugin_id AS plugin_publication_requests_target_plugin_id, plugin_publication_requests.submitter_user_id AS plugin_publication_requests_submitter_user_id, plugin_publication_requests.current_revision_id AS plugin_publication_requests_current_revision_id, plugin_publication_requests.current_revision AS plugin_publication_requests_current_revision, plugin_publication_requests.aggregate_status AS plugin_publication_requests_aggregate_status, plugin_publication_requests.risk_level AS plugin_publication_requests_risk_level, plugin_publication_requests.submitted_at AS plugin_publication_requests_submitted_at, plugin_publication_requests.created_at AS plugin_publication_requests_created_at, plugin_publication_requests.updated_at AS plugin_publication_requests_updated_at";

const RECORDED_PLUGIN_COLUMNS: &str = "plugins.id AS plugins_id, plugins.catalog_namespace AS plugins_catalog_namespace, plugins.slug AS plugins_slug, plugins.name AS plugins_name, plugins.display_name AS plugins_display_name, plugins.summary AS plugins_summary, plugins.description_md AS plugins_description_md, plugins.listing_type AS plugins_listing_type, plugins.source_type AS plugins_source_type, plugins.source_provider AS plugins_source_provider, plugins.owner_user_id AS plugins_owner_user_id, plugins.origin_plugin_id AS plugins_origin_plugin_id, plugins.category AS plugins_category, plugins.keywords_json AS plugins_keywords_json, plugins.interface_json AS plugins_interface_json, plugins.visibility AS plugins_visibility, plugins.allow_copy AS plugins_allow_copy, plugins.status AS plugins_status, plugins.latest_release_id AS plugins_latest_release_id, plugins.featured_rank AS plugins_featured_rank, plugins.created_at AS plugins_created_at, plugins.updated_at AS plugins_updated_at, plugins.published_at AS plugins_published_at";

const RECORDED_REVISION_COLUMNS: &str = "plugin_publication_revisions.id AS plugin_publication_revisions_id, plugin_publication_revisions.request_id AS plugin_publication_revisions_request_id, plugin_publication_revisions.revision AS plugin_publication_revisions_revision, plugin_publication_revisions.source_release_id AS plugin_publication_revisions_source_release_id, plugin_publication_revisions.requested_version AS plugin_publication_revisions_requested_version, plugin_publication_revisions.snapshot_sha256 AS plugin_publication_revisions_snapshot_sha256, plugin_publication_revisions.source_tree_sha256 AS plugin_publication_revisions_source_tree_sha256, plugin_publication_revisions.storage_key AS plugin_publication_revisions_storage_key, plugin_publication_revisions.staging_storage_key AS plugin_publication_revisions_staging_storage_key, plugin_publication_revisions.filename AS plugin_publication_revisions_filename, plugin_publication_revisions.size_bytes AS plugin_publication_revisions_size_bytes, plugin_publication_revisions.manifest_snapshot AS plugin_publication_revisions_manifest_snapshot, plugin_publication_revisions.package_entries_json AS plugin_publication_revisions_package_entries_json, plugin_publication_revisions.package_entry_count AS plugin_publication_revisions_package_entry_count, plugin_publication_revisions.capabilities_json AS plugin_publication_revisions_capabilities_json, plugin_publication_revisions.risk_declaration AS plugin_publication_revisions_risk_declaration, plugin_publication_revisions.release_notes AS plugin_publication_revisions_release_notes, plugin_publication_revisions.test_notes AS plugin_publication_revisions_test_notes, plugin_publication_revisions.source_updated_at AS plugin_publication_revisions_source_updated_at, plugin_publication_revisions.status AS plugin_publication_revisions_status, plugin_publication_revisions.gitlab_project_id AS plugin_publication_revisions_gitlab_project_id, plugin_publication_revisions.gitlab_project_url AS plugin_publication_revisions_gitlab_project_url, plugin_publication_revisions.source_branch AS plugin_publication_revisions_source_branch, plugin_publication_revisions.merge_request_iid AS plugin_publication_revisions_merge_request_iid, plugin_publication_revisions.merge_request_url AS plugin_publication_revisions_merge_request_url, plugin_publication_revisions.merge_request_status AS plugin_publication_revisions_merge_request_status, plugin_publication_revisions.pipeline_id AS plugin_publication_revisions_pipeline_id, plugin_publication_revisions.pipeline_url AS plugin_publication_revisions_pipeline_url, plugin_publication_revisions.pipeline_status AS plugin_publication_revisions_pipeline_status, plugin_publication_revisions.commit_sha AS plugin_publication_revisions_commit_sha, plugin_publication_revisions.created_by_user_id AS plugin_publication_revisions_created_by_user_id, plugin_publication_revisions.completed_at AS plugin_publication_revisions_completed_at, plugin_publication_revisions.created_at AS plugin_publication_revisions_created_at, plugin_publication_revisions.updated_at AS plugin_publication_revisions_updated_at";

const RECORDED_CHECK_COLUMNS: &str = "plugin_publication_checks.id AS plugin_publication_checks_id, plugin_publication_checks.revision_id AS plugin_publication_checks_revision_id, plugin_publication_checks.stage AS plugin_publication_checks_stage, plugin_publication_checks.check_code AS plugin_publication_checks_check_code, plugin_publication_checks.title AS plugin_publication_checks_title, plugin_publication_checks.severity AS plugin_publication_checks_severity, plugin_publication_checks.status AS plugin_publication_checks_status, plugin_publication_checks.summary AS plugin_publication_checks_summary, plugin_publication_checks.evidence_json AS plugin_publication_checks_evidence_json, plugin_publication_checks.execution_environment AS plugin_publication_checks_execution_environment, plugin_publication_checks.job_url AS plugin_publication_checks_job_url, plugin_publication_checks.acknowledgement_required AS plugin_publication_checks_acknowledgement_required, plugin_publication_checks.acknowledged AS plugin_publication_checks_acknowledged, plugin_publication_checks.acknowledged_by_user_id AS plugin_publication_checks_acknowledged_by_user_id, plugin_publication_checks.created_at AS plugin_publication_checks_created_at, plugin_publication_checks.updated_at AS plugin_publication_checks_updated_at";

const RECORDED_USER_COLUMNS: &str = "users.id AS users_id, users.user_name AS users_user_name, users.password_hash AS users_password_hash, users.email AS users_email, users.git_info AS users_git_info, users.is_active AS users_is_active, users.`role` AS users_role, users.auth_source AS users_auth_source, users.preferences AS users_preferences, users.created_at AS users_created_at, users.updated_at AS users_updated_at";

/// The expected serialized body for the synthetic row fixtures below.
const EXPECTED_BODY: &str = "{\"items\":[{\"id\":1,\"pluginId\":24,\"pluginName\":\"示例插件\",\"pluginSlug\":\"example-plugin\",\"requestedVersion\":\"0.1.2\",\"submitter\":{\"id\":293,\"userName\":\"example-user\",\"email\":\"example-user@example.invalid\"},\"currentRevision\":2,\"stage\":\"administrator_review\",\"status\":\"awaiting_admin\",\"riskLevel\":\"high\",\"blockerCount\":0,\"warningCount\":4,\"gitlabStatus\":null,\"waitingDurationSeconds\":2323737,\"submittedAt\":\"2026-09-10T09:42:13.596829\",\"updatedAt\":\"2026-09-10T09:46:29.250420\"}],\"total\":1,\"page\":1,\"limit\":20}";

fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Substitute `?` with the rendered argument, mirroring the driver's inline
/// rendering of bound values.
fn render(sql: &str, args: &[SqlArg]) -> String {
    let mut rendered = String::new();
    let mut args = args.iter();
    for character in sql.chars() {
        if character != '?' {
            rendered.push(character);
            continue;
        }
        match args.next().expect("a placeholder has an argument") {
            SqlArg::Int(value) => rendered.push_str(&value.to_string()),
            SqlArg::Str(value) => {
                rendered.push('\'');
                rendered.push_str(value);
                rendered.push('\'');
            }
            SqlArg::DateTime(value) => {
                rendered.push('\'');
                rendered.push_str(&value.format("%Y-%m-%d %H:%M:%S%.6f").to_string());
                rendered.push('\'');
            }
        }
    }
    assert!(args.next().is_none(), "every argument is consumed");
    rendered
}

fn recorded_params() -> ListParams {
    ListParams {
        page: 1,
        limit: 20,
        status: Some("awaiting_admin".to_string()),
        risk_level: None,
        submitter: None,
        query: None,
        submitted_after: None,
        submitted_before: None,
    }
}

fn opaque() -> Json<OpaqueJson> {
    Json(OpaqueJson::from_serializable(EmptyObject {}))
}

/// A serializable empty JSON object for opaque column fixtures.
#[derive(serde::Serialize)]
struct EmptyObject {}

fn datetime(value: &str) -> NaiveDateTime {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S"))
        .expect("valid datetime")
}

fn request_row() -> RequestRow {
    RequestRow {
        id: 1,
        source_plugin_id: 24,
        target_plugin_id: 0,
        submitter_user_id: 293,
        current_revision_id: 2,
        current_revision: 2,
        aggregate_status: "awaiting_admin".to_string(),
        risk_level: "high".to_string(),
        submitted_at: datetime("2026-09-10 09:42:13.596829"),
        created_at: datetime("2026-09-10 09:42:13.596829"),
        updated_at: datetime("2026-09-10 09:46:29.250420"),
    }
}

fn plugin_row() -> PluginRow {
    PluginRow {
        id: 24,
        catalog_namespace: "enterprise".to_string(),
        slug: "example-plugin".to_string(),
        name: "example-plugin".to_string(),
        display_name: "示例插件".to_string(),
        summary: String::new(),
        description_md: String::new(),
        listing_type: "plugin".to_string(),
        source_type: "submission".to_string(),
        source_provider: "wework".to_string(),
        owner_user_id: 293,
        origin_plugin_id: 0,
        category: String::new(),
        keywords_json: opaque(),
        interface_json: opaque(),
        visibility: "public".to_string(),
        allow_copy: false,
        status: "published".to_string(),
        latest_release_id: 0,
        featured_rank: 0,
        created_at: datetime("2026-09-01 00:00:00"),
        updated_at: datetime("2026-09-10 09:42:13"),
        published_at: datetime("2026-09-10 09:42:13"),
    }
}

fn revision_row() -> RevisionRow {
    RevisionRow {
        id: 2,
        request_id: 1,
        revision: 2,
        source_release_id: 0,
        requested_version: "0.1.2".to_string(),
        snapshot_sha256: String::new(),
        source_tree_sha256: String::new(),
        storage_key: String::new(),
        staging_storage_key: String::new(),
        filename: "plugin.zip".to_string(),
        size_bytes: 0,
        manifest_snapshot: opaque(),
        package_entries_json: opaque(),
        package_entry_count: 0,
        capabilities_json: opaque(),
        risk_declaration: opaque(),
        release_notes: String::new(),
        test_notes: String::new(),
        source_updated_at: datetime("1970-01-01 00:00:00"),
        status: "awaiting_admin".to_string(),
        gitlab_project_id: String::new(),
        gitlab_project_url: String::new(),
        source_branch: String::new(),
        merge_request_iid: 0,
        merge_request_url: String::new(),
        merge_request_status: String::new(),
        pipeline_id: 0,
        pipeline_url: String::new(),
        pipeline_status: String::new(),
        commit_sha: String::new(),
        created_by_user_id: 0,
        completed_at: datetime("1970-01-01 00:00:00"),
        created_at: datetime("2026-09-10 09:42:13"),
        updated_at: datetime("2026-09-10 09:42:13"),
    }
}

fn user_row() -> UserRow {
    UserRow {
        id: 293,
        user_name: "example-user".to_string(),
        password_hash: String::new(),
        email: Some("example-user@example.invalid".to_string()),
        git_info: opaque(),
        is_active: true,
        role: "user".to_string(),
        auth_source: "oidc".to_string(),
        preferences: String::new(),
        created_at: datetime("2026-09-01 00:00:00"),
        updated_at: datetime("2026-09-10 09:42:13"),
    }
}

fn check_row(severity: &str, status: &str) -> CheckRow {
    CheckRow {
        id: 0,
        revision_id: 2,
        stage: "automatic".to_string(),
        check_code: String::new(),
        title: String::new(),
        severity: severity.to_string(),
        status: status.to_string(),
        summary: String::new(),
        evidence_json: opaque(),
        execution_environment: "backend".to_string(),
        job_url: String::new(),
        acknowledgement_required: false,
        acknowledged: false,
        acknowledged_by_user_id: 0,
        created_at: datetime("2026-09-10 09:42:13"),
        updated_at: datetime("2026-09-10 09:42:13"),
    }
}

/// The recorded checks: 10 rows, four of them warnings and none blockers.
fn recorded_checks() -> Vec<CheckRow> {
    let mut checks = Vec::new();
    for _ in 0..4 {
        checks.push(check_row("info", "warning"));
    }
    for _ in 0..6 {
        checks.push(check_row("info", "passed"));
    }
    checks
}

#[test]
fn summary_matches_the_expected_body() {
    let checks = recorded_checks();
    let summary = summary_from(
        &request_row(),
        Some(&plugin_row()),
        Some(&revision_row()),
        Some(&user_row()),
        &checks,
        datetime("2026-10-07 07:11:11"),
    );
    let response = ListResponse {
        items: vec![summary],
        total: 1,
        page: 1,
        limit: 20,
    };
    // `from_serializable` renders through the same compact serializer the HTTP
    // response layer uses, so the bytes are byte-comparable to the fixture.
    let body = OpaqueJson::from_serializable(&response);
    assert_eq!(body.to_raw_value().get(), EXPECTED_BODY);
}

#[test]
fn summary_defaults_absent_relations() {
    let summary = summary_from(
        &request_row(),
        None,
        None,
        None,
        &[],
        datetime("2026-09-10 09:42:14"),
    );
    let body = OpaqueJson::from_serializable(&summary);
    assert_eq!(
        body.to_raw_value().get(),
        "{\"id\":1,\"pluginId\":24,\"pluginName\":\"\",\"pluginSlug\":\"\",\"requestedVersion\":\"\",\"submitter\":{\"id\":293,\"userName\":\"\",\"email\":null},\"currentRevision\":2,\"stage\":\"administrator_review\",\"status\":\"awaiting_admin\",\"riskLevel\":\"high\",\"blockerCount\":0,\"warningCount\":0,\"gitlabStatus\":null,\"waitingDurationSeconds\":0,\"submittedAt\":\"2026-09-10T09:42:13.596829\",\"updatedAt\":\"2026-09-10T09:46:29.250420\"}"
    );
}

#[test]
fn stage_matches_the_source_buckets() {
    assert_eq!(stage("uploading"), "submit_request");
    assert_eq!(stage("submitted"), "submit_request");
    assert_eq!(stage("automatic_checking"), "automated_checks");
    assert_eq!(stage("automatic_check_failed"), "automated_checks");
    assert_eq!(stage("awaiting_admin"), "administrator_review");
    assert_eq!(stage("admin_review"), "administrator_review");
    assert_eq!(stage("changes_requested"), "administrator_review");
    assert_eq!(stage("admin_accepted"), "administrator_review");
    assert_eq!(stage("draft_mr_open"), "code_review");
    assert_eq!(stage("merged"), "code_review");
    assert_eq!(stage("published"), "release");
}

#[test]
fn gitlab_status_prefers_terminal_merge_request_states() {
    let mut revision = revision_row();
    assert_eq!(gitlab_status(&revision), None);
    revision.pipeline_status = "running".to_string();
    assert_eq!(gitlab_status(&revision).as_deref(), Some("running"));
    revision.merge_request_status = "opened".to_string();
    assert_eq!(gitlab_status(&revision).as_deref(), Some("running"));
    revision.pipeline_status = String::new();
    assert_eq!(gitlab_status(&revision).as_deref(), Some("opened"));
    revision.merge_request_status = "merged".to_string();
    assert_eq!(gitlab_status(&revision).as_deref(), Some("merged"));
    revision.pipeline_status = "failed".to_string();
    assert_eq!(gitlab_status(&revision).as_deref(), Some("merged"));
}

#[test]
fn iso_datetime_matches_pydantic_rendering() {
    assert_eq!(
        iso_datetime(datetime("2026-09-10 09:42:13.596829")),
        "2026-09-10T09:42:13.596829"
    );
    assert_eq!(
        iso_datetime(datetime("2026-09-10 09:46:29")),
        "2026-09-10T09:46:29"
    );
    assert_eq!(
        iso_datetime(datetime("2026-09-10 09:46:29.1")),
        "2026-09-10T09:46:29.100000"
    );
}

#[test]
fn waiting_duration_uses_updated_at_for_terminal_status() {
    let mut request = request_row();
    let submitted_at = datetime("2026-09-10 09:42:13.596829");
    let now = datetime("2026-10-07 07:11:11");
    assert_eq!(
        waiting_duration_seconds(&request, submitted_at, now),
        2323737
    );
    request.aggregate_status = "published".to_string();
    assert_eq!(waiting_duration_seconds(&request, submitted_at, now), 255);
    let future = datetime("2026-10-08 00:00:00");
    assert_eq!(waiting_duration_seconds(&request, future, now), 0);
}

#[test]
fn unset_datetime_matches_the_epoch_sentinel() {
    assert!(unset_datetime(datetime("1970-01-01 00:00:00")));
    assert!(!unset_datetime(datetime("1970-01-01 00:00:01")));
    assert!(!unset_datetime(datetime("2026-09-10 09:42:13")));
}

#[test]
fn recorded_select_renders_the_captured_statement() {
    let (statement, args) = sql::select_sql(&recorded_params(), &sql::Filters::default());
    let expected = format!(
        "SELECT {RECORDED_REQUEST_COLUMNS} FROM plugin_publication_requests WHERE plugin_publication_requests.aggregate_status = 'awaiting_admin' ORDER BY CASE WHEN (plugin_publication_requests.aggregate_status IN ('published', 'withdrawn', 'closed')) THEN 1 ELSE 0 END ASC, CASE WHEN (plugin_publication_requests.aggregate_status IN ('published', 'withdrawn', 'closed')) THEN NULL ELSE CASE WHEN (plugin_publication_requests.submitted_at = '1970-01-01 00:00:00') THEN plugin_publication_requests.created_at ELSE plugin_publication_requests.submitted_at END END ASC, CASE WHEN (plugin_publication_requests.aggregate_status IN ('published', 'withdrawn', 'closed')) THEN CASE WHEN (plugin_publication_requests.submitted_at = '1970-01-01 00:00:00') THEN plugin_publication_requests.created_at ELSE plugin_publication_requests.submitted_at END END DESC, plugin_publication_requests.id ASC LIMIT 0, 20"
    );
    assert_eq!(normalize(&render(&statement, &args)), normalize(&expected));
    assert_eq!(args.len(), 3);
    assert!(matches!(&args[0], SqlArg::Str(value) if value == "awaiting_admin"));
    assert!(matches!(args[1], SqlArg::Int(0)));
    assert!(matches!(args[2], SqlArg::Int(20)));
}

#[test]
fn recorded_count_renders_the_captured_statement() {
    let (statement, args) = sql::count_sql(&recorded_params(), &sql::Filters::default());
    let expected = format!(
        "SELECT count(*) AS count_1 FROM (SELECT {RECORDED_REQUEST_COLUMNS} FROM plugin_publication_requests WHERE plugin_publication_requests.aggregate_status = 'awaiting_admin') AS anon_1"
    );
    assert_eq!(normalize(&render(&statement, &args)), normalize(&expected));
    assert_eq!(args.len(), 1);
}

#[test]
fn filters_omit_conditions_when_unset() {
    let params = ListParams {
        page: 2,
        limit: 5,
        status: None,
        risk_level: Some("high".to_string()),
        submitter: None,
        query: None,
        submitted_after: None,
        submitted_before: None,
    };
    let (statement, args) = sql::select_sql(&params, &sql::Filters::default());
    assert!(statement.contains("WHERE plugin_publication_requests.risk_level = ?"));
    assert!(!statement.contains("aggregate_status = ?"));
    assert!(statement.ends_with("LIMIT ?, ?"));
    assert!(matches!(args[0], SqlArg::Str(_)));
    assert!(matches!(args[1], SqlArg::Int(5)));
    assert!(matches!(args[2], SqlArg::Int(5)));
}

#[tokio::test]
async fn lookup_statements_match_the_recorded_exchange() {
    use crate::sql_test_support::KindQueryCapture;

    let mysql = KindQueryCapture::default();
    let _ = sql::get_plugin(&mysql, 24).await.unwrap();
    let _ = sql::current_revision(&mysql, 1, 2).await.unwrap();
    let _ = sql::get_user(&mysql, 293).await.unwrap();
    let _ = sql::checks_for_revision(&mysql, 2).await.unwrap();
    let queries = mysql.queries();
    assert_eq!(queries.len(), 4);
    assert_eq!(
        queries[0].sql,
        normalize(&format!(
            "SELECT {RECORDED_PLUGIN_COLUMNS} FROM plugins WHERE plugins.id = ?"
        ))
    );
    assert_eq!(queries[0].first_integer, Some(24));
    assert_eq!(
        queries[1].sql,
        normalize(&format!(
            "SELECT {RECORDED_REVISION_COLUMNS} FROM plugin_publication_revisions WHERE plugin_publication_revisions.id = ? AND plugin_publication_revisions.request_id = ? LIMIT 1"
        ))
    );
    assert_eq!(queries[1].args, 2);
    assert_eq!(queries[1].first_integer, Some(2));
    assert_eq!(
        queries[2].sql,
        normalize(&format!(
            "SELECT {RECORDED_USER_COLUMNS} FROM users WHERE users.id = ?"
        ))
    );
    assert_eq!(queries[2].first_integer, Some(293));
    assert_eq!(
        queries[3].sql,
        normalize(&format!(
            "SELECT {RECORDED_CHECK_COLUMNS} FROM plugin_publication_checks WHERE plugin_publication_checks.revision_id = ? ORDER BY plugin_publication_checks.id"
        ))
    );
    assert_eq!(queries[3].first_integer, Some(2));
}

#[test]
fn list_query_applies_fastapi_defaults_and_bounds() {
    let params = ListQuery::default()
        .validated()
        .expect("defaults are valid");
    assert_eq!(params.page, 1);
    assert_eq!(params.limit, 20);
    assert!(params.status.is_none());

    for page in ["0", "-3", "abc"] {
        let query = ListQuery {
            page: Some(page.to_string()),
            ..ListQuery::default()
        };
        let error = query.validated().expect_err("page must be rejected");
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    for limit in ["0", "101"] {
        let query = ListQuery {
            limit: Some(limit.to_string()),
            ..ListQuery::default()
        };
        assert!(query.validated().is_err());
    }
    let query = ListQuery {
        limit: Some("100".to_string()),
        ..ListQuery::default()
    };
    assert_eq!(query.validated().expect("100 is allowed").limit, 100);
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

#[test]
fn non_admin_is_rejected_with_the_source_detail() {
    let error = require_admin("user").expect_err("non-admin is rejected");
    assert_eq!(error.status(), brz_http_server::StatusCode::FORBIDDEN);
    assert_eq!(error.detail_message(), Some(ADMIN_REQUIRED_DETAIL));
    assert!(require_admin("admin").is_ok());
}
