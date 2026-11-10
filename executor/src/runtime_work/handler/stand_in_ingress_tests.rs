use super::*;

#[test]
fn generic_cli_legacy_failure_recovers_original_checkpoint_with_bounded_backoff() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let source = json!({"providerId":crate::task_runtime::personal_stand_in::DINGTALK_PROVIDER,"profile":"account","kind":"direct","id":"own"});
    let version = json!(20);
    let legacy = json!({"version":20,"checkpoint":{"after":"2026-11-09T07:59:44.720Z","cursor":"0"},"error":{"code":"connection_cli_request_failed","message":"Plugin tool request failed (request_failed)"}});
    store.save_stand_in_source(7, &source, &legacy).unwrap();
    let mut state = store.stand_in_source(7, &source).unwrap();
    assert!(!collection_error_latched(&state, &version));
    for attempt in 1..=10 {
        let mut failure = AppIpcError::new(
            "connection_cli_request_unavailable",
            "Plugin tool request failed (request_failed)",
        );
        failure.provider_code = Some("request_failed".to_owned());
        let failure = crate::runtime_work::connection_cli::collection_read_error(failure);
        let before = chrono::Utc::now().timestamp_millis();
        save_collection_result(&store, 7, &source, &version, &state, Err(failure)).unwrap();
        state = store.stand_in_source(7, &source).unwrap();
        assert_eq!(state["checkpoint"], legacy["checkpoint"]);
        assert_eq!(state["version"], version);
        assert_eq!(state["error"]["providerCode"], "request_failed");
        assert_eq!(state["failures"], attempt);
        let delay = (30_000_i64 << (attempt - 1).min(7)).min(3_600_000);
        assert!(state["retryAt"].as_i64().unwrap() >= before + delay);
        assert!(
            state["retryAt"].as_i64().unwrap() <= chrono::Utc::now().timestamp_millis() + delay
        );
        assert!(collection_error_latched(&state, &version));
        state["retryAt"] = json!(before - 1);
        assert!(!collection_error_latched(&state, &version));
    }
    save_collection_result(
        &store,
        7,
        &source,
        &version,
        &state,
        Ok(json!({"checkpoint":{"after":"2026-11-10T01:33:03Z","cursor":"0"}})),
    )
    .unwrap();
    let recovered = store.stand_in_source(7, &source).unwrap();
    assert_eq!(recovered["checkpoint"]["after"], "2026-11-10T01:33:03Z");
    assert!(recovered["error"].is_null());
    assert!(recovered["retryAt"].is_null());
    assert!(recovered["failures"].is_null());

    for message in [
        "Plugin tool request failed (FORBIDDEN)",
        "Plugin tool request failed (PERMISSION_DENIED)",
        "Plugin tool request failed (EACCES)",
        "Plugin tool request failed (CERTIFICATE_VERIFY_FAILED)",
        "request_failed",
        "Plugin tool request failed (request_failed): permission denied",
    ] {
        let mut rejection = legacy.clone();
        rejection["error"]["message"] = json!(message);
        assert!(collection_error_latched(&rejection, &version));
    }
    let mut structured_rejection = legacy.clone();
    structured_rejection["error"]["providerCode"] = json!("FORBIDDEN");
    assert!(collection_error_latched(&structured_rejection, &version));
    let mut rejection = AppIpcError::new(
        "connection_cli_request_failed",
        "Plugin tool request failed (FORBIDDEN)",
    );
    rejection.provider_code = Some("FORBIDDEN".to_owned());
    save_collection_result(&store, 7, &source, &version, &state, Err(rejection)).unwrap();
    let stopped = store.stand_in_source(7, &source).unwrap();
    assert!(collection_error_latched(&stopped, &version));
    assert_eq!(stopped["checkpoint"], legacy["checkpoint"]);
    assert_eq!(stopped["error"]["providerCode"], "FORBIDDEN");
    assert!(stopped["error"]["retryable"].is_null());
    assert!(stopped["retryAt"].is_null());
    assert!(stopped["failures"].is_null());
}

