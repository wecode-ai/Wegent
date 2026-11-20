use super::super::tests::{context, seed, EnvGuard};
use super::*;

#[test]
fn connection_provider_discovery_exposes_details_only_for_the_selected_provider() {
    let github = json!({"id": "github", "displayName": "GitHub", "resourceKinds": ["repository"],
        "availability": {"status": "ready"}, "assistance": {"observe": ["Wait for checks"]}});
    let catalog = json!({"items": [github, {"id": "gitlab"}]});
    let summary = connection_event_provider_catalog(catalog.clone(), None).unwrap();
    assert_eq!(summary["items"][0]["id"], "github");
    assert!(summary["items"][0].get("assistance").is_none());
    assert_eq!(summary["_meta"]["connectionEventProviderCatalog"], catalog);

    let selected = connection_event_provider_catalog(catalog.clone(), Some("github")).unwrap();
    assert_eq!(selected, json!({"items": [github]}));
    assert_eq!(
        connection_event_provider_catalog(catalog, Some("missing"))
            .unwrap_err()
            .code,
        "not_found"
    );
}

fn seed_claude(handler: &RuntimeWorkRpcHandler, task: &str) -> RuntimeTaskLink {
    let mut link = seed(handler, task);
    link.runtime = "claude_code".into();
    handler.store.upsert_task(link.clone());
    let mut request = runtime_event_request_from_link(&link);
    request.new_session = false;
    crate::agent_session::save_session_id(&request, &format!("native-{task}"));
    assert!(session::binding(&link).is_ok());
    link
}

