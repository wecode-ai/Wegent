use super::*;

#[tokio::test]
async fn memory_forgetting_rules_use_owner_routing_without_becoming_recalled_facts() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let saved = store
        .save_stand_in_memory(
            7,
            "mac",
            json!({"scope":{"kind":"personal"},"content":"Prefer short reports"}),
        )
        .unwrap();
    store
        .delete_stand_in_memory(7, saved["id"].as_str().unwrap(), 1)
        .unwrap();
    let runtime = TaskRuntime::new(store).unwrap();
    let request: ExecutionRequest = serde_json::from_value(
        json!({"origin":{"type":"stand_in_identity","userId":7,"deviceId":"mac"}}),
    )
    .unwrap();
    let mut context = SpaceMcpRequestContext::new(None, None, None);
    context.stand_in = stand_in_identity(&request);
    let result = call(
        &runtime,
        "list_memory_forgetting_rules",
        json!({}),
        &context,
    )
    .await;
    assert_ne!(result["isError"], true, "{result}");
    let page: Value = serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(page["items"][0]["kind"], "forgetting_rule");
    assert_eq!(page["items"][0]["content"], "Prefer short reports");
    let search = call(&runtime, "search_memories", json!({}), &context).await;
    let page: Value = serde_json::from_str(search["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(page["items"], json!([]));
    context.stand_in.as_mut().unwrap().user = 8;
    let result = call(
        &runtime,
        "list_memory_forgetting_rules",
        json!({}),
        &context,
    )
    .await;
    let page: Value = serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(page["items"], json!([]));
}

#[test]
fn memory_recall_drops_revoked_sources_but_owner_can_still_delete_records() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let source = json!({"providerId":"@example/calendar/events","profile":"owner","kind":"calendar","id":"work","name":"Work calendar","policy":{"automatic":true,"askBeforeAct":true}});
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["roles"][0]["connections"] = json!([source.clone()]);
    let mut settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    let scope = crate::task_runtime::personal_stand_in::connection_memory_scope(&source);
    let saved = store
        .save_stand_in_memory(
            7,
            "mac",
            json!({
                "scope":scope,"content":"Weekly planning is on Monday"
            }),
        )
        .unwrap();
    let request: ExecutionRequest = serde_json::from_value(json!({
        "origin":{"type":"stand_in_identity","userId":7,"deviceId":"mac"}
    }))
    .unwrap();
    let identity = stand_in_identity(&request).unwrap();
    let search = || memory_call(&store, &identity, "search_memories", json!({})).unwrap();
    assert_eq!(search()["items"], json!([saved]));
    assert_eq!(
        store
            .recall_stand_in_memories(7, "mac", Some("default"), Some(&scope))
            .unwrap(),
        vec![saved.clone()]
    );
    assert!(store
        .recall_stand_in_memories(7, "mac", Some("other"), Some(&scope))
        .unwrap()
        .is_empty());
    settings["roles"][0]["connections"] = json!([]);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    assert_eq!(search()["items"], json!([]));
    assert!(store
        .recall_stand_in_memories(7, "mac", Some("default"), Some(&scope))
        .unwrap()
        .is_empty());
    assert_eq!(store.stand_in_memories(7).unwrap(), vec![saved.clone()]);
    memory_call(
        &store,
        &identity,
        "forget_memory",
        json!({"id":saved["id"],"version":saved["version"]}),
    )
    .unwrap();
    assert!(store.stand_in_memories(7).unwrap().is_empty());
}

