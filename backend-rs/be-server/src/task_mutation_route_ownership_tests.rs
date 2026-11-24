// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Gateway cutover contract for the registered cancellation route.

/// Deferred APIs retain Python ownership and registered Rust implementations.
#[test]
fn deferred_route_keeps_python_ownership_and_handler_registration() {
    const PATH: &str = "/api/tasks/:task_id/cancel";
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let config = crate::hybrid::load_routes_config(&file).unwrap();
    assert!(
        !config
            .routes
            .iter()
            .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "POST")),
        "POST {PATH} must remain on Python"
    );
    let table = crate::RouteTable::compile(config).unwrap();
    assert!(!table.matches(&http::Method::POST, "/api/tasks/292195215235945/cancel"));
    for method in [
        http::Method::GET,
        http::Method::PUT,
        http::Method::PATCH,
        http::Method::DELETE,
    ] {
        assert!(!table.matches(&method, "/api/tasks/292195215235945/cancel"));
    }

    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const POST: u16 = 1 << 5;
    let registered = wegent_task_mutations::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & POST != 0);
    assert!(registered, "POST {PATH} must be registered by the router");
}
