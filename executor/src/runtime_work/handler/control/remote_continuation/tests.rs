use super::*;
use crate::config::device::ConnectionConfig;
use crate::runtime_work::handler::control::tests::{context, seed, EnvGuard};
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Probe {
    sends: Mutex<Vec<Value>>,
    origin: Mutex<Value>,
    read_denied: AtomicBool,
    write_denied: AtomicBool,
}

async fn transcript(
    State(probe): State<Arc<Probe>>,
    headers: axum::http::HeaderMap,
    Json(address): Json<Value>,
) -> (StatusCode, Json<Value>) {
    assert_eq!(headers["authorization"], "Bearer synthetic-token");
    assert_eq!(address["deviceId"], "other-device");
    assert_eq!(address["taskId"], "remote-task");
    assert_eq!(address["workspacePath"], "/code/aigc-video-agent");
    if probe.read_denied.load(Ordering::SeqCst) {
        return (StatusCode::FORBIDDEN, Json(json!({"detail":"Forbidden"})));
    }
    (
        StatusCode::OK,
        Json(json!({"origin":probe.origin.lock().unwrap().clone(),"messages":[]})),
    )
}

async fn send(
    State(probe): State<Arc<Probe>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    assert_eq!(headers["authorization"], "Bearer synthetic-token");
    assert_eq!(body["address"]["deviceId"], "other-device");
    assert_eq!(body["address"]["taskId"], "remote-task");
    assert_eq!(body["address"]["workspacePath"], "/code/aigc-video-agent");
    assert_eq!(body["address"]["runtimeHandle"]["wegentTeam"]["id"], 91);
    assert_eq!(body["modelSelection"]["modelName"], "test");
    assert_eq!(body["queueIfBusy"], true);
    assert!(body.get("executionRequest").is_none());
    assert!(!body.to_string().contains("private-secret"));
    probe.sends.lock().unwrap().push(body);
    if probe.write_denied.load(Ordering::SeqCst) {
        return (StatusCode::FORBIDDEN, Json(json!({"detail":"Forbidden"})));
    }
    (
        StatusCode::OK,
        Json(json!({"accepted":true,"taskId":"remote-task","status":"queued","queuePosition":2})),
    )
}

async fn backend(probe: Arc<Probe>) -> (ConnectionConfig, [tokio::task::JoinHandle<()>; 2]) {
    let (mut connection, socket) = crate::runtime_work::reader::tests::start_server().await;
    let app = Router::new()
        .route("/deployed/api/runtime-work/transcript", post(transcript))
        .route("/deployed/api/runtime-work/send", post(send))
        .with_state(probe);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    connection.backend_url = format!("http://{}/deployed/api/", listener.local_addr().unwrap());
    connection.auth_token = "desktop-token-must-not-replace-caller-authorization".into();
    let http = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (connection, [socket, http])
}

fn args(device: &str, task: &str, key: &str) -> Value {
    json!({"conversation_id":workbench_control::conversation_id(device, task),
        "message":"abc","request_key":key})
}

fn controller(connection: &ConnectionConfig) -> (RuntimeWorkRpcHandler, ControlContext) {
    let mut handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
    handler.backend_connection = Arc::new(Mutex::new(Some(connection.clone())));
    seed(&handler, "caller");
    let mut ctx = context("caller");
    ctx.request.backend_url = Some(connection.backend_url.clone());
    ctx.request.auth_token = Some("synthetic-token".into());
    (handler, ctx)
}

#[test]
fn remote_continuation_metadata_keeps_the_target_configuration_and_never_guesses_a_model() {
    let mut target = json!({"taskId":"target","workspacePath":"/original/worktree","runtime":"claude_code",
        "modelSelection":{"modelName":"original-model","modelType":"public","options":{"weworkCloudModelResourceUserId":17,"api_key":"private-secret"}},
        "runtimeHandle":{"wegentTeam":{"id":91},"executionRequest":{"auth_token":"private-secret"}}});
    let link = continuation_link("target", &target).unwrap();
    assert_eq!(link.workspace_path, "/original/worktree");
    assert_eq!(link.runtime, "claude_code");
    assert_eq!(
        link.runtime_handle["modelSelection"]["modelName"],
        "original-model"
    );
    assert_eq!(
        link.runtime_handle["modelSelection"]["options"]["weworkCloudModelResourceUserId"],
        17
    );
    assert_eq!(link.runtime_handle["wegentTeam"]["id"], 91);
    assert!(link.runtime_handle.get("executionRequest").is_none());
    assert!(!link.runtime_handle.to_string().contains("private-secret"));
    assert!(continuation_link("different-task", &target).is_err());
    target["modelSelection"] = Value::Null;
    assert!(continuation_link("target", &target).is_ok());
    target["runtimeHandle"]["wegentTeam"] = Value::Null;
    assert_eq!(
        continuation_link("target", &target).unwrap_err().code,
        "model_configuration_required"
    );
}

