use super::*;
use crate::runtime_work::handler::control::tests::{seed, EnvGuard};

#[test]
fn refresh_while_registration_is_uncertain_survives_restart_and_is_submitted_after_attach() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let calls = Arc::new(Mutex::new(Vec::<Value>::new())); let recorded = calls.clone();
        let app = axum::Router::new().route("/api/runtime-observations/command",axum::routing::post(move |axum::Json(body):axum::Json<Value>| {
            let calls = recorded.clone();
            async move {
                let mut calls = calls.lock().unwrap(); calls.push(body.clone());
                assert_eq!(body["expectedOwnerId"],7);
                if calls.len()==1 || calls.len()==3 { return (axum::http::StatusCode::SERVICE_UNAVAILABLE,axum::Json(json!({"detail":"response_lost"}))); }
                let result = match body["action"].as_str().unwrap() {
                    "attach" => {
                        let input=&body["subscription"];
                        let id=format!("{:x}",Sha256::digest(wegent_protocol::connection_events::canonical_json(&json!([input["device_id"],input["task_id"],input["subscription_key"]]))));
                        let intent=json!({"source":wegent_protocol::connection_events::observation_identity(&input["source"]),"target":{"deviceId":input["device_id"],"taskId":input["task_id"],"session":input["session"]},"match":input["match"],"continuation":input["continuation"],"goalIdentity":input["waiting_goal"]});
                        json!({"ownerId":7,"subscriptionId":id,"subscription":{"id":id,"intent":intent,"activation":input["source"],"status":"armed"}})
                    }
                    "refresh" => json!({"ownerId":7,"observation":{"id":body["observationId"]}}),
                    _ => panic!("Refresh recovery must not execute a model or another source operation"),
                };
                (axum::http::StatusCode::OK,axum::Json(result))
            }
        }));
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let address=listener.local_addr().unwrap();
        let server=tokio::spawn(async move { axum::serve(listener,app).await.unwrap() });
        let connection=ConnectionConfig {backend_url:format!("http://{address}"),auth_token:"synthetic-session".into(),..Default::default()};
        let handler=RuntimeWorkRpcHandler::new("control-test-device","/bin/false");
        *handler.backend_connection.lock().unwrap()=Some(connection.clone()); seed(&handler,"task");
        let source=json!({"providerId":"documents","profile":"account","kind":"document","id":"doc","name":"Document","enabledAfter":"2026-11-15T00:00:00Z"});
        let cloud_id=format!("{:x}",Sha256::digest(wegent_protocol::connection_events::canonical_json(&json!(["control-test-device","task","watch"]))));
        let id=handler.subscription_id("task","watch");
        let mut record=json!({"task_id":"task","device_id":"control-test-device","subscription_key":"watch","status":"preparing","source":source,"intent":{"source":wegent_protocol::connection_events::observation_identity(&source),"match":{},"continuation":"Continue","wait_for_event":false},"wait_for_event":false,"observation_id":"observed","match":{},"continuation":"Continue","waiting_goal":null,"cloud_registration":{"owner_id":7,"device_id":"control-test-device","subscription_id":cloud_id,"initial_checkpoint":{"cursor":4}}});
        record["session"]=json!({"engine":"Codex","id":"thread-task"});
        handler.save_event_subscription(&id,&record).unwrap();
        assert!(handler.prepare_event_subscription(&id,&mut record).await.is_err());
        let result=handler.refresh_connection_observation(json!({"taskId":"task","subscriptionKey":"watch"})).await.unwrap();
        assert_eq!(result["subscription"]["refresh_pending"],true);
        assert_eq!(calls.lock().unwrap().len(),1,"The refresh intent waits until its source exists");
        let restarted=RuntimeWorkRpcHandler::new("control-test-device","/bin/false");
        *restarted.backend_connection.lock().unwrap()=Some(connection);
        restarted.poll_conversation_connection_events(true).await.unwrap();
        let pending=event_store::transact(&restarted.event_subscription_path(),|state|Ok(state["operations"][&id].clone())).unwrap();
        assert_eq!(pending["cloud_refresh_pending"],true,"A lost refresh acknowledgement must retain the retry intent");
        restarted.poll_conversation_connection_events(true).await.unwrap();
        restarted.poll_conversation_connection_events(true).await.unwrap();
        let record=event_store::transact(&restarted.event_subscription_path(),|state|Ok(state["operations"][&id].clone())).unwrap();
        assert_eq!(record["status"],"armed"); assert_eq!(record["cloud_refresh_pending"],false); assert_eq!(record["refresh_pending"],true);
        assert_eq!(calls.lock().unwrap().iter().map(|call|call["action"].as_str().unwrap()).collect::<Vec<_>>(),vec!["attach","attach","refresh","refresh"]);
        assert!(restarted.command_journal.lock().unwrap().is_empty());
        server.abort(); let _=server.await;
    });
}