#[test]
fn event_receipts_validate_host_facts_and_do_not_restart_accepted_execution() {
    use crate::runtime_work::handler::command_journal::{CommandState, RuntimeCommand};
    let _guard = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _env = EnvGuard::home(root.path().to_str().unwrap());
    let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
    let event_key = "a".repeat(64);
    let second_event_key = "b".repeat(64);
    event_store::transact(&handler.event_subscription_path(), |state| {
        state["observations"] =
            json!({"observed":{"events":[{"key":event_key,"sequence":1,"event":{"id":"already-delivered","at":"2026-11-15T00:00:01Z"}},{"key":second_event_key,"sequence":2,"event":{"id":"new-event","at":"2026-11-15T00:00:01Z"}}]}});
        state["operations"]["subscription"] = json!({"task_id":"task","observation_id":"observed","source":{"enabledAfter":"2026-11-15T00:00:00Z"}});
        Ok(())
    })
    .unwrap();
    let turn = |id: &str, user: i64, key: &str| {
        let payload = json!({"commandId":id,"message":id,"resourceEventKeys":[key]});
        let mut request = ExecutionRequest {
            prompt: json!(id),
            ..Default::default()
        };
        request.extra.insert("user_id".into(), json!(user));
        apply_runtime_payload_metadata(&mut request, &payload);
        SpawnTurnRequest {
            task_kind: None,
            local_task_id: "task".into(),
            runtime: "codex".into(),
            request,
            send_payload: Some(payload),
            direct_thread_id: None,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: None,
            initial_thread_goal: None,
        }
    };
    let original = turn("accepted", 7, &event_key);
    let command = RuntimeCommand::from_turn(&original, CommandState::AwaitingUser)
        .unwrap()
        .unwrap();
    handler
        .command_journal
        .lock()
        .unwrap()
        .insert(command.key(), command);
    let receipt = handler
        .existing_command(&turn("other-consumer", 7, &event_key))
        .unwrap()
        .unwrap();
    assert_eq!(receipt["commandId"], "accepted");
    assert_eq!(receipt["state"], "awaiting_user");
    assert_eq!(receipt["requiresUserReview"], true);
    assert!(handler
        .existing_command(&turn("other-user", 8, &event_key))
        .unwrap()
        .is_none());
    assert!(handler
        .existing_command(&turn("forged", 7, &"f".repeat(64)))
        .is_err());
    let mut different_task = turn("other-task", 7, &event_key);
    different_task.local_task_id = "other-task".into();
    assert!(handler.existing_command(&different_task).is_err());
    let mut partial = turn("partial", 7, &event_key);
    partial.request.extra.insert(
        "resource_event_keys".into(),
        json!([event_key, second_event_key]),
    );
    let fingerprint = RuntimeCommand::from_turn(&partial, CommandState::Queued)
        .unwrap()
        .unwrap()
        .fingerprint;
    let input_identity = partial.request.extra["runtime_command_input"].clone();
    handler
        .prepare_resource_event_request("task", &mut partial.request)
        .unwrap();
    assert_eq!(
        partial.request.extra["resource_event_keys"],
        json!([second_event_key])
    );
    assert_eq!(
        partial.request.extra["runtime_command_input"],
        input_identity
    );
    assert_eq!(
        RuntimeCommand::from_turn(&partial, CommandState::Queued)
            .unwrap()
            .unwrap()
            .fingerprint,
        fingerprint
    );
    let prompt = partial.request.prompt.as_str().unwrap();
    let delivered: Value =
        serde_json::from_str(&prompt[prompt.find("\n{").unwrap() + 1..]).unwrap();
    assert_eq!(
        delivered["events"],
        json!([{"id":"new-event","at":"2026-11-15T00:00:01Z"}])
    );
    assert_eq!(delivered["eventKeys"], json!([second_event_key]));
    assert_eq!(
        delivered["previouslyDeliveredEventKeys"],
        json!([event_key])
    );
    let second_command =
        RuntimeCommand::from_turn(&turn("second", 7, &second_event_key), CommandState::Settled)
            .unwrap()
            .unwrap();
    let second_key = second_command.key();
    handler
        .command_journal
        .lock()
        .unwrap()
        .insert(second_key.clone(), second_command);
    let mut combined = turn("combined", 7, &event_key);
    combined.request.extra.insert(
        "resource_event_keys".into(),
        json!([event_key, second_event_key]),
    );
    let combined_receipt = handler.existing_command(&combined).unwrap().unwrap();
    assert_eq!(
        combined_receipt["resourceEventCommands"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(combined_receipt["requiresUserReview"], true);
    handler
        .command_journal
        .lock()
        .unwrap()
        .get_mut(&second_key)
        .unwrap()
        .state = CommandState::RecoveryRequired;
    assert_eq!(
        handler.existing_command(&combined).unwrap_err().code,
        "command_recovery_required",
        "Every owning command must be checked, not just the first event's receipt"
    );
    let key = crate::runtime_work::handler::command_journal::key("task", "accepted");
    let mut partial_unknown = turn("partial-unknown", 7, &second_event_key);
    partial_unknown.request.extra.insert(
        "resource_event_keys".into(),
        json!([second_event_key, "c".repeat(64)]),
    );
    event_store::transact(&handler.event_subscription_path(), |state| {
        state["observations"]["observed"]["events"]
            .as_array_mut()
            .unwrap()
            .push(json!({"key":"c".repeat(64),"sequence":3,"event":{"id":"fresh","at":"2026-11-15T00:00:01Z"}}));
        Ok(())
    })
    .unwrap();
    assert!(handler
        .existing_command(&partial_unknown)
        .unwrap()
        .is_none());
    assert_eq!(
        handler
            .prepare_resource_event_request("task", &mut partial_unknown.request)
            .unwrap_err()
            .code,
        "command_recovery_required"
    );
    handler
        .command_journal
        .lock()
        .unwrap()
        .get_mut(&key)
        .unwrap()
        .state = CommandState::RecoveryRequired;
    assert_eq!(
        handler
            .existing_command(&turn("new-consumer", 7, &event_key))
            .unwrap_err()
            .code,
        "command_recovery_required"
    );
}

#[test]
fn observations_share_collection_and_isolate_provider_accounts() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = calls.clone();
        let app = axum::Router::new().route("/wework/connections/v1/rpc", axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            captured.lock().unwrap().push(body.clone());
            async move {
                let result = match body["method"].as_str().unwrap() {
                    "initializeObservation" => json!({"checkpoint":{"cursor":0},"source":body["input"]}),
                    "collectObservation" if body["input"]["checkpoint"]["cursor"] == 0 => json!({"events":[{"id":"revision","objectId":"doc","version":"v1","eventType":"document.updated","at":"2026-11-15T00:00:01Z"}],"nextCheckpoint":{"cursor":1}}),
                    "collectObservation" => json!({"events":(0..1000).map(|index| json!({"id":format!("later-{index}"),"eventType":"document.updated","at":"2026-11-15T00:00:02Z"})).collect::<Vec<_>>(),"nextCheckpoint":{"cursor":2}}),
                    _ => panic!("Unexpected provider call"),
                };
                axum::Json(json!({"ok":true,"result":result}))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
        handler.configure_connection_host(json!({"url":format!("http://{address}/wework/connections/v1/rpc"),"token":"a".repeat(64)})).unwrap();
        let mut source = json!({"providerId":"documents","profile":"account-a","kind":"document","id":"doc","name":"Document","enabledAfter":"2026-11-15T00:00:00Z"});
        let (first, sequence, _) = handler.attach_event_observation(&mut source).await.unwrap();
        assert_eq!(sequence,0);
        let mut later = source.clone();
        later["enabledAfter"] = json!("2026-11-15T01:00:00Z");
        let (second, _, _) = handler.attach_event_observation(&mut later).await.unwrap();
        assert_eq!(first,second);
        let record = json!({"observation_id":first});
        let observed = handler.read_event_observation(&record,"tick-1",false).await.unwrap();
        assert_eq!(handler.read_event_observation(&record,"tick-1",false).await.unwrap(),observed);
        assert_eq!(calls.lock().unwrap().len(),3,"Each consumer activates independently and shares one collection");
        let mut other = source.clone();
        other["profile"] = json!("account-b");
        assert_ne!(handler.attach_event_observation(&mut other).await.unwrap().0,first);
        let key = observed["events"][0]["key"].as_str().unwrap().to_owned();
        handler.save_event_subscription("first",&json!({"task_id":"first-task","subscription_key":"first","status":"armed","source":source,"observation_id":first})).unwrap();
        handler.validate_resource_event_keys("first-task",std::slice::from_ref(&key)).unwrap();
        handler.save_event_subscription("later",&json!({"task_id":"later-task","subscription_key":"later","status":"armed","source":later,"observation_id":first})).unwrap();
        assert!(handler.validate_resource_event_keys("later-task",std::slice::from_ref(&key)).is_err(),"A shared historical event is not a new consumer's execution trigger");
        assert!(handler.validate_resource_event_keys("other-task",std::slice::from_ref(&key)).is_err());
        assert!(handler.validate_resource_event_keys("first-task",&["f".repeat(64)]).is_err());
        handler.save_event_subscription("third", &json!({"task_id":"third-task","subscription_key":"third","status":"armed","source":source,"observation_id":first,"match":{"/id":"revision"}})).unwrap();
        let compacted = handler.read_event_observation(&record,"tick-2",true).await.unwrap();
        assert_eq!(compacted["checkpoint"]["cursor"], 2);
        assert_eq!(compacted["events"].as_array().unwrap().len(), 1000);
        assert!(compacted["events"].as_array().unwrap().iter().all(|entry|entry["event"]["id"]!="revision"));
        let persisted = event_store::transact(&handler.event_subscription_path(), |state|Ok(state["operations"].clone())).unwrap();
        for id in ["first", "third"] {
            assert_eq!(persisted[id]["status"], "pending");
            assert_eq!(persisted[id]["events"][0]["id"], "revision");
        }
        assert_eq!(persisted["later"]["status"], "armed", "A later activation must not receive earlier events");
        let restarted = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
        restarted.validate_resource_event_keys("first-task",std::slice::from_ref(&key)).unwrap();
        restarted.validate_resource_event_keys("third-task",std::slice::from_ref(&key)).unwrap();
        assert!(restarted.validate_resource_event_keys("later-task",std::slice::from_ref(&key)).is_err());
        assert_eq!(calls.lock().unwrap().iter().filter(|call|call["method"]=="collectObservation").count(),2);
        server.abort();
    });
}

#[test]
fn event_filters_use_exact_provider_values_and_valid_json_pointers() {
    let event = json!({"eventType":"document.updated","topicId":"doc-7","revision":7,"nested":{"a/b":null}});
    assert!(matches_event(&json!({}), &event));
    assert!(matches_event(
        &json!({"/eventType":"document.updated","/topicId":"doc-7","/revision":7,"/nested/a~1b":null}),
        &event
    ));
    assert!(!matches_event(&json!({"/revision":"7"}), &event));
    assert!(!matches_event(&json!({"/absent":null}), &event));
    for filter in [
        json!({"eventType":"updated"}),
        json!({"/bad~":true}),
        json!({"/bad~3":1}),
        json!([]),
    ] {
        assert!(validate_filter(&filter).is_err(), "{filter}");
    }
}

#[test]
fn goal_wait_identity_preserves_budget_and_does_not_follow_replaced_goals() {
    let goal = json!({"objective":"Finish work","createdAt":1,"tokenBudget":300,"tokensUsed":12,"status":"active"});
    let mut blocked = goal.clone();
    blocked["status"] = json!("blocked");
    blocked["tokensUsed"] = json!(15);
    assert_eq!(goal_identity(&goal), goal_identity(&blocked));
    for (key, value) in [
        ("objective", json!("New work")),
        ("createdAt", json!(2)),
        ("tokenBudget", json!(400)),
    ] {
        let mut replacement = blocked.clone();
        replacement[key] = value;
        assert_ne!(goal_identity(&goal), goal_identity(&replacement));
    }
}

#[test]
fn delayed_native_goal_projections_cannot_cancel_a_newly_armed_wait() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
        let link = seed_claude(&handler, "caller");
        let initial = handler.set_claude_goal(&link, &json!({"objective":"Original work","status":"active","tokenBudget":500}));
        // Capture notifications before the acknowledged suspension and deliver them later.
        let delayed = [json!({"method":"thread/goal/updated","params":{"goal":{"status":"active"}}}),
            json!({"method":"thread/goal/updated","params":{"goal":{"status":"complete"}}}),
            json!({"method":"thread/goal/cleared","params":{}})];
        let mut record = json!({"task_id":"caller","subscription_key":"wait","status":"preparing",
            "waiting_goal":goal_identity(&initial),"session":session::binding(&link).unwrap()});
        handler.save_event_subscription("wait", &record).unwrap();
        handler.prepare_event_goal_wait("wait", &mut record).await.unwrap();
        assert_eq!(record["status"], "armed");
        let gate = handler.task_send_gate("goal-status:caller");
        let admission = gate.lock().await;
        for message in delayed {
            handler.sync_runtime_task_goal_from_notification("caller", &message);
            assert_eq!(handler.connection_goal_reconciliations.lock().unwrap().len(), 1);
            assert_eq!(event_store::transact(&handler.event_subscription_path(), |state| Ok(state["operations"]["wait"]["status"].clone())).unwrap(), "armed");
        }
        drop(admission);
        tokio::time::timeout(Duration::from_secs(2), async {
            while !handler.connection_goal_reconciliations.lock().unwrap().is_empty() { tokio::task::yield_now().await; }
        }).await.unwrap();
        assert_eq!(handler.read_event_goal("caller").await.unwrap()["status"], "blocked");
        assert_eq!(event_store::transact(&handler.event_subscription_path(), |state| Ok(state["operations"]["wait"]["status"].clone())).unwrap(), "armed");
    });
}

