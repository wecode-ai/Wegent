// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[test]
fn route_table_selects_both_registered_transport_methods() {
    const PATH: &str = "/api/mcp/subscription/sse";
    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;
    const POST: u16 = 1 << 5;
    let table = crate::app_test_support::cutover_route_table(&[(PATH, &["GET", "POST"])]);
    assert!(table.matches(&http::Method::GET, PATH));
    assert!(table.matches(&http::Method::POST, PATH));
    let mut selected = 0u16;
    for (path, methods) in wegent_subscriptions::registered_routes() {
        if path == PATH {
            selected |= methods;
        }
    }
    assert_eq!(selected & GET, GET, "GET {PATH} must be registered");
    assert_eq!(selected & POST, POST, "POST {PATH} must be registered");
}

#[test]
fn registered_route_keeps_python_ownership() {
    const PATH: &str = "/api/subscriptions/preview/:preview_id/confirm";
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let config = crate::hybrid::load_routes_config(&file).unwrap();
    assert!(
        !config
            .routes
            .iter()
            .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "POST")),
        "POST {PATH} must remain on Python until cutover"
    );
    let table = crate::RouteTable::compile(config).unwrap();
    assert!(!table.matches(
        &http::Method::POST,
        "/api/subscriptions/preview/preview_26d9d11d/confirm"
    ));

    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const POST: u16 = 1 << 5;
    let registered = wegent_subscriptions::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & POST != 0);
    assert!(registered, "POST {PATH} must be registered by the router");
}

/// Deferred APIs retain Python ownership and registered Rust implementations.
#[test]
fn deferred_route_keeps_python_ownership_and_handler_registration() {
    const PATH: &str = "/api/users/me/subscription-invitations";
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let config = crate::hybrid::load_routes_config(&file).unwrap();
    assert!(
        !config
            .routes
            .iter()
            .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
        "GET {PATH} must remain on Python"
    );
    let table = crate::RouteTable::compile(config).unwrap();
    assert!(!table.matches(&http::Method::GET, PATH));
    // Other methods also retain Python ownership.
    for method in [
        http::Method::POST,
        http::Method::PUT,
        http::Method::PATCH,
        http::Method::DELETE,
    ] {
        assert!(!table.matches(&method, PATH));
    }

    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;
    let registered = wegent_subscriptions::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & GET != 0);
    assert!(registered, "GET {PATH} must be registered by the router");
}
