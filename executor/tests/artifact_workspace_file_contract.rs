// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use sha2::{Digest, Sha256};
use std::{ffi::OsString, path::Path};
use wegent_executor::{
    protocol::ExecutionRequest,
    server::{create_router, AppState, RunnerResult, TaskRunner},
};

struct ExecutorHome(Option<OsString>);

impl ExecutorHome {
    fn set(path: &Path) -> Self {
        let previous = std::env::var_os("WEGENT_EXECUTOR_HOME");
        std::env::set_var("WEGENT_EXECUTOR_HOME", path);
        Self(previous)
    }
}

impl Drop for ExecutorHome {
    fn drop(&mut self) {
        match &self.0 {
            Some(previous) => std::env::set_var("WEGENT_EXECUTOR_HOME", previous),
            None => std::env::remove_var("WEGENT_EXECUTOR_HOME"),
        }
    }
}

fn native_binding(home: &Path, workspace: &Path) -> String {
    let id = format!("{:x}", Sha256::digest(b"artifact-contract-task-token"));
    let bindings = home.join("artifact-workspaces");
    std::fs::create_dir_all(&bindings).unwrap();
    // Native launch persists this trusted state before accepting artifact requests.
    std::fs::write(
        bindings.join(format!("{id}.json")),
        serde_json::to_vec(&serde_json::json!({
            "task_id": "42",
            "subtask_id": "7",
            "workspace_root": workspace.canonicalize().unwrap(),
        }))
        .unwrap(),
    )
    .unwrap();
    id
}

#[derive(Clone)]
struct IdleRunner;

impl TaskRunner for IdleRunner {
    type SubmitFuture = std::future::Ready<RunnerResult>;

    fn submit(&self, _request: ExecutionRequest) -> Self::SubmitFuture {
        unreachable!("artifact downloads must not submit tasks")
    }
}

#[tokio::test]
async fn artifact_file_endpoint_requires_and_enforces_its_workspace_root() {
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("report.txt"), "original bytes").unwrap();
    let home = tempfile::tempdir().unwrap();
    let _home = ExecutorHome::set(home.path());
    let binding = native_binding(home.path(), workspace.path());
    let identity = [
        ("binding_id", binding.as_str()),
        ("task_id", "42"),
        ("subtask_id", "7"),
    ];
    let app = create_router(AppState::new(IdleRunner));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let url = format!("http://{address}/filesystem/artifact");
    let missing_root = client
        .get(&url)
        .query(&identity)
        .query(&[("path", "report.txt")])
        .send()
        .await
        .unwrap();

    assert_eq!(missing_root.status(), reqwest::StatusCode::BAD_REQUEST);

    let canonical_root = workspace.path().canonicalize().unwrap();
    let root = canonical_root.to_str().unwrap();
    let missing_binding = client
        .get(&url)
        .query(&[("root_path", root), ("path", "report.txt")])
        .send()
        .await
        .unwrap();
    assert_eq!(missing_binding.status(), reqwest::StatusCode::BAD_REQUEST);

    let file = client
        .get(&url)
        .query(&identity)
        .query(&[("root_path", root), ("path", "report.txt")])
        .send()
        .await
        .unwrap();
    assert_eq!(file.status(), reqwest::StatusCode::OK);
    assert_eq!(file.bytes().await.unwrap().as_ref(), b"original bytes");
    let other_workspace = tempfile::tempdir().unwrap();
    let secret = other_workspace.path().join("secret.txt");
    std::fs::write(&secret, "private bytes").unwrap();
    let outside = client
        .get(&url)
        .query(&identity)
        .query(&[("root_path", root), ("path", secret.to_str().unwrap())])
        .send()
        .await
        .unwrap();
    assert_eq!(outside.status(), reqwest::StatusCode::FORBIDDEN);

    let forged_root = other_workspace.path().canonicalize().unwrap();
    let forged = client
        .get(&url)
        .query(&identity)
        .query(&[
            ("root_path", forged_root.to_str().unwrap()),
            ("path", "secret.txt"),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(forged.status(), reqwest::StatusCode::FORBIDDEN);

    for (task_id, subtask_id) in [("43", "7"), ("42", "8")] {
        let wrong_execution = client
            .get(&url)
            .query(&[
                ("binding_id", binding.as_str()),
                ("task_id", task_id),
                ("subtask_id", subtask_id),
                ("root_path", root),
                ("path", "report.txt"),
            ])
            .send()
            .await
            .unwrap();
        assert_eq!(wrong_execution.status(), reqwest::StatusCode::FORBIDDEN);
    }
    server.abort();
}