#[test]
fn current_goal_identity_phase_and_read_failures_govern_wait_cancellation() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
        let link = seed_claude(&handler, "caller");
        let initial = handler.set_claude_goal(&link, &json!({"objective":"Original work","status":"blocked","tokenBudget":500}));
        for (phase, current, retained) in [
            ("preparing", "active", true), ("resuming_goal", "active", true),
            ("armed", "active", false), ("pending", "blocked", true),
            ("armed", "complete", false), ("resuming_goal", "paused", false),
            ("armed", "cleared", false), ("armed", "replaced", false),
        ] {
            let link = handler.store.get_task("caller").unwrap();
            handler.set_claude_goal(&link, &initial);
            let record = json!({"task_id":"caller","subscription_key":phase,"status":phase,"waiting_goal":goal_identity(&initial),"session":session::binding(&link).unwrap()});
            let id = format!("{phase}-{current}");
            handler.save_event_subscription(&id, &record).unwrap();
            let link = handler.store.get_task("caller").unwrap();
            match current {
                "cleared" => { handler.clear_claude_goal(&link); },
                "replaced" => { handler.set_claude_goal(&link, &json!({"objective":"Different work","status":"blocked"})); },
                status => { handler.set_claude_goal(&link, &json!({"status":status})); },
            }
            handler.reconcile_connection_goal_waits("caller").await.unwrap();
            assert_eq!(event_store::transact(&handler.event_subscription_path(), |state| Ok(state["operations"][&id]["status"].clone())).unwrap(), if retained {phase} else {"cancelled"}, "{phase}/{current}");
        }
        let link = handler.store.get_task("caller").unwrap();
        handler.set_claude_goal(&link, &initial);
        let receipt = json!({
            "task_id": "caller",
            "subscription_key": "guided",
            "status": "resuming_goal",
            "operation_id": "event-operation",
            "native_guidance": "accepted",
            "waiting_goal": goal_identity(&initial),
            "session": session::binding(&link).unwrap(),
        });
        handler.save_event_subscription("guided-reconcile", &receipt).unwrap();
        let link = handler.store.get_task("caller").unwrap();
        handler.set_claude_goal(&link, &json!({"status":"complete"}));
        handler.reconcile_connection_goal_waits("caller").await.unwrap();

        let link = handler.store.get_task("caller").unwrap();
        handler.set_claude_goal(&link, &initial);
        handler.save_event_subscription("guided-sync", &receipt).unwrap();
        let mut unrelated = receipt.clone();
        unrelated["waiting_goal"]["objective"] = json!("Previous work");
        handler.save_event_subscription("guided-replaced", &unrelated).unwrap();
        let result = handler.set_task_goal(json!({"taskId":"caller","status":"complete"})).await.unwrap();
        assert_eq!(result["accepted"], true);
        let projection = event_store::read(
            &handler.event_subscription_path(),
            event_store::Scope::TaskProjection("caller"),
            |state| Ok(state["operations"].clone()),
        ).unwrap();
        for id in ["guided-reconcile", "guided-sync"] {
            assert_eq!(projection[id]["status"], "delivered", "{id}");
            assert_eq!(projection[id]["operation_id"], "event-operation");
        }
        assert!(projection["guided-replaced"].is_null());
        assert_eq!(
            event_store::read(
                &handler.event_subscription_path(),
                event_store::Scope::Row("operations", "guided-replaced"),
                |state| Ok(state["operations"]["guided-replaced"]["status"].clone()),
            ).unwrap(),
            "cancelled"
        );
        let mut link = handler.store.get_task("caller").unwrap();
        handler.set_claude_goal(&link, &initial);
        let record = json!({"task_id":"caller","subscription_key":"unavailable","status":"armed","waiting_goal":goal_identity(&initial),"session":session::binding(&link).unwrap()});
        handler.save_event_subscription("unavailable", &record).unwrap();
        link.runtime = "codex".into();
        link.thread_id = Some("missing-native-session".into());
        handler.store.upsert_task(link);
        assert!(handler.reconcile_connection_goal_waits("caller").await.is_err());
        assert_eq!(event_store::transact(&handler.event_subscription_path(), |state| Ok(state["operations"]["unavailable"]["status"].clone())).unwrap(), "armed");
    });
}

