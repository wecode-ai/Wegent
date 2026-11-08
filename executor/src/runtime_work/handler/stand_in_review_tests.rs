use super::*;

#[test]
fn evidence_filter_preserves_pagination_and_discloses_unknown_time_and_truncation() {
    let start = 1_780_000_000_000_i64;
    let end = start + 1000;
    let mut page = json!({"messages":[
        {"id":"old","createdAt":start-1}, {"id":"start","createdAt":start},
        {"id":"inside","createdAt":end-1}, {"id":"end","createdAt":end},
        {"id":"unknown"}], "turns":[{"private":"unfiltered"}],
        "beforeCursor":"older", "hasMoreBefore":true, "fullContent":false});
    super::super::stand_in_history::filter_history_page(&mut page, Some(start), Some(end));
    assert_eq!(
        page["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["start", "inside", "unknown"]
    );
    assert!(page.get("turns").is_none());
    assert_eq!(page["unknownTimestamps"], true);
    assert_eq!(page["contentMayBeTruncated"], true);
    assert_eq!(page["beforeCursor"], "older");
    assert_eq!(page["hasMoreBefore"], true);
    let mut previous = json!({"messages":[{"createdAt":start-1},{"createdAt":end}]});
    super::super::stand_in_history::filter_history_page(&mut previous, None, Some(end));
    assert_eq!(previous["messages"].as_array().unwrap().len(), 1);
}

#[test]
fn onboarding_never_resumes_unrelated_persisted_turns() {
    assert!(!should_resume_persisted_turns_before_rpc(
        "runtime.stand_in.onboarding.get"
    ));
    assert!(!should_resume_persisted_turns_before_rpc(
        "runtime.stand_in.onboarding.complete"
    ));
}

#[tokio::test]
async fn scheduled_review_uses_the_real_run_window_and_rejects_stale_versions() {
    let root = tempfile::tempdir().unwrap();
    let (handler, mut identity) = fixture(root.path());
    let review = handler
        .automation_store
        .create(weekly_review(7, "mac", "09:00", "en").unwrap())
        .unwrap();
    let (_, run) = handler
        .automation_store
        .start_manual_run(&review.id)
        .unwrap();
    let binding = run.coordination.as_ref().unwrap();
    identity.task_id = binding.task_id.clone();
    identity.review = true;
    identity.role = Some("@primary".into());
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:binding.task_id.clone(),runtime_handle:json!({
        "origin":{"type":"stand_in_schedule","weeklyReview":true,"userId":7,"deviceId":"mac","standInId":"@primary","automationId":review.id},
        "executionRequest":{"user_id":7,"standInSchedule":{"id":review.id,"version":review.version,"runId":run.id}}
    }),..Default::default()});
    let page = handler
        .read_stand_in_conversations(&identity, "list_tasks", &json!({}))
        .await
        .unwrap();
    let end = chrono::DateTime::parse_from_rfc3339(page["windowEnd"].as_str().unwrap()).unwrap();
    assert_eq!(end.timestamp_millis(), run.scheduled_for.timestamp_millis());
    handler.automation_store.update(review).unwrap();
    assert_eq!(
        handler
            .read_stand_in_conversations(&identity, "list_tasks", &json!({}))
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
}

#[tokio::test]
async fn memory_review_reads_older_history_and_revalidates_the_scheduled_run() {
    let root = tempfile::tempdir().unwrap();
    let (handler, mut identity) = fixture(root.path());
    let review = handler
        .automation_store
        .create(crate::runtime_work::automations::memory_review(7, "mac").unwrap())
        .unwrap();
    let (_, run) = handler
        .automation_store
        .start_manual_run(&review.id)
        .unwrap();
    let binding = run.coordination.as_ref().unwrap();
    identity.task_id = binding.task_id.clone();
    identity.memory_review = true;
    identity.role = Some("@primary".into());
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:binding.task_id.clone(), runtime_handle:json!({
        "origin":{"type":"stand_in_schedule","memoryReview":true,"userId":7,"deviceId":"mac","standInId":"@primary","automationId":review.id},
        "executionRequest":{"user_id":7,"standInSchedule":{"id":review.id,"version":review.version,"runId":run.id}}
    }), ..Default::default()});
    let page = handler
        .read_stand_in_conversations(&identity, "list_tasks", &json!({}))
        .await
        .unwrap();
    assert_eq!(
        chrono::DateTime::parse_from_rfc3339(page["windowStart"].as_str().unwrap())
            .unwrap()
            .timestamp_millis(),
        0
    );
    assert!(handler.remember_from_conversation(&identity, &json!({"taskId":"missing","messageId":"fake","excerpt":"invented","content":"False fact"})).await.is_err());
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    assert!(store.stand_in_memories(7).unwrap().is_empty());
    handler.automation_store.update(review).unwrap();
    assert_eq!(
        handler
            .read_stand_in_conversations(&identity, "list_tasks", &json!({}))
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
}

