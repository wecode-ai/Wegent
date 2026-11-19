//! Busy conversations accept source input into the ordinary durable queue.
use super::super::tests::{context, seed, EnvGuard};
use super::*;

#[test]
fn received_event_enters_the_message_queue_while_the_conversation_is_busy() {
    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
        let mut link = seed(&handler,"caller");
        link.runtime_handle["executionRequest"]["user_id"] = json!(7);
        handler.store.upsert_task(link.clone());
        handler.preparing_turns.lock().unwrap().insert("caller".into(), PreparingTurn { owner_request:None,cancellation_requested:false });
        handler.turn_scheduler.lock().unwrap().active_task_ids.insert("caller".into(), RuntimeTaskKind::Personal);
        let key = "a".repeat(64);
        let subscription_key = "busy-event";
        let id = &handler.subscription_id("caller", subscription_key);
        let operation = super::super::execution::continuation_operation_id("control-test-device","caller",&format!("connection-event:{id}"));
        let event = json!({"id":"ci-terminal","topicId":"pr","text":"Checks failed","at":chrono::Utc::now().to_rfc3339()});
        let record = json!({"subscription_key":subscription_key,"task_id":"caller","device_id":"control-test-device",
            "session":session::binding(&link).unwrap(),"source":{"name":"Repository","enabledAfter":"2026-01-01T00:00:00Z"},
            "status":"pending","operation_id":operation,"continuation":"Inspect the CI failure","events":[event],
            "resource_event_keys":[key],"observation_id":"observation"});
        handler.save_event_subscription(id,&record).unwrap();
        event_store::transact(&handler.event_subscription_path(),|state| {
            state["observations"]["observation"] = json!({"events":[{"key":key,"sequence":1,"event":event}]}); Ok(())
        }).unwrap();
        assert!(handler.is_busy_local_task("caller"));
        handler.collect_conversation_subscription(id,record,"cycle").await.unwrap();
        let saved = event_store::transact(&handler.event_subscription_path(),|state|Ok(state["operations"][id].clone())).unwrap();
        let receipt = handler.control_get_operation(&context("caller"),&json!({"operation_id":operation})).await.unwrap();
        assert_eq!(receipt["operation"]["delivery_status"],"accepted", "{receipt}");
        assert_eq!(saved["status"],"delivered");
        let queued = handler.turn_scheduler.lock().unwrap().queued_turns.clone();
        assert_eq!(queued.len(),1);
        assert_eq!(queued[0].request.extra["resource_event_keys"],json!([key]));
        handler.collect_conversation_subscription(id,saved,"cycle-2").await.unwrap();
        assert_eq!(handler.turn_scheduler.lock().unwrap().queued_turns.clone().len(),1,"The accepted event must not be enqueued twice");
        let unrelated = handler.control_continue(
            &context("caller"), link, json!({
                "conversation_id":workbench_control::conversation_id("control-test-device", "caller"),
                "request_key":"unrelated",
                "message":"Keep the unrelated queued continuation",
                "queue_if_busy":true,
            }),
        ).await.unwrap();
        assert_eq!(unrelated["operation"]["delivery_status"], "accepted");
        let unrelated_operation = unrelated["operation"]["operation_id"].as_str().unwrap();
        let cancelled = handler.control_operation(
            &context("caller"), "cancel_connection_event_subscription",
            json!({"subscription_key":subscription_key}),
        ).await.unwrap();
        assert_eq!(cancelled["subscription"]["status"], "cancelled");
        let admit = handler.automatic_input_admission("caller", &queued[0].request).unwrap();
        assert_eq!(admit().unwrap_err(), CODEX_APP_SERVER_TURN_CANCELLED);
        let turns = super::super::super::turns::read_runtime_turn_state(&handler.turn_queue_path).unwrap();
        assert_eq!(turns.queued_turns.len(), 1);
        assert_eq!(turns.queued_turns[0].request.extra["client_user_message_id"], unrelated_operation);
        assert_eq!(
            turns.commands[&command_journal::key("caller", &operation)].state,
            command_journal::CommandState::Cancelled,
        );
    });
}

#[test]
fn already_failed_pr_status_starts_one_turn_in_the_original_conversation() {
    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(verify_preexisting_pr_failure_delivery());
}