#[test]
fn goal_status_sync_projects_native_status_when_wait_storage_fails() {
    let _guard = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _env = EnvGuard::home(root.path().to_str().unwrap());
    let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
    let link = seed_claude(&handler, "caller");
    let goal = handler.set_claude_goal(
        &link,
        &json!({"objective":"Finish work","status":"blocked","tokenBudget":500}),
    );
    let waiting = json!({
        "task_id": "caller",
        "subscription_key": "wait",
        "status": "armed",
        "waiting_goal": goal_identity(&goal),
        "session": session::binding(&link).unwrap(),
    });
    handler.save_event_subscription("wait", &waiting).unwrap();
    let mut delivered = waiting.clone();
    delivered["status"] = json!("delivered");
    handler
        .save_event_subscription("delivered", &delivered)
        .unwrap();
    let connection = rusqlite::Connection::open(handler.event_subscription_path()).unwrap();
    connection
        .execute(
            "UPDATE records SET metadata='invalid' WHERE section='operations' AND id='delivered'",
            [],
        )
        .unwrap();
    let mut active = goal;
    active["status"] = json!("active");
    handler.sync_runtime_task_goal_status("caller", Some("active".into()), Some(&active));
    assert_eq!(
        handler
            .store
            .get_task("caller")
            .unwrap()
            .goal_status
            .as_deref(),
        Some("active"),
    );
    let wait_status: String = connection
        .query_row(
            "SELECT status FROM records WHERE section='operations' AND id='wait'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(wait_status, "armed", "The failed projection must roll back");
}

#[test]
fn goal_wait_transactions_recover_without_resetting_usage_or_overriding_user_pause() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let handler = RuntimeWorkRpcHandler::new("control-test-device","/bin/false");
        let link=seed_claude(&handler,"caller");
        let initial = handler.set_claude_goal(&link,&json!({"objective":"Review a document","status":"active","createdAt":now_ms()-1000,"tokenBudget":500,"tokensUsed":123,"timeUsedSeconds":9}));
        let identity = goal_identity(&initial);
        let mut record = json!({"task_id":"caller","subscription_key":"goal-wait","status":"preparing","waiting_goal":identity,"wait_for_event":true,"source":{"name":"Document"},"continuation":"Process the document update","resource_event_keys":["document-version"]});
        record["session"]=session::binding(&link).unwrap();
        handler.save_event_subscription("goal-wait",&record).unwrap();
        handler.prepare_event_goal_wait("goal-wait",&mut record).await.unwrap();
        assert_eq!(record["status"],"armed");
        let blocked = handler.read_event_goal("caller").await.unwrap();
        assert_eq!(blocked["status"],"blocked");
        assert_eq!(goal_identity(&blocked),identity);
        assert_eq!(blocked["tokensUsed"],123);
        assert_eq!(blocked["timeUsedSeconds"],9);
        // Recover a crash after native suspension but before committing armed.
        record["status"] = json!("preparing");
        handler.save_event_subscription("goal-wait",&record).unwrap();
        handler.prepare_event_goal_wait("goal-wait",&mut record).await.unwrap();
        record["status"] = json!("resuming_goal");
        record["operation_id"] = json!("already-accepted-event");
        handler.save_event_subscription("goal-wait",&record).unwrap();
        let restarted = RuntimeWorkRpcHandler::new("control-test-device","/bin/false");
        restarted.poll_conversation_connection_events(true).await.unwrap();
        assert_eq!(restarted.read_event_goal("caller").await.unwrap()["status"],"blocked","collection must wait for actual worker capacity");
        let mut request = ExecutionRequest { prompt:record["continuation"].clone(),..Default::default() };
        request.extra.insert("client_user_message_id".into(),record["operation_id"].clone());
        apply_runtime_payload_metadata(&mut request,&json!({"commandId":record["operation_id"],"message":event_user_message_presentation(&record)["content"],"resourceEventKeys":record["resource_event_keys"]}));
        restarted.admit_claude_event_goal("caller",&request).await.unwrap();
        let active = restarted.read_event_goal("caller").await.unwrap();
        assert_eq!(active["status"],"active");
        assert_eq!(goal_identity(&active),identity);
        assert_eq!(active["tokensUsed"],123);
        let recovered = event_store::transact(&restarted.event_subscription_path(),|state| Ok(state["operations"]["goal-wait"].clone())).unwrap();
        assert_eq!(recovered["status"],"delivered");
        restarted.set_claude_goal(&restarted.store.get_task("caller").unwrap(),&json!({"status":"blocked"}));
        restarted.poll_conversation_connection_events(true).await.unwrap();
        assert_eq!(restarted.read_event_goal("caller").await.unwrap()["status"],"blocked","a completed event must not reactivate the same Goal after it blocks again");
        assert!(restarted.admit_claude_event_goal("caller",&request).await.is_err(),"accepted event work cannot start twice");
        // A second interrupted preparation is invalidated by an explicit pause.
        let mut second = record.clone();
        second["subscription_key"] = json!("second-wait");
        second["status"] = json!("preparing");
        restarted.save_event_subscription("second-wait",&second).unwrap();
        restarted.set_task_goal(json!({"taskId":"caller","status":"paused"})).await.unwrap();
        assert!(restarted.save_event_subscription("second-wait",&second).is_err(),"A stale collector cannot overwrite cancellation");
        restarted.poll_conversation_connection_events(true).await.unwrap();
        assert_eq!(restarted.read_event_goal("caller").await.unwrap()["status"],"paused");
    });
}

