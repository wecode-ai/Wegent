// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn file_uri(route: &str, path: &str) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("path", path)
        .finish();
    format!("{route}?{query}")
}

async fn response_json(response: axum::response::Response) -> Value {
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[tokio::test]
async fn managed_repository_paths_round_trip_from_stat_to_tree_and_files() {
    let _lock = env_lock().lock().await;
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let repository = root.join("demo-12345678");
    fs::create_dir_all(repository.join(".claude")).unwrap();
    fs::create_dir_all(repository.join("empty")).unwrap();
    fs::write(repository.join(".claude/settings.json"), "{}").unwrap();
    fs::create_dir_all(root.join("42/attachments")).unwrap();
    fs::write(root.join("42/attachments/input.txt"), "attachment").unwrap();
    fs::create_dir_all(root.join(".wegent/tasks")).unwrap();
    fs::write(
        root.join(".wegent/tasks/42.json"),
        json!({"key": "demo-12345678", "name": "demo"}).to_string(),
    )
    .unwrap();
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", root.to_str().unwrap());
    let app = create_router(AppState::new(RecordingRunner::default()));

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/filesystem.Filesystem/Stat")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({"path": "/workspace/42"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let stat = response_json(response).await;
    assert_eq!(stat["entry"]["path"], json!(repository));
    let path = stat["entry"]["path"].as_str().unwrap();

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(file_uri("/filesystem/list-dir", path))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let tree = response_json(response).await;
    assert_eq!(tree[0]["path"], json!(repository.join(".claude")));

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/filesystem.Filesystem/ListDir")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"path": tree[0]["path"], "depth": 1}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let nested = response_json(response).await;
    assert_eq!(
        nested["entries"][0]["path"],
        json!(repository.join(".claude/settings.json"))
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(file_uri(
                    "/filesystem/file",
                    nested["entries"][0]["path"].as_str().unwrap(),
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.into_body().collect().await.unwrap().to_bytes(),
        "{}"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(file_uri(
                    "/filesystem/list-dir",
                    tree[1]["path"].as_str().unwrap(),
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response_json(response).await, json!([]));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/filesystem/file?path=/workspace/42/attachments/input.txt")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.into_body().collect().await.unwrap().to_bytes(),
        "attachment"
    );
}