#[test]
fn runtime_collection_timeout_recovers_legacy_latches_and_backs_off_new_failures() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let source = json!({"providerId":crate::task_runtime::personal_stand_in::DINGTALK_PROVIDER,"profile":"account","kind":"direct","id":"own"});
    let version = json!(19);
    let legacy = json!({"version":version,"checkpoint":{"after":"2026-11-08T22:57:19.411Z","cursor":"0"},"error":{"code":"request_timeout","message":"Executor request runtime.connections.cli timed out"}});
    store.save_stand_in_source(7, &source, &legacy).unwrap();
    let state = store.stand_in_source(7, &source).unwrap();
    assert!(!collection_error_latched(&state, &version));
    let before = chrono::Utc::now().timestamp_millis();
    save_collection_result(
        &store,
        7,
        &source,
        &version,
        &state,
        Err(AppIpcError::new(
            "request_timeout",
            "Runtime read timed out",
        )),
    )
    .unwrap();
    let failed = store.stand_in_source(7, &source).unwrap();
    assert_eq!(failed["checkpoint"], legacy["checkpoint"]);
    assert_eq!(failed["version"], version);
    assert_eq!(failed["error"]["retryable"], true);
    assert!(failed["retryAt"].as_i64().unwrap() >= before + 30_000);
    assert!(collection_error_latched(&failed, &version));
    let mut due = failed.clone();
    due["retryAt"] = json!(before - 1);
    assert!(!collection_error_latched(&due, &version));
    let recovered = json!({"checkpoint":{"after":"2026-11-09T00:00:00Z","cursor":"0"}});
    save_collection_result(&store, 7, &source, &version, &due, Ok(recovered.clone())).unwrap();
    let resumed = store.stand_in_source(7, &source).unwrap();
    assert_eq!(resumed["checkpoint"], recovered["checkpoint"]);
    assert!(resumed["error"].is_null());
    assert!(resumed["retryAt"].is_null());
    assert!(resumed["failures"].is_null());
    for code in [
        "connector_auth_required",
        "forbidden",
        "dingtalk_response_invalid",
    ] {
        let mut permanent = legacy.clone();
        permanent["error"]["code"] = json!(code);
        assert!(collection_error_latched(&permanent, &version));
    }
}

#[test]
fn declared_cli_read_process_failure_retries_from_the_original_cursor_then_clears_error() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let source =
        json!({"providerId":"example.source","profile":"account","kind":"inbox","id":"inbox"});
    let version = json!(48);
    let state = json!({"checkpoint":{"partition":"generation-1","cursor":"page-two"}});
    let error = crate::runtime_work::connection_cli::collection_read_error(AppIpcError::new(
        "connection_cli_failed",
        "Plugin tool exited without a structured outcome",
    ));
    save_collection_result(&store, 7, &source, &version, &state, Err(error)).unwrap();
    let mut failed = store.stand_in_source(7, &source).unwrap();
    assert_eq!(failed["checkpoint"], state["checkpoint"]);
    assert_eq!(failed["version"], version);
    assert_eq!(failed["error"]["retryable"], true);
    assert!(collection_error_latched(&failed, &version));
    failed["retryAt"] = json!(chrono::Utc::now().timestamp_millis() - 1);
    assert!(!collection_error_latched(&failed, &version));
    save_collection_result(
        &store,
        7,
        &source,
        &version,
        &failed,
        Ok(json!({"checkpoint":{"partition":"generation-1","cursor":"page-three"}})),
    )
    .unwrap();
    let resumed = store.stand_in_source(7, &source).unwrap();
    assert!(resumed["error"].is_null());
    assert!(resumed["retryAt"].is_null());
    assert_eq!(resumed["version"], version);
    assert_eq!(
        resumed["checkpoint"],
        json!({"partition":"generation-1","cursor":"page-three"})
    );
}

#[test]
fn explicit_source_retry_clears_the_latch_without_resetting_collection_progress() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["roles"][0]["connections"] = json!([{"providerId":"example.source","profile":"account","kind":"inbox","id":"inbox","name":"Source","policy":{"automatic":false,"askBeforeAct":true}}]);
    settings["roles"][0]["enabled"] = json!(true);
    let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    let role = stand_in_identities(&settings).remove(0);
    let source = &role["connections"][0];
    let state = json!({"version":settings["version"],"checkpoint":{"partition":"generation-1","cursor":"page-two"},"error":{"code":"connection_cli_response_invalid","message":"Old failed process"}});
    store.save_stand_in_source(7, source, &state).unwrap();
    assert!(collection_error_latched(&state, &settings["version"]));
    assert_eq!(
        handler
            .retry_connection_source(json!({"userId":7,"source":source}))
            .unwrap()["success"],
        true
    );
    let restored = store.stand_in_source(7, source).unwrap();
    assert!(restored["error"].is_null());
    assert!(!collection_error_latched(&restored, &settings["version"]));
    assert_eq!(restored["checkpoint"], state["checkpoint"]);
    assert_eq!(restored["version"], settings["version"]);
    assert_eq!(
        store.personal_stand_in(7, "mac").unwrap()["version"],
        settings["version"]
    );
    let mut removed = source.clone();
    removed["id"] = json!("different-inbox");
    assert_eq!(
        handler
            .retry_connection_source(json!({"userId":7,"source":removed}))
            .unwrap_err()
            .code,
        "source_removed"
    );
}