#[test]
fn remote_continuation_reuses_addressed_send_and_keeps_durable_device_scoped_receipts() {
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
            let probe = Arc::new(Probe::default());
            let (connection, servers) = backend(probe.clone()).await;
            let (handler, ctx) = controller(&connection);
            let mut collision = seed(&handler, "remote-task");
            collision.title = "Unrelated local conversation".into();
            handler.store.upsert_task(collision);
            let arguments = args("other-device", "remote-task", "one-instruction");
            let (first, second) = tokio::join!(
                handler.control_operation(&ctx, "continue_conversation", arguments.clone()),
                handler.control_operation(&ctx, "continue_conversation", arguments.clone())
            );
            let first = first.unwrap();
            let second = second.unwrap();
            workbench_control::assert_output_contract("continue_conversation", &first);
            workbench_control::assert_output_contract("continue_conversation", &second);
            assert_ne!(first["duplicate"], second["duplicate"]);
            assert_eq!(first["operation"], second["operation"]);
            assert_eq!(first["operation"]["delivery_status"], "accepted");
            assert_eq!(first["operation"]["result"]["status"], "queued");
            assert_eq!(first["operation"]["result"]["queuePosition"], 2);
            assert_eq!(first["operation"]["device_id"], "other-device");
            assert_eq!(probe.sends.lock().unwrap().len(), 1);
            assert_eq!(probe.sends.lock().unwrap()[0]["message"], "abc");
            let operation_id = first["operation"]["operation_id"].as_str().unwrap();
            let local_operation_id = format!(
                "op_{:x}",
                Sha256::digest("control-test-device\0remote-task\0one-instruction")
            );
            assert_ne!(operation_id, local_operation_id);
            assert_eq!(
                probe.sends.lock().unwrap()[0]["clientUserMessageId"],
                operation_id
            );
            let mut conflict = arguments.clone();
            conflict["message"] = json!("different message");
            let error = handler
                .control_operation(&ctx, "continue_conversation", conflict)
                .await
                .unwrap_err();
            assert_eq!(error.code, "conflict");
            assert_eq!(probe.sends.lock().unwrap().len(), 1);
            let (reloaded, _) = controller(&connection);
            let receipt = reloaded
                .control_operation(&ctx, "get_operation", json!({"operation_id":operation_id}))
                .await
                .unwrap();
            workbench_control::assert_output_contract("get_operation", &receipt);
            assert_eq!(receipt["operation"], first["operation"]);
            assert!(receipt["current_conversation"].is_null());
            let duplicate = reloaded
                .control_operation(&ctx, "continue_conversation", arguments.clone())
                .await
                .unwrap();
            assert_eq!(duplicate["duplicate"], true);
            let path = reloaded
                .store
                .index_path()
                .with_file_name("control-operations.json");
            workbench_control::journal::transact(&path, |state| {
                state["operations"][operation_id]["delivery_status"] = json!("pending");
                Ok(())
            })
            .unwrap();
            let pending = reloaded
                .control_operation(&ctx, "continue_conversation", arguments)
                .await
                .unwrap();
            assert_eq!(pending["duplicate"], true);
            assert_eq!(pending["operation"]["delivery_status"], "pending");
            assert_eq!(probe.sends.lock().unwrap().len(), 1);
            for server in servers {
                server.abort();
            }
        });
}

