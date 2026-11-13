use super::*;

pub(super) struct EnvGuard(&'static str, Option<std::ffi::OsString>);
impl EnvGuard {
    pub(super) fn home(path: &str) -> Self {
        Self::set("WEGENT_EXECUTOR_HOME", path)
    }
    pub(super) fn set(key: &'static str, path: &str) -> Self {
        let old = std::env::var_os(key);
        std::env::set_var(key, path);
        Self(key, old)
    }
}
impl Drop for EnvGuard {
    fn drop(&mut self) {
        match self.1.take() {
            Some(value) => std::env::set_var(self.0, value),
            None => std::env::remove_var(self.0),
        }
    }
}

pub(super) fn seed(handler: &RuntimeWorkRpcHandler, task: &str) -> RuntimeTaskLink {
    let mut link =
        RuntimeTaskLink::new_pending(task.into(), "/tmp/control-workspace".into(), task.into());
    link.thread_id = Some(format!("thread-{task}"));
    link.runtime_handle = json!({"runtime":"codex","executionRequest":{"model_config":{"api_key":"private-secret"}},
        "modelSelection":{"modelName":"test","modelType":"runtime","options":{"api_key":"private-secret"}}});
    handler.store.upsert_task(link.clone());
    link
}

pub(super) fn context(task: &str) -> ControlContext {
    let mut request = ExecutionRequest::default();
    crate::runtime_work::api_context::inject_current_session(
        &mut request,
        "control-test-device",
        task,
    );
    ControlContext::from_request(&request).unwrap()
}

#[test]
fn continuation_restores_selected_mode_from_legacy_execution_snapshot() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
        for (selection_key, option_key) in [("modelSelection", "collaborationMode"), ("model_selection", "collaboration_mode")] {
            for mode in ["default", "plan"] {
                let mut link = seed(&handler, "target");
                link.runtime_handle = json!({"executionRequest":{"collaboration_model":"single"},
                    selection_key:{"modelName":"test","modelType":"runtime","options":{option_key:mode}}});
                let payload = handler.control_execution_payload(&link, "Continue original work", "message").await.unwrap();
                let mut request = execution_request(&payload).unwrap();
                apply_runtime_payload_metadata(&mut request, &payload);
                assert_eq!(request.extra["collaborationMode"], mode);
                assert_eq!(request.extra["collaboration_model"], "single");
                assert_eq!(request.task_id, "target");
                assert!(!request.new_session);
            }
        }
    });
}

#[test]
fn control_context_preserves_personal_authority_and_denies_all_dispatch_aliases() {
    let original = context("caller").request;
    for key in ["dispatchRole", "dispatch_role", "dispatchId", "dispatch_id"] {
        let mut delegated = original.clone();
        delegated
            .extra
            .insert("origin".into(), json!({key:"executor"}));
        assert!(ControlContext::from_request(&delegated).is_none(), "{key}");
    }
    for origin_type in [
        "stand_in_identity",
        "connection_work",
        "dingtalk_work",
        "stand_in_coordinator",
        "stand_in_task",
        "project_coordinator",
    ] {
        let mut restricted = original.clone();
        restricted
            .extra
            .insert("origin".into(), json!({"type":origin_type}));
        assert!(ControlContext::from_request(&restricted).is_none());
    }
    for extra in [
        json!({"standInDelegation":{"sourceTaskId":"primary","askBeforeAct":true}}),
        json!({"origin":{"project_coordination":{"userId":7,"projectId":"project"}}}),
    ] {
        let mut restricted = original.clone();
        restricted.extra.extend(extra.as_object().unwrap().clone());
        assert!(ControlContext::from_request(&restricted).is_none());
    }
    assert!(ControlContext::from_request(&ExecutionRequest::default()).is_none());
}