#[tokio::test]
async fn connection_all_scope_persists_distinct_conversations_and_rejects_missing_identity() {
    for kind in ["group", "direct"] {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        let source = json!({"providerId":crate::task_runtime::personal_stand_in::DINGTALK_PROVIDER,"profile":"corp","kind":kind,"id":"*","scope":"all","name":"All","policy":{"automatic":false,"askBeforeAct":true}});
        settings["roles"][0]["connections"] = json!([source]);
        settings["roles"][0]["enabled"] = json!(true);
        let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        let role = stand_in_identities(&settings).remove(0);
        let source = &role["connections"][0];
        let messages:Vec<Value> = ["first","second"].iter().map(|id| json!({"id":id,"text":"New matter","at":"2099-01-01T00:00:00Z","resource":{"kind":kind,"id":id,"name":id}})).collect();
        handler
            .collect_connection_page(
                &store,
                7,
                source,
                std::slice::from_ref(&role),
                (messages.clone(), json!({})),
            )
            .await
            .unwrap();
        handler
            .collect_connection_page(
                &store,
                7,
                source,
                std::slice::from_ref(&role),
                (messages, json!({})),
            )
            .await
            .unwrap();
        let works = store.list_stand_in_work(7, None).unwrap();
        assert_eq!(works.len(), 2);
        assert!(works.iter().all(|work| work["source"]["id"] != "*"
            && work["source"].get("scope").is_none()
            && work["source"]["profile"] == "corp"
            && work["source"]["kind"] == kind));
        for resource in [
            Value::Null,
            json!({"id":"*","kind":kind,"name":"Bad"}),
            json!({"id":"other","kind":"wrong","name":"Bad"}),
        ] {
            assert!(concrete_connection_source(source, &json!({"resource":resource})).is_err());
        }
    }
}

#[tokio::test]
async fn silent_collection_keeps_manual_sources_pending_and_automatic_sources_in_intake() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["processing"] = json!({"mode":"silent","intervalMinutes":5});
    let source = json!({"id":"group","name":"Group","kind":"group","profile":"corp","providerId":crate::task_runtime::personal_stand_in::DINGTALK_PROVIDER});
    let base = settings["roles"][0].clone();
    settings["roles"] = json!([base.clone(), base]);
    for (role, automatic) in settings["roles"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip([true, false])
    {
        role["id"] = json!(if automatic { "automatic" } else { "manual" });
        role["enabled"] = json!(true);
        let mut connection = source.clone();
        connection["policy"] = json!({"automatic":automatic,"askBeforeAct":true});
        role["connections"] = json!([connection]);
    }
    let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    let message = json!({"id":"one","text":"New matter","at":"2099-01-01T00:00:00Z"});
    for _ in 0..2 {
        handler
            .collect_connection_page(
                &store,
                7,
                &source,
                &stand_in_identities(&settings),
                (vec![message.clone()], json!({"cursor":"next"})),
            )
            .await
            .unwrap();
    }
    let events = store.stand_in_events(7).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["roleIds"], json!(["automatic"]));
    let works = store.list_stand_in_work(7, None).unwrap();
    assert_eq!(works.len(), 1);
    assert_eq!(works[0]["roleId"], "manual");
    assert_eq!(works[0]["status"], "pending");
    assert_eq!(works[0]["messageCount"], 1);
    assert!(handler.local_task_links(true).is_empty());
}