#[test]
fn desktop_refresh_reuses_collection_and_queues_cloud_refresh_without_model_work() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
        let plugin_calls = calls.clone(); let cloud_calls = calls.clone();
        let app = axum::Router::new()
            .route("/wework/connections/v1/rpc",axum::routing::post(move |axum::Json(body):axum::Json<Value>| {
                plugin_calls.lock().unwrap().push(body.clone());
                async move {
                    assert_eq!(body["method"], "collectObservation");
                    assert_eq!(body["input"]["force"], true);
                    assert_eq!(body["input"]["checkpoint"], json!({"cursor":4}));
                    axum::Json(json!({"ok":true,"result":{"events":[{"id":"changed","at":"2026-11-15T00:00:01Z"}],"resourceStates":[{"kind":"change_request","data":{"state":"OPEN"}}],"nextCheckpoint":{"cursor":5}}}))
                }
            }))
            .route("/api/runtime-observations/command",axum::routing::post(move |axum::Json(body):axum::Json<Value>| {
                cloud_calls.lock().unwrap().push(body.clone());
                async move {
                    assert_eq!(body,json!({"action":"refresh","expectedOwnerId":7,"observationId":"cloud-observed"}));
                    axum::Json(json!({"ownerId":7,"observation":{"id":"cloud-observed"}}))
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener,app).await.unwrap() });
        let handler = RuntimeWorkRpcHandler::new("control-test-device","/bin/false");
        handler.configure_connection_host(json!({"url":format!("http://{address}/wework/connections/v1/rpc"),"token":"a".repeat(64)})).unwrap();
        *handler.backend_connection.lock().unwrap() = Some(ConnectionConfig {backend_url:format!("http://{address}"),auth_token:"synthetic-session".into(),..Default::default()});
        let source = json!({"providerId":"documents","profile":"account","kind":"document","id":"doc","name":"Document","enabledAfter":"2026-11-15T00:00:00Z"});
        let ipc = crate::local::app_ipc::AppIpcServer::new().with_runtime_work_handler(handler.clone());
        for task in ["local-task","cloud-task","gap-task"] {
            seed(&handler,task);
            let id = handler.subscription_id(task,"watch");
            let mut record = json!({"task_id":task,"device_id":"control-test-device","subscription_key":"watch","source":source,"status":"armed","observation_id":"observed","after_sequence":0,"initial_sequence":0,"match":{}});
            if task=="cloud-task" {
                record["observation_id"] = json!("cloud-observed");
                record["cloud_subscription"] = json!({"id":"cloud-subscription","owner_id":7});
            }
            handler.save_event_subscription(&id,&record).unwrap();
            event_store::transact(&handler.event_subscription_path(),|state| {
                state["observations"]["observed"] = json!({"source":source,"checkpoint":{"cursor":4},"sequence":0,"events":[]});
                if task=="gap-task" { state["observations"]["observed"]["sequence"] = json!(3); state["observations"]["observed"]["events"] = json!([{"sequence":3,"key":"old","event":{"id":"old","at":"2026-11-15T00:00:01Z"}}]); }
                Ok(())
            }).unwrap();
            let result = ipc.dispatch("device.execute_command",json!({"command_key":"connection_observation_refresh","args":[task,"watch"]})).await.unwrap();
            assert_eq!(result["success"],true);
            let subscription=&result["stdout"]["subscription"];
            assert_eq!(subscription["status"],if task=="local-task" {"pending"} else {"armed"});
            assert_eq!(subscription["refresh_pending"],task=="cloud-task");
            if task=="local-task" { assert_eq!(subscription["resource_states"][0]["data"]["state"],"OPEN"); }
            if task=="gap-task" { assert_eq!(subscription["error_code"],"observation_history_gap"); }
            assert!(handler.command_journal.lock().unwrap().is_empty());
            record["status"] = json!("cancelled"); handler.save_event_subscription(&id,&record).unwrap();
            assert!(ipc.dispatch("device.execute_command",json!({"command_key":"connection_observation_refresh","args":[task,"watch"]})).await.is_err());
        }
        assert_eq!(calls.lock().unwrap().len(),3);
        assert!(ipc.dispatch("device.execute_command",json!({"command_key":"connection_observation_refresh","args":["local-task"]})).await.is_err());
        server.abort(); let _=server.await;
    });
}