#[test]
fn capability_contract_rejects_unknown_payloads_and_invalid_types() {
    for input in [
        json!({"query":"x","executionRequest":{}}),
        json!({"query":"x","limit":0}),
        json!({"query":"x","limit":"20"}),
        json!({}),
    ] {
        assert!(workbench_control::validate_arguments("search_conversations", &input).is_err());
    }
    assert!(
        workbench_control::validate_arguments("runtime.codex.app_server.request", &json!({}))
            .is_err()
    );
    assert!(workbench_control::validate_arguments(
        "search_conversations",
        &json!({"query":"x","limit":20})
    )
    .is_ok());
    let valid = json!({"name":"CI","prompt":"Check CI","schedule":{"type":"interval","value":5,"unit":"minutes"},"timezone":"Asia/Shanghai"});
    assert!(workbench_control::validate_arguments("create_automation", &valid).is_ok());
    for schedule in [
        json!({"type":"interval","value":0,"unit":"minutes"}),
        json!({"type":"interval","value":5,"unit":"seconds"}),
        json!({"type":"one_time","execute_at":"tomorrow"}),
        json!({"type":"cron","expression":"* * * * *","executionRequest":{}}),
    ] {
        let mut input = valid.clone();
        input["schedule"] = schedule;
        assert!(workbench_control::validate_arguments("create_automation", &input).is_err());
    }
}

#[test]
fn pr_identity_is_exact_and_does_not_accept_arbitrary_urls() {
    assert_eq!(
        canonical_pr("https://GITHUB.com/acme/repo/pull/12/?tab=checks#x").unwrap(),
        "https://github.com/acme/repo/pull/12"
    );
    assert_eq!(
        canonical_pr("https://github.com/ACME/Repo/pull/0012").unwrap(),
        "https://github.com/acme/repo/pull/12"
    );
    assert_eq!(
        canonical_pr("https://git.company/a/b/repo/-/merge_requests/9").unwrap(),
        "https://git.company/a/b/repo/-/merge_requests/9"
    );
    for invalid in [
        "https://github.com/acme/repo/issues/12",
        "https://user:password@github.com/acme/repo/pull/12",
        "http://github.com/acme/repo/pull/12",
        "https://github.com/acme/repo/pull/0",
    ] {
        assert!(canonical_pr(invalid).is_err());
    }
}

#[test]
fn metadata_binding_and_discovery_survive_reload_without_exposing_profiles() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            seed(&handler, "caller");
            let link = seed(&handler, "target");
            let ctx = context("caller");
            let id = workbench_control::conversation_id("control-test-device", "target");
            let view = handler
                .control_operation(&ctx, "get_conversation", json!({"conversation_id":id}))
                .await
                .unwrap();
            assert_eq!(view["taskId"], "target");
            assert!(!view.to_string().contains("private-secret"));
            assert!(view.get("runtimeHandle").is_none());
            handler
                .control_bind_pr(link, &json!({"url":"https://github.com/acme/repo/pull/12"}))
                .unwrap();
            let reloaded = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            let found = reloaded
                .control_find_pr(&json!({"url":"https://github.com/acme/repo/pull/12#checks"}))
                .unwrap();
            assert_eq!(found["resolution"], "unique");
            assert_eq!(found["items"][0]["conversation_id"], id);
            let other = seed(&reloaded, "other");
            reloaded
                .control_bind_pr(
                    other,
                    &json!({"url":"https://github.com/acme/repo/pull/12"}),
                )
                .unwrap();
            assert_eq!(
                reloaded
                    .control_find_pr(&json!({"url":"https://github.com/acme/repo/pull/12"}))
                    .unwrap()["resolution"],
                "ambiguous"
            );
            assert_eq!(
                reloaded
                    .control_find_pr(&json!({"url":"https://github.com/other/repo/pull/12"}))
                    .unwrap()["resolution"],
                "missing"
            );
        });
}

#[test]
fn schedules_use_non_secret_intent_and_require_the_current_version() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            seed(&handler, "caller");
            let ctx = context("caller");
            let result = handler.control_operation(&ctx,"create_automation",json!({"name":"CI patrol","prompt":"Check failed CI and continue its bound conversation",
                "schedule":{"type":"interval","value":5,"unit":"minutes"},"timezone":"Asia/Shanghai"})).await.unwrap();
            let id = result["automation"]["id"].as_str().unwrap();
            assert!(result["automation"].get("taskPayload").is_none());
            let persisted = handler.automation_store.get(id).unwrap();
            assert_eq!(persisted.task_request["sourceTaskId"], "caller");
            assert!(!serde_json::to_string(&persisted)
                .unwrap()
                .contains("private-secret"));
            let updated = handler
                .control_operation(
                    &ctx,
                    "update_automation",
                    json!({"automation_id":id,"version":1,"name":"Updated"}),
                )
                .await
                .unwrap();
            assert_eq!(updated["automation"]["version"], 2);
            assert!(handler
                .control_operation(
                    &ctx,
                    "update_automation",
                    json!({"automation_id":id,"version":1,"name":"Stale"})
                )
                .await
                .is_err());
        });
}