#[tokio::test]
async fn collection_persists_role_scoped_events_without_grouping_or_work() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["processing"] = json!({"mode":"silent","intervalMinutes":5});
    let source = json!({"id":"group","name":"Group","kind":"group","profile":"corp","providerId":crate::task_runtime::personal_stand_in::DINGTALK_PROVIDER,"policy":{"automatic":true,"askBeforeAct":true}});
    let base = settings["roles"][0].clone();
    settings["roles"] = json!([base.clone(), base]);
    for (index, role) in settings["roles"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        role["id"] = json!(format!("role-{index}"));
        role["enabled"] = json!(true);
        role["connections"] = json!([source]);
    }
    let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    let roles = stand_in_identities(&settings);
    let messages = vec![
        json!({"id":"one","text":"First matter","at":"2099-01-01T00:00:00Z"}),
        json!({"id":"two","text":"Another matter","at":"2099-01-01T00:00:01Z"}),
    ];
    for _ in 0..2 {
        handler
            .collect_connection_page(
                &store,
                7,
                &source,
                &roles,
                (messages.clone(), json!({"cursor":"next"})),
            )
            .await
            .unwrap();
    }
    let events = store.stand_in_events(7).unwrap();
    assert_eq!(events.len(), 4);
    assert!(events.iter().all(
        |event| event["roleScoped"] == true && event["roleIds"].as_array().unwrap().len() == 1
    ));
    for role in ["role-0", "role-1"] {
        assert_eq!(
            events
                .iter()
                .filter(|event| event["roleIds"] == json!([role]))
                .count(),
            2
        );
    }
    assert!(store.list_stand_in_work(7, None).unwrap().is_empty());
    assert!(handler.local_task_links(true).is_empty());
}

#[test]
fn declared_transport_failure_retains_progress_and_retries_without_settings_changes() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let source = json!({"id":"INBOX","kind":"inbox","profile":"account","providerId":crate::task_runtime::personal_stand_in::EMAIL_PROVIDER});
    let version = json!(3);
    let state = json!({"checkpoint":{"partition":"12","sequence":42}});
    save_collection_result(
        &store,
        7,
        &source,
        &version,
        &state,
        Err(
            AppIpcError::new("email_transport_failed", "Connection interrupted")
                .with_retry_after_ms(30_000),
        ),
    )
    .unwrap();
    let failed = store.stand_in_source(7, &source).unwrap();
    assert_eq!(failed["checkpoint"], state["checkpoint"]);
    assert_eq!(failed["error"]["code"], "email_transport_failed");
    assert!(collection_error_latched(&failed, &version));
    let mut due = failed.clone();
    due["retryAt"] = json!(chrono::Utc::now().timestamp_millis() - 1);
    assert!(!collection_error_latched(&due, &version));
    for code in [
        "email_auth_failed",
        "email_message_invalid",
        "email_connection_failed",
    ] {
        let mut permanent = failed.clone();
        permanent["error"] = json!({"code":code,"message":"Permanent failure"});
        assert!(collection_error_latched(&permanent, &version));
    }
    save_collection_result(
        &store,
        7,
        &source,
        &version,
        &failed,
        Ok(json!({"checkpoint":{"partition":"12","sequence":43}})),
    )
    .unwrap();
    let resumed = store.stand_in_source(7, &source).unwrap();
    assert!(resumed["error"].is_null());
    assert_eq!(resumed["checkpoint"]["sequence"], 43);
}

#[test]
fn collection_retry_starts_at_the_declared_delay_and_backs_off_after_repeated_failures() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let source = json!({"providerId":"@test/calendar/events","profile":"account","kind":"calendar","id":"work"});
    let version = json!(3);
    let mut state = json!({"checkpoint":{"cursor":"page-two"}});
    for expected_delay in [30_000, 60_000, 120_000] {
        let before = chrono::Utc::now().timestamp_millis();
        save_collection_result(
            &store,
            7,
            &source,
            &version,
            &state,
            Err(AppIpcError::new("transport_failed", "Offline").with_retry_after_ms(30_000)),
        )
        .unwrap();
        let after = chrono::Utc::now().timestamp_millis();
        state = store.stand_in_source(7, &source).unwrap();
        let deadline = state["retryAt"].as_i64().unwrap();
        assert!((before + expected_delay..=after + expected_delay).contains(&deadline));
        assert_eq!(state["checkpoint"], json!({"cursor":"page-two"}));
    }
    let before = chrono::Utc::now().timestamp_millis();
    save_collection_result(
        &store,
        7,
        &source,
        &version,
        &json!({"failures":10}),
        Err(AppIpcError::new("transport_failed", "Offline").with_retry_after_ms(30_000)),
    )
    .unwrap();
    let after = chrono::Utc::now().timestamp_millis();
    let deadline = store.stand_in_source(7, &source).unwrap()["retryAt"]
        .as_i64()
        .unwrap();
    assert!((before + 3_600_000..=after + 3_600_000).contains(&deadline));

    let before = chrono::Utc::now().timestamp_millis();
    save_collection_result(
        &store,
        7,
        &source,
        &version,
        &json!({}),
        Err(AppIpcError::new("rate_limited", "Wait").with_retry_after_ms(90_000)),
    )
    .unwrap();
    let after = chrono::Utc::now().timestamp_millis();
    let deadline = store.stand_in_source(7, &source).unwrap()["retryAt"]
        .as_i64()
        .unwrap();
    assert!((before + 90_000..=after + 90_000).contains(&deadline));
}