#[test]
fn memory_search_catalogs_expose_continuation_for_each_identity() {
    let request: ExecutionRequest = serde_json::from_value(json!({
        "origin":{"type":"stand_in_identity","userId":7,"deviceId":"mac"}
    }))
    .unwrap();
    for (project, review, name) in [
        (None, false, "search_memories"),
        (Some(json!({"id":"project"})), false, "search_memories"),
        (None, true, "search_review_memories"),
    ] {
        let mut context = SpaceMcpRequestContext::new(None, None, None);
        let mut identity = stand_in_identity(&request).unwrap();
        identity.project = project;
        identity.memory_review = review;
        context.stand_in = Some(identity);
        let catalog = tools(&context);
        let rules = catalog
            .iter()
            .find(|tool| tool["name"] == "list_memory_forgetting_rules")
            .unwrap();
        assert_eq!(rules["annotations"]["readOnlyHint"], true);
        assert_eq!(
            rules["inputSchema"]["properties"]["cursor"]["type"],
            "string"
        );
        let search = catalog.iter().find(|tool| tool["name"] == name).unwrap();
        assert_eq!(
            search["inputSchema"]["properties"]["cursor"]["type"],
            "string"
        );
        assert!(search["description"]
            .as_str()
            .unwrap()
            .contains("nextCursor"));
        assert!(search["description"]
            .as_str()
            .unwrap()
            .contains("itemChunk"));
    }
}

#[tokio::test]
async fn memory_review_tools_allow_evidence_but_reject_actions_even_when_called_directly() {
    let request: ExecutionRequest = serde_json::from_value(json!({
        "origin":{"type":"stand_in_schedule","memoryReview":true,"userId":7,"deviceId":"mac","standInId":"@primary"}
    })).unwrap();
    let mut context = SpaceMcpRequestContext::new(None, None, None);
    context.stand_in = stand_in_identity(&request);
    let catalog = tools(&context);
    let actual: std::collections::BTreeSet<_> = catalog
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    let allowed: std::collections::BTreeSet<_> =
        crate::task_runtime::memory_policy::MEMORY_REVIEW_TOOLS
            .iter()
            .copied()
            .collect();
    assert_eq!(
        actual, allowed,
        "The unattended policy must exactly match the guarded memory catalog"
    );
    for name in [
        "list_memory_sources",
        "next_memory_page",
        "complete_memory_source",
        "remember_from_conversation",
        "search_review_memories",
        "list_memory_forgetting_rules",
    ] {
        assert!(catalog.iter().any(|tool| tool["name"] == name), "{name}");
    }
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let runtime = TaskRuntime::new(store).unwrap();
    for name in [
        "create_task",
        "continue_task",
        "schedule_task",
        "cancel_schedule",
        "connect_source",
        "reply",
        "remember",
        "forget_memory",
        "propose_settings",
        "list_memory_connections",
        "list_memory_connection_resources",
        "read_memory_connection",
        "remember_from_connection",
        "complete_memory_connection",
        "list_memory_attachments",
        "read_memory_attachment",
        "remember_from_attachment",
        "list_memory_projects",
        "read_memory_project",
        "remember_from_project",
        "complete_memory_project",
    ] {
        assert!(!catalog.iter().any(|tool| tool["name"] == name), "{name}");
        let result = call(&runtime, name, json!({}), &context).await;
        assert_eq!(result["isError"], true, "{name}: {result}");
    }
    assert!(runtime
        .stand_in_store()
        .stand_in_memories(7)
        .unwrap()
        .is_empty());
}

#[test]
fn project_memory_tool_reuses_formation_and_forgetting_without_widening_scope() {
    let request: ExecutionRequest = serde_json::from_value(json!({
        "origin":{"type":"stand_in_identity","userId":7,"deviceId":"mac"}
    }))
    .unwrap();
    let mut context = SpaceMcpRequestContext::new(None, None, None);
    context.stand_in = stand_in_identity(&request);
    context.stand_in.as_mut().unwrap().project = Some(json!({"id":"project"}));
    let catalog = tools(&context);
    let remember = catalog
        .iter()
        .find(|tool| tool["name"] == "remember")
        .unwrap();
    let description = remember["description"].as_str().unwrap();
    assert!(description.contains(crate::task_runtime::memory_policy::STAND_IN_MEMORY_POLICY));
    assert!(description.contains(crate::task_runtime::memory_policy::STAND_IN_FORGETTING_POLICY));
    assert!(!description.contains("only when the user explicitly asks"));
    assert!(description.contains("not authorization to publish"));
    assert!(remember["inputSchema"]["properties"].get("scope").is_none());
    assert_eq!(remember["annotations"]["openWorldHint"], false);
    assert!(catalog
        .iter()
        .any(|tool| tool["name"] == "list_memory_forgetting_rules"));
    context.stand_in.as_mut().unwrap().readonly_worker = true;
    assert!(!tools(&context)
        .iter()
        .any(|tool| tool["name"] == "remember"));
}

