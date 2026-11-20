use super::*;

#[test]
fn registration_preserves_wait_mode_without_execution_credentials() {
    let (mut record, _, _) = fixture();
    record["subscription_key"] = json!("original-key");
    record["wait_for_event"] = json!(true);
    record["intent"]["wait_for_event"] = json!(true);
    record["cloud_registration"] =
        json!({"owner_id":7,"device_id":"device","initial_checkpoint":{"cursor":12}});
    record["execution_profile"] = json!({"auth_token":"private-token"});
    for action in ["attach", "cancel_registration"] {
        let request = registration_input(&record, action);
        assert_eq!(request["subscription"]["wait_for_event"], true);
        assert_eq!(request["subscription"]["subscription_key"], "original-key");
        assert_eq!(request["subscription"]["request_intent"], record["intent"]);
        assert_eq!(request["expectedOwnerId"], 7);
        assert!(!request.to_string().contains("private-token"));
    }
}

fn fixture() -> (Value, Value, Value) {
    let source = json!({"providerId":"documents","profile":"account","kind":"document","id":"doc","name":"Document","enabledAfter":"2026-11-15T00:00:00Z"});
    let intent = json!({"source":wegent_protocol::connection_events::observation_identity(&source),"target":{"deviceId":"device","taskId":"task","session":{"engine":"Codex","id":"thread-task"}},"match":{"/eventType":"document.updated"},"continuation":"Continue editing","goalIdentity":null});
    let cloud_id = "a".repeat(64);
    let record = json!({"status":"armed","task_id":"task","device_id":"device","session":intent["target"]["session"],"source":source,"match":intent["match"],"continuation":intent["continuation"],"waiting_goal":null,"intent":{"source":observation_identity(&source),"match":intent["match"],"continuation":intent["continuation"],"wait_for_event":false},"cloud_subscription":{"id":cloud_id,"owner_id":7,"intent":intent}});
    let event = json!({"id":"event","eventType":"document.updated","at":"2026-11-15T00:00:01Z","text":"Changed"});
    let key = format!(
        "{:x}",
        Sha256::digest(canonical_json(&event_identity(&source, &event)))
    );
    let snapshot = json!({"ownerId":7,"subscription":{"id":cloud_id,"activation":source,"intent":intent,"status":"pending","deliveryId":"batch"},"observation":{"lastCollectedAt":10,"resourceStates":[],"errorCode":null},"delivery":{"id":"batch","subscriptionId":cloud_id,"source":source,"intent":intent,"status":"pending","lease":{"id":"lease","expiresAt":60_000},"events":[event],"eventKeys":[key]}});
    let signal = json!({"subscriptionId":cloud_id,"deliveryId":"batch","leaseId":"lease"});
    (record, snapshot, signal)
}

