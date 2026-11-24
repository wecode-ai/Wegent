// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[cfg(test)]
mod chat_agents {

    /// Deferred APIs retain Python ownership and registered Rust implementations.
    #[test]
    fn deferred_route_keeps_python_ownership_and_handler_registration() {
        const PATH: &str = "/api/v1/cloud-projects/:project_id/chat-agents";
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
        assert!(!table.matches(
            &http::Method::GET,
            "/api/v1/cloud-projects/2753648597973755964/chat-agents"
        ));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered = wegent_project_coordination::registered_routes()
            .into_iter()
            .any(|(path, methods)| path == PATH && methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }
}

/// The route is selected by the active table and registered by the router.
#[test]
fn board_route_is_selected_and_registered() {
    const PATH: &str = "/api/v1/cloud-projects/:project_id/board-snapshot";
    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;

    let table = crate::app_test_support::cutover_route_table(&[(PATH, &["GET"])]);
    assert!(table.matches(
        &http::Method::GET,
        "/api/v1/cloud-projects/2753648597973755964/board-snapshot"
    ));

    let registered = wegent_project_coordination::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & GET != 0);
    assert!(registered, "GET {PATH} must be registered by the router");
}

/// The route is selected by the active table and registered by the router.
#[test]
fn loop_items_route_is_selected_and_registered() {
    const PATH: &str = "/api/v1/cloud-projects/:project_id/loop-items";
    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;

    let table = crate::app_test_support::cutover_route_table(&[(PATH, &["GET"])]);
    assert!(table.matches(
        &http::Method::GET,
        "/api/v1/cloud-projects/2753648597973755964/loop-items"
    ));

    let registered = wegent_project_coordination::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & GET != 0);
    assert!(registered, "GET {PATH} must be registered by the router");
}

/// The route is selected by the active table and registered by the router.
#[test]
fn item_route_is_selected_and_registered() {
    const PATH: &str = "/api/v1/loop-items/:item_id";
    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;

    let table = crate::app_test_support::cutover_route_table(&[(PATH, &["GET"])]);
    assert!(table.matches(&http::Method::GET, "/api/v1/loop-items/WEWORK2D8526-118"));

    let registered = wegent_project_coordination::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & GET != 0);
    assert!(registered, "GET {PATH} must be registered by the router");
}

#[test]
fn comments_deferred_route_keeps_python_ownership_and_handler_registration() {
    const PATH: &str = "/api/v1/loop-items/:item_id/comments";
    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let config = crate::hybrid::load_routes_config(&path).expect("routes file loads");
    let table = crate::RouteTable::compile(config).expect("routes compile");
    assert!(!table.matches(&http::Method::GET, "/api/v1/loop-items/abc/comments"));
    assert!(!table.matches(&http::Method::POST, "/api/v1/loop-items/abc/comments"));

    let registered = wegent_project_coordination::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & GET != 0);
    assert!(registered, "GET {PATH} must be registered by the router");
}

/// Deferred APIs retain Python ownership and registered Rust implementations.
#[test]
fn attachments_deferred_route_keeps_python_ownership_and_handler_registration() {
    const PATH: &str = "/api/v1/loop-items/:item_id/attachments";
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
    assert!(!table.matches(
        &http::Method::GET,
        "/api/v1/loop-items/WEWORK2D8526-22/attachments"
    ));

    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;
    let registered = wegent_project_coordination::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & GET != 0);
    assert!(registered, "GET {PATH} must be registered by the router");
}