async fn verify_preexisting_pr_failure_delivery() {
    use crate::runtime_work::handler::tests::install_native_history;
    use std::fs;
    let root = tempfile::tempdir().unwrap();
    let _env = EnvGuard::home(root.path().to_str().unwrap());
    let sha = "a".repeat(40);
    let observed_sha = sha.clone();
    let thread = "c0dd0000-0000-4000-8000-000000000001";
    let topic = "https://github.com/org/repo/pull/1";
    let failed_at = (chrono::Utc::now() - chrono::Duration::minutes(2)).to_rfc3339();
    let app = axum::Router::new().route(
        "/wework/connections/v1/rpc",
        axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            let sha = observed_sha.clone();
            let failed_at = failed_at.clone();
            async move {
                let input = &body["input"];
                let result = match body["method"].as_str().unwrap() {
                    "validate" => input.clone(),
                    "initializeObservation" => json!({"checkpoint":{},"source":input}),
                    "collectObservation" => {
                        assert_eq!(input["source"]["observeCurrentStatus"], true);
                        assert!(failed_at.as_str() < input["source"]["enabledAfter"].as_str().unwrap());
                        json!({"events":[{
                            "id":"fresh-status-sample","eventType":"git.event","topicId":topic,
                            "at":chrono::Utc::now().to_rfc3339(),
                            "external":{"eventType":"tracked.status","headSha":sha,
                                "payload":{"headRefOid":sha,"statusCheckRollup":{"state":"FAILURE"},"conclusion":"failure"}}
                        }],"nextCheckpoint":{}})
                    }
                    method => panic!("Unexpected connection method: {method}"),
                };
                axum::Json(json!({"ok":true,"result":result}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
    install_native_history(&mut handler, root.path(), vec![], None);
    for (method, response) in [
        ("thread_goal_get", json!({"goal":null})),
        (
            "thread_resume",
            json!({"thread":{"id":thread,"modelProvider":"~"}}),
        ),
        ("turn_start", json!({"turn":{"id":"resumed"}})),
    ] {
        fs::write(
            root.path().join(format!("{method}.json")),
            response.to_string(),
        )
        .unwrap();
    }
    let notifications = ["started", "completed"].map(|phase| {
        json!({"method":format!("turn/{phase}"),"params":{
            "threadId":thread,"turn":{"id":"resumed",
                "status":if phase == "started" { "inProgress" } else { "completed" }}
        }})
        .to_string()
    });
    fs::write(
        root.path().join("turn_start.notifications.jsonl"),
        notifications.join("\n") + "\n",
    )
    .unwrap();
    handler
        .configure_connection_host(json!({
            "url":format!("http://{address}/wework/connections/v1/rpc"),
            "token":"a".repeat(64)
        }))
        .unwrap();
    let mut link = seed(&handler, "caller");
    link.thread_id = Some(thread.into());
    link.workspace_path = root.path().to_string_lossy().into_owned();
    link.runtime_handle = json!({"runtime":"codex","executionRequest":{"user_id":7,
        "bot":[{"shell_type":"Codex"}],"model_config":{"model_id":"gpt-test","api_key":"synthetic-key"}}});
    handler.store.upsert_task(link);

    let goal = handler
        .get_task_goal(json!({"taskId":"caller"}))
        .await
        .unwrap();
    assert_eq!(goal["accepted"], true, "{goal}");
    let request = json!({
        "subscription_key":"failed-pr", "git_wait":"merge", "head_sha":sha, "wait_for_event":true,
        "source":{"providerId":"@wegent/dsh-connection-git/github","profile":"[\"https://github.com\",\"7\"]",
            "kind":"repository","id":"42","name":"org/repo","transport":"cli",
            "monitoredObjects":[{"entityKind":"change_request","number":1}]},
        "continuation":"Inspect the CI failure"
    });
    let subscribed = handler
        .control_operation(
            &context("caller"),
            "subscribe_connection_events",
            request.clone(),
        )
        .await
        .unwrap();
    assert_eq!(subscribed["subscription"]["status"], "armed");
    assert_eq!(subscribed["conflict_subscription"]["status"], "armed");
    assert_eq!(
        subscribed["subscription"]["observation_id"],
        subscribed["conflict_subscription"]["observation_id"],
    );
    let replay = handler
        .control_operation(&context("caller"), "subscribe_connection_events", request)
        .await
        .unwrap();
    for field in ["subscription", "conflict_subscription"] {
        assert_eq!(
            replay[field]["subscription_key"],
            subscribed[field]["subscription_key"]
        );
    }

    handler
        .poll_conversation_connection_events(true)
        .await
        .unwrap();
    handler
        .poll_conversation_connection_events(true)
        .await
        .unwrap();
    let subscriptions = handler
        .control_operation(
            &context("caller"),
            "list_connection_event_subscriptions",
            json!({}),
        )
        .await
        .unwrap();
    let items = subscriptions["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "{subscriptions}");
    for (field, status) in [
        ("subscription", "delivered"),
        ("conflict_subscription", "armed"),
    ] {
        assert!(
            items.iter().any(|item| item["subscription_key"]
                == subscribed[field]["subscription_key"]
                && item["status"] == status),
            "{subscriptions}"
        );
    }
    let requests_path = root.path().join("requests.jsonl");
    let starts = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let calls: Vec<Value> = fs::read_to_string(&requests_path)
                .unwrap_or_default()
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect();
            let starts: Vec<_> = calls
                .into_iter()
                .filter(|call| call["method"] == "turn/start")
                .collect();
            if !starts.is_empty() && !handler.is_busy_local_task("caller") {
                break starts;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("The failure observation must start and finish a native turn");
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0]["params"]["threadId"], thread);
    let input = starts[0]["params"]["input"].to_string();
    assert!(input.contains("Inspect the CI failure"));
    assert!(input.contains("fresh-status-sample"));
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    server.abort();
}

#[test]
fn merge_subscription_replaces_legacy_heads_and_reuses_the_pr_wait() {
    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            let link = seed(&handler, "caller");
            let app = axum::Router::new().route(
                "/wework/connections/v1/rpc",
                axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                    let result = match body["method"].as_str().unwrap() {
                        "validate" => body["input"].clone(),
                        "initializeObservation" => json!({"source":body["input"],"checkpoint":{}}),
                        method => panic!("Unexpected connection method: {method}"),
                    };
                    axum::Json(json!({"ok":true,"result":result}))
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            handler
                .configure_connection_host(json!({
                    "url":format!("http://{address}/wework/connections/v1/rpc"),
                    "token":"a".repeat(64)
                }))
                .unwrap();

            let mut request = json!({
                "subscription_key":"legacy-a", "git_wait":"merge",
                "source":{"providerId":"@wegent/dsh-connection-git/github",
                    "profile":"[\"https://github.com\",\"7\"]", "kind":"repository","id":"42",
                    "name":"org/repo","monitoredObjects":[{"entityKind":"change_request","number":1}]},
                "continuation":"Check whether the PR can be merged"
            });
            let mut source = request["source"].clone();
            source["observeCurrentStatus"] = json!(true);
            let session = session::binding(&link).unwrap();
            for (key, sha) in [("legacy-a", "a".repeat(40)), ("legacy-b", "b".repeat(40))] {
                let mut filter = conditions::resolve(&request).unwrap();
                filter["/external/payload/headRefOid"] = json!(sha);
                handler.save_event_subscription(&handler.subscription_id("caller", key), &json!({
                    "subscription_key":key, "task_id":"caller", "session":session, "source":source,
                    "match":filter, "status":"armed",
                    "intent":{"source":source,"match":filter,"continuation":request["continuation"],"wait_for_event":false},
                    "cloud_registration":{"subscription_id":key}
                })).unwrap();
            }
            let mut checks = request.clone();
            checks["subscription_key"] = json!("checks");
            checks["git_wait"] = json!("checks");
            checks["head_sha"] = json!("b".repeat(40));
            handler.control_operation(&context("caller"), "subscribe_connection_events", checks)
                .await.unwrap();

            let first = handler.control_operation(
                &context("caller"), "subscribe_connection_events", request.clone()
            ).await.unwrap();
            assert_eq!(first["subscription"]["status"], "armed");
            assert_ne!(first["subscription"]["subscription_key"], "legacy-a");
            let retry = handler.control_operation(
                &context("caller"), "subscribe_connection_events", request.clone()
            ).await.unwrap();
            assert_eq!(retry, first);
            request["subscription_key"] = json!("another-key");
            request["head_sha"] = json!("c".repeat(40));
            let reused = handler.control_operation(
                &context("caller"), "subscribe_connection_events", request.clone()
            ).await.unwrap();
            assert_eq!(reused, first);

            request["continuation"] = json!("Report results without merging");
            let updated = handler.control_operation(
                &context("caller"), "subscribe_connection_events", request
            ).await.unwrap();
            assert_eq!(updated["subscription"]["continuation"], "Report results without merging");
            assert_eq!(updated["subscription"]["status"], "armed");

            let states = event_store::read(
                &handler.event_subscription_path(), event_store::Scope::Task("caller"),
                |state| Ok(state["operations"].clone()),
            ).unwrap();
            assert_eq!(states.as_object().unwrap().len(), 7);
            let old_conflict_key = first["conflict_subscription"]["subscription_key"].as_str().unwrap();
            let new_conflict_key = updated["conflict_subscription"]["subscription_key"].as_str().unwrap();
            assert_eq!(states[&handler.subscription_id("caller", old_conflict_key)]["status"], "cancelled");
            assert_eq!(states[&handler.subscription_id("caller", new_conflict_key)]["status"], "armed");
            let first_key = first["subscription"]["subscription_key"].as_str().unwrap();
            assert_eq!(states[&handler.subscription_id("caller", first_key)]["status"], "cancelled");
            for key in ["legacy-a", "legacy-b"] {
                let retired = &states[&handler.subscription_id("caller", key)];
                assert_eq!(retired["status"], "cancelled");
                assert_eq!(retired["cloud_cancel_pending"], true);
            }
            assert_eq!(states[&handler.subscription_id("caller", "checks")]["status"], "armed");
            server.abort();
        });
}