#[test]
fn identity_remember_tool_uses_the_shared_proactive_memory_policy() {
    let request: ExecutionRequest = serde_json::from_value(json!({
        "origin":{"type":"stand_in_identity","userId":7,"deviceId":"mac"}
    }))
    .unwrap();
    let mut context = SpaceMcpRequestContext::new(None, None, None);
    context.stand_in = stand_in_identity(&request);
    let catalog = tools(&context);
    let remember = catalog
        .iter()
        .find(|tool| tool["name"] == "remember")
        .unwrap();
    assert!(remember["description"]
        .as_str()
        .unwrap()
        .contains(crate::task_runtime::memory_policy::STAND_IN_MEMORY_POLICY));
    assert_eq!(remember["annotations"]["readOnlyHint"], false);
    context.stand_in.as_mut().unwrap().readonly_worker = true;
    assert!(!tools(&context)
        .iter()
        .any(|tool| tool["name"] == "remember"));
}

#[test]
fn connected_work_keeps_bounded_payloads_and_revalidates_each_provider_scope() {
    for provider in [
        "@wegent/dsh-connection-git/github",
        "@third-party/calendar/events",
        "@third-party/builds/alerts",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let source = json!({"providerId":provider,"profile":"account","kind":"repository","id":"42","name":"org/repo","policy":{"automatic":true,"askBeforeAct":true}});
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["roles"][0]["connections"] = json!([source.clone()]);
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        let work = store
            .ingest_stand_in_message(
                7,
                "default",
                &source,
                &json!({
                    "id":"event","at":"2026-01-01T00:00:00Z","text":"CI failed",
                    "external":{"platform":provider,"payload":{"body":"x".repeat(16000)}}
                }),
                None,
            )
            .unwrap();
        let runtime = TaskRuntime::new(store).unwrap();
        let identity = StandInMcpIdentity {
            task_id: "primary".into(),
            user: 7,
            device: "mac".into(),
            role: None,
            work: None,
            ask_before_act: true,
            coordinator_batch: None,
            project: None,
            review: false,
            memory_review: false,
            readonly_worker: false,
        };
        let arguments = json!({"workId":work["id"]});
        let summary = read_connected_work_store(&runtime, &identity, &arguments).unwrap();
        assert_eq!(summary["messages"][0]["external"]["payloadAvailable"], true);
        assert!(summary["messages"][0]["external"].get("payload").is_none());
        let payload = read_connected_work_store(
            &runtime,
            &identity,
            &json!({
                "workId":work["id"],"messageId":"event"
            }),
        )
        .unwrap();
        assert_eq!(payload["payload"].as_str().unwrap().chars().count(), 12000);
        assert_eq!(payload["nextOffset"], 12000);
        assert!(read_connected_work_store(
            &runtime,
            &StandInMcpIdentity {
                role: Some("other-role".into()),
                ..identity.clone()
            },
            &arguments
        )
        .is_err());
        assert!(read_connected_work_store(
            &runtime,
            &StandInMcpIdentity {
                user: 8,
                ..identity.clone()
            },
            &arguments
        )
        .is_err());
        assert!(read_connected_work_store(
            &runtime,
            &StandInMcpIdentity {
                work: Some("different-bound-work".into()),
                ..identity.clone()
            },
            &arguments
        )
        .is_err());
        let tail = read_connected_work_store(
            &runtime,
            &identity,
            &json!({"workId":work["id"],"messageId":"event","payloadOffset":12000}),
        )
        .unwrap();
        let original: Value = serde_json::from_str(&format!(
            "{}{}",
            payload["payload"].as_str().unwrap(),
            tail["payload"].as_str().unwrap()
        ))
        .unwrap();
        assert_eq!(original["external"]["payload"]["body"], "x".repeat(16000));
        let store = runtime.stand_in_store();
        let mut revoked = store.personal_stand_in(7, "mac").unwrap();
        revoked["roles"][0]["connections"] = json!([]);
        store.save_personal_stand_in(7, "mac", revoked).unwrap();
        assert!(read_connected_work_store(&runtime, &identity, &arguments).is_err());
    }
}

