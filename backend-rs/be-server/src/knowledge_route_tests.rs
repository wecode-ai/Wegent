// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Knowledge route selection and registration in the public gateway.

#[test]
fn knowledge_wiki_bindings_stays_with_python() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let table = crate::RouteTable::compile(crate::load_routes_config(&path).unwrap()).unwrap();
    assert!(!table.matches(&http::Method::GET, "/api/knowledge/1884840/wiki-bindings"));
    // Inspect emitted registrations from the collection used by
    // Application; GET is bit 1<<1 of the method mask.
    let methods: Vec<_> = wegent_knowledge::registered_routes()
        .into_iter()
        .filter(|(path, _)| *path == "/api/knowledge/:knowledge_base_id/wiki-bindings")
        .map(|(_, methods)| methods)
        .collect();
    assert_eq!(methods, vec![1 << 1]);
}

/// The literal Rust handler is registered ahead of its gateway cutover.
#[test]
fn knowledge_multimodal_prompts_stays_with_python() {
    const PATH: &str = "/api/knowledge-bases/multimodal-default-prompts";
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
    assert!(!table.matches(
        &http::Method::GET,
        "/api/knowledge-bases/multimodal-default-prompts"
    ));

    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;
    let registered = wegent_knowledge::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & GET != 0);
    assert!(registered, "GET {PATH} must be registered by the router");
}

/// Python owns the route while the Rust handler stays registered.
#[test]
fn knowledge_folders_stays_with_python() {
    const PATH: &str = "/api/knowledge-bases/:knowledge_base_id/folders";
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
    assert!(!table.matches(&http::Method::GET, "/api/knowledge-bases/257464/folders"));

    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;
    let registered = wegent_knowledge::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & GET != 0);
    assert!(registered, "GET {PATH} must be registered by the router");
}

/// Python owns the route while the Rust handler stays registered.
#[test]
fn knowledge_base_share_permission_stays_with_python() {
    const PATH: &str = "/api/share/KnowledgeBase/:resource_id/my-permission";
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
    assert!(!table.matches(
        &http::Method::GET,
        "/api/share/KnowledgeBase/1758221/my-permission"
    ));

    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;
    let registered = wegent_knowledge::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & GET != 0);
    assert!(registered, "GET {PATH} must be registered by the router");
}