#[test]
fn desktop_cancellation_is_exact_durable_and_does_not_resume_goals_or_models() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
        seed(&handler, "task");
        seed(&handler, "other");
        handler.store.update_task("task", |link| {
            link.goal_status = Some("blocked".into());
            link.goal_execution_status = Some("waitingForEvent".into());
        });
        let ipc = crate::local::app_ipc::AppIpcServer::new().with_runtime_work_handler(handler.clone());
        for status in ["preparing", "armed", "pending", "resuming_goal", "error", "needs_attention"] {
            let record = json!({"task_id":"task","device_id":"control-test-device","subscription_key":status,
                "status":status,"source":{"name":"PR"},"waiting_goal":{"objective":"Notify when ready"}});
            let id = handler.subscription_id("task", status);
            handler.save_event_subscription(&id, &record).unwrap();
            let response = ipc.dispatch("device.execute_command", json!({"command_key":"connection_subscription_cancel","args":["task",status]})).await.unwrap();
            assert_eq!(response["stdout"]["subscription"]["status"], "cancelled");
            assert_eq!(response["stdout"]["subscription"]["subscription_key"], status);
            assert!(handler.store.get_task("task").unwrap().runtime_handle["connectionEventSubscriptions"].as_array().unwrap().iter().all(|item| item["subscription_key"] != status));
            assert!(ipc.dispatch("device.execute_command", json!({"command_key":"connection_subscription_cancel","args":["other",status]})).await.is_err());
            assert!(ipc.dispatch("device.execute_command", json!({"command_key":"connection_subscription_cancel","args":["task",status]})).await.is_ok());
        }
        let link = handler.store.get_task("task").unwrap();
        assert_eq!(link.goal_status.as_deref(), Some("blocked"));
        assert_eq!(link.goal_execution_status.as_deref(), Some("waitingForEvent"));
        assert!(handler.command_journal.lock().unwrap().is_empty());
        let restarted = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
        event_store::transact(&restarted.event_subscription_path(), |state| {
            for status in ["preparing", "armed", "pending", "resuming_goal", "error", "needs_attention"] {
                let id = restarted.subscription_id("task", status);
                assert_eq!(state["operations"][&id]["status"], "cancelled");
            }
            Ok(())
        }).unwrap();
    });
}

#[test]
fn desktop_cancellation_uses_current_connection_for_cloud_bound_task() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _home = EnvGuard::home(root.path().to_str().unwrap());
            let app = axum::Router::new().route(
                "/api/v1/runtime-tasks/cloud-context",
                axum::routing::get(
                    |uri: axum::http::Uri, headers: axum::http::HeaderMap| async move {
                        assert_eq!(
                            uri.query(),
                            Some("device_id=control-test-device&task_id=task")
                        );
                        match headers[axum::http::header::AUTHORIZATION].to_str().unwrap() {
                            "Bearer denied-session" => {
                                (axum::http::StatusCode::FORBIDDEN, axum::Json(json!({})))
                            }
                            "Bearer current-session" => (
                                axum::http::StatusCode::OK,
                                axum::Json(json!({"task_id":"task"})),
                            ),
                            _ => panic!("Unexpected authorization for cloud task"),
                        }
                    },
                ),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let _backend = EnvGuard::set(
                "WEGENT_BACKEND_URL",
                &format!("http://{address}/stale-environment"),
            );
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            let mut link = seed(&handler, "task");
            link.runtime_handle["cloudProjectId"] = json!("project");
            link.runtime_handle["executionRequest"]["backend_url"] =
                json!(format!("http://{address}/stale-backend"));
            handler.store.upsert_task(link);
            let id = handler.subscription_id("task", "watch");
            let record = json!({"task_id":"task","device_id":"control-test-device",
                "subscription_key":"watch","status":"armed","source":{"name":"PR"}});
            handler.save_event_subscription(&id, &record).unwrap();
            let ipc = crate::local::app_ipc::AppIpcServer::new()
                .with_runtime_work_handler(handler.clone());
            let command =
                json!({"command_key":"connection_subscription_cancel","args":["task","watch"]});

            let disconnected = ipc
                .dispatch("device.execute_command", command.clone())
                .await
                .unwrap_err();
            assert_eq!(disconnected.code, "cloud_unavailable");
            let mut connection = ConnectionConfig {
                backend_url: format!("http://{address}"),
                auth_token: "denied-session".into(),
                ..Default::default()
            };
            *handler.backend_connection.lock().unwrap() = Some(connection.clone());
            let denied = ipc
                .dispatch("device.execute_command", command.clone())
                .await
                .unwrap_err();
            assert_eq!(denied.code, "permission_denied");
            event_store::read(
                &handler.event_subscription_path(),
                event_store::Scope::Row("operations", &id),
                |state| {
                    assert_eq!(state["operations"][&id]["status"], "armed");
                    Ok(())
                },
            )
            .unwrap();

            connection.auth_token = "current-session".into();
            *handler.backend_connection.lock().unwrap() = Some(connection);
            let receipt = ipc
                .dispatch("device.execute_command", command)
                .await
                .unwrap();
            assert_eq!(receipt["stdout"]["subscription"]["status"], "cancelled");
            server.abort();
        });
}

#[test]
fn desktop_cancellation_rejects_delegated_task_origins() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            seed(&handler, "task");
            handler.store.update_task("task", |link| {
                link.runtime_handle["executionRequest"]["origin"] =
                    json!({"dispatchRole":"executor"});
            });
            let failure = handler
                .cancel_connection_subscription_from_ui(
                    json!({"taskId":"task","subscriptionKey":"watch"}),
                )
                .await
                .unwrap_err();
            assert!(failure
                .message
                .contains("no longer permits personal control"));
        });
}
