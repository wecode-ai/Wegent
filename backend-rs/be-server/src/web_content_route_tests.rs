// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

/// The cutover and the handler registration must agree. An inactive route
/// entry sends `GET /api/utils/url-metadata` to the Python fallback (the
/// hybrid gateway answers `fallback upstream unavailable` in Replay), so
/// the recorded metadata document is never served by this handler.
#[test]
fn selected_route_is_registered_in_the_shared_group() {
    const PATH: &str = "/api/utils/url-metadata";
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let config = crate::hybrid::load_routes_config(&file).unwrap();
    assert!(
        config
            .routes
            .iter()
            .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
        "GET {PATH} must be selected for Rust"
    );
    let table = crate::RouteTable::compile(config).unwrap();
    assert!(table.matches(&http::Method::GET, PATH));

    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;
    let registered = wegent_web_content::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & GET != 0);
    assert!(registered, "GET {PATH} must be registered by the router");
}

/// The create-document route is registered exactly once in the public
/// route group, so the gateway serves it from Rust instead of forwarding
/// it to the Python fallback.
#[test]
fn create_document_is_registered_in_the_public_group() {
    let paths: Vec<_> = wegent_web_content::registered_routes()
        .into_iter()
        .map(|(path, _)| path)
        .filter(|path| *path == "/api/web-scraper/create-document")
        .collect();
    assert_eq!(paths, ["/api/web-scraper/create-document"]);
}
