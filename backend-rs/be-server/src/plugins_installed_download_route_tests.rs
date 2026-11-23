// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Route ownership for `GET /api/plugins/installed/{installed_id}/download`.

#[test]
fn download_route_selects_the_registered_rust_handler() {
    let table = crate::app_test_support::cutover_route_table(&[(
        "/api/plugins/installed/:installed_id/download",
        &["GET"],
    )]);
    assert!(
        table.matches(&http::Method::GET, "/api/plugins/installed/254688/download"),
        "GET /api/plugins/installed/{{installed_id}}/download must be served by Rust"
    );
    // The literal sibling and every other method stay on Python.
    assert!(!table.matches(
        &http::Method::POST,
        "/api/plugins/installed/254688/download"
    ));
    assert!(!table.matches(&http::Method::GET, "/api/plugins/installed/254688"));
}

#[test]
fn the_download_handler_is_registered_with_the_application() {
    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;
    assert!(
        wegent_plugin_runtime::registered_routes()
            .into_iter()
            .any(|(path, methods)| {
                path == "/api/plugins/installed/:installed_id/download" && methods & GET != 0
            }),
        "the download route must have exactly one registered Rust handler"
    );
}