#[test]
fn pending_delivery_is_not_replayed_and_request_key_conflicts_are_rejected() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            seed(&handler, "caller");
            let target = seed(&handler, "target");
            let operation_id = format!(
                "op_{:x}",
                Sha256::digest("control-test-device\0target\0ci-run-12-attempt-1")
            );
            let path = handler
                .store
                .index_path()
                .with_file_name("control-operations.json");
            workbench_control::journal::transact(&path, |state| {
                state["operations"][&operation_id] = json!({"operation_id":operation_id,"fingerprint":format!("{:x}",Sha256::digest(json!({"message":"Fix CI","queue_if_busy":true}).to_string())),"delivery_status":"pending"});
                Ok(())
            }).unwrap();
            let args = json!({"conversation_id":workbench_control::conversation_id("control-test-device","target"),"message":"Fix CI","request_key":"ci-run-12-attempt-1"});
            let receipt = handler
                .control_continue(&context("caller"), target.clone(), args.clone())
                .await
                .unwrap();
            assert_eq!(receipt["duplicate"], true);
            assert_eq!(receipt["operation"]["delivery_status"], "pending");
            assert!(!handler.is_busy_local_task("target"));
            let mut explicit_default = args.clone();
            explicit_default["queue_if_busy"] = json!(true);
            assert_eq!(
                handler
                    .control_continue(&context("caller"), target.clone(), explicit_default)
                    .await
                    .unwrap()["duplicate"],
                true
            );
            let mut changed_policy = args.clone();
            changed_policy["queue_if_busy"] = json!(false);
            assert_eq!(
                handler
                    .control_continue(&context("caller"), target.clone(), changed_policy)
                    .await
                    .unwrap_err()
                    .code,
                "conflict"
            );
            let mut conflict = args;
            conflict["message"] = json!("A different instruction");
            assert_eq!(
                handler
                    .control_continue(&context("caller"), target, conflict)
                    .await
                    .unwrap_err()
                    .code,
                "conflict"
            );
        });
}

#[test]
fn journal_corruption_and_write_failures_never_become_success() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("operations.json");
    fs::write(&path, "broken").unwrap();
    assert!(workbench_control::journal::transact(&path, |_| Ok(())).is_err());
    for invalid in [
        json!(null),
        json!({"version":2,"operations":{}}),
        json!({"version":1,"operations":[]}),
    ] {
        fs::write(&path, invalid.to_string()).unwrap();
        assert!(workbench_control::journal::transact(&path, |_| Ok(())).is_err());
    }
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(workbench_control::journal::transact(&path, |_| Ok(())).is_err());
}

#[test]
fn foreign_devices_and_forged_personal_contexts_are_rejected() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            let mut source = seed(&handler, "caller");
            let ctx = context("caller");
            let mut target = seed(&handler, "delegated-target");
            target.runtime_handle["origin"] = json!({"dispatchRole":"executor"});
            handler.store.upsert_task(target);
            let error = handler.control_operation(&ctx, "continue_conversation", json!({"conversation_id":workbench_control::conversation_id("control-test-device","delegated-target"),"message":"bypass","request_key":"bypass"})).await.unwrap_err();
            assert_eq!(error.code, "permission_denied");
            assert!(error.message.contains("Target conversation"));
            assert!(error.message.contains("origin.dispatchRole (executor)"));
            assert_eq!(handler.control_target(&json!({"conversation_id":workbench_control::conversation_id("other-device","caller")})).unwrap_err().code,"wrong_device");
            for metadata in [
                json!({"origin":{"dispatchRole":"executor"}}),
                json!({"origin":{"type":"stand_in_coordinator"}}),
                json!({"origin":{"type":"stand_in_task"}}),
                json!({"origin":{"type":"project_coordinator"}}),
                json!({"origin":{"project_coordination":{"projectId":"project"}}}),
                json!({"executionRequest":{"standInDelegation":{"sourceTaskId":"primary","askBeforeAct":true}}}),
            ] {
                source.runtime_handle = metadata;
                handler.store.upsert_task(source.clone());
                assert_eq!(
                    handler
                        .control_operation(&ctx, "list_automations", json!({}))
                        .await
                        .unwrap_err()
                        .code,
                    "permission_denied"
                );
            }
        });
}

