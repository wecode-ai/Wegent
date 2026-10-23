use super::*;
use axum::{routing::get, Json, Router};
use std::sync::atomic::AtomicUsize;

#[test]
fn tag_rules_prefer_a_specific_stand_in_and_never_choose_an_ambiguous_match() {
    let configs = vec![
        json!({"id":"default","tags":[]}),
        json!({"id":"review","tags":["review","security"]}),
        json!({"id":"docs","tags":["docs"]}),
    ];
    assert_eq!(
        matching_stand_in(&configs, &json!({"tags":["review"]})).unwrap()["id"],
        "review"
    );
    assert_eq!(
        matching_stand_in(&configs, &json!({"tags":["other"]})).unwrap()["id"],
        "default"
    );
    assert!(matching_stand_in(&configs, &json!({"tags":["review","docs"]})).is_none());
    assert!(matching_stand_in(&configs[1..], &json!({"tags":["other"]})).is_none());
}

#[test]
fn selected_agent_uses_existing_runner_compiler_and_keeps_capabilities() {
    let model = json!({"runtime":"codex","provider":"native","model_id":"model"});
    let agent = json!({"id":"reviewer","name":"Reviewer","runtime":"codex","execution_policy":{"mode":"fixed","environment_id":"mac"},"model_policy":{"mode":"fixed","model":model},"system_prompt":"Review carefully","additional_skills":["review"],"plugins":[{"id":"plugin"}],"mcp_servers":{"tools":{}}});
    let catalog = json!({"runtimes":["codex"],"models":[{"runtime":"codex","provider":"native","model_id":"model","local_model_id":"model","is_default":true}]});
    let mut payload =
        json!({"taskId":"task","message":"Handle this task","origin":{"initiatedBy":"stand_in"}});
    apply_stand_in_agent(&mut payload, &agent, &catalog, "mac", None).unwrap();
    assert_eq!(
        payload["executionRequest"]["system_prompt"],
        "Review carefully"
    );
    assert_eq!(payload["executionRequest"]["bot"][0]["id"], "reviewer");
    assert_eq!(
        payload["executionRequest"]["preload_skills"],
        json!(["review"])
    );
    assert_eq!(
        payload["executionRequest"]["model_config"]["model_id"],
        "model"
    );
    assert!(
        apply_stand_in_agent(&mut json!({}), &agent, &catalog, "another-device", None).is_err()
    );
}

#[test]
fn historical_and_invalid_assignments_never_trigger() {
    let settings = json!({"enabledAfter":"2026-10-20T12:00:00Z"});
    assert!(!assignment_after_enable(
        &json!({"created_at":"2026-10-20T11:59:59Z"}),
        &settings
    ));
    assert!(assignment_after_enable(
        &json!({"created_at":"2026-10-20T12:00:01Z"}),
        &settings
    ));
    assert!(assignment_after_enable(
        &json!({"created_at":"2026-10-20T20:00:01+08:00"}),
        &settings
    ));
    assert!(!assignment_after_enable(
        &json!({"created_at":"2026-10-20T20:00:01"}),
        &settings
    ));
    assert!(!assignment_after_enable(
        &json!({"created_at":"invalid"}),
        &settings
    ));
}

#[tokio::test]
async fn existing_manual_binding_prevents_another_device_from_creating_a_task() {
    let bindings = Arc::new(AtomicUsize::new(0));
    let calls = bindings.clone();
    let router = Router::new()
            .route("/api/v1/loop-items/issue/assignments", get(|| async { Json(json!({"items":[{"id":"assignment","status":"active","created_at":"2026-10-20T12:00:01Z"}]})) }))
            .route("/api/v1/loop-items/issue/tasks", get(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Json(json!([{"human_assignment_id":"human","device_id":"other"}])) }
            }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: url,
        auth_token: "test".into(),
        ..Default::default()
    })));
    let config = json!({"projectId":"project","userId":7,"enabledAfter":"2026-10-20T12:00:00Z"});
    let issue = json!({"id":"issue","assignee_user_id":7,"human_task_binding":{"humanAssignmentId":"human","assignmentId":"assignment"}});
    handler.start_cloud_stand_in(&config, &issue).await.unwrap();
    assert_eq!(bindings.load(Ordering::SeqCst), 1);
    assert!(handler.local_task_link("stand-in-human").is_none());
    server.abort();
}

