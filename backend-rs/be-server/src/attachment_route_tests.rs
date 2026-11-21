// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Attachment route selection and registration in the public gateway.

/// The cutover and the handler registration must agree. The hybrid
/// gateway forwards unselected paths to Python, whose Replay upstream is
/// unavailable (`502 fallback upstream unavailable`), so a missing route
/// entry reproduces the recorded failure instead of the detail body.
#[test]
fn attachment_detail_is_selected_and_registered() {
    const PATH: &str = "/api/attachments/:attachment_id";
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let config = crate::load_routes_config(&file).unwrap();
    assert!(
        config
            .routes
            .iter()
            .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
        "GET {PATH} must be selected for Rust"
    );
    let table = crate::RouteTable::compile(config).unwrap();
    assert!(table.matches(&http::Method::GET, "/api/attachments/1385519"));

    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;
    let registered = wegent_attachments::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & GET != 0);
    assert!(registered, "GET {PATH} must be registered by the router");
}

/// The download cutover is selected and registered; without the entry the
/// gateway proxies the request to Python and Replay observes the 502
/// `fallback upstream unavailable` body instead of the stored file bytes.
#[test]
fn attachment_download_is_selected_and_registered() {
    const PATH: &str = "/api/attachments/:attachment_id/download";
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let config = crate::load_routes_config(&file).unwrap();
    assert!(
        config
            .routes
            .iter()
            .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
        "GET {PATH} must be selected for Rust"
    );
    let table = crate::RouteTable::compile(config).unwrap();
    assert!(table.matches(&http::Method::GET, "/api/attachments/1404377/download"));
    assert!(!table.matches(&http::Method::POST, "/api/attachments/1404377/download"));

    // `method_bit`: GET.
    const GET: u16 = 1 << 1;
    let registered = wegent_attachments::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & GET != 0);
    assert!(registered, "GET {PATH} must be registered by the router");
}

/// Deferred APIs retain Python ownership and registered Rust implementations.
#[test]
fn attachment_playback_stays_with_python() {
    const PATH: &str = "/api/attachments/:attachment_id/playback";
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
    assert!(!table.matches(&http::Method::GET, "/api/attachments/42/playback"));

    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;
    let registered = wegent_attachments::registered_routes()
        .into_iter()
        .any(|(path, methods)| path == PATH && methods & GET != 0);
    assert!(registered, "GET {PATH} must be registered by the router");
}

#[test]
fn attachment_video_metadata_stays_with_python() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let table = crate::RouteTable::compile(crate::load_routes_config(&path).unwrap()).unwrap();
    assert!(!table.matches(
        &http::Method::POST,
        "/api/attachments/upload-video-metadata"
    ));
    let registered = wegent_attachments::registered_routes()
        .into_iter()
        .any(|(path, methods)| {
            path == "/api/attachments/upload-video-metadata" && methods & (1 << 5) != 0
        });
    assert!(registered);
}

#[test]
fn internal_attachment_download_stays_with_python() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let table = crate::RouteTable::compile(crate::load_routes_config(&path).unwrap()).unwrap();
    assert!(!table.matches(
        &http::Method::GET,
        "/api/internal/attachments/1392099/download"
    ));
    // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;
    let registered = wegent_attachments::registered_routes()
        .into_iter()
        .any(|(path, methods)| {
            path == "/api/internal/attachments/:attachment_id/download" && methods & GET != 0
        });
    assert!(
        registered,
        "GET /api/internal/attachments/:attachment_id/download must be registered"
    );
}

/// The route table selects the OpenAPI upload for Rust and leaves the chat
/// upload's own entry untouched.
#[test]
fn open_attachment_upload_is_selected() {
    let table = crate::app_test_support::cutover_route_table(&[
        ("/api/v1/attachments/upload", &["POST"]),
        ("/api/attachments/upload", &["POST"]),
    ]);
    assert!(table.matches(&http::Method::POST, "/api/v1/attachments/upload"));
    assert!(!table.matches(&http::Method::GET, "/api/v1/attachments/upload"));
    assert!(table.matches(&http::Method::POST, "/api/attachments/upload"));
}