#[test]
fn event_goal_worker_requires_host_intent_and_preserves_an_earlier_human_pause() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let handler = RuntimeWorkRpcHandler::new("control-test-device","/bin/false");
        let link=seed_claude(&handler,"caller");
        let goal=handler.set_claude_goal(&link,&json!({"objective":"Wait for the review","status":"blocked","tokenBudget":500,"tokensUsed":123}));
        let record=json!({"task_id":"caller","status":"resuming_goal","subscription_key":"review","operation_id":"event-operation","session":session::binding(&link).unwrap(),"waiting_goal":goal_identity(&goal),"continuation":"Process the review","resource_event_keys":["a".repeat(64)],"source":{"name":"Review"}});
        handler.save_event_subscription("review",&record).unwrap();
        let request_for = |message:&str| {
            let mut request=ExecutionRequest{prompt:json!(message),..Default::default()};
            request.extra.insert("client_user_message_id".into(),json!("event-operation"));
            apply_runtime_payload_metadata(&mut request,&json!({"commandId":"event-operation","message":event_user_message_presentation(&record)["content"],"resourceEventKeys":record["resource_event_keys"]}));
            request
        };
        assert!(handler.admit_claude_event_goal("caller",&request_for("Run unrelated work")).await.is_err());
        assert_eq!(handler.read_event_goal("caller").await.unwrap()["status"],"blocked");
        let gate=handler.task_send_gate("goal-status:caller");
        let held=gate.lock().await;
        let owner=handler.clone();
        let pause=tokio::spawn(async move { owner.set_task_goal(json!({"taskId":"caller","status":"paused"})).await });
        tokio::task::yield_now().await;
        let worker=handler.clone();
        let request=request_for("Process the review");
        let work=tokio::spawn(async move { worker.admit_claude_event_goal("caller",&request).await });
        tokio::task::yield_now().await;
        assert!(!work.is_finished(),"worker admission must wait on the same Goal gate as the owner");
        drop(held);
        assert_eq!(pause.await.unwrap().unwrap()["accepted"],true);
        assert!(work.await.unwrap().is_err());
        let paused=handler.read_event_goal("caller").await.unwrap();
        assert_eq!(paused["status"],"paused");
        assert_eq!(paused["tokensUsed"],123);
    });
}

