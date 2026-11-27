use super::*;
use crate::runtime_work::handler::control::tests::{seed, EnvGuard};

fn snapshot() -> (Value, Value) {
    let source = json!({"providerId":"documents","profile":"account","kind":"document","id":"doc","name":"Document"});
    let activation = json!({"providerId":"documents","profile":"account","kind":"document","id":"doc","name":"Document","enabledAfter":"2026-11-15T00:00:00Z","policy":{"automatic":false,"askBeforeAct":true}});
    let intent = json!({"source":source,"target":{"deviceId":"control-test-device","taskId":"task","session":{"engine":"Codex","id":"thread-task"}},"match":{},"continuation":"Continue work","goalIdentity":null});
    let cloud_id = format!(
        "{:x}",
        Sha256::digest(canonical_json(&json!([
            "control-test-device",
            "task",
            "key"
        ])))
    );
    let subscription = json!({"id":cloud_id,"subscriptionKey":"key","requestIntent":{"source":source,"match":{},"continuation":"Continue work","wait_for_event":false},"waitForEvent":false,"intent":intent,"activation":activation,"status":"armed","observationId":"observation","afterSequence":4});
    (
        json!({"ownerId":7,"subscription":subscription,"observation":{},"delivery":null}),
        json!({"subscriptionId":cloud_id}),
    )
}

#[test]
fn recovered_descriptor_keeps_original_request_separate_from_activation() {
    let (snapshot, _) = snapshot();
    let record = recovered_record(&snapshot, "local-device", "control-test-device").unwrap();
    assert_eq!(record["device_id"], "local-device");
    assert_eq!(record["intent"], snapshot["subscription"]["requestIntent"]);
    assert_eq!(record["source"], snapshot["subscription"]["activation"]);
    assert_eq!(record["after_sequence"], 4);
    for (path, value) in [
        ("/subscription/subscriptionKey", Value::Null),
        ("/subscription/requestIntent", Value::Null),
        (
            "/subscription/requestIntent/continuation",
            json!("Other work"),
        ),
        (
            "/subscription/intent/target/deviceId",
            json!("other-device"),
        ),
        ("/subscription/activation/id", json!("other-resource")),
        ("/subscription/id", json!("other-id")),
    ] {
        let mut invalid = snapshot.clone();
        *invalid.pointer_mut(path).unwrap() = value;
        assert!(
            recovered_record(&invalid, "local-device", "control-test-device").is_err(),
            "{path}"
        );
    }
}

async fn runtime(
    canonical: Value,
) -> (
    RuntimeWorkRpcHandler,
    Arc<Mutex<Vec<Value>>>,
    tokio::task::JoinHandle<()>,
    Arc<Mutex<Value>>,
) {
    let canonical = Arc::new(Mutex::new(canonical));
    let server_canonical = canonical.clone();
    let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let observed = calls.clone();
    let app = axum::Router::new()
            .route("/api/users/me", axum::routing::get(|| async { axum::Json(json!({"id":7})) }))
            .route("/api/runtime-observations/command", axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let canonical = server_canonical.clone(); let calls = observed.clone();
                async move {
                    calls.lock().unwrap().push(body.clone());
                    match body["action"].as_str().unwrap() {
                        "get_subscription" => axum::Json(canonical.lock().unwrap().clone()),
                        "cancel" => { assert_eq!(body["expectedOwnerId"], 7); axum::Json(json!({"ownerId":7,"subscription":{"id":body["subscriptionId"],"status":"cancelled"}})) },
                        "ack_projection" => axum::Json(json!({"acknowledged":true})),
                        _ => panic!("Recovery must not initialize or register another source"),
                    }
                }
            }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false")
        .with_connection_observation_device_type("remote");
    *handler.backend_connection.lock().unwrap() = Some(ConnectionConfig {
        backend_url: format!("http://{address}"),
        auth_token: "synthetic-session".into(),
        authenticated_user_id: Some(7),
        ..Default::default()
    });
    seed(&handler, "task");
    (handler, calls, server, canonical)
}

#[test]
fn cold_runtime_recovers_and_cancels_without_reinitializing_a_provider() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let (snapshot, signal) = snapshot();
            let (handler, calls, server, _) = runtime(snapshot.clone()).await;
            assert_eq!(
                handler
                    .sync_cloud_connection_subscription(signal.clone())
                    .await
                    .unwrap()["status"],
                "armed"
            );
            let id = handler.subscription_id("task", "key");
            let mut recovered =
                event_store::transact(&handler.event_subscription_path(), |state| {
                    Ok(state["operations"][&id].clone())
                })
                .unwrap();
            assert_eq!(
                recovered["intent"],
                snapshot["subscription"]["requestIntent"]
            );
            recovered["status"] = json!("cancelled");
            handler.save_event_subscription(&id, &recovered).unwrap();
            handler
                .finish_cloud_connection_cancellation(&id, &mut recovered)
                .await
                .unwrap();
            assert_eq!(recovered["cloud_cancel_acknowledged"], true);
            assert_eq!(recovered["cloud_cancel_pending"], false);
            assert_eq!(
                calls
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|call| call["action"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                vec!["get_subscription", "cancel", "ack_projection"]
            );
            assert!(handler.command_journal.lock().unwrap().is_empty());
            server.abort();
            let _ = server.await;
        });
}