#[test]
fn connection_host_restart_preserves_progress_and_allows_collection_to_resume() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let source =
        json!({"id":"inbox","kind":"folder","profile":"account","providerId":"@test/mail/inbox"});
    let version = json!(3);
    for checkpoint in [
        Value::Null,
        json!({"checkpoint":{"cursor":"page2"},"version":3}),
    ] {
        store.save_stand_in_source(7, &source, &checkpoint).unwrap();
        let previous = store.stand_in_source(7, &source).unwrap();
        save_collection_result(
            &store,
            7,
            &source,
            &version,
            &previous,
            Err(AppIpcError::new(
                "connection_host_unavailable",
                "Host is restarting",
            )),
        )
        .unwrap();
        assert_eq!(store.stand_in_source(7, &source).unwrap(), previous);
    }
    let previous = store.stand_in_source(7, &source).unwrap();
    save_collection_result(
        &store,
        7,
        &source,
        &version,
        &previous,
        Ok(json!({"checkpoint":{"cursor":"page3"}})),
    )
    .unwrap();
    let resumed = store.stand_in_source(7, &source).unwrap();
    assert_eq!(resumed["checkpoint"]["cursor"], "page3");
    assert!(resumed["error"].is_null());
    save_collection_result(
        &store,
        7,
        &source,
        &version,
        &resumed,
        Err(AppIpcError::new(
            "connector_auth_required",
            "Authorize the account",
        )),
    )
    .unwrap();
    let failed = store.stand_in_source(7, &source).unwrap();
    assert_eq!(failed["checkpoint"], resumed["checkpoint"]);
    assert_eq!(failed["error"]["code"], "connector_auth_required");
    assert_eq!(failed["version"], version);
}

#[test]
fn stand_in_collection_uses_the_stored_settings_version_without_role_selection_metadata() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    let version = settings["version"].clone();
    assert!(validate_collection_version(&store, 7, "mac", &version).is_ok());
    settings["roles"][0]["prompt"] = json!("New instructions");
    let updated = store.save_personal_stand_in(7, "mac", settings).unwrap();
    assert_ne!(updated["version"], version);
    assert_eq!(
        validate_collection_version(&store, 7, "mac", &version)
            .unwrap_err()
            .code,
        "connection_configuration_changed"
    );
    assert!(validate_collection_version(&store, 7, "mac", &updated["version"]).is_ok());
}