#[test]
fn event_goal_recovers_the_binding_before_collector_acceptance_is_saved() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root=tempfile::tempdir().unwrap();
        let _env=EnvGuard::home(root.path().to_str().unwrap());
        let handler=RuntimeWorkRpcHandler::new("control-test-device","/bin/false");
        let link=seed_claude(&handler,"caller");
        let goal=handler.set_claude_goal(&link,&json!({"objective":"Wait for an external update","status":"blocked","tokenBudget":500,"tokensUsed":123}));
        let operation=super::super::execution::continuation_operation_id("control-test-device","caller","connection-event:review");
        let mut record=json!({"task_id":"caller","status":"pending","subscription_key":"review","waiting_goal":goal_identity(&goal),"continuation":"Process the external update","resource_event_keys":["a".repeat(64)],"source":{"name":"Review"}});
        record["session"]=session::binding(&link).unwrap();
        handler.save_event_subscription("review",&record).unwrap();
        let mut request=ExecutionRequest{prompt:record["continuation"].clone(),..Default::default()};
        request.extra.insert("client_user_message_id".into(),json!(operation));
        apply_runtime_payload_metadata(&mut request,&json!({"commandId":operation,"message":event_user_message_presentation(&record)["content"],"resourceEventKeys":record["resource_event_keys"]}));
        assert!(handler.admit_claude_event_goal("caller",&request).await.is_err(),"a recognizable event operation without durable authority must never enter ordinary execution");
        assert_eq!(handler.read_event_goal("caller").await.unwrap()["status"],"blocked");
        record["operation_id"]=json!(operation);
        handler.save_event_subscription("review",&record).unwrap();
        // Model the durable queue surviving a crash before collector acceptance.
        let restarted=RuntimeWorkRpcHandler::new("control-test-device","/bin/false");
        restarted.admit_claude_event_goal("caller",&request).await.unwrap();
        assert_eq!(restarted.read_event_goal("caller").await.unwrap()["status"],"active");
        let saved=event_store::transact(&restarted.event_subscription_path(),|state|Ok(state["operations"]["review"].clone())).unwrap();
        assert_eq!(saved["status"],"delivered");
        assert_eq!(saved["native_event_phase"],"activated");
    });
}

