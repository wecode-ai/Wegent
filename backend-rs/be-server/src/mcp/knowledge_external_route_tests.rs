// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/// The formal download stays Python-owned with its Rust handler retained.
#[test]
fn formal_download_keeps_python_ownership_and_rust_registration() {
    const PATH: &str = "/api/mcp/knowledge-external/documents/:document_id/file";
    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let config = crate::hybrid::load_routes_config(&path).expect("routes file loads");
    let table = crate::RouteTable::compile(config).expect("routes compile");
    assert!(!table.matches(
        &http::Method::GET,
        "/api/mcp/knowledge-external/documents/30830/file"
    ));
    assert!(!table.matches(
        &http::Method::POST,
        "/api/mcp/knowledge-external/documents/30830/file"
    ));

    let registered = wegent_knowledge_mcp::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & GET != 0);
    assert!(registered, "GET {PATH} must be registered by the router");
}

/// The doubled-prefix cutover selects only `GET` on the nested
/// `/api/api/...` path and the router registers its handler.
#[test]
fn registered_route_keeps_python_ownership() {
    const PATH: &str = "/api/api/mcp/knowledge-external/documents/:document_id/file";
    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let config = crate::hybrid::load_routes_config(&path).expect("routes file loads");
    let table = crate::RouteTable::compile(config).expect("routes compile");
    assert!(!table.matches(
        &http::Method::GET,
        "/api/api/mcp/knowledge-external/documents/30829/file"
    ));
    assert!(!table.matches(
        &http::Method::GET,
        "/api/mcp/knowledge-external/documents/30829/file".trim_start_matches("/api")
    ));
    assert!(!table.matches(
        &http::Method::POST,
        "/api/api/mcp/knowledge-external/documents/30829/file"
    ));

    let registered = wegent_knowledge_mcp::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & GET != 0);
    assert!(registered, "GET {PATH} must be registered by the router");
}
