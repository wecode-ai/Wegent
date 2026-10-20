// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use wegent_executor::{
    protocol::ExecutionRequest,
    server::{create_router, AppState, RunnerResult, TaskRunner},
};

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
    let app = create_router(AppState::new(IdleRunner));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let url = format!("http://{address}/filesystem/artifact");
    let missing_root = client
        .get(&url)
        .query(&[("path", "report.txt")])
        .send()
        .await
        .unwrap();

    assert_eq!(missing_root.status(), reqwest::StatusCode::BAD_REQUEST);

    let root = workspace.path().to_str().unwrap();
    let file = client
        .get(&url)
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
        .query(&[("root_path", root), ("path", secret.to_str().unwrap())])
        .send()
        .await
        .unwrap();
    assert_eq!(outside.status(), reqwest::StatusCode::FORBIDDEN);
    server.abort();
}