#[test]
fn cold_cancelled_projection_clears_its_pending_acknowledgement() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let (mut snapshot, signal) = snapshot();
            snapshot["subscription"]["status"] = json!("cancelled");
            let (handler, calls, server, _) = runtime(snapshot).await;
            assert_eq!(
                handler
                    .sync_cloud_connection_subscription(signal)
                    .await
                    .unwrap()["status"],
                "cancelled"
            );
            let id = handler.subscription_id("task", "key");
            let record = event_store::transact(&handler.event_subscription_path(), |state| {
                Ok(state["operations"][&id].clone())
            })
            .unwrap();
            assert_eq!(record["cloud_cancel_acknowledged"], true);
            assert_eq!(record["cloud_cancel_pending"], false);
            handler
                .poll_conversation_connection_events(true)
                .await
                .unwrap();
            assert_eq!(
                calls
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|call| call["action"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                vec!["get_subscription", "ack_projection"]
            );
            server.abort();
            let _ = server.await;
        });
}

#[test]
fn cold_recovery_cannot_recreate_another_owners_or_restricted_task_subscription() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            for restriction in ["owner", "archived", "delegated"] {
                let root = tempfile::tempdir().unwrap();
                let _env = EnvGuard::home(root.path().to_str().unwrap());
                let (mut snapshot, signal) = snapshot();
                if restriction == "owner" {
                    snapshot["ownerId"] = json!(8);
                }
                let (handler, calls, server, _) = runtime(snapshot).await;
                handler.store.update_task("task", |link| match restriction {
                    "archived" => link.status = "archived".into(),
                    "delegated" => {
                        link.runtime_handle["origin"] = json!({"type":"project_coordinator"})
                    }
                    _ => {}
                });
                assert!(
                    handler
                        .sync_cloud_connection_subscription(signal)
                        .await
                        .is_err(),
                    "{restriction}"
                );
                let operations =
                    event_store::transact(&handler.event_subscription_path(), |state| {
                        Ok(state["operations"].clone())
                    })
                    .unwrap();
                assert!(operations.as_object().unwrap().is_empty());
                assert!(handler.command_journal.lock().unwrap().is_empty());
                assert_eq!(calls.lock().unwrap().len(), 1);
                server.abort();
                let _ = server.await;
            }
        });
}

#[test]
fn cold_recovery_preserves_pending_batches_without_interrupting_or_replaying() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        for (admitted, health_first, admit_after_health) in [(false,false,false),(true,false,false),(true,true,false),(true,true,true)] {
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let (mut snapshot, mut signal) = snapshot();
        let event = json!({"id":"event","eventType":"document.updated","at":"2026-11-15T00:00:01Z"});
        let source = snapshot["subscription"]["activation"].clone();
        let key = format!("{:x}", Sha256::digest(canonical_json(&event_identity(&source, &event))));
        let local_id = format!("{:x}", Sha256::digest(json!(["control-test-device","task","key"]).to_string()));
        let operation = format!("op_{:x}", Sha256::digest(format!("control-test-device\0task\0connection-event:{local_id}")));
        snapshot["subscription"]["status"] = json!("pending");
        snapshot["subscription"]["deliveryId"] = json!("batch");
        snapshot["delivery"] = json!({"id":"batch","subscriptionId":snapshot["subscription"]["id"],"intent":snapshot["subscription"]["intent"],"source":source,"status":"pending","events":[event],"eventKeys":[key],"lease":{"id":"lease","expiresAt":now_ms()+60_000},"admission":{"operationId":operation,"at":now_ms()}});
        if !admitted { snapshot["delivery"]["admission"] = Value::Null; }
        signal["deliveryId"] = json!("batch");
        signal["leaseId"] = json!("lease");
        let admission = snapshot["delivery"]["admission"].clone();
        if admit_after_health { snapshot["delivery"]["admission"] = Value::Null; }
        let (handler, calls, server, canonical) = runtime(snapshot).await;
        handler.store.update_task("task", |link| link.interaction_status = Some("waiting_for_user".into()));
        if health_first {
            let health = json!({"subscriptionId":signal["subscriptionId"]});
            let result = handler.sync_cloud_connection_subscription(health).await.unwrap();
            assert_eq!(result["status"], if admit_after_health { "armed" } else { "needs_attention" });
        }
        if admit_after_health { canonical.lock().unwrap()["delivery"]["admission"] = admission; }
        let recovered = handler.sync_cloud_connection_subscription(signal.clone()).await.unwrap();
        assert_eq!(recovered["accepted"], false);
        let expected_status = if admitted { "needs_attention" } else { "pending" };
        assert_eq!(recovered["status"], expected_status);
        assert_eq!(handler.sync_cloud_connection_subscription(signal).await.unwrap()["status"], expected_status);
        let record = event_store::transact(&handler.event_subscription_path(), |state| Ok(state["operations"][&local_id].clone())).unwrap();
        if !health_first || admit_after_health {
            assert_eq!(record["events"].as_array().unwrap().len(), 1);
        }
        assert_eq!(canonical.lock().unwrap()["delivery"]["events"].as_array().unwrap().len(), 1);
        assert_eq!(record["error_code"], if admitted { json!("command_recovery_required") } else { Value::Null });
        assert!(handler.command_journal.lock().unwrap().is_empty());
        assert!(calls.lock().unwrap().iter().all(|call|call["action"]=="get_subscription"));
        server.abort(); let _ = server.await;
        }
    });
}