#[test]
fn stand_in_identity_uses_host_local_task_id_with_empty_backend_ids() {
    let mut request: ExecutionRequest = serde_json::from_value(json!({
        "task_id":"", "subtask_id":"", "runtimeLocalTaskId":"local-worker",
        "origin":{"type":"stand_in_task","userId":7,"deviceId":"mac",
            "standInId":"@primary","sourceTaskId":"primary"}
    }))
    .unwrap();
    let identity = stand_in_identity(&request).unwrap();
    assert_eq!(identity.task_id, "local-worker");
    assert!(identity.readonly_worker);
    assert!(request.task_id.is_empty() && request.subtask_id.is_empty());
    request.extra.get_mut("origin").unwrap()["runtimeTaskId"] = json!("stale-worker");
    assert_eq!(stand_in_identity(&request).unwrap().task_id, "local-worker");
    request.extra.remove("runtimeLocalTaskId");
    assert_eq!(stand_in_identity(&request).unwrap().task_id, "stale-worker");
    request
        .extra
        .get_mut("origin")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("runtimeTaskId");
    assert!(stand_in_identity(&request).unwrap().task_id.is_empty());
}

#[tokio::test]
async fn delegated_worker_raw_catalog_is_readonly_and_roles_have_history_tools() {
    let directory = tempfile::tempdir().unwrap();
    let runtime =
        TaskRuntime::new(LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap())
            .unwrap();
    let mut request:ExecutionRequest=serde_json::from_value(json!({"task_id":"worker","origin":{"type":"stand_in_task","userId":7,"deviceId":"mac","standInId":"@primary","sourceTaskId":"primary"}})).unwrap();
    let mut context = SpaceMcpRequestContext::new(None, None, None);
    context.surface = WeworkMcpSurface::StandIn;
    context.stand_in = stand_in_identity(&request);
    let result = handle_request_with_context(
        &runtime,
        &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
        &context,
    )
    .await
    .unwrap();
    let names: Vec<_> = result["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec![
            "list_tasks",
            "read_task",
            "list_connection_providers",
            "read_source"
        ]
    );
    for name in [
        "read_source",
        "create_task",
        "continue_task",
        "propose_profile",
        "schedule_task",
        "remember",
        "forget_memory",
        "reply",
        "send_email",
    ] {
        assert_eq!(
            call(&runtime, name, json!({}), &context).await["isError"],
            true,
            "{name}"
        );
    }
    request.extra.get_mut("origin").unwrap()["type"] = json!("stand_in_identity");
    request.extra.get_mut("origin").unwrap()["standInId"] = json!("default");
    context.stand_in = stand_in_identity(&request);
    let names: Vec<_> = tools(&context)
        .into_iter()
        .map(|tool| tool["name"].as_str().unwrap().to_owned())
        .collect();
    assert!(names.contains(&"list_tasks".into()) && names.contains(&"read_task".into()));
    assert!(!names.contains(&"create_task".into()));
}

#[test]
fn source_bound_work_catalog_keeps_read_source_without_identity_configuration_tools() {
    let request: ExecutionRequest = serde_json::from_value(json!({"task_id":"source-work","origin":{"type":"connection_work","userId":7,"deviceId":"mac","standInId":"default","workId":"source-work"}})).unwrap();
    let mut context = SpaceMcpRequestContext::new(None, None, None);
    context.surface = WeworkMcpSurface::StandIn;
    context.stand_in = stand_in_identity(&request);
    let catalog = tools(&context);
    let read = catalog
        .iter()
        .find(|tool| tool["name"] == "read_source")
        .expect("source work must retain its source-bound read capability");
    assert_eq!(read["annotations"]["readOnlyHint"], true);
    assert_eq!(read["inputSchema"]["required"], json!([]));
    assert!(read["inputSchema"]["properties"].get("query").is_some());
    assert!(read["inputSchema"]["properties"].get("since").is_none());
    assert!(read["inputSchema"]["properties"].get("limit").is_none());
    assert!(catalog
        .iter()
        .any(|tool| tool["name"] == "list_connection_providers"));
    let reply = catalog.iter().find(|tool| tool["name"] == "reply").unwrap();
    assert_eq!(reply["title"], "Wework: Reply to source");
    assert_eq!(
        reply["inputSchema"]["required"],
        json!(["messageId", "text"])
    );
    assert_eq!(reply["annotations"]["readOnlyHint"], false);
    assert_eq!(reply["annotations"]["openWorldHint"], true);
    assert_eq!(
        reply["inputSchema"]["properties"]["mentionOpenDingTalkIds"]["type"],
        "array"
    );
    assert!(reply["description"]
        .as_str()
        .unwrap()
        .contains("Writing @Name in text alone"));
    assert!(catalog.iter().all(|tool| !matches!(
        tool["name"].as_str(),
        Some(
            "get_profile"
                | "propose_profile"
                | "connect_source"
                | "search_connections"
                | "create_task"
        )
    )));
}