#[test]
fn local_creation_binds_project_or_issue_and_preserves_personal_scope() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let _native: Vec<_> = [
                "CODEX_HOME",
                "WEGENT_CODEX_HOME",
                "WEGENT_WORKBENCH_HOME",
                "WEGENT_CAPABILITIES_HOME",
                "CODEX_SQLITE_HOME",
            ]
            .into_iter()
            .map(|key| EnvGuard::set(key, root.path().join(key).to_str().unwrap()))
            .collect();
            let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            let mut caller = seed(&handler, "caller");
            caller.runtime_handle["origin"] = json!({"type":"board_task","cloudProjectId":"old-project","loopItemId":"old-issue","projectStore":"local"});
            caller.runtime_handle["executionRequest"]["origin"] = caller.runtime_handle["origin"].clone();
            caller.runtime_handle["executionRequest"]["attachments"] =
                json!([{"file_path":"old-private-file"}]);
            handler.store.upsert_task(caller);
            let mut delegated = seed(&handler, "delegated");
            delegated.runtime_handle["origin"] = json!({"dispatchRole":"executor"});
            handler.store.upsert_task(delegated);
            assert_eq!(
                handler
                    .control_operation(
                        &context("caller"),
                        "create_conversation",
                        json!({"message":"create","options":{"runtime":"claude_code"}})
                    )
                    .await
                    .unwrap_err()
                    .code,
                "model_configuration_required"
            );
            assert_eq!(handler.control_operation(&context("caller"),"create_conversation",json!({"message":"create",
                "reference_conversation_id":workbench_control::conversation_id("control-test-device","delegated")})).await.unwrap_err().code,"permission_denied");
            handler.sync_creation_model_profiles(json!({"profiles":[{"runtime":"codex","modelName":"new-model","modelConfig":{"model_id":"test"}}]})).unwrap();
            let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
            let project = store
                .create_project(serde_json::from_value(json!({"name":"Creation"})).unwrap())
                .unwrap();
            let issue = store
                .create_task(
                    &project.id,
                    serde_json::from_value(json!({"title":"Issue"})).unwrap(),
                )
                .unwrap();
            let mut args = json!({"message":"create","workspace_path":root.path(),
                "options":{"modelSelection":{"modelName":"new-model","modelType":"runtime"},"execution":{"workspace":{"source":"git_worktree"}}},
                "project_space":{"space_id":project.id,"item_id":issue.id,"store":"local"}});
            assert!(handler
                .control_operation(&context("caller"), "create_conversation", args.clone())
                .await
                .is_err());
            assert!(store.list_task_bindings(&issue.id).unwrap().is_empty());
            args["options"].as_object_mut().unwrap().remove("execution");
            args["options"]
                .as_object_mut()
                .unwrap()
                .remove("modelSelection");
            args["project_space"]
                .as_object_mut()
                .unwrap()
                .remove("item_id");
            let result = handler
                .control_operation(&context("caller"), "create_conversation", args)
                .await
                .unwrap();
            workbench_control::assert_output_contract("create_conversation", &result);
            assert_eq!(result["accepted"], true);
            let task = result["taskId"].as_str().unwrap();
            let binding = store
                .find_user_task_binding("control-test-device", task)
                .unwrap();
            assert_eq!(binding.cloud_project_id, project.id);
            assert!(binding.loop_item_id.is_none());
            let link = handler.store.get_task(task).unwrap();
            assert_ne!(
                link.runtime_handle["origin"]["cloudProjectId"],
                "old-project"
            );
            assert!(!link.runtime_handle.to_string().contains("old-private-file"));
            let visible = handler
                .control_operation(
                    &context("caller"),
                    "get_conversation",
                    json!({"conversation_id":result["conversation_id"]}),
                )
                .await
                .unwrap();
            assert_eq!(visible["origin"]["projectStore"], "local");
            handler.codex_app_server.restart().await;
        });
}