#[test]
fn independent_manual_intake_needs_no_model_and_preserves_each_roles_boundary() {
    let _lock = crate::test_env::lock();
    let environment = tempfile::tempdir().unwrap();
    let _env: Vec<_> = [
        "WEGENT_CODEX_HOME",
        "WEGENT_EXECUTOR_HOME",
        "WEGENT_CLAUDE_HOME",
        "WEGENT_WORKBENCH_HOME",
        "WEGENT_CAPABILITIES_HOME",
    ]
    .into_iter()
    .map(|key| {
        let directory = environment.path().join(key);
        fs::create_dir_all(&directory).unwrap();
        super::super::tests::ScalarEnv::set(key, directory.to_str().unwrap())
    })
    .collect();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let source = json!({"id":"group","kind":"group","profile":"account","enabledAfter":"2026-01-01T00:00:00Z","policy":{"automatic":false,"askBeforeAct":true,"sessionStrategy":"independent"}});
        let roles = ["broken", "good"]
            .map(|id| json!({"id":id,"enabled":true,"connections":[source.clone()]}));
        store
            .ingest_stand_in_message(
                7,
                "broken",
                &source,
                &json!({"id":"seed","text":"Old work","topicId":"old"}),
                None,
            )
            .unwrap();
        let first =
            json!({"id":"first","text":"New work","topicId":"new","at":"2026-10-25T00:00:00Z"});
        let next = handler
            .collect_connection_page(
                &store,
                7,
                &source,
                &roles,
                (vec![first.clone()], json!({"cursor":"page2"})),
            )
            .await
            .unwrap();
        assert_eq!(next["cursor"], "page2");
        store.save_stand_in_source(7, &source, &next).unwrap();
        assert_eq!(
            store.stand_in_source(7, &source).unwrap()["cursor"],
            "page2"
        );
        let known = store
            .known_stand_in_message(7, "broken", &source, "first")
            .unwrap()
            .unwrap();
        assert_eq!(known["dispatchStatus"], "pending");
        let manual = store
            .stand_in_work(7, known["workId"].as_str().unwrap())
            .unwrap();
        assert_eq!(manual["status"], "pending");
        assert!(manual["error"].is_null());
        let second =
            json!({"id":"second","text":"Next page","topicId":"new","at":"2026-10-25T00:01:00Z"});
        let next = handler
            .collect_connection_page(
                &store,
                7,
                &source,
                &roles,
                (vec![first, second], json!({"cursor":"page3"})),
            )
            .await
            .unwrap();
        assert_eq!(next["cursor"], "page3");
        let good = store.list_stand_in_work(7, Some("good")).unwrap();
        assert_eq!(good.len(), 2);
        assert!(good.iter().all(|work| work["messageCount"] == 1));
        assert_eq!(
            store.list_stand_in_work(7, Some("broken")).unwrap().len(),
            3
        );
        assert_eq!(
            store
                .stand_in_work(7, known["workId"].as_str().unwrap())
                .unwrap()["status"],
            "pending"
        );
        let second = store.known_stand_in_message(7, "broken", &source, "second").unwrap().unwrap();
        assert_ne!(second["workId"], known["workId"], "A matching topic must not override independent sessions");
        let mut reconnected = roles;
        reconnected[0]["connections"][0]["enabledAfter"] = json!("2026-10-26T00:00:00Z");
        let old = json!({"id":"old-after-reconnect","text":"Prior message","topicId":"new","at":"2026-10-25T00:02:00Z"});
        handler
            .collect_connection_page(
                &store,
                7,
                &source,
                &reconnected,
                (vec![old], json!({"cursor":"page4"})),
            )
            .await
            .unwrap();
        assert!(store
            .known_stand_in_message(7, "broken", &source, "old-after-reconnect")
            .unwrap()
            .is_none());
        assert!(store
            .known_stand_in_message(7, "good", &source, "old-after-reconnect")
            .unwrap()
            .is_some());
        });
}

#[tokio::test]
async fn each_connected_role_keeps_its_own_messages_and_reply_thread() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let source = json!({"id":"group","kind":"group","profile":"account","policy":{"automatic":true,"askBeforeAct":true}});
    let roles =
        ["one", "two"].map(|id| json!({"id":id,"enabled":true,"connections":[source.clone()]}));
    let first = json!({"id":"first","text":"Check this proposal","at":"2026-10-25T00:00:00Z"});
    let reply = json!({"id":"reply","text":"And check its budget","quotedMessageId":"first","at":"2026-10-25T00:01:00Z"});
    for role in &roles {
        for message in [&first, &first, &reply, &reply] {
            handler
                .collect_connection_message(&store, 7, role, &source, message)
                .await
                .unwrap();
        }
    }
    let works = store.list_stand_in_work(7, None).unwrap();
    assert_eq!(works.len(), 2);
    assert_ne!(works[0]["taskId"], works[1]["taskId"]);
    for role in ["one", "two"] {
        let owned = store.list_stand_in_work(7, Some(role)).unwrap();
        assert_eq!(owned.len(), 1);
        assert_eq!(owned[0]["messageCount"], 2);
        let messages = store
            .stand_in_messages(7, owned[0]["id"].as_str().unwrap())
            .unwrap();
        assert!(messages.iter().all(|message| message["roleId"] == role));
        let known = store
            .known_stand_in_message(7, role, &source, "reply")
            .unwrap()
            .unwrap();
        assert_eq!(known["workId"], owned[0]["id"]);
    }
    assert!(store.list_stand_in_work(8, None).unwrap().is_empty());
}

