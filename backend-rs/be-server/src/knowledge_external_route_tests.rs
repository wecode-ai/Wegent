// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

#[test]
fn wiki_connections_keeps_existing_ownership() {
    const PATH: &str = "/api/wiki/connections";
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let config = crate::hybrid::load_routes_config(&file).unwrap();
    assert!(
        !config
            .routes
            .iter()
            .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
        "GET {PATH} must remain Python-owned"
    );
    let table = crate::RouteTable::compile(config).unwrap();
    assert!(!table.matches(&http::Method::GET, "/api/wiki/connections"));

    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;
    let registered = wegent_knowledge::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & GET != 0);
    assert!(registered, "GET {PATH} must be registered by the router");
}

#[test]
fn dingtalk_wikispace_keeps_existing_ownership() {
    const PATH: &str = "/api/dingtalk-wikispace";
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let config = crate::hybrid::load_routes_config(&file).unwrap();
    assert!(
        !config
            .routes
            .iter()
            .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
        "GET {PATH} must remain on Python until cutover"
    );
    let table = crate::RouteTable::compile(config).unwrap();
    assert!(!table.matches(&http::Method::GET, "/api/dingtalk-wikispace"));

    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;
    let registered = wegent_knowledge::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & GET != 0);
    assert!(registered, "GET {PATH} must be registered by the router");
}
