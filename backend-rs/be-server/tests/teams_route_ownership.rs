// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Application route ownership for Teams.

/// Unverified cutovers keep Python ownership while their handlers stay registered.
#[test]
fn registered_route_keeps_python_ownership() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let config = wegent_backend_rs::load_routes_config(&path).unwrap();
    assert!(
        !config
            .routes
            .iter()
            .any(|rule| rule.path == "/api/teams/share/info"
                && rule.methods.iter().any(|method| method == "GET")),
        "GET /api/teams/share/info must remain on Python until cutover"
    );
    let table = wegent_backend_rs::RouteTable::compile(config).unwrap();
    assert!(!table.matches(&http::Method::GET, "/api/teams/share/info"));
    assert!(!table.matches(&http::Method::POST, "/api/teams/share/info"));

    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;
    let registered = wegent_teams::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == "/api/teams/share/info" && methods & GET != 0);
    assert!(
        registered,
        "GET /api/teams/share/info must be registered by the router"
    );
}
