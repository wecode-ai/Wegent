use super::*;
use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, put},
    Json, Router,
};

pub(in crate::runtime_work::handler) fn fixture() -> (
    tempfile::TempDir,
    RuntimeWorkRpcHandler,
    LocalTaskStore,
    Value,
    Value,
) {
    let directory = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("runner-a", "/bin/false");
    handler.task_store_path = Arc::new(directory.path().join("tasks.sqlite"));
    handler.turn_queue_path = Arc::new(directory.path().join("queue.json"));
    handler.store = RuntimeWorkStore::new(directory.path().join("runtime.json"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Protocol"})).unwrap())
        .unwrap();
    let agent = store.create_chat_agent(&project.id,serde_json::from_value(json!({"name":"Leader","execution_mode":"auto",
        "execution_policy":{"mode":"project_pool"},"model_policy":{"mode":"fixed","model":{"runtime":"codex","provider":"test","model_id":"model"}}})).unwrap()).unwrap();
    store.update_project(&project.id,serde_json::from_value(json!({"version":project.version,"execution_environment":{"repositories":[],"setup_steps":[],"devices":{}},
        "collaboration_groups":[{"id":"group","name":"Team","leader":{"kind":"agent","id":agent.id},"members":[]}]})).unwrap()).unwrap();
    let binding = store
        .set_project_coordination_binding(
            &project.id,
            "group",
            7,
            "runner-a",
            &json!({"enabled":true,"expectedGeneration":null}),
        )
        .unwrap();
    let project = store.get_project(&project.id).unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Work"})).unwrap(),
        )
        .unwrap();
    let payload = json!({"userId":7,"projectStore":"local","projectId":project.id,"groupId":"group","commandId":"one",
        "input":{"generation":binding["generation"],"projectVersion":project.version,"issueId":issue.id,"issueVersion":issue.version,
            "groupVersion":LocalTaskStore::coordination_event_version(&project.metadata["collaboration_groups"][0]),"userId":999,"deviceId":"forged"}});
    let catalog = json!({"models":[{"runtime":"codex","provider":"test","model_id":"model","local_model_id":"native","account_label":"Fixture"}]});
    (directory, handler, store, payload, catalog)
}

#[tokio::test]
async fn local_command_rpc_uses_real_issue_queue_and_checks_original_runtime_identity() {
    let (_directory, handler, store, payload, catalog) = fixture();
    let receipt = handler
        .dispatch_method(
            "runtime.project_coordinator.command.dispatch",
            payload.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        handler
            .dispatch_method("runtime.project_coordinator.command.get", payload.clone())
            .await
            .unwrap(),
        receipt
    );
    assert!(handler.local_task_links(true).is_empty());
    let claimed = store
        .claim_next_execution_with_catalog(Some("runner-a"), "runner-a", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    let runtime_payload = claimed.execution_payload.as_ref().unwrap();
    let mut request = execution_request(runtime_payload).unwrap();
    apply_runtime_payload_metadata(&mut request, runtime_payload);
    assert_eq!(request.extra["user_id"], 7);
    assert_eq!(
        request.extra["origin"]["project_coordination"]["deviceId"],
        "runner-a"
    );
    handler
        .validate_project_coordinator_request(&request)
        .await
        .unwrap();
    let mut forged = request.clone();
    forged.task_id = "another-task".into();
    assert!(handler
        .validate_project_coordinator_request(&forged)
        .await
        .is_err());
    forged = request.clone();
    forged.extra["origin"]["project_coordination"]["userId"] = json!(999);
    assert!(handler
        .validate_project_coordinator_request(&forged)
        .await
        .is_err());
    store
        .set_project_coordination_binding(
            payload["projectId"].as_str().unwrap(),
            "group",
            7,
            "runner-a",
            &json!({"enabled":false,"expectedGeneration":payload["input"]["generation"]}),
        )
        .unwrap();
    assert!(handler
        .validate_project_coordinator_request(&request)
        .await
        .is_err());
}

#[tokio::test]
async fn revocation_of_native_accepted_unstarted_work_releases_queue_scope() {
    let (_directory, handler, store, payload, catalog) = fixture();
    handler
        .dispatch_method(
            "runtime.project_coordinator.command.dispatch",
            payload.clone(),
        )
        .await
        .unwrap();
    let claimed = store
        .claim_next_execution_with_catalog(Some("runner-a"), "runner-a", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    let task = claimed.runtime_task_id.clone().unwrap();
    let runtime_payload = claimed.execution_payload.as_ref().unwrap();
    let mut request = execution_request(runtime_payload).unwrap();
    apply_runtime_payload_metadata(&mut request, runtime_payload);
    store
        .request_runtime_start(claimed.id, "runner-a", &task, 300)
        .unwrap()
        .unwrap();
    store
        .confirm_runtime_accepted(claimed.id, "runner-a", &task, 300)
        .unwrap()
        .unwrap();
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        task.clone(),
        "/tmp/coordination-fixture".into(),
        "Queued work".into(),
    ));
    handler
        .queue_turn(SpawnTurnRequest {
            task_kind: None,
            local_task_id: task.clone(),
            runtime: "codex".into(),
            request,
            send_payload: None,
            direct_thread_id: None,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: None,
            initial_thread_goal: None,
        })
        .await
        .unwrap();
    assert!(handler.is_queued_local_task(&task));
    assert_eq!(
        super::super::turns::read_runtime_turn_queue(handler.turn_queue_path.as_ref())
            .unwrap()
            .len(),
        1
    );
    store
        .set_project_coordination_binding(
            payload["projectId"].as_str().unwrap(),
            "group",
            7,
            "runner-a",
            &json!({"enabled":false,"expectedGeneration":payload["input"]["generation"]}),
        )
        .unwrap();
    handler.reconcile_local_project_coordination().await;
    assert!(!handler.is_queued_local_task(&task));
    assert!(!handler.is_active_local_task(&task));
    assert!(
        super::super::turns::read_runtime_turn_queue(handler.turn_queue_path.as_ref())
            .unwrap()
            .is_empty()
    );
    let rows = store
        .list_executions(payload["projectId"].as_str().unwrap(), None, None, true)
        .unwrap();
    assert_eq!(rows[0].status, "cancelled");
    assert!(rows[0].started_at.is_none());
    assert!(rows[0].completed_at.is_some());
    handler.reconcile_local_project_coordination().await;
    assert!(store
        .reconcile_project_coordination_authority()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn cloud_command_protocol_keeps_actor_device_and_structured_error_boundaries() {
    let submitted = Arc::new(Mutex::new(Vec::<Value>::new()));
    let app = Router::new()
        .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
        .route(
            "/api/v1/cloud-projects/1001/coordinator-bindings/101/commands/one",
            put(
                |State(calls): State<Arc<Mutex<Vec<Value>>>>, Json(body): Json<Value>| async move {
                    calls.lock().unwrap().push(body.clone());
                    match body["generation"].as_str().unwrap_or_default() {
                        "revoked" => (
                            StatusCode::FORBIDDEN,
                            Json(json!({"detail":"Execution permission revoked"})),
                        ),
                        "stale" => (
                            StatusCode::CONFLICT,
                            Json(json!({"detail":"Binding changed"})),
                        ),
                        _ => (StatusCode::OK, Json(json!({"accepted":true}))),
                    }
                },
            ),
        )
        .with_state(submitted.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
    let mut handler = RuntimeWorkRpcHandler::new("actual-host", "/bin/false");
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: url,
        auth_token: "fixture".into(),
        ..Default::default()
    })));
    let payload = json!({"userId":7,"projectStore":"cloud","projectId":"1001","groupId":"101","commandId":"one","input":{"generation":"current","deviceId":"forged"}});
    assert_eq!(
        handler
            .dispatch_method(
                "runtime.project_coordinator.command.dispatch",
                payload.clone()
            )
            .await
            .unwrap()["accepted"],
        true
    );
    assert_eq!(submitted.lock().unwrap()[0]["deviceId"], "actual-host");
    for (generation, code) in [("revoked", "permission_denied"), ("stale", "stale_context")] {
        let mut changed = payload.clone();
        changed["input"]["generation"] = json!(generation);
        assert_eq!(
            handler
                .dispatch_method("runtime.project_coordinator.command.dispatch", changed)
                .await
                .unwrap_err()
                .code,
            code
        );
    }
    let mut other = payload;
    other["userId"] = json!(8);
    assert_eq!(
        handler
            .dispatch_method("runtime.project_coordinator.command.dispatch", other)
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
    assert_eq!(submitted.lock().unwrap().len(), 3);
    server.abort();
}

#[tokio::test]
async fn private_project_turns_reject_changed_project_or_group_configuration() {
    let (_directory, handler, store, payload, _) = fixture();
    let project = payload["projectId"].as_str().unwrap();
    let context = store.project_coordinator_context(project, "group").unwrap();
    let again = store.project_coordinator_context(project, "group").unwrap();
    assert_eq!(context["group"]["version"], again["group"]["version"]);
    assert!(context["group"]["version"].is_string());
    let current = store.get_project(project).unwrap();
    assert_eq!(context["project"]["version"], current.version);
    assert_eq!(
        context["group"]["version"],
        LocalTaskStore::coordination_event_version(&current.metadata["collaboration_groups"][0])
    );
    let mut request = ExecutionRequest::default();
    request.extra.insert("origin".into(),json!({"type":"project_coordinator","userId":7,"deviceId":"runner-a","projectStore":"local",
        "cloudProjectId":project,"groupId":"group","projectVersion":context["project"]["version"],
        "groupVersion":context["group"]["version"],"leaderId":context["group"]["leader"]["id"],"agentVersion":context["agent"]["version"]}));
    handler
        .validate_project_coordinator_request(&request)
        .await
        .unwrap();
    let updated = store
        .update_project(
            project,
            serde_json::from_value(
                json!({"version":current.version,"description":"New project goal"}),
            )
            .unwrap(),
        )
        .unwrap();
    assert!(handler
        .validate_project_coordinator_request(&request)
        .await
        .is_err());
    request.extra["origin"]["projectVersion"] = json!(updated.version);
    handler
        .validate_project_coordinator_request(&request)
        .await
        .unwrap();
    let mut groups = updated.metadata["collaboration_groups"].clone();
    groups[0]["instructions"] = json!("Updated shared instructions");
    let updated = store
        .update_project(
            project,
            serde_json::from_value(
                json!({"version":updated.version,"collaboration_groups":groups}),
            )
            .unwrap(),
        )
        .unwrap();
    request.extra["origin"]["projectVersion"] = json!(updated.version);
    assert_eq!(
        store.project_coordinator_context(project, "group").unwrap()["group"]["leader"]["id"],
        context["group"]["leader"]["id"]
    );
    assert!(handler
        .validate_project_coordinator_request(&request)
        .await
        .is_err());
}

#[tokio::test]
async fn missing_cloud_project_version_never_becomes_a_valid_null_revision() {
    let app = Router::new()
        .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
        .route(
            "/api/v1/cloud-projects/1001",
            get(|| async { Json(json!({"id":"1001","name":"Project"})) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
    let mut handler = RuntimeWorkRpcHandler::new("runner-a", "/bin/false");
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: url,
        auth_token: "fixture".into(),
        ..Default::default()
    })));
    assert_eq!(
        handler
            .project_coordinator_context(7, "cloud", "1001", "101")
            .await
            .unwrap_err()
            .code,
        "cloud_response_invalid"
    );
    server.abort();
}
