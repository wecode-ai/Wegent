// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

#[test]
fn api_routes_are_registered_and_selected_for_rust_only() {
    let config = crate::hybrid::load_routes_config(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml"),
    )
    .unwrap();
    let table = crate::RouteTable::compile(config).unwrap();
    assert!(table.matches(
        &http::Method::POST,
        "/api/tasks/42/remote-workspace/artifacts"
    ));
    assert!(table.matches(
        &http::Method::GET,
        "/api/tasks/42/remote-workspace/artifacts/7/file"
    ));
    let routes = wegent_device_artifacts::registered_routes();
    for (path, bit) in [
        ("/api/tasks/:task_id/remote-workspace/artifacts", 1 << 5),
        (
            "/api/tasks/:task_id/remote-workspace/artifacts/:context_id/file",
            1 << 1,
        ),
    ] {
        assert!(
            routes
                .iter()
                .any(|(registered_path, methods)| *registered_path == path && methods & bit != 0)
        );
    }
    let python = include_str!("../../../backend/app/api/endpoints/adapter/tasks.py");
    assert!(!python.contains("def declare_remote_workspace_artifact("));
    assert!(!python.contains("def download_remote_workspace_artifact("));
}