fn fixture(root: &std::path::Path) -> (RuntimeWorkRpcHandler, StandInMcpIdentity) {
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.join("runtime.json"));
    handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
    handler.automation_store =
        crate::runtime_work::automations::AutomationStore::new(root.join("automations.json"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let settings = store.personal_stand_in(7, "mac").unwrap();
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id:"primary".into(),
        runtime_handle:json!({"origin":{"type":"stand_in_identity","userId":7,"deviceId":"mac","standInId":"@primary"},"executionRequest":{"user_id":7}}),
        ..Default::default()
    });
    (
        handler,
        StandInMcpIdentity {
            task_id: "primary".into(),
            user: 7,
            device: "mac".into(),
            role: Some("@primary".into()),
            work: None,
            ask_before_act: true,
            coordinator_batch: None,
            project: None,
            review: false,
            memory_review: false,
            readonly_worker: false,
        },
    )
}

#[tokio::test]
async fn memory_review_connections_require_live_run_and_current_source_grants() {
    let root = tempfile::tempdir().unwrap();
    let (handler, mut identity) = fixture(root.path());
    let denied = handler
        .memory_connection_operation(&identity, "list_memory_connections", &json!({}))
        .await
        .unwrap_err();
    assert_eq!(denied.code, "permission_denied");
    let review = handler
        .automation_store
        .create(crate::runtime_work::automations::memory_review(7, "mac").unwrap())
        .unwrap();
    let (_, run) = handler
        .automation_store
        .start_manual_run(&review.id)
        .unwrap();
    let binding = run.coordination.as_ref().unwrap();
    identity.task_id = binding.task_id.clone();
    identity.memory_review = true;
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: binding.task_id.clone(),
        runtime_handle: json!({
            "origin":{"type":"stand_in_schedule","memoryReview":true,"userId":7,"deviceId":"mac","standInId":"@primary","automationId":review.id},
            "executionRequest":{"user_id":7,"standInSchedule":{"id":review.id,"version":review.version,"runId":run.id}}
        }),
        ..Default::default()
    });
    let empty = handler
        .memory_connection_operation(&identity, "list_memory_connections", &json!({}))
        .await
        .unwrap();
    assert_eq!(empty, json!({"sources":[],"collections":[],"providers":[]}));
    for operation in ["read_memory_connection", "remember_from_connection"] {
        let denied = handler.memory_connection_operation(&identity, operation, &json!({
            "source":{"providerId":"ungranted","profile":"other-account","kind":"document","id":"private"},
            "itemId":"record","excerpt":"forged evidence","content":"forged fact"
        })).await.unwrap_err();
        // Rejection precedes any provider call, even when no host is registered.
        assert_eq!(denied.code, "permission_denied");
    }
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    assert!(store.stand_in_memories(7).unwrap().is_empty());
    handler.automation_store.update(review).unwrap();
    let expired = handler
        .memory_connection_operation(&identity, "list_memory_connections", &json!({}))
        .await
        .unwrap_err();
    assert_eq!(expired.code, "permission_denied");
}

#[test]
fn memory_review_empty_increment_ignores_disabled_project_configuration() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    store.materialize_implicit_primary(7, "mac").unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["primary"]["collaboration"] = json!({
        "enabled":false,"allProjects":true,"projects":[],"excludedProjects":[],"tags":[]
    });
    let mut settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    let through = chrono::Utc::now().timestamp_millis();
    assert!(!handler
        .memory_review_has_pending_sources(7, through, &store)
        .unwrap());
    settings["primary"]["collaboration"]["enabled"] = json!(true);
    let mut settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    assert!(handler
        .memory_review_has_pending_sources(7, through, &store)
        .unwrap());
    settings["primary"]["enabled"] = json!(false);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    assert!(handler
        .memory_review_has_pending_sources(7, through, &store)
        .unwrap());
}