#[test]
fn cloud_collection_rpc_relays_only_a_source_credential_to_the_known_host() {
    use crate::runtime_work::handler::control::tests::EnvGuard;
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = calls.clone();
        let app = axum::Router::new().route("/api/users/me", axum::routing::get(|| async { axum::Json(json!({"id":7})) })).route("/wework/connections/v1/rpc", axum::routing::post(move |headers: axum::http::HeaderMap, axum::Json(body): axum::Json<Value>| {
            let calls = captured.clone();
            async move {
                assert_eq!(headers.get("authorization").unwrap(), format!("Bearer {}", "a".repeat(64)).as_str());
                calls.lock().unwrap().push(body.clone());
                axum::Json(json!({"ok":true,"result":{"accepted":true,"sequence":1}}))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let handler = RuntimeWorkRpcHandler::new("device", "/bin/false");
        *handler.backend_connection.lock().unwrap() = Some(ConnectionConfig {backend_url:format!("http://{address}"),auth_token:"private-session-token".into(),authenticated_user_id:Some(7),..Default::default()});
        handler.configure_connection_host(json!({"url":format!("http://{address}/wework/connections/v1/rpc"),"token":"a".repeat(64)})).unwrap();
        let result = handler.handle_runtime_rpc(json!({"method":"runtime.connections.observations.collect","payload":{"expectedOwnerId":7,"collectorToken":"source-lease-token","backendUrl":"https://untrusted.example","taskId":"arbitrary-task","executionRequest":{"prompt":"Never run"}}})).await.unwrap();
        assert_eq!(result["accepted"], true);
        assert_eq!(*calls.lock().unwrap(), vec![json!({"method":"collectCloudObservation","providerId":null,"input":{"backendUrl":format!("http://{address}"),"collectorToken":"source-lease-token","expectedOwnerId":7}})]);
        assert_eq!(handler.collect_cloud_connection_observation(json!({"expectedOwnerId":8,"collectorToken":"foreign-owner"})).await.unwrap_err().code, "permission_denied");
        assert_eq!(calls.lock().unwrap().len(), 1);
        assert!(handler.command_journal.lock().unwrap().is_empty());
        assert!(handler.store.get_task("arbitrary-task").is_none());
        server.abort(); let _ = server.await;
    });
}

#[test]
fn cloud_batch_is_captured_without_requiring_shared_history_and_survives_reclaim() {
    let (record, snapshot, signal) = fixture();
    let pending = merge_snapshot(&record, &snapshot, &signal, 10).unwrap();
    assert_eq!(pending["status"], "pending");
    assert_eq!(pending["events"], snapshot["delivery"]["events"]);
    assert_eq!(
        pending["resource_event_keys"],
        snapshot["delivery"]["eventKeys"]
    );
    let mut reclaimed = snapshot.clone();
    reclaimed["delivery"]["lease"] = json!({"id":"replacement","expiresAt":120_000});
    let mut new_signal = signal;
    new_signal["leaseId"] = json!("replacement");
    let reclaimed_pending = merge_snapshot(&pending, &reclaimed, &new_signal, 70_000).unwrap();
    assert_eq!(reclaimed_pending["events"], pending["events"]);
    assert_eq!(
        reclaimed_pending["resource_event_keys"],
        pending["resource_event_keys"]
    );
    assert_eq!(reclaimed_pending["cloud_delivery_lease"], "replacement");
    let mut conflicting = reclaimed;
    conflicting["delivery"]["id"] = json!("different-batch");
    conflicting["subscription"]["deliveryId"] = json!("different-batch");
    new_signal["deliveryId"] = json!("different-batch");
    assert!(merge_snapshot(&pending, &conflicting, &new_signal, 70_000).is_err());
}

#[test]
fn canonical_owner_target_source_goal_filter_and_live_lease_are_required() {
    let (record, snapshot, signal) = fixture();
    for (path, replacement) in [
        ("/ownerId", json!(8)),
        ("/subscription/id", json!("foreign")),
        ("/subscription/intent/target/taskId", json!("other-task")),
        (
            "/subscription/intent/goalIdentity",
            json!({"objective":"different"}),
        ),
        ("/subscription/activation/profile", json!("other-account")),
        ("/delivery/subscriptionId", json!("foreign")),
        ("/delivery/source/id", json!("other-doc")),
        ("/delivery/intent/continuation", json!("Different work")),
        ("/delivery/lease/id", json!("old")),
        ("/delivery/lease/expiresAt", json!(10)),
        ("/delivery/events/0/eventType", json!("document.deleted")),
        ("/delivery/events/0/at", json!("2026-11-14T00:00:00Z")),
        ("/delivery/eventKeys/0", json!("forged")),
    ] {
        let mut invalid = snapshot.clone();
        *invalid.pointer_mut(path).unwrap() = replacement;
        assert!(
            merge_snapshot(&record, &invalid, &signal, 10).is_err(),
            "{path}"
        );
    }
    let mut duplicate = snapshot.clone();
    duplicate["delivery"]["events"] = json!([
        snapshot["delivery"]["events"][0],
        snapshot["delivery"]["events"][0]
    ]);
    duplicate["delivery"]["eventKeys"] = json!([
        snapshot["delivery"]["eventKeys"][0],
        snapshot["delivery"]["eventKeys"][0]
    ]);
    assert!(merge_snapshot(&record, &duplicate, &signal, 10).is_err());
    for (field, replacement) in [
        ("task_id", json!("different-task")),
        ("continuation", json!("Different work")),
        ("waiting_goal", json!({"objective":"Replacement goal"})),
        ("match", json!({"/eventType":"document.deleted"})),
    ] {
        let mut changed = record.clone();
        changed[field] = replacement;
        assert!(
            merge_snapshot(&changed, &snapshot, &signal, 10).is_err(),
            "{field}"
        );
    }
}

#[test]
fn health_refresh_and_terminal_notifications_cannot_admit_a_new_batch() {
    let (record, mut snapshot, signal) = fixture();
    let health = json!({"subscriptionId":signal["subscriptionId"]});
    let refreshed = merge_snapshot(&record, &snapshot, &health, 10).unwrap();
    assert_eq!(refreshed["status"], "armed");
    assert!(refreshed["events"].is_null());
    assert_eq!(refreshed["last_collected_at"], 10);
    for status in ["cancelled", "delivered", "resuming_goal", "needs_attention"] {
        let mut terminal = record.clone();
        terminal["status"] = json!(status);
        assert_eq!(
            merge_snapshot(&terminal, &snapshot, &signal, 10).unwrap(),
            terminal
        );
    }
    let mut preparing = record.clone();
    preparing["status"] = json!("preparing");
    let deferred = merge_snapshot(&preparing, &snapshot, &signal, 10).unwrap();
    assert_eq!(deferred["status"], "preparing");
    assert!(deferred["events"].is_null());
    snapshot["subscription"]["status"] = json!("cancelled");
    assert_eq!(
        merge_snapshot(&record, &snapshot, &signal, 10).unwrap()["status"],
        "cancelled"
    );
}

#[test]
fn cancellation_while_native_waits_for_the_send_gate_prevents_continuation() {
    use crate::runtime_work::handler::control::tests::{seed, EnvGuard};
    use std::sync::atomic::{AtomicBool, Ordering};
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let (mut record, mut snapshot, signal) = fixture();
            snapshot["delivery"]["lease"]["expiresAt"] = json!(now_ms() + 60_000);
            record["subscription_key"] = json!("wait");
            let cancelled = Arc::new(AtomicBool::new(false));
            let calls = Arc::new(Mutex::new(Vec::new()));
            let server_cancelled = cancelled.clone();
            let server_calls = calls.clone();
            let app = axum::Router::new().route(
                "/api/runtime-observations/command",
                axum::routing::post(
                    move |headers: axum::http::HeaderMap, axum::Json(body): axum::Json<Value>| {
                        let cancelled = server_cancelled.clone();
                        let calls = server_calls.clone();
                        let snapshot = snapshot.clone();
                        async move {
                            assert_eq!(
                                headers.get("authorization").unwrap(),
                                "Bearer synthetic-runtime-session"
                            );
                            calls.lock().unwrap().push(body.clone());
                            match body["action"].as_str().unwrap() {
                                "get_subscription" => {
                                    (axum::http::StatusCode::OK, axum::Json(snapshot))
                                }
                                "admit_delivery" => {
                                    assert!(cancelled.load(Ordering::Acquire));
                                    (
                                        axum::http::StatusCode::CONFLICT,
                                        axum::Json(
                                            json!({"detail":"observation_delivery_lease_lost"}),
                                        ),
                                    )
                                }
                                _ => panic!("Unexpected Runtime request"),
                            }
                        }
                    },
                ),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let handler = RuntimeWorkRpcHandler::new("device", "/bin/false");
            *handler.backend_connection.lock().unwrap() = Some(ConnectionConfig {
                backend_url: format!("http://{address}"),
                auth_token: "synthetic-runtime-session".into(),
                authenticated_user_id: Some(7),
                ..Default::default()
            });
            seed(&handler, "task");
            let id = handler.subscription_id("task", "wait");
            event_store::transact(&handler.event_subscription_path(), |state| {
                state["operations"][&id] = record;
                Ok(())
            })
            .unwrap();
            let goal_gate = handler.task_send_gate("goal-status:task");
            let held = goal_gate.lock().await;
            let running = handler.clone();
            let delivery =
                tokio::spawn(
                    async move { running.sync_cloud_connection_subscription(signal).await },
                );
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let status =
                        event_store::transact(&handler.event_subscription_path(), |state| {
                            Ok(state["operations"][&id]["status"].clone())
                        })
                        .unwrap();
                    if status == "pending" {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            cancelled.store(true, Ordering::Release);
            drop(held);
            let error = tokio::time::timeout(Duration::from_secs(10), delivery)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            assert_eq!(error.code, "cloud_request_failed");
            assert_eq!(
                calls
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|body| body["action"].as_str().unwrap().to_owned())
                    .collect::<Vec<_>>(),
                vec!["get_subscription", "admit_delivery"]
            );
            let persisted = event_store::transact(&handler.event_subscription_path(), |state| {
                Ok(state["operations"][&id].clone())
            })
            .unwrap();
            assert!(
                persisted["operation_id"].is_null(),
                "Rejected cloud admission cannot create a local continuation"
            );
            assert!(handler.command_journal.lock().unwrap().is_empty());
            assert!(!handler.is_busy_local_task("task"));
            server.abort();
            let _ = server.await;
        });
}

#[test]
fn backend_cancellation_removes_the_wait_before_ack_and_recovers_a_lost_ack() {
    use crate::runtime_work::handler::control::tests::{seed, EnvGuard};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let (mut record, mut snapshot, signal) = fixture();
            record["subscription_key"] = json!("wait");
            snapshot["subscription"]["status"] = json!("cancelled");
            let handler = RuntimeWorkRpcHandler::new("device", "/bin/false");
            seed(&handler, "task");
            let id = handler.subscription_id("task", "wait");
            handler.save_event_subscription(&id, &record).unwrap();
            let path = handler.event_subscription_path();
            let attempts = Arc::new(AtomicUsize::new(0));
            let server_attempts = attempts.clone();
            let app = axum::Router::new().route(
                "/api/runtime-observations/command",
                axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                    let snapshot = snapshot.clone();
                    let path = path.clone();
                    let id = id.clone();
                    let attempts = server_attempts.clone();
                    async move {
                        match body["action"].as_str().unwrap() {
                            "get_subscription" => {
                                (axum::http::StatusCode::OK, axum::Json(snapshot))
                            }
                            "ack_projection" => {
                                let status = event_store::transact(&path, |state| {
                                    Ok(state["operations"][&id]["status"].clone())
                                })
                                .unwrap();
                                assert_eq!(
                                    status, "cancelled",
                                    "Only a persisted projection may be acknowledged"
                                );
                                let status = if attempts.fetch_add(1, Ordering::AcqRel) == 0 {
                                    axum::http::StatusCode::SERVICE_UNAVAILABLE
                                } else {
                                    axum::http::StatusCode::OK
                                };
                                (status, axum::Json(json!({"acknowledged":true})))
                            }
                            _ => panic!("Cancellation must not admit or send a continuation"),
                        }
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            *handler.backend_connection.lock().unwrap() = Some(ConnectionConfig {
                backend_url: format!("http://{address}"),
                auth_token: "synthetic-runtime-session".into(),
                authenticated_user_id: Some(7),
                ..Default::default()
            });
            let health = json!({"subscriptionId":signal["subscriptionId"]});
            assert!(handler
                .sync_cloud_connection_subscription(health.clone())
                .await
                .is_err());
            let task = handler.get_task(&json!({"taskId":"task"})).unwrap();
            assert_eq!(
                task["task"]["runtimeHandle"]["connectionEventSubscriptions"],
                json!([]),
                "A lost Backend ack must not leave a stale waiting indicator"
            );
            let result = handler
                .sync_cloud_connection_subscription(health)
                .await
                .unwrap();
            assert_eq!(result["accepted"], false);
            assert_eq!(result["status"], "cancelled");
            assert_eq!(attempts.load(Ordering::Acquire), 2);
            assert!(handler.command_journal.lock().unwrap().is_empty());
            server.abort();
            let _ = server.await;
        });
}

#[test]
fn remote_model_subscription_recovers_lost_registration_without_reinitializing_or_collecting_locally(
) {
    use crate::runtime_work::handler::control::tests::{context, seed, EnvGuard};
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
        let attached = Arc::new(Mutex::new(None::<Value>));
        let backend_calls = calls.clone();
        let backend_attached = attached.clone();
        let plugin_calls = calls.clone();
        let app = axum::Router::new()
            .route("/api/users/me", axum::routing::get(|| async { axum::Json(json!({"id":7})) }))
            .route("/api/runtime-observations/command", axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let calls = backend_calls.clone();
                let attached = backend_attached.clone();
                async move {
                    assert_eq!(body["expectedOwnerId"], 7);
                    calls.lock().unwrap().push(body.clone());
                    match body["action"].as_str().unwrap() {
                        "attach" => {
                            let input = &body["subscription"];
                            assert_eq!(input.as_object().unwrap().len(), 10);
                            assert_eq!(input["session"],json!({"engine":"Codex","id":"thread-task"}));
                            assert_eq!(input["wait_for_event"], false);
                            assert!(wegent_protocol::connection_events::matches_subscription_request(&input["request_intent"], &json!({"source":observation_identity(&input["source"]),"match":input["match"],"continuation":input["continuation"]}), &input["wait_for_event"]));
                            assert_eq!(body["initialCheckpoint"], json!({"cursor":40}));
                            let id = format!("{:x}", Sha256::digest(canonical_json(&json!([input["device_id"],input["task_id"],input["subscription_key"]]))));
                            let response = json!({"ownerId":7,"subscriptionId":id,"subscription":{"id":id,"activation":input["source"],"status":"armed","intent":{"source":observation_identity(&input["source"]),"target":{"deviceId":input["device_id"],"taskId":input["task_id"],"session":input["session"]},"match":input["match"],"continuation":input["continuation"],"goalIdentity":input["waiting_goal"]}}});
                            let mut previous = attached.lock().unwrap();
                            if let Some(previous) = previous.as_ref() {
                                assert_eq!(*previous, response, "Recovery must reuse the exact activation and consumer identity");
                                (axum::http::StatusCode::OK, axum::Json(response))
                            } else {
                                *previous = Some(response);
                                (axum::http::StatusCode::SERVICE_UNAVAILABLE, axum::Json(json!({"detail":"response_lost"})))
                            }
                        }
                        "cancel_registration" => {
                            let previous = attached.lock().unwrap();
                            assert_eq!(body["subscription"]["task_id"], "task");
                            (axum::http::StatusCode::OK, axum::Json(json!({"ownerId":7,"subscription":{"id":previous.as_ref().unwrap()["subscriptionId"],"status":"cancelled"}})))
                        }
                        "ack_projection" => (axum::http::StatusCode::OK, axum::Json(json!({"acknowledged":true}))),
                        _ => panic!("Unexpected Backend request"),
                    }
                }
            }))
            .route("/wework/connections/v1/rpc", axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let calls = plugin_calls.clone();
                async move {
                    calls.lock().unwrap().push(body.clone());
                    let result = match body["method"].as_str().unwrap() {
                        "validate" => body["input"].clone(),
                        "initializeObservation" => json!({"checkpoint":{"cursor":40},"source":body["input"]}),
                        _ => panic!("A cloud-owned subscription must not start a local provider collector"),
                    };
                    axum::Json(json!({"ok":true,"result":result}))
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
        let model_service = handler.clone();
        let handler = handler.with_connection_observation_device_type("remote");
        *handler.backend_connection.lock().unwrap() = Some(ConnectionConfig {backend_url:format!("http://{address}"),auth_token:"synthetic-runtime-session".into(),authenticated_user_id:Some(7),..Default::default()});
        handler.configure_connection_host(json!({"url":format!("http://{address}/wework/connections/v1/rpc"),"token":"a".repeat(64)})).unwrap();
        seed(&handler, "task");
        let args = json!({"subscription_key":"wait","source":{"providerId":"documents","profile":"account","kind":"document","id":"doc","name":"Document"},"match":{"/eventType":"document.updated"},"continuation":"Continue editing"});
        assert!(model_service.control_operation(&context("task"), "subscribe_connection_events", args.clone()).await.is_err());
        let id = handler.subscription_id("task", "wait");
        let read = || event_store::transact(&handler.event_subscription_path(), |state| Ok(state["operations"][&id].clone())).unwrap();
        assert_eq!(read()["status"], "preparing");
        handler.poll_conversation_connection_events(true).await.unwrap();
        assert_eq!(read()["status"], "armed");
        assert_eq!(read()["cloud_subscription"]["id"], attached.lock().unwrap().as_ref().unwrap()["subscriptionId"]);
        handler.poll_conversation_connection_events(true).await.unwrap();
        let repeated = handler.control_operation(&context("task"), "subscribe_connection_events", args).await.unwrap();
        assert_eq!(repeated["subscription"]["status"], "armed");
        handler.control_operation(&context("task"), "cancel_connection_event_subscription", json!({"subscription_key":"wait"})).await.unwrap();
        assert_eq!(read()["status"], "cancelled");
        {
            let calls = calls.lock().unwrap();
            assert_eq!(calls.iter().filter(|call| call["method"] == "initializeObservation").count(), 1);
            assert_eq!(calls.iter().filter(|call| call["action"] == "attach").count(), 2);
            assert_eq!(calls.iter().filter(|call| call["action"] == "cancel_registration").count(), 1);
            assert_eq!(calls.iter().filter(|call| call["action"] == "ack_projection").count(), 1);
        }
        assert_eq!(read()["cloud_cancel_pending"], false);
        assert!(handler.command_journal.lock().unwrap().is_empty());
        server.abort();
        let _ = server.await;
    });
}

