// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::io::{Cursor, Write};

#[tokio::test]
async fn sandbox_skill_sync_installs_required_abtest_script_before_success() {
    use sha2::{Digest, Sha256};

    let _lock = env_lock().lock().await;
    let temporary = tempfile::tempdir().unwrap();
    let home = temporary.path();
    let workbench = home.join("workbench");
    let native_home = home.join("native-claude");
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _workbench = EnvGuard::set("WEGENT_WORKBENCH_HOME", workbench.to_str().unwrap());
    let _claude = EnvGuard::set("WEGENT_CLAUDE_HOME", native_home.to_str().unwrap());
    let app = create_router(AppState::new(RecordingRunner::default()));
    let mut payload = json!({
        "task_id": 37520834448496_i64,
        "subtask_id": 1,
        "type": "sandbox",
        "auth_token": "task-jwt",
        "team_namespace": "default",
        "bot": [{
            "shell_type": "ClaudeCode",
            "skills": ["abtest-file-analyzer"],
            "skill_refs": {
                "abtest-file-analyzer": {
                    "skill_id": 237510,
                    "namespace": "default"
                }
            }
        }],
        "skill_names": ["abtest-file-analyzer"],
        "required_skills": ["abtest-file-analyzer"]
    });

    // Initial sync, repeat sync, namespace/version update, then reinstall from cache.
    let skills_dir = home.join(".claude/skills");
    for (step, (namespace, version)) in [
        ("default", "v1"),
        ("default", "v1"),
        ("another", "v2"),
        ("another", "v2"),
    ]
    .into_iter()
    .enumerate()
    {
        let archive = abtest_skill_zip(version);
        let hash = format!("{:x}", Sha256::digest(&archive));
        let (archive, status) = if step == 1 || step == 3 {
            (Vec::new(), StatusCode::NOT_FOUND)
        } else {
            (archive, StatusCode::OK)
        };
        if step == 3 {
            fs::remove_dir_all(&skills_dir).unwrap();
        }
        let backend_url = spawn_skill_server(archive, status).await;
        let _backend = EnvGuard::set("WEGENT_BACKEND_URL", &backend_url);
        let _task_api = EnvGuard::set("TASK_API_DOMAIN", &backend_url);
        payload["bot"][0]["skill_refs"]["abtest-file-analyzer"]["namespace"] = json!(namespace);
        payload["bot"][0]["skill_refs"]["abtest-file-analyzer"]["content_hash"] = json!(hash);
        let response = app
            .clone()
            .oneshot(skill_sync_request(&payload))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "sync step {step}");
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body["skills_dir"], json!(skills_dir));

        // These reads happen after the HTTP response, when temporary staging is gone.
        let skill = skills_dir.join("abtest-file-analyzer");
        assert!(skill.join("SKILL.md").is_file());
        assert!(skill.join("scripts/abtest_cli.py").is_file());
        assert_eq!(
            fs::read_to_string(skill.join("references/version.txt")).unwrap(),
            version
        );
        let output = std::process::Command::new("sh")
            .arg(skill.join("scripts/check.sh"))
            .current_dir(home)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8(output.stdout).unwrap(), version);
        assert!(!native_home.exists());
        assert!(!workbench.join("agents").exists());
    }
}

fn skill_sync_request(payload: &Value) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri("/v1/skills/sync")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(payload.to_string()))
        .unwrap()
}

#[tokio::test]
async fn skill_sync_prewarm_does_not_replace_sandbox_skills() {
    let _lock = env_lock().lock().await;
    let home = tempfile::tempdir().unwrap();
    let workbench = home.path().join("workbench");
    let _home = EnvGuard::set("HOME", home.path().to_str().unwrap());
    let _workbench = EnvGuard::set("WEGENT_WORKBENCH_HOME", workbench.to_str().unwrap());
    let backend_url = spawn_skill_server(abtest_skill_zip("new"), StatusCode::OK).await;
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", &backend_url);
    let _task_api = EnvGuard::set("TASK_API_DOMAIN", &backend_url);
    let existing = home
        .path()
        .join(".claude/skills/abtest-file-analyzer/SKILL.md");
    fs::create_dir_all(existing.parent().unwrap()).unwrap();
    fs::write(&existing, "existing sandbox skill").unwrap();
    let payload = json!({
        "task_id": 123,
        "auth_token": "test-token",
        "bot": [{
            "shell_type": "ClaudeCode",
            "skills": ["abtest-file-analyzer"],
            "skill_refs": {"abtest-file-analyzer": {"skill_id": 237510, "namespace": "default"}}
        }],
        "required_skills": ["abtest-file-analyzer"]
    });
    let response = create_router(AppState::new(RecordingRunner::default()))
        .oneshot(skill_sync_request(&payload))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["skills_dir"], json!(workbench.join("shared/skills")));
    assert_eq!(
        fs::read_to_string(existing).unwrap(),
        "existing sandbox skill"
    );
    assert_eq!(
        fs::read_dir(workbench.join("shared/staging"))
            .unwrap()
            .count(),
        0
    );
    assert!(!workbench.join("agents").exists());
}

#[tokio::test]
async fn sandbox_skill_sync_rejects_missing_required_skill() {
    let _lock = env_lock().lock().await;
    let temporary = tempfile::tempdir().unwrap();
    let home = temporary.path();
    let backend_url = spawn_skill_server(Vec::new(), StatusCode::NOT_FOUND).await;
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _workbench = EnvGuard::set(
        "WEGENT_WORKBENCH_HOME",
        home.join("workbench").to_str().unwrap(),
    );
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", &backend_url);
    let _task_api = EnvGuard::set("TASK_API_DOMAIN", &backend_url);
    let app = create_router(AppState::new(RecordingRunner::default()));
    let payload = json!({
        "task_id": 37520834448496_i64,
        "subtask_id": 1,
        "type": "sandbox",
        "auth_token": "task-jwt",
        "bot": [{
            "shell_type": "ClaudeCode",
            "skills": ["abtest-file-analyzer"],
            "skill_refs": {
                "abtest-file-analyzer": {
                    "skill_id": 237510,
                    "namespace": "default"
                }
            }
        }],
        "required_skills": ["abtest-file-analyzer"]
    });

    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/v1/skills/sync")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(body["detail"]
        .as_str()
        .unwrap()
        .contains("required Skill deployment failed: abtest-file-analyzer"));
}

async fn spawn_skill_server(archive: Vec<u8>, status: StatusCode) -> String {
    let app = Router::new().route(
        "/api/v1/kinds/skills/237510/download",
        get(move || {
            let archive = archive.clone();
            async move { (status, [(header::CONTENT_TYPE, "application/zip")], archive) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

fn abtest_skill_zip(version: &str) -> Vec<u8> {
    let cursor = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    let options = zip::write::FileOptions::default();
    writer
        .start_file("abtest-file-analyzer/SKILL.md", options)
        .unwrap();
    writer.write_all(b"# ABTest file analyzer\n").unwrap();
    writer
        .start_file("abtest-file-analyzer/scripts/abtest_cli.py", options)
        .unwrap();
    writer.write_all(b"print('ready')\n").unwrap();
    writer
        .start_file("abtest-file-analyzer/scripts/check.sh", options)
        .unwrap();
    writer
        .write_all(b"cat \"$(dirname \"$0\")/../references/version.txt\"\n")
        .unwrap();
    writer
        .start_file("abtest-file-analyzer/references/version.txt", options)
        .unwrap();
    writer.write_all(version.as_bytes()).unwrap();
    writer.finish().unwrap().into_inner()
}