#[tokio::test]
async fn memory_review_connection_protocol_reads_pages_saves_evidence_and_rechecks_revocation() {
    use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
    use std::sync::atomic::{AtomicBool, Ordering};
    #[derive(Clone)]
    struct ProviderState {
        store: LocalTaskStore,
        revoke: Arc<AtomicBool>,
        changed: Arc<AtomicBool>,
        calls: Arc<Mutex<Vec<Value>>>,
    }
    async fn provider(
        State(state): State<ProviderState>,
        headers: HeaderMap,
        Json(request): Json<Value>,
    ) -> Json<Value> {
        assert_eq!(headers["authorization"], "Bearer fixture-token");
        state.calls.lock().unwrap().push(request.clone());
        if state.revoke.load(Ordering::SeqCst) {
            let mut settings = state.store.personal_stand_in(7, "mac").unwrap();
            settings["primary"]["connections"] = json!([]);
            state
                .store
                .save_personal_stand_in(7, "mac", settings)
                .unwrap();
        }
        if request["method"] == "catalog" {
            return Json(json!({"ok":true,"result":{"items":[
                {"id":"docs","name":"Documents","read":{"querySchema":{"type":"object"}}},
                {"id":"other-provider"}
            ]}}));
        }
        assert_eq!(request["method"], "readSource");
        assert_eq!(request["providerId"], "docs");
        assert_eq!(request["input"]["source"]["name"], "Authorized guide");
        assert_eq!(request["input"]["query"], json!({"limit":1}));
        let page = if request["input"]["cursor"] == "second" {
            json!({"items":[{"id":"record","body":{"text":"Team lead is Lin","details":"资料🌳".repeat(3000)},"revision":state.changed.load(Ordering::SeqCst)}],"nextCursor":null})
        } else {
            json!({"items":[],"nextCursor":"second"})
        };
        Json(json!({"ok":true,"result":page}))
    }
    let root = tempfile::tempdir().unwrap();
    let (handler, mut identity) = fixture(root.path());
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    store.materialize_implicit_primary(7, "mac").unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["primary"]["connections"] = json!([{
        "providerId":"docs","profile":"account","kind":"document","id":"guide","name":"Authorized guide",
        "policy":{"automatic":false,"askBeforeAct":true}
    }]);
    let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    let source = settings["primary"]["connections"][0].clone();
    let review = handler
        .automation_store
        .create(crate::runtime_work::automations::memory_review(7, "mac").unwrap())
        .unwrap();
    let (_, run) = handler
        .automation_store
        .start_manual_run(&review.id)
        .unwrap();
    identity.task_id = run.coordination.as_ref().unwrap().task_id.clone();
    identity.memory_review = true;
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:identity.task_id.clone(),runtime_handle:json!({
        "origin":{"type":"stand_in_schedule","memoryReview":true,"userId":7,"deviceId":"mac","standInId":"@primary","automationId":review.id},
        "executionRequest":{"user_id":7,"standInSchedule":{"id":review.id,"version":review.version,"runId":run.id}}
    }),..Default::default()});
    let state = ProviderState {
        store: store.clone(),
        revoke: Arc::new(AtomicBool::new(false)),
        changed: Arc::new(AtomicBool::new(false)),
        calls: Arc::new(Mutex::new(Vec::new())),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/", post(provider))
        .with_state(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let host = json!({"url":format!("http://{address}/"),"token":"fixture-token","registeredAt":chrono::Utc::now().timestamp()});
    crate::runtime_work::connection_host::TEST_HOST
        .scope(host, async {
            let catalog = handler
                .memory_connection_operation(&identity, "list_memory_connections", &json!({}))
                .await
                .unwrap();
            assert_eq!(catalog["sources"], json!([source]));
            assert_eq!(catalog["providers"].as_array().unwrap().len(), 1);
            let mut args = json!({"source":source,"query":{"limit":1}});
            args["source"]["name"] = json!("Forged provenance");
            let first = handler
                .memory_connection_operation(&identity, "read_memory_connection", &args)
                .await
                .unwrap();
            let mut completed_first = args.clone();
            completed_first["contentHash"] = first["contentHash"].clone();
            handler
                .memory_connection_operation(
                    &identity,
                    "complete_memory_connection",
                    &completed_first,
                )
                .await
                .unwrap();
            let unchanged = handler
                .memory_connection_operation(&identity, "read_memory_connection", &args)
                .await
                .unwrap();
            assert_eq!(unchanged["unchanged"], true);
            assert_eq!(unchanged["nextCursor"], "second");
            assert!(unchanged.get("content").is_none());
            let first: Value = serde_json::from_str(first["content"].as_str().unwrap()).unwrap();
            assert!(first["items"].as_array().unwrap().is_empty());
            assert_eq!(first["nextCursor"], "second");
            args["cursor"] = first["nextCursor"].clone();
            let mut assembled = String::new();
            loop {
                let part = handler
                    .memory_connection_operation(&identity, "read_memory_connection", &args)
                    .await
                    .unwrap();
                assert!(part["content"].as_str().unwrap().len() <= 8192);
                assembled.push_str(part["content"].as_str().unwrap());
                args["contentHash"] = part["contentHash"].clone();
                if assembled.len() <= 8192 {
                    assert!(
                        handler
                            .memory_connection_operation(
                                &identity,
                                "complete_memory_connection",
                                &args
                            )
                            .await
                            .is_err(),
                        "A partially read page cannot be completed"
                    );
                }
                if part["nextOffset"].is_null() {
                    break;
                }
                args["offset"] = part["nextOffset"].clone();
            }
            let second: Value = serde_json::from_str(&assembled).unwrap();
            assert_eq!(second["items"][0]["id"], "record");
            assert_eq!(second["items"][0]["body"]["details"], "资料🌳".repeat(3000));
            args["itemId"] = json!("record");
            args["excerpt"] = json!("Team lead is Lin");
            args["content"] = json!("The guide names Lin as team lead.");
            let saved = handler
                .memory_connection_operation(&identity, "remember_from_connection", &args)
                .await
                .unwrap();
            assert_eq!(
                saved["scope"],
                crate::task_runtime::personal_stand_in::connection_memory_scope(&source)
            );
            assert_eq!(saved["evidence"]["source"], source);
            assert_eq!(saved["evidence"]["excerpt"], args["excerpt"]);
            handler
                .memory_connection_operation(&identity, "complete_memory_connection", &args)
                .await
                .unwrap();
            let unchanged = handler
                .memory_connection_operation(&identity, "read_memory_connection", &args)
                .await
                .unwrap();
            assert_eq!(unchanged["unchanged"], true);
            assert!(unchanged.get("content").is_none());
            let mut update = args.clone();
            update["id"] = saved["id"].clone();
            update["version"] = json!(0);
            assert!(handler
                .memory_connection_operation(&identity, "remember_from_connection", &update)
                .await
                .is_err());
            assert!(
                handler
                    .memory_connection_operation(&identity, "complete_memory_connection", &args)
                    .await
                    .is_err(),
                "Failed writes prevent completion"
            );
            let pending = handler
                .memory_connection_operation(&identity, "read_memory_connection", &args)
                .await
                .unwrap();
            assert!(
                pending["content"].is_string(),
                "An unsettled write must not be hidden by an old completion"
            );
            update["version"] = saved["version"].clone();
            let saved = handler
                .memory_connection_operation(&identity, "remember_from_connection", &update)
                .await
                .unwrap();
            handler
                .memory_connection_operation(&identity, "complete_memory_connection", &args)
                .await
                .unwrap();
            state.changed.store(true, Ordering::SeqCst);
            for operation in [
                "read_memory_connection",
                "remember_from_connection",
                "complete_memory_connection",
            ] {
                assert_eq!(
                    handler
                        .memory_connection_operation(&identity, operation, &args)
                        .await
                        .unwrap_err()
                        .code,
                    "evidence_changed"
                );
            }
            let mut fresh = args.clone();
            fresh.as_object_mut().unwrap().remove("contentHash");
            fresh["offset"] = json!(0);
            let changed = handler
                .memory_connection_operation(&identity, "read_memory_connection", &fresh)
                .await
                .unwrap();
            assert!(changed["content"].is_string());
            assert_ne!(changed["contentHash"], args["contentHash"]);
            state.changed.store(false, Ordering::SeqCst);
            let mut missing_hash = args.clone();
            missing_hash.as_object_mut().unwrap().remove("contentHash");
            assert_eq!(
                handler
                    .memory_connection_operation(
                        &identity,
                        "remember_from_connection",
                        &missing_hash
                    )
                    .await
                    .unwrap_err()
                    .code,
                "evidence_changed"
            );
            let mut forged = args.clone();
            forged["excerpt"] = json!("An invented quote");
            assert_eq!(
                handler
                    .memory_connection_operation(&identity, "remember_from_connection", &forged)
                    .await
                    .unwrap_err()
                    .code,
                "evidence_changed"
            );
            let call_count = state.calls.lock().unwrap().len();
            forged["source"]["profile"] = json!("other-account");
            assert_eq!(
                handler
                    .memory_connection_operation(&identity, "read_memory_connection", &forged)
                    .await
                    .unwrap_err()
                    .code,
                "permission_denied"
            );
            assert_eq!(state.calls.lock().unwrap().len(), call_count);
            assert_eq!(store.active_stand_in_memories(7, "mac").unwrap().len(), 1);
            state.revoke.store(true, Ordering::SeqCst);
            for operation in [
                "read_memory_connection",
                "remember_from_connection",
                "complete_memory_connection",
            ] {
                let mut current = store.personal_stand_in(7, "mac").unwrap();
                current["primary"]["connections"] = json!([source]);
                store.save_personal_stand_in(7, "mac", current).unwrap();
                assert_eq!(
                    handler
                        .memory_connection_operation(&identity, operation, &args)
                        .await
                        .unwrap_err()
                        .code,
                    "permission_denied"
                );
                assert!(store.active_stand_in_memories(7, "mac").unwrap().is_empty());
                assert_eq!(store.stand_in_memories(7).unwrap(), vec![saved.clone()]);
            }
            let mut current = store.personal_stand_in(7, "mac").unwrap();
            current["primary"]["connections"] = json!([source]);
            store.save_personal_stand_in(7, "mac", current).unwrap();
            assert_eq!(
                handler
                    .memory_connection_operation(&identity, "list_memory_connections", &json!({}))
                    .await
                    .unwrap_err()
                    .code,
                "permission_denied"
            );
            let call_count = state.calls.lock().unwrap().len();
            assert_eq!(
                handler
                    .memory_connection_operation(&identity, "read_memory_connection", &args)
                    .await
                    .unwrap_err()
                    .code,
                "permission_denied"
            );
            assert_eq!(state.calls.lock().unwrap().len(), call_count);
        })
        .await;
    server.abort();
}

#[tokio::test]
async fn memory_review_traverses_long_history_saves_evidence_and_commits_only_complete_sources() {
    let root = tempfile::tempdir().unwrap();
    let (mut handler, mut identity) = fixture(root.path());
    handler.transcript_test_workers = Some(Arc::new(tokio::sync::Semaphore::new(2)));
    let review = handler
        .automation_store
        .create(crate::runtime_work::automations::memory_review(7, "mac").unwrap())
        .unwrap();
    let (_, run) = handler
        .automation_store
        .start_manual_run(&review.id)
        .unwrap();
    identity.task_id = run.coordination.as_ref().unwrap().task_id.clone();
    identity.role = Some("@primary".into());
    identity.memory_review = true;
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:identity.task_id.clone(),runtime_handle:json!({
        "origin":{"type":"stand_in_schedule","memoryReview":true,"userId":7,"deviceId":"mac","standInId":"@primary","automationId":review.id},
        "executionRequest":{"user_id":7,"standInSchedule":{"id":review.id,"version":review.version,"runId":run.id}}
    }),..Default::default()});
    let mut messages: Vec<Value> = (0..55).map(|index| json!({"id":format!("message-{index}"),"role":"user","content":format!("Fact {index}"),"createdAt":1})).collect();
    messages[54]["content"] = json!(format!(
        "{} Keep weekly reports brief",
        "context ".repeat(4000)
    ));
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:"history".into(), runtime:"chat".into(),created_at:1,updated_at:2,
        runtime_handle:json!({"origin":{"type":"ordinary","userId":7},"executionRequest":{"user_id":7},"messages":messages}),..Default::default()});
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let args = json!({"taskId":"history"});
    assert!(handler
        .memory_progress_operation(&identity, "complete_memory_source", &args)
        .await
        .is_err());
    let mut seen = HashSet::new();
    let mut saved = None;
    let mut saved_input = None;
    let mut finished = false;
    for _ in 0..30 {
        let result = handler
            .memory_progress_operation(&identity, "next_memory_page", &args)
            .await
            .unwrap();
        let page = &result["page"];
        for message in page["messages"].as_array().into_iter().flatten() {
            seen.insert(message["id"].as_str().unwrap().to_owned());
        }
        if page["content"]
            .as_str()
            .is_some_and(|text| text.contains("Keep weekly reports brief"))
        {
            let mut input = result["readArguments"].clone();
            input["messageId"] = json!("message-54");
            input["excerpt"] = json!("Keep weekly reports brief");
            input["content"] = json!("Prefers brief weekly reports");
            saved_input = Some(input.clone());
            saved = Some(
                handler
                    .remember_from_conversation(&identity, &input)
                    .await
                    .unwrap(),
            );
        }
        if result["readyToComplete"] == true {
            finished = true;
            break;
        }
        assert_eq!(
            store.memory_review_progress(7, "history").unwrap()["completedThrough"],
            0
        );
        assert!(handler
            .memory_progress_operation(&identity, "complete_memory_source", &args)
            .await
            .is_err());
    }
    assert!(
        finished,
        "The bounded fixture must finish without cursor cycles"
    );
    assert_eq!(seen.len(), 55);
    let saved = saved.expect("A fact in a later content chunk must be readable and savable");
    assert_eq!(saved["scope"], json!({"kind":"personal"}));
    assert_eq!(saved["evidence"]["messageId"], "message-54");
    let mut input = saved_input.unwrap();
    input["id"] = saved["id"].clone();
    input["version"] = json!(saved["version"].as_i64().unwrap() + 1);
    assert!(handler
        .remember_from_conversation(&identity, &input)
        .await
        .is_err());
    let pending = handler
        .memory_progress_operation(&identity, "next_memory_page", &args)
        .await
        .unwrap();
    assert_eq!(pending["readyToComplete"], false);
    assert_eq!(pending["pendingWriteCount"], 1);
    assert!(handler
        .memory_progress_operation(&identity, "complete_memory_source", &args)
        .await
        .is_err());
    assert_eq!(
        store.memory_review_progress(7, "history").unwrap()["completedThrough"],
        0
    );
    input["version"] = saved["version"].clone();
    let retried = handler
        .remember_from_conversation(&identity, &input)
        .await
        .unwrap();
    store
        .delete_stand_in_memory(
            7,
            retried["id"].as_str().unwrap(),
            retried["version"].as_i64().unwrap(),
        )
        .unwrap();
    input.as_object_mut().unwrap().remove("id");
    input.as_object_mut().unwrap().remove("version");
    for content in [
        "Prefers brief weekly reports",
        "Weekly summaries should be concise",
    ] {
        input["content"] = json!(content);
        let suppressed = handler
            .remember_from_conversation(&identity, &input)
            .await
            .unwrap();
        assert_eq!(suppressed["saved"], false);
        assert_eq!(suppressed["status"], "suppressed");
        assert!(store.stand_in_memories(7).unwrap().is_empty());
        assert!(
            store.memory_review_progress(7, "history").unwrap()["pendingWrites"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    let committed = handler
        .memory_progress_operation(&identity, "complete_memory_source", &args)
        .await
        .unwrap();
    assert_eq!(
        committed["completedThrough"],
        run.scheduled_for.timestamp_millis()
    );
    let listed = handler
        .memory_progress_operation(&identity, "list_memory_sources", &json!({}))
        .await
        .unwrap();
    assert!(!listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["taskId"] == "history"));
}

#[path = "stand_in_memory_attachment_protocol_tests.rs"]
mod attachment_protocol;

#[tokio::test]
async fn discovery_reads_all_pages_and_keeps_identity_and_recent_updates_to_old_tasks() {
    let root = tempfile::tempdir().unwrap();
    let (handler, identity) = fixture(root.path());
    for index in 0..121 {
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: format!("task-{index:03}"),
            created_at: 1,
            updated_at: chrono::Utc::now().timestamp_millis(),
            runtime_handle: json!({"executionRequest":{"user_id":7}}),
            ..Default::default()
        });
    }
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "other-user".into(),
        updated_at: chrono::Utc::now().timestamp_millis(),
        runtime_handle: json!({"executionRequest":{"user_id":8}}),
        ..Default::default()
    });
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:"role-chat".into(),updated_at:chrono::Utc::now().timestamp_millis(),runtime_handle:json!({"origin":{"type":"stand_in_identity"},"executionRequest":{"user_id":7}}),..Default::default()});
    let mut args = json!({});
    let mut ids = Vec::new();
    loop {
        let page = handler
            .read_stand_in_conversations(&identity, "list_tasks", &args)
            .await
            .unwrap();
        ids.extend(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["taskId"].as_str().unwrap().to_owned()),
        );
        if page["nextCursor"].is_null() {
            break;
        }
        args = json!({"cursor":page["nextCursor"]});
    }
    assert_eq!(ids.len(), 123);
    assert!(ids.contains(&"role-chat".into()));
    assert!(!ids.contains(&"other-user".into()));
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 123);
}