#[tokio::test]
async fn collection_partitions_isolate_role_intake_and_durable_cursors_without_changing_authority()
{
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    let source = json!({"providerId":"example/events","profile":"account","kind":"resource","id":"shared","name":"Shared resource","enabledAfter":"2026-11-04T00:00:00Z","policy":{"automatic":true,"askBeforeAct":true}});
    let mut selected = source.clone();
    selected["collectionKey"] = json!("selection:v1:one");
    let roles = vec![
        json!({"id":"selected-a","enabled":true,"connections":[selected]}),
        json!({"id":"all","enabled":true,"connections":[source]}),
        json!({"id":"selected-b","enabled":true,"connections":[selected]}),
    ];
    let groups = collection_sources(&roles);
    assert_eq!(groups.len(), 2);
    assert_eq!(
        groups.values().map(|(_, roles)| roles.len()).sum::<usize>(),
        3
    );
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    for (collected, grouped_roles) in groups.values() {
        let partition = collected["collectionKey"].as_str().unwrap_or("all");
        assert_eq!(grouped_roles.len(), if partition == "all" { 1 } else { 2 });
        let message = json!({"id":partition,"text":"A new change","at":"2026-11-05T00:00:00Z"});
        // Deliberately include all roles: intake itself must reject foreign partitions.
        for _ in 0..2 {
            let next = handler
                .collect_connection_page(
                    &store,
                    7,
                    collected,
                    &roles,
                    (
                        vec![message.clone()],
                        json!({"checkpoint":{"cursor":partition}}),
                    ),
                )
                .await
                .unwrap();
            save_collection_result(&store, 7, collected, &json!(1), &Value::Null, Ok(next))
                .unwrap();
        }
    }
    let events = store.stand_in_events(7).unwrap();
    assert_eq!(events.len(), 3);
    for event in &events {
        let selected_role = event["roleIds"][0] != "all";
        assert_eq!(
            event["source"].get("collectionKey").is_some(),
            selected_role
        );
        assert_eq!(event["message"]["id"] == "selection:v1:one", selected_role);
    }
    drop(store);
    let restored = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    assert_eq!(
        restored.stand_in_source(7, &source).unwrap()["checkpoint"]["cursor"],
        "all"
    );
    assert_eq!(
        restored.stand_in_source(7, &selected).unwrap()["checkpoint"]["cursor"],
        "selection:v1:one"
    );
    let mut changed = selected.clone();
    changed["collectionKey"] = json!("selection:v1:two");
    assert!(restored.stand_in_source(7, &changed).unwrap().is_null());
    // Monitoring partitions must neither remove nor grant resource-level permissions.
    for role in &roles {
        assert!(
            crate::task_runtime::personal_stand_in::stand_in_connection(role, &changed).is_some()
        );
        let mut foreign = changed.clone();
        foreign["profile"] = json!("other-account");
        assert!(
            crate::task_runtime::personal_stand_in::stand_in_connection(role, &foreign).is_none()
        );
    }
}

#[tokio::test]
async fn collection_partition_changes_cannot_reuse_another_partitions_ordered_boundary() {
    let handler = RuntimeWorkRpcHandler::new("mac", "unused");
    let source = json!({"providerId":crate::task_runtime::personal_stand_in::EMAIL_PROVIDER,"profile":"account","kind":"inbox","id":"INBOX","collectionKey":"selected:first","boundary":{"partition":"mailbox","sequence":42}});
    let previous = json!({"userId":7,"executionDeviceId":"mac","roles":[{"id":"reader","enabled":false,"connections":[source]}]});
    let mut unchanged = previous.clone();
    handler
        .prepare_connection_boundaries(&mut unchanged, &previous)
        .await
        .unwrap();
    assert_eq!(
        unchanged["roles"][0]["connections"][0]["boundary"],
        source["boundary"]
    );
    let mut changed = previous.clone();
    changed["roles"][0]["connections"][0]["collectionKey"] = json!("selected:second");
    handler
        .prepare_connection_boundaries(&mut changed, &previous)
        .await
        .unwrap();
    assert!(changed["roles"][0]["connections"][0]
        .get("boundary")
        .is_none());
}