#[test]
fn goal_pause_recovers_cloud_cancellation_after_a_lost_attach_response_and_restart() {
    use crate::runtime_work::handler::control::tests::{seed, EnvGuard};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let (mut record, _, _) = fixture();
        record.as_object_mut().unwrap().remove("cloud_subscription");
        record["status"] = json!("preparing");
        record["subscription_key"] = json!("goal-wait");
        record["waiting_goal"] = json!({"objective":"Finish the original work","createdAt":1,"tokenBudget":20_000});
        let cloud_id = format!("{:x}", Sha256::digest(canonical_json(&json!(["device","task","goal-wait"]))));
        record["cloud_registration"] = json!({"owner_id":7,"device_id":"device","subscription_id":cloud_id,"initial_checkpoint":{"cursor":40}});
        let original = registration_input(&record, "attach");
        let cancels = Arc::new(AtomicUsize::new(0));
        let acks = Arc::new(AtomicUsize::new(0));
        let remote_status = Arc::new(Mutex::new("absent"));
        let server_cancels = cancels.clone();
        let server_acks = acks.clone();
        let server_status = remote_status.clone();
        let server_id = cloud_id.clone();
        let app = axum::Router::new().route("/api/runtime-observations/command", axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            let cancels = server_cancels.clone(); let acks = server_acks.clone();
            let status = server_status.clone(); let original = original.clone(); let id = server_id.clone();
            async move {
                assert_eq!(body["expectedOwnerId"], 7);
                match body["action"].as_str().unwrap() {
                    "attach" => {
                        *status.lock().unwrap() = "armed";
                        (axum::http::StatusCode::SERVICE_UNAVAILABLE, axum::Json(json!({"detail":"attach_response_lost"})))
                    }
                    "cancel_registration" => {
                        assert_eq!(body["subscription"], original["subscription"]);
                        assert_eq!(body["initialCheckpoint"], original["initialCheckpoint"]);
                        if cancels.fetch_add(1, Ordering::AcqRel) == 0 {
                            return (axum::http::StatusCode::SERVICE_UNAVAILABLE, axum::Json(json!({"detail":"offline"})));
                        }
                        *status.lock().unwrap() = "cancelled";
                        (axum::http::StatusCode::OK, axum::Json(json!({"ownerId":7,"subscription":{"id":id,"status":"cancelled"}})))
                    }
                    "ack_projection" => {
                        assert_eq!(*status.lock().unwrap(), "cancelled");
                        acks.fetch_add(1, Ordering::AcqRel);
                        (axum::http::StatusCode::OK, axum::Json(json!({"acknowledged":true})))
                    }
                    _ => panic!("Cancelled registration must not read a Goal, collect events or create a turn"),
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let connection = ConnectionConfig {backend_url:format!("http://{address}"),auth_token:"synthetic-runtime-session".into(),authenticated_user_id:Some(7),..Default::default()};
        let handler = RuntimeWorkRpcHandler::new("device", "/bin/false");
        *handler.backend_connection.lock().unwrap() = Some(connection.clone());
        seed(&handler, "task");
        let id = handler.subscription_id("task", "goal-wait");
        handler.save_event_subscription(&id, &record).unwrap();
        assert!(handler.register_cloud_connection_subscription(&id, &mut record).await.is_err());
        assert_eq!(*remote_status.lock().unwrap(), "armed");
        handler.cancel_connection_goal_waits("task", Some("paused"));
        let read = || event_store::transact(&handler.event_subscription_path(), |state| Ok(state["operations"][&id].clone())).unwrap();
        assert_eq!(read()["status"], "cancelled");
        assert_eq!(read()["cloud_cancel_pending"], true);
        assert!(read()["cloud_subscription"].is_null());
        let restored = RuntimeWorkRpcHandler::new("device", "/bin/false");
        *restored.backend_connection.lock().unwrap() = Some(connection);
        restored.poll_conversation_connection_events(true).await.unwrap();
        assert_eq!(read()["cloud_cancel_pending"], true, "A failed cloud cancellation must remain durable across retries");
        let result = restored.sync_cloud_connection_subscription(json!({"subscriptionId":cloud_id})).await.unwrap();
        assert_eq!(result["status"], "cancelled");
        assert_eq!(read()["cloud_cancel_pending"], false);
        assert_eq!(read()["cloud_cancel_acknowledged"], true);
        restored.poll_conversation_connection_events(true).await.unwrap();
        assert_eq!(cancels.load(Ordering::Acquire), 2);
        assert_eq!(acks.load(Ordering::Acquire), 1);
        assert!(restored.command_journal.lock().unwrap().is_empty());
        server.abort(); let _ = server.await;
    });
}
