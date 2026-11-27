// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[test]
fn plugin_release_route_selects_the_registered_rust_handler() {
    let path = "/api/internal/plugins/releases";
    let table = crate::app_test_support::cutover_route_table(&[(path, &["POST"])]);
    assert!(
        table.matches(&http::Method::POST, path),
        "POST {path} must be served by the Rust release handler"
    );
    // The sibling GitLab webhook and every other method stay on Python.
    assert!(!table.matches(&http::Method::GET, path));
    assert!(!table.matches(&http::Method::POST, "/api/internal/plugins/gitlab/events"));
    assert!(!table.matches(&http::Method::POST, "/api/internal/plugins/releases/extra"));
}

#[test]
fn the_plugin_release_handler_is_registered_with_the_application() {
    const POST: u16 = 1 << 5;
    assert!(
        wegent_plugin_catalog::registered_routes()
            .into_iter()
            .any(|(path, methods)| path == "/api/internal/plugins/releases" && methods & POST != 0),
        "the release route must have exactly one registered Rust handler"
    );
}