#[test]
fn subscriptions_collect_without_models_and_preserve_pending_events_across_restart() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = calls.clone();
        let app = axum::Router::new().route("/wework/connections/v1/rpc", axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            let calls = captured.clone();
            async move {
                calls.lock().unwrap().push(body.clone());
                let result = match body["method"].as_str().unwrap() {
                    "validate" => body["input"].clone(),
                    "initializeObservation" => json!({"checkpoint":{"cursor":10},"source":body["input"]}),
                    "collectObservation" => {
                        let cursor = body["input"]["checkpoint"]["cursor"].as_i64().unwrap();
                        let event = if cursor == 10 {
                            json!({"id":"ignored","eventType":"document.created","text":"new","at":chrono::Utc::now().to_rfc3339()})
                        } else {
                            json!({"id":"event-11","objectId":"doc-7","version":"v2","eventType":"document.updated","text":"changed","at":chrono::Utc::now().to_rfc3339()})
                        };
                        let events = if cursor >= 12 { (0..1000).map(|index| json!({"id":format!("later-{index}"),"eventType":"document.updated","text":"Later revision","at":chrono::Utc::now().to_rfc3339()})).collect::<Vec<_>>() } else { vec![event.clone(),event] };
                        json!({"events":events,"nextCheckpoint":{"cursor":cursor+1},"hasMore":false})
                    },
                    _ => panic!("Unexpected plugin method: {}",body["method"]),
                };
                axum::Json(json!({"ok":true,"result":result}))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
        handler.configure_connection_host(json!({"url":format!("http://{address}/wework/connections/v1/rpc"),"token":"a".repeat(64)})).unwrap();
        seed(&handler,"caller");
        handler.store.update_task("caller", |link| link.interaction_status = Some("waitingForUserInput".into()));
        let args = json!({"subscription_key":"document-v2","source":{"providerId":"third-party/documents","profile":"owned-account","kind":"document","id":"doc-7","name":"Release document"},"match":{"/eventType":"document.updated"},"continuation":"Continue reviewing the document"});
        let first = handler.control_operation(&context("caller"),"subscribe_connection_events",args.clone()).await.unwrap();
        assert_eq!(first["subscription"]["status"],"armed");
        workbench_control::assert_output_contract("subscribe_connection_events", &first);
        assert_eq!(handler.control_operation(&context("caller"),"subscribe_connection_events",args.clone()).await.unwrap(),first);
        assert_eq!(calls.lock().unwrap().len(),2,"An idempotent call must not initialize another cursor");
        let mut conflicting = args.clone();
        conflicting["continuation"] = json!("Different work");
        assert!(handler.control_operation(&context("caller"),"subscribe_connection_events",conflicting).await.is_err());
        handler.poll_conversation_connection_events(true).await.unwrap();
        let listed = handler.control_operation(&context("caller"),"list_connection_event_subscriptions",json!({})).await.unwrap();
        assert_eq!(listed["items"][0]["status"],"armed","Unrelated events must not wake the model");
        // Advance the source's due time instead of sleeping through a scheduler interval.
        event_store::transact(&handler.event_subscription_path(),|state| { state["observations"][first["subscription"]["observation_id"].as_str().unwrap()]["next_poll_at"]=json!(0); Ok(()) }).unwrap();
        handler.poll_conversation_connection_events(true).await.unwrap();
        let id = handler.subscription_id("caller","document-v2");
        let read_record = || event_store::transact(&handler.event_subscription_path(), |state| Ok(state["operations"][&id].clone())).unwrap();
        let pending = read_record();
        assert_eq!(pending["status"],"pending");
        assert_eq!(pending["events"].as_array().unwrap().len(),1,"Duplicate provider events are delivered once");
        let observation = event_store::transact(&handler.event_subscription_path(), |state| Ok(state["observations"][pending["observation_id"].as_str().unwrap()].clone())).unwrap();
        assert_eq!(observation["checkpoint"]["cursor"],12);
        let summary = handler.get_task(&json!({"taskId":"caller"})).unwrap();
        assert_eq!(summary["task"]["runtimeHandle"]["connectionEventSubscriptions"][0]["observed_events"],2);
        assert!(summary["task"]["runtimeHandle"].get("executionRequest").is_none(),"Status reads must not expose the execution profile");
        assert!(pending.get("operation_id").is_none(),"A pending human question must not be answered or interrupted");
        let restored = RuntimeWorkRpcHandler::new("control-test-device","/bin/false");
        restored.store.update_task("caller", |link| link.interaction_status = Some("waitingForUserInput".into()));
        event_store::transact(&restored.event_subscription_path(),|state| { state["observations"][pending["observation_id"].as_str().unwrap()]["next_poll_at"]=json!(0); Ok(()) }).unwrap();
        restored.poll_conversation_connection_events(true).await.unwrap();
        assert_eq!(read_record()["events"],pending["events"]);
        let retained = event_store::transact(&restored.event_subscription_path(),|state| Ok(state["observations"][pending["observation_id"].as_str().unwrap()]["events"].clone())).unwrap();
        assert_eq!(retained.as_array().unwrap().len(),1000);
        assert!(!retained.as_array().unwrap().iter().any(|entry| entry["event"]["id"] == "event-11"));
        let again = RuntimeWorkRpcHandler::new("control-test-device","/bin/false");
        let mut delivery = ExecutionRequest {prompt:json!("Continue original work"),..Default::default()};
        delivery.extra.insert("resource_event_keys".into(),pending["resource_event_keys"].clone());
        again.prepare_resource_event_request("caller",&mut delivery).unwrap();
        assert!(delivery.prompt.as_str().unwrap().contains("event-11"),"The durable pending batch survives shared history truncation and another restart");
        assert!(!delivery.prompt.as_str().unwrap().contains("later-999"));
        assert_eq!(calls.lock().unwrap().iter().filter(|c| c["method"] == "collectObservation").count(),3,"Shared resource observation continues while delivery waits for a human answer");
        let result = restored.control_operation(&context("caller"),"cancel_connection_event_subscription",json!({"subscription_key":"document-v2"})).await.unwrap();
        assert_eq!(result["subscription"]["status"],"cancelled");
        restored.poll_conversation_connection_events(true).await.unwrap();
        assert_eq!(calls.lock().unwrap().len(),5);
        seed(&restored,"other");
        let other = restored.control_operation(&context("other"),"list_connection_event_subscriptions",json!({})).await.unwrap();
        assert_eq!(other["items"],json!([]));
        assert!(restored.control_operation(&context("other"),"cancel_connection_event_subscription",json!({"subscription_key":"document-v2"})).await.is_err());
        server.abort();
    });
}
