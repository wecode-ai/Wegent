// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use tower::ServiceExt;
use wegent_executor::{
    agents::{AgentCommandPlanner, AgentProcessEngine},
    server::{create_router, AppState, RunnerResult, TaskRunner},
};

#[tokio::test]
async fn codex_without_repository_uses_the_file_api_task_workspace() {
    let _lock = env_lock().await;
    for streaming in [false, true] {
        verify_workspace(streaming, false).await;
    }
}

#[tokio::test]
async fn codex_preserves_explicit_workspace_under_configured_root() {
    let _lock = env_lock().await;
    for streaming in [false, true] {
        verify_workspace(streaming, true).await;
    }
}

async fn verify_workspace(streaming: bool, explicit: bool) {
    let fixture = Fixture::new("stream");
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let _projects = EnvGuard::set("WEGENT_EXECUTOR_PROJECTS_DIR", "");
    let workspace_root = if explicit {
        fixture.root.path().join("custom-workspaces")
    } else {
        fixture.root.path().join("executor/workspace/projects")
    };
    let _root = EnvGuard::set(
        "WORKSPACE_ROOT",
        if explicit {
            workspace_root.as_os_str()
        } else {
            "".as_ref()
        },
    );
    let mut request = fixture.request("first");
    request.task_id = "502".to_owned();
    let task_path = if explicit { "502/repository" } else { "502" };
    let expected_cwd = workspace_root.join(task_path);
    request.project_workspace_path = explicit.then(|| expected_cwd.display().to_string());
    request.extra.insert(
        "execution".to_owned(),
        json!({"setup": {"steps": [{"command": "printf workspace-ready > setup.txt"}]}}),
    );
    fs::write(fixture.root.path().join("release"), "complete").unwrap();
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        "unused-claude",
        fixture.binary.to_str().unwrap(),
    ));
    let outcome = if streaming {
        let (sink, _events) = event_channel();
        tokio::time::timeout(
            TIMEOUT,
            engine.run_with_events(request.clone(), sink, builder(&request)),
        )
        .await
        .unwrap()
    } else {
        tokio::time::timeout(TIMEOUT, engine.run(request))
            .await
            .unwrap()
    };
    assert_completed(outcome);

    assert_eq!(
        fs::read_to_string(expected_cwd.join("setup.txt")).unwrap(),
        "workspace-ready"
    );
    let messages = fixture.messages();
    for method in ["thread/start", "turn/start"] {
        let message = messages
            .iter()
            .find(|message| message["method"] == method)
            .unwrap();
        assert_eq!(message["params"]["cwd"], expected_cwd.display().to_string());
    }
    verify_file_api(&format!("/workspace/{task_path}")).await;
}

async fn verify_file_api(logical_path: &str) {
    let app = create_router(AppState::new(UnusedRunner));
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/filesystem.Filesystem/ListDir")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"path": logical_path, "depth": 1}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(body["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == "setup.txt"));
}

#[derive(Clone)]
struct UnusedRunner;

impl TaskRunner for UnusedRunner {
    type SubmitFuture = Ready<RunnerResult>;

    fn submit(&self, _: ExecutionRequest) -> Self::SubmitFuture {
        panic!("file listing must not submit a task")
    }
}