#[tokio::test]
async fn stand_in_review_has_only_generic_read_tools_and_other_schedules_have_no_identity() {
    let mut request: ExecutionRequest = serde_json::from_value(json!({"task_id":"review","origin":{"type":"stand_in_schedule","userId":7,"deviceId":"mac","standInId":"@primary"}})).unwrap();
    assert!(stand_in_identity(&request).is_none());
    request.extra.get_mut("origin").unwrap()["weeklyReview"] = json!(true);
    let identity = stand_in_identity(&request).unwrap();
    let mut context = SpaceMcpRequestContext::new(None, None, None);
    context.stand_in = Some(identity);
    let names: Vec<_> = tools(&context)
        .into_iter()
        .map(|tool| tool["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names, vec!["list_tasks", "read_task"]);
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let runtime = TaskRuntime::new(store).unwrap();
    for name in [
        "read_review_history",
        "create_task",
        "continue_task",
        "propose_profile",
        "reply",
        "send_email",
        "remember",
    ] {
        let rejected = call(&runtime, name, json!({}), &context).await;
        assert_eq!(rejected["isError"], true, "{name}");
        assert!(rejected["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Unknown"));
    }
}

#[test]
fn stand_in_memory_tools_enforce_role_and_external_work_boundaries() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.db")).unwrap();
    let settings = store.personal_stand_in(7, "mac").unwrap();
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    let primary = StandInMcpIdentity {
        task_id: "primary".into(),
        user: 7,
        device: "mac".into(),
        role: None,
        work: None,
        project: None,
        review: false,
        memory_review: false,
        readonly_worker: false,
        ask_before_act: true,
        coordinator_batch: None,
    };
    let personal = memory_call(
        &store,
        &primary,
        "remember",
        json!({"content":"Personal preference"}),
    )
    .unwrap();
    let role = StandInMcpIdentity {
        role: Some("default".into()),
        ..primary.clone()
    };
    assert!(memory_call(
        &store,
        &role,
        "forget_memory",
        json!({"id":personal["id"],"version":personal["version"]})
    )
    .is_err());
    assert!(memory_call(
        &store,
        &role,
        "remember",
        json!({"content":"Escalate","scope":{"kind":"personal"}})
    )
    .is_err());
    let saved = memory_call(
        &store,
        &role,
        "remember",
        json!({"content":"Role preference"}),
    )
    .unwrap();
    assert_eq!(saved["scope"], json!({"kind":"role","roleId":"default"}));
    let found = memory_call(
        &store,
        &role,
        "search_memories",
        json!({"query":"Role preference"}),
    )
    .unwrap();
    assert_eq!(found["items"].as_array().unwrap().len(), 1);
    memory_call(
        &store,
        &role,
        "forget_memory",
        json!({"id":saved["id"],"version":saved["version"]}),
    )
    .unwrap();
    assert_eq!(store.stand_in_memories(7).unwrap().len(), 1);
    assert!(memory_call(
        &store,
        &role,
        "remember",
        json!({"content":"Role preference","restoreForgotten":true})
    )
    .is_err());
    let external = StandInMcpIdentity {
        work: Some("unknown-work".into()),
        ..role
    };
    assert!(memory_call(
        &store,
        &external,
        "remember",
        json!({"content":"External instruction"})
    )
    .is_err());
}