#[tokio::test]
async fn manual_cloud_retry_reaches_preparation_without_mutating_an_existing_binding() {
    let mutations = Arc::new(AtomicUsize::new(0));
    let writes = mutations.clone();
    let router = Router::new()
        .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
        .route("/api/v1/cloud-projects/project", get(|| async { Json(json!({"access_role":"Developer"})) }))
        .route("/api/v1/cloud-projects/project/execution-environments", get(|| async { Json(json!({"items":[{"device_key":"mac","can_use":true}]})) }))
        .route("/api/v1/loop-items/issue/assignments", get(|| async { Json(json!({"items":[{"id":"assignment","status":"active"}]})) }))
        .route("/api/v1/loop-items/issue/tasks", get(|| async { Json(json!([{"human_assignment_id":"human","device_id":"mac","task_id":"stand-in-human"}])) }).post(move || {
            writes.fetch_add(1, Ordering::SeqCst);
            async { Json(json!({})) }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: url,
        auth_token: "test".into(),
        ..Default::default()
    })));
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "stand-in-human".into(),
        status: "failed".into(),
        ..RuntimeTaskLink::default()
    });
    let mut config = json!({"projectId":"project","projectStore":"cloud","userId":7,"manual":true,"workspace":{"projectKey":"unregistered-retry-project"}});
    let issue = json!({"id":"issue","assignee_user_id":7,"human_task_binding":{"humanAssignmentId":"human","assignmentId":"assignment"}});
    let error = handler
        .start_cloud_stand_in(&config, &issue)
        .await
        .unwrap_err();
    assert_eq!(error.code, "workspace_unavailable");
    config["manual"] = json!(false);
    handler.start_cloud_stand_in(&config, &issue).await.unwrap();
    assert_eq!(mutations.load(Ordering::SeqCst), 0);
    assert_eq!(
        handler.local_task_link("stand-in-human").unwrap().status,
        "failed"
    );
    server.abort();
}

#[tokio::test]
async fn rejected_local_creation_rolls_back_the_issue_binding() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Stand-in"})).unwrap())
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Issue"})).unwrap(),
        )
        .unwrap();
    let error = handler
        .create_stand_in_task(
            &json!({"projectId":project.id,"projectStore":"local"}),
            &serde_json::to_value(&issue).unwrap(),
            &json!({"humanAssignmentId":"human"}),
            json!({"schemaVersion":99}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "unsupported_schema_version");
    assert!(store
        .find_user_task_binding("mac", "stand-in-human")
        .is_err());
    assert!(handler.local_task_link("stand-in-human").is_none());
}

#[tokio::test]
async fn rejected_cloud_creation_rolls_back_the_issue_binding() {
    let bindings = Arc::new(AtomicUsize::new(0));
    let created = bindings.clone();
    let removed = bindings.clone();
    let router = Router::new()
        .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
        .route(
            "/api/v1/cloud-projects/project",
            get(|| async { Json(json!({"access_role":"Developer"})) }),
        )
        .route(
            "/api/v1/cloud-projects/project/execution-environments",
            get(|| async { Json(json!({"items":[{"device_key":"mac","can_use":true}]})) }),
        )
        .route(
            "/api/v1/loop-items/issue/tasks",
            axum::routing::post(move || {
                created.fetch_add(1, Ordering::SeqCst);
                async { Json(json!({"id":1})) }
            })
            .delete(move || {
                removed.fetch_sub(1, Ordering::SeqCst);
                async { axum::http::StatusCode::NO_CONTENT }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let runtime_root = tempfile::tempdir().unwrap();
    let handler = RuntimeWorkRpcHandler {
        store: RuntimeWorkStore::new(runtime_root.path().join("runtime-index.json")),
        backend_connection: Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: url,
            auth_token: "test".into(),
            ..Default::default()
        }))),
        ..RuntimeWorkRpcHandler::new("mac", "unused")
    };
    let error = handler
        .create_stand_in_task(
            &json!({"projectId":"project","projectStore":"cloud","userId":7}),
            &json!({"id":"issue","title":"Issue"}),
            &json!({"humanAssignmentId":"human"}),
            json!({"schemaVersion":99}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "unsupported_schema_version");
    assert_eq!(bindings.load(Ordering::SeqCst), 0);
    server.abort();
}

#[tokio::test]
async fn executor_rejects_settings_for_a_different_device() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let error = handler.stand_in_settings(json!({"projectId":"project","userId":7,"projectStore":"local","settings":{"executionDeviceId":"cloud"}}), true).await.unwrap_err();
    assert_eq!(error.code, "wrong_device");
}

