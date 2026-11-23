// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/// `GET /api/git/repositories/branches` is served by the registered
/// repository-branch listing handler (`app/api/endpoints/repository.py::
/// get_branches`). Its rule stayed commented, so the recorded request went to
/// the unavailable Python fallback and answered `502 fallback upstream
/// unavailable`.
#[test]
fn git_branches_select_the_registered_rust_handler() {
    let path = "/api/git/repositories/branches";
    let table = crate::app_test_support::cutover_route_table(&[(path, &["GET"])]);
    assert!(
        table.matches(&http::Method::GET, path),
        "GET {path} must select the Rust cutover"
    );
    assert!(!table.matches(&http::Method::POST, path));
    let registered: Vec<&str> = wegent_git_repositories::registered_routes()
        .into_iter()
        .filter(|(registered, _)| *registered == path)
        .map(|(registered, _)| registered)
        .collect();
    assert_eq!(
        registered,
        [path],
        "the selected route needs exactly one registered handler"
    );
}