#[test]
fn remote_continuation_preserves_source_target_and_backend_denials() {
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
            let probe = Arc::new(Probe::default());
            let (connection, servers) = backend(probe.clone()).await;
            let (handler, ctx) = controller(&connection);
            for (origin, reason) in [
                (
                    json!({"dispatchRole":"executor"}),
                    "origin.dispatchRole (executor)",
                ),
                (
                    json!({"dispatch_role":"manager"}),
                    "origin.dispatch_role (manager)",
                ),
                (
                    json!({"dispatchId":"private-dispatch-id"}),
                    "origin.dispatchId (nonempty_string)",
                ),
                (
                    json!({"dispatchRole":""}),
                    "origin.dispatchRole (empty_string)",
                ),
                (
                    json!({"dispatchId":false}),
                    "origin.dispatchId (non_string)",
                ),
            ] {
                *probe.origin.lock().unwrap() = origin;
                let error = handler
                    .control_operation(
                        &ctx,
                        "continue_conversation",
                        args("other-device", "remote-task", "forbidden"),
                    )
                    .await
                    .unwrap_err();
                assert_eq!(error.code, "permission_denied");
                assert!(error.message.contains(reason), "{}", error.message);
                assert!(!error.message.contains("private-dispatch-id"));
            }
            *probe.origin.lock().unwrap() = Value::Null;
            for (device, task, expected) in [
                ("denied-device", "remote-task", "remote_control_disabled"),
                ("other-device", "different-task", "invalid_response"),
            ] {
                let error = handler
                    .control_operation(
                        &ctx,
                        "continue_conversation",
                        args(device, task, "forbidden"),
                    )
                    .await
                    .unwrap_err();
                assert_eq!(error.code, expected);
            }
            probe.read_denied.store(true, Ordering::SeqCst);
            let error = handler
                .control_operation(
                    &ctx,
                    "continue_conversation",
                    args("other-device", "remote-task", "read-denied"),
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "permission_denied");
            probe.read_denied.store(false, Ordering::SeqCst);
            probe.write_denied.store(true, Ordering::SeqCst);
            let arguments = args("other-device", "remote-task", "write-denied");
            let denied = handler
                .control_operation(&ctx, "continue_conversation", arguments.clone())
                .await
                .unwrap();
            assert_eq!(denied["operation"]["delivery_status"], "needs_attention");
            assert_eq!(denied["operation"]["error"]["code"], "permission_denied");
            let duplicate = handler
                .control_operation(&ctx, "continue_conversation", arguments)
                .await
                .unwrap();
            assert_eq!(duplicate["duplicate"], true);
            assert_eq!(probe.sends.lock().unwrap().len(), 1);
            let mut source = seed(&handler, "caller");
            source.runtime_handle["origin"] = json!({"dispatchRole":"executor"});
            handler.store.upsert_task(source);
            let error = handler
                .control_operation(
                    &ctx,
                    "continue_conversation",
                    args("other-device", "remote-task", "forged-source"),
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "permission_denied");
            assert_eq!(probe.sends.lock().unwrap().len(), 1);
            // External/delegated source sessions still cannot acquire personal control.
            for origin in [
                json!({"type":"stand_in_identity"}),
                json!({"type":"connection_work"}),
                json!({"type":"dingtalk_work"}),
            ] {
                let mut source = seed(&handler, "caller");
                source.runtime_handle["origin"] = origin;
                handler.store.upsert_task(source);
                let error = handler
                    .control_operation(
                        &ctx,
                        "continue_conversation",
                        args("other-device", "remote-task", "external-source"),
                    )
                    .await
                    .unwrap_err();
                assert_eq!(error.code, "permission_denied");
                assert_eq!(probe.sends.lock().unwrap().len(), 1);
            }
            assert!(!denied.to_string().contains("synthetic-token"));
            assert!(!denied.to_string().contains("private-secret"));
            for server in servers {
                server.abort();
            }
        });
}

#[test]
fn personal_controller_can_resume_scoped_targets_without_reclassifying_them() {
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
            let probe = Arc::new(Probe::default());
            let (connection, servers) = backend(probe.clone()).await;
            let (handler, ctx) = controller(&connection);
            for (index, origin) in [
                json!({"type":"board_task","dispatch_role":"executor","cloudProjectId":"project-1","loopItemId":"issue-1"}),
                json!({"type":"issue_dispatch","dispatchRole":"manager","cloudProjectId":"project-1","loopItemId":"issue-1"}),
                json!({"type":"issue_dispatch","humanAssignmentId":"human-1","dispatchId":"dispatch-1","cloudProjectId":"project-1","loopItemId":"issue-1"}),
                json!({"type":"connection_work","initiatedBy":"stand_in","askBeforeAct":true}),
            ].into_iter().enumerate() {
                *probe.origin.lock().unwrap() = origin.clone();
                let response = handler.control_operation(&ctx, "continue_conversation", args("other-device", "remote-task", &format!("scoped-{index}"))).await.unwrap();
                assert_eq!(response["operation"]["delivery_status"], "accepted");
                let mut link = seed(&handler, "scoped-target");
                link.runtime_handle["origin"] = origin;
                validate_continuation_target(&link, "control-test-device").unwrap();
                let mut request = runtime_event_request_from_link(&link);
                crate::runtime_work::api_context::inject_current_session(&mut request, "control-test-device", "scoped-target");
                assert!(workbench_control::ControlContext::from_request(&request).is_none());
                if index < 3 {
                    assert!(crate::task_runtime::mcp::has_bound_issue_context(&request).unwrap());
                } else {
                    assert!(crate::runtime_work::stand_in_requires_confirmation(&request));
                }
            }
            assert_eq!(probe.sends.lock().unwrap().len(), 4);
            for server in servers {
                server.abort();
            }
        });
}