#[tokio::test]
async fn explicit_retry_reuses_failed_task_and_rolls_back_a_rejected_restart() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "stand-in-human".into(),
        status: "failed".into(),
        workspace_path: root.path().to_string_lossy().into_owned(),
        ..RuntimeTaskLink::default()
    });
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Retry"})).unwrap())
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Issue"})).unwrap(),
        )
        .unwrap();
    let config = json!({"projectId":project.id,"projectStore":"local"});
    let binding = json!({"humanAssignmentId":"human"});
    let payload = json!({"taskId":"stand-in-human","executionRequest":{"schema_version":99}});
    handler
        .create_stand_in_task(
            &config,
            &serde_json::to_value(&issue).unwrap(),
            &binding,
            payload.clone(),
        )
        .await
        .unwrap();
    assert!(store
        .find_user_task_binding("mac", "stand-in-human")
        .is_err());
    let mut explicit = config;
    explicit["manual"] = json!(true);
    assert!(handler
        .create_stand_in_task(
            &explicit,
            &serde_json::to_value(&issue).unwrap(),
            &binding,
            payload
        )
        .await
        .is_err());
    assert!(store
        .find_user_task_binding("mac", "stand-in-human")
        .is_err());
    assert_eq!(
        handler.local_task_link("stand-in-human").unwrap().status,
        "failed"
    );
}

#[tokio::test]
async fn personal_stand_in_checks_actor_without_project_device_setup() {
    let router = Router::new().route("/api/users/me", get(|| async { Json(json!({"id":7})) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let handler = RuntimeWorkRpcHandler {
        store: RuntimeWorkStore::new(root.path().join("runtime-index.json")),
        backend_connection: Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: url,
            auth_token: "test".into(),
            ..Default::default()
        }))),
        ..RuntimeWorkRpcHandler::new("mac", "unused")
    };
    let mut config = json!({"projectId":"project","userId":8});
    assert_eq!(
        handler
            .verify_stand_in_user(&config)
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
    config["userId"] = json!(7);
    handler.verify_stand_in_user(&config).await.unwrap();
    server.abort();
}

#[tokio::test]
async fn enabled_settings_save_offline_without_agent_model_or_workspace_preparation() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let prompt = "x".repeat(16000);
    let settings = json!({
        "enabled":true,"executionDeviceId":"mac","version":0,"prompt":prompt,
        "name":"n".repeat(200),"tags":(0..60).map(|n| n.to_string()).collect::<Vec<_>>(),
        "agentId":"not-loaded",
        "model":{"runtime":"codex","provider":"native","model_id":"not-loaded"},
        "workspace":{"projectKey":"not-indexed","workspacePath":"/not-present","executionMode":"git_worktree"}
    });
    let saved = handler
        .stand_in_settings(
            json!({
                "projectId":"cloud-project","projectStore":"cloud","userId":7,"settings":settings
            }),
            true,
        )
        .await
        .unwrap();
    assert_eq!(saved["enabled"], true);
    assert_eq!(saved["version"], 1);
    assert_eq!(saved["prompt"], prompt);
    assert_eq!(saved["workspace"], settings["workspace"]);
}

#[tokio::test]
async fn default_personal_task_needs_no_project_environment() {
    let handler = RuntimeWorkRpcHandler::new("mac", "unused");
    let payload = handler
        .prepare_stand_in_task(
            &json!({"projectStore":"local","projectId":"not-configured","userId":7}),
            &json!({"id":"issue","title":"Task"}),
            &json!({"humanAssignmentId":"human"}),
        )
        .await
        .unwrap();
    assert_eq!(payload["taskId"], "stand-in-human");
    assert_eq!(payload["executionRequest"]["bot"][0]["shell_type"], "Codex");
    assert!(payload.get("workspacePath").is_none());
    let request = execution_request(&payload).unwrap();
    assert!(is_standalone_chat_workspace(&request));
}

#[test]
fn cloud_assignments_created_in_the_enable_second_are_not_lost() {
    let settings =
        json!({"projectStore":"cloud","enabledAfter":"2026-10-22T06:54:17.591610+00:00"});
    assert!(assignment_after_enable(
        &json!({"created_at":"2026-10-22T06:54:17Z"}),
        &settings
    ));
    assert!(!assignment_after_enable(
        &json!({"created_at":"2026-10-22T06:54:16Z"}),
        &settings
    ));
    assert!(!assignment_after_enable(
        &json!({"created_at":"2026-10-22T06:54:17Z"}),
        &json!({"projectStore":"local","enabledAfter":settings["enabledAfter"]})
    ));
}
