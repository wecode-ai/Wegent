// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/plugins/publication-requests` must be selected by the active
//! route table and served by the registered submitter list handler.
//!
//! `PluginPublicationService.list_requests(is_admin=False)` has a single
//! owner, so the path stays out of the admin cutover and off every other
//! method.

const PATH: &str = "/api/plugins/publication-requests";

#[test]
fn publication_list_route_selects_the_rust_handler() {
    let table = crate::app_test_support::cutover_route_table(&[(PATH, &["GET"])]);
    assert!(
        table.matches(&http::Method::GET, PATH),
        "GET {PATH} must be served by the Rust publication list handler"
    );
    // The sibling admin list, the detail route, and every mutation stay on
    // Python.
    assert!(!table.matches(&http::Method::POST, PATH));
    assert!(!table.matches(&http::Method::GET, "/api/plugins/publication-requests/41"));
    assert!(!table.matches(
        &http::Method::GET,
        "/api/admin/plugins/publication-requests"
    ));
}

#[test]
fn the_publication_list_handler_is_registered_with_the_application() {
    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;
    let registrations = wegent_plugin_catalog::registered_routes()
        .into_iter()
        .filter(|(path, methods)| *path == PATH && methods & GET != 0)
        .count();
    assert_eq!(
        registrations, 1,
        "GET {PATH} must have exactly one registered Rust handler"
    );
}