#[test]
fn remote_creation_binds_before_dispatch_and_rolls_back_definite_rejection() {
    use axum::{
        http::StatusCode,
        response::IntoResponse,
        routing::{get, post},
        Json, Router,
    };
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let _backend = EnvGuard::set("WEGENT_BACKEND_URL", "");
            let _domain = EnvGuard::set("TASK_API_DOMAIN", "");
            let calls = Arc::new(Mutex::new(Vec::<String>::new()));
            let reject = Arc::new(AtomicBool::new(false));
            let binding_calls = calls.clone();
            let delete_calls = calls.clone();
            let create_calls = calls.clone();
            let rejected = reject.clone();
            let app = Router::new()
                .route("/deployed/api/v1/loop-items/ISSUE-1", get(|| async { Json(json!({"cloud_project_id":"space"})) }))
                .route("/deployed/api/v1/loop-items/ISSUE-1/tasks", post(move |Json(body): Json<Value>| {
                    let calls = binding_calls.clone();
                    async move { assert_eq!(body["deviceId"], "target-device"); calls.lock().unwrap().push(format!("bind:{}",body["taskId"])); Json(json!({"id":"binding"})) }
                }).delete(move || { let calls = delete_calls.clone(); async move { calls.lock().unwrap().push("rollback".into()); StatusCode::NO_CONTENT } }))
                .route("/deployed/api/runtime-work/create", post(move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                    let calls = create_calls.clone(); let reject = rejected.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer synthetic-token");
                        assert_eq!(body["compileOnDevice"], true);
                        assert_eq!(body["modelId"], "target-model");
                        assert_eq!(body["modelType"], "runtime");
                        assert_eq!(body["modelOptions"]["reasoning"], "high");
                        assert_eq!(body["origin"]["loopItemId"], "ISSUE-1");
                        assert!(body.get("executionRequest").is_none());
                        assert!(body.get("inheritModelConfiguration").is_none());
                        let mut calls = calls.lock().unwrap();
                        assert_eq!(calls.last(), Some(&format!("bind:{}",body["taskId"])));
                        calls.push("create".into());
                        if reject.load(Ordering::SeqCst) { StatusCode::FORBIDDEN.into_response() }
                        else { Json(json!({"accepted":true,"deviceId":body["deviceId"],"taskId":body["taskId"],"runtimeHandle":{"secret":"hidden"}})).into_response() }
                    }
                }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/deployed/api/", listener.local_addr().unwrap());
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let (event_tx, mut event_rx) = broadcast::channel(8);
            let handler = RuntimeWorkRpcHandler::with_event_sender(
                "control-test-device",
                "/bin/false",
                event_tx,
            );
            seed(&handler, "caller");
            let mut ctx = context("caller");
            ctx.request.backend_url = Some(url);
            ctx.request.auth_token = Some("synthetic-token".into());
            let args = json!({"message":"Create remotely","options":{"deviceId":"target-device","runtime":"claude_code",
                "modelSelection":{"modelName":"target-model","modelType":"runtime","options":{"reasoningEffort":"high"}}},
                "project_space":{"space_id":"space","item_id":"ISSUE-1","store":"cloud"}});
            let result = handler
                .control_operation(&ctx, "create_conversation", args.clone())
                .await
                .unwrap();
            assert_eq!(result["device_id"], "target-device");
            assert!(result.get("runtimeHandle").is_none());
            let changed = event_rx
                .try_recv()
                .expect("Accepted creation must invalidate the workbench catalog");
            assert_eq!(changed["event"], "runtime.work.changed");
            assert_eq!(changed["payload"]["deviceId"], "target-device");
            assert_eq!(changed["payload"]["taskId"], result["taskId"]);
            reject.store(true, Ordering::SeqCst);
            let error = handler
                .control_operation(&ctx, "create_conversation", args)
                .await
                .unwrap_err();
            assert_eq!(error.code, "backend_request_rejected");
            assert_eq!(calls.lock().unwrap().last().unwrap(), "rollback");
            assert!(matches!(
                event_rx.try_recv(),
                Err(broadcast::error::TryRecvError::Empty)
            ));
            server.abort();
        });
}

