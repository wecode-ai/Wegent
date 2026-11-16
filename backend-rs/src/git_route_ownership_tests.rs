// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[test]
fn git_branches_keep_python_route_ownership() {
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
    let table = crate::RouteTable::compile(crate::load_routes_config(&file).unwrap()).unwrap();
    let path = "/api/git/repositories/branches";
    assert!(
        !table.matches(&http::Method::GET, path),
        "GET {path} must remain on Python"
    );
    assert!(!table.matches(&http::Method::POST, path));
}
