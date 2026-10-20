// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the admin plugin-publication list.

use super::*;

#[test]
fn non_admin_is_rejected_with_the_source_detail() {
    let error = require_admin("user").expect_err("non-admin is rejected");
    assert_eq!(error.status(), brz_http_server::StatusCode::FORBIDDEN);
    assert_eq!(error.detail_message(), Some(ADMIN_REQUIRED_DETAIL));
    assert!(require_admin("admin").is_ok());
}

#[test]
fn admin_count_renders_the_captured_statement_shape() {
    let params = ListParams {
        page: 1,
        limit: 20,
        status: Some("awaiting_admin".to_string()),
        risk_level: None,
        submitter: None,
        query: None,
        submitted_after: None,
        submitted_before: None,
    };
    let conditions = admin_conditions_for_test(&params);
    let (statement, args) = crate::plugin_publications::sql::count_sql(&conditions);
    let expected_suffix = "FROM plugin_publication_requests WHERE \
         plugin_publication_requests.aggregate_status = 'awaiting_admin') AS anon_1";
    assert!(statement.replace('\n', " ").contains(expected_suffix));
    assert!(args.is_empty());
}

/// Expose the admin `WHERE` chain for the statement-shape test.
fn admin_conditions_for_test(params: &ListParams) -> Vec<String> {
    admin_conditions(params, &Default::default())
}

/// The admin `WHERE` chain with an empty text filter (`admin_conditions`).
fn admin_conditions(
    params: &ListParams,
    filters: &crate::plugin_publications::sql::Filters,
) -> Vec<String> {
    admin_where_conditions(params, filters)
}

/// Delegate to the shared renderer through the module-private seam.
fn admin_where_conditions(
    params: &ListParams,
    filters: &crate::plugin_publications::sql::Filters,
) -> Vec<String> {
    crate::plugin_publications::sql::admin_conditions(params, filters)
}