#[test]
fn cloud_mutations_use_the_authorized_backend_and_preserve_deployment_prefixes() {
    use axum::{
        extract::Query,
        routing::{get, post},
        Json, Router,
    };
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let _backend = EnvGuard::set("WEGENT_BACKEND_URL", "");
            let _domain = EnvGuard::set("TASK_API_DOMAIN", "");
            let probe = Arc::new(AtomicBool::new(false));
            let parallel = probe.clone();
            let barrier = Arc::new(tokio::sync::Barrier::new(4));
            let app = Router::new()
                .route(
                    "/deployed/api/v1/runtime-tasks/cloud-context",
                    get(move |Query(address): Query<HashMap<String, String>>| {
                        assert_eq!(address["device_id"], "control-test-device");
                        assert!(address["task_id"].starts_with("cloud-"));
                        let parallel = parallel.clone();
                        let barrier = barrier.clone();
                        async move {
                            if parallel.load(Ordering::SeqCst) {
                                barrier.wait().await;
                            }
                            Json(json!({"task_id":address["task_id"],"cloud_project_id":"project"}))
                        }
                    }),
                )
                .route(
                    "/deployed/api/runtime-work/rename",
                    post(|| async { axum::http::StatusCode::FORBIDDEN }),
                )
                .route(
                    "/deployed/api/runtime-work/materialize",
                    post(|Json(body): Json<Value>| async move {
                        assert_eq!(body["newSession"], false);
                        assert_eq!(body["compileOnDevice"], true);
                        assert!(body.get("executionRequest").is_none());
                        axum::http::StatusCode::FORBIDDEN
                    }),
                );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/deployed/api/", listener.local_addr().unwrap());
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            seed(&handler, "caller");
            let mut target = seed(&handler, "cloud-target");
            target.runtime_handle["cloudProjectId"] = json!("project");
            target.runtime_handle["executionRequest"]["model_config"] =
                json!({"base_url":"https://stale.invalid","model_id":"old"});
            handler.store.upsert_task(target);
            handler.retain_runtime_model_config("cloud-target", &json!({"model_id":"test"}));
            let mut ctx = context("caller");
            ctx.request.backend_url = Some(url);
            ctx.request.auth_token = Some("synthetic-session-token".into());
            let id = workbench_control::conversation_id("control-test-device", "cloud-target");
            let view = handler
                .control_operation(&ctx, "get_conversation", json!({"conversation_id":id}))
                .await
                .unwrap();
            assert_eq!(view["title"], "cloud-target");
            let error = handler
                .control_operation(
                    &ctx,
                    "rename_conversation",
                    json!({"conversation_id":id,"title":"unauthorized edit"}),
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "permission_denied");
            assert!(!error.message.contains("synthetic-session-token"));
            assert_eq!(
                handler.store.get_task("cloud-target").unwrap().title,
                "cloud-target"
            );
            let error = handler
                .control_operation(
                    &ctx,
                    "continue_conversation",
                    json!({"conversation_id":id,"message":"Fix CI","request_key":"cloud-ci-run"}),
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "permission_denied");
            let mut links = vec![handler.store.get_task("caller").unwrap()];
            for index in 0..4 {
                let mut link = handler.store.get_task("cloud-target").unwrap();
                link.local_task_id = format!("cloud-probe-{index}");
                links.push(link);
            }
            probe.store(true, Ordering::SeqCst);
            let (authorized, unavailable) = tokio::time::timeout(
                Duration::from_secs(5),
                handler.control_authorized_links(&ctx, links),
            )
            .await
            .expect("Independent cloud permission checks must run concurrently");
            assert_eq!(authorized.len(), 5);
            assert!(unavailable.is_empty());
            server.abort();
        });
}

