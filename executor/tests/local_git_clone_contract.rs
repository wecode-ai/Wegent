// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::json;
use wegent_executor::local::app_ipc::AppIpcServer;

#[path = "support/git_clone_fixture.rs"]
mod git_clone_fixture;

#[tokio::test]
async fn ipc_clone_preserves_path_and_cwd_for_preflight_and_relative_destination() {
    for field in ["path", "cwd"] {
        for relative_source in [true, false] {
            let fixture = git_clone_fixture::GitCloneFixture::new();
            let mut params = json!({
                "command_key": "git_clone",
                "args": fixture.args(relative_source),
                "env": fixture.env,
                "timeout_seconds": 10,
            });
            params[field] = json!(fixture.directory.path());
            let result = AppIpcServer::new()
                .dispatch("device.execute_command", params)
                .await
                .unwrap();
            assert_eq!(
                result["success"], true,
                "{field}, {relative_source}: {result}"
            );
            fixture.assert_checkout();
        }
    }
}

#[tokio::test]
async fn ipc_clone_missing_relative_source_does_not_create_destination() {
    let fixture = git_clone_fixture::GitCloneFixture::new();
    let result = AppIpcServer::new()
        .dispatch(
            "device.execute_command",
            json!({
                "command_key": "git_clone",
                "path": fixture.directory.path(),
                "args": ["missing-source", "checkout"],
                "env": fixture.env,
                "timeout_seconds": 10,
            }),
        )
        .await
        .unwrap();
    assert_eq!(result["success"], false);
    assert!(result["error"].as_str().unwrap().starts_with("git-access:"));
    assert!(!fixture.directory.path().join("checkout").exists());
}