#[tokio::test]
async fn history_rejects_forged_runs_foreign_owners_roles_and_devices() {
    let root = tempfile::tempdir().unwrap();
    let (handler, identity) = fixture(root.path());
    for forbidden in [
        StandInMcpIdentity {
            user: 8,
            ..identity.clone()
        },
        StandInMcpIdentity {
            device: "other".into(),
            ..identity.clone()
        },
        StandInMcpIdentity {
            role: Some("other".into()),
            ..identity.clone()
        },
        StandInMcpIdentity {
            work: Some("external".into()),
            ..identity.clone()
        },
        StandInMcpIdentity {
            review: true,
            memory_review: false,
            readonly_worker: false,
            ..identity.clone()
        },
    ] {
        assert_eq!(
            handler
                .read_stand_in_conversations(&forbidden, "list_tasks", &json!({}))
                .await
                .unwrap_err()
                .code,
            "permission_denied"
        );
    }
    assert_eq!(
        handler
            .read_stand_in_conversations(&identity, "read_task", &json!({"taskId":"missing"}))
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
}

#[tokio::test]
async fn onboarding_rpc_is_offline_and_repeated_completion_does_not_recreate_deleted_review() {
    let root = tempfile::tempdir().unwrap();
    let (handler, _) = fixture(root.path());
    let args = json!({"userId":7,"weeklyReview":true,"time":"09:00"});
    let before = handler
        .stand_in_onboarding_rpc("runtime.stand_in.onboarding.get", args.clone())
        .await
        .unwrap();
    assert_eq!(before["state"]["completed"], false);
    let completed = handler
        .stand_in_onboarding_rpc("runtime.stand_in.onboarding.complete", args.clone())
        .await
        .unwrap();
    assert_eq!(completed["state"]["completed"], true);
    assert_eq!(completed["settings"]["primary"]["enabled"], true);
    handler
        .automation_store
        .delete("stand-in-weekly-review-7")
        .unwrap();
    handler
        .stand_in_onboarding_rpc("runtime.stand_in.onboarding.complete", args)
        .await
        .unwrap();
    assert!(handler.automation_store.list().is_empty());
}

#[tokio::test]
async fn onboarding_preserves_a_paused_primary_and_does_not_initialize_on_opt_out() {
    let root = tempfile::tempdir().unwrap();
    let (handler, _) = fixture(root.path());
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["primary"] =
        json!({"enabled":false,"prompt":"Keep this","preferences":"Private preference"});
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    let completed = handler
        .stand_in_onboarding_rpc(
            "runtime.stand_in.onboarding.complete",
            json!({"userId":7,"weeklyReview":true}),
        )
        .await
        .unwrap();
    assert_eq!(completed["settings"]["primary"]["enabled"], false);
    assert_eq!(completed["settings"]["primary"]["prompt"], "Keep this");
    let opted_out = handler
        .stand_in_onboarding_rpc(
            "runtime.stand_in.onboarding.complete",
            json!({"userId":8,"weeklyReview":false}),
        )
        .await
        .unwrap();
    assert!(opted_out["settings"]["primary"].is_null());
}