#[test]
fn cloud_conversation_search_preserves_visible_titles_and_reports_failed_checks() {
    use axum::{
        extract::Query,
        http::StatusCode,
        routing::{get, post},
        Json, Router,
    };
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let _sidebar = EnvGuard::set("CODEX_HOME", root.path().to_str().unwrap());
            let _native = EnvGuard::set("WEGENT_CODEX_HOME", root.path().to_str().unwrap());
            let _backend = EnvGuard::set("WEGENT_BACKEND_URL", "");
            let _domain = EnvGuard::set("TASK_API_DOMAIN", "");
            let invalid = Arc::new(AtomicBool::new(false));
            let validation_error = invalid.clone();
            let app = Router::new().route(
                "/api/runtime-work/transcript",
                post(|| async { (StatusCode::BAD_GATEWAY, Json(json!({"detail":"Remote control is disabled for this app device"}))) }),
            ).route(
                "/api/v1/runtime-tasks/cloud-context",
                get(
                    move |Query(address): Query<HashMap<String, String>>| {
                        let invalid = validation_error.load(Ordering::SeqCst);
                        async move {
                            assert_eq!(address["device_id"], "control-test-device");
                            let status = if address["task_id"] == "cloud-denied" {
                                StatusCode::FORBIDDEN
                            } else if invalid {
                                StatusCode::UNPROCESSABLE_ENTITY
                            } else {
                                StatusCode::OK
                            };
                            (status, Json(json!({"task_id":address["task_id"],"cloud_project_id":"project"})))
                        }
                    },
                ),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let mut handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            crate::runtime_work::handler::tests::install_native_history(
                &mut handler,
                root.path(),
                vec![],
                None,
            );
            let mut caller = seed(&handler, "caller");
            caller.thread_id = None;
            handler.store.upsert_task(caller);
            let title = "发个评论帮我@control-e2e";
            for task in ["cloud-visible", "cloud-denied"] {
                let mut link = seed(&handler, task);
                link.title = title.into();
                link.runtime_handle["cloudProjectId"] = json!("project");
                handler.store.upsert_task(link);
            }
            let mut ctx = context("caller");
            ctx.request.backend_url = Some(url);
            ctx.request.auth_token = Some("synthetic-session-token".into());
            let visible_id =
                workbench_control::conversation_id("control-test-device", "cloud-visible");
            let search = || json!({"query":title,"scope":"current_device"});
            let result = handler
                .control_operation(&ctx, "search_conversations", search())
                .await
                .unwrap();
            assert_eq!(result["items"].as_array().unwrap().len(), 1);
            assert_eq!(result["items"][0]["conversation_id"], visible_id);
            assert_eq!(
                result["coverage"]["unavailable_reasons"]["permission_denied"],
                1
            );
            let listed = handler
                .control_operation(
                    &ctx,
                    "list_conversations",
                    json!({"limit":100,"scope":"current_device"}),
                )
                .await
                .unwrap();
            assert!(listed["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["conversation_id"] == visible_id));
            assert_eq!(listed["coverage"]["unavailable_count"], 1);
            assert_eq!(listed["coverage"]["authorized_index_complete"], false);

            invalid.store(true, Ordering::SeqCst);
            let failed = handler
                .control_operation(&ctx, "search_conversations", search())
                .await
                .unwrap();
            assert!(failed["items"].as_array().unwrap().is_empty());
            assert_eq!(failed["coverage"]["unavailable_count"], 2);
            assert_eq!(
                failed["coverage"]["unavailable_reasons"],
                json!({"permission_denied":1,"backend_validation_error":1})
            );
            ctx.request.auth_token = None;
            let disconnected = handler
                .control_operation(&ctx, "search_conversations", search())
                .await
                .unwrap();
            assert!(disconnected["items"].as_array().unwrap().is_empty());
            assert_eq!(
                disconnected["coverage"]["unavailable_reasons"]["cloud_unavailable"],
                2
            );
            assert!(!disconnected.to_string().contains("synthetic-session-token"));
            handler.codex_app_server.restart().await;
            server.abort();
        });
}
