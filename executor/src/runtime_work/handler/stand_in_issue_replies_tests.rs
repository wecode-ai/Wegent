use super::*;

#[tokio::test]
async fn issue_conversations_do_not_depend_on_intake_or_current_assignment() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, origin, mut settings) = paused_issue_fixture(root.path());
    let mut request = ExecutionRequest::default();
    request.extra.insert("origin".into(), origin.clone());
    handler
        .validate_stand_in_issue_request(&request)
        .await
        .unwrap();
    let roles = crate::task_runtime::personal_stand_in::stand_in_identities(&settings);
    assert!(issue_reply_role(&roles, &origin).is_some());
    for field in ["trigger", "humanAssignmentId", "triggerCommentId"] {
        let mut forged = origin.clone();
        forged[field] = json!("forged");
        request.extra.insert("origin".into(), forged);
        assert_eq!(
            handler
                .validate_stand_in_issue_request(&request)
                .await
                .unwrap_err(),
            "Issue conversation owner does not match"
        );
    }
    let mut automatic = origin.clone();
    automatic["trigger"] = json!("assignment");
    handler.store.update_task("issue-chat", |link| {
        link.runtime_handle["origin"] = automatic.clone()
    });
    request.extra.insert("origin".into(), automatic.clone());
    assert!(issue_reply_role(&roles, &automatic).is_some());
    handler
        .validate_stand_in_issue_request(&request)
        .await
        .unwrap();
    assert!(issue_reply_role(&[], &origin).is_none());
    handler.store.update_task("issue-chat", |link| {
        link.runtime_handle["origin"] = origin.clone()
    });
    request.extra.insert("origin".into(), origin);
    settings["roles"][0]["collaboration"]["enabled"] = json!(false);
    store
        .save_personal_stand_in(7, "mac", settings.clone())
        .unwrap();
    handler
        .validate_stand_in_issue_request(&request)
        .await
        .unwrap();
    let link = handler.local_task_link("issue-chat").unwrap();
    assert_eq!(
        handler
            .validate_followup_role(&store, 7, &settings["roles"][0], &link)
            .await
            .unwrap_err()
            .message,
        "Work project is no longer connected"
    );
    let project = link.runtime_handle["origin"]["cloudProjectId"]
        .as_str()
        .unwrap();
    let issue_id = link.runtime_handle["origin"]["loopItemId"]
        .as_str()
        .unwrap();
    let issue = store.get_task(project, issue_id).unwrap();
    store
        .update_task(
            project,
            issue_id,
            serde_json::from_value(json!({"version":issue.version,"assignee_user_id":8})).unwrap(),
        )
        .unwrap();
    handler
        .validate_stand_in_issue_request(&request)
        .await
        .unwrap();
    let issue = store.get_task(project, issue_id).unwrap();
    store
        .update_task(
            project,
            issue_id,
            serde_json::from_value(json!({"version":issue.version,"assignee_user_id":null}))
                .unwrap(),
        )
        .unwrap();
    handler
        .validate_stand_in_issue_request(&request)
        .await
        .unwrap();
}

fn paused_issue_fixture(root: &Path) -> (RuntimeWorkRpcHandler, LocalTaskStore, Value, Value) {
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.join("runtime.json"));
    handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Manual Issue"})).unwrap())
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Review","assignee_user_id":7})).unwrap(),
        )
        .unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["roles"][0]["enabled"] = json!(false);
    settings["roles"][0]["collaboration"] = json!({"enabled":true,"allProjects":false,"projects":[{"id":project.id,"store":"local"}],"excludedProjects":[],"tags":[],"policy":{"automatic":false,"askBeforeAct":false}});
    let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    let origin = json!({"type":"issue_dispatch","initiatedBy":"stand_in","trigger":"manual","publicConversation":true,"runtimeTaskId":"issue-chat","userId":7,"standInId":"default","projectStore":"local","cloudProjectId":project.id,"loopItemId":issue.id,"humanAssignmentId":format!("{}-{}",issue.id,issue.metadata["assignment_history"].as_array().unwrap().len())});
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "issue-chat".into(),
        runtime_handle: json!({"origin":origin}),
        ..Default::default()
    });
    (handler, store, origin, settings)
}

#[tokio::test]
async fn issue_review_recovers_the_published_reply_and_stops_after_tag_revocation() {
    use crate::task_runtime::personal_stand_in::training_memory_scope;
    let root = tempfile::tempdir().unwrap();
    let (handler, store, origin, mut settings) = paused_issue_fixture(root.path());
    let project = origin["cloudProjectId"].as_str().unwrap();
    let issue = origin["loopItemId"].as_str().unwrap();
    settings["roles"][0]["enabled"] = json!(true);
    settings["roles"][0]["selfLearningEnabled"] = json!(true);
    settings["roles"][0]["collaboration"]["tags"] = json!(["qa"]);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    let set_tags = |tags: Value| {
        let version = store.get_task(project, issue).unwrap().version;
        store
            .update_task(
                project,
                issue,
                serde_json::from_value(json!({"version":version,"tags":tags})).unwrap(),
            )
            .unwrap();
    };
    set_tags(json!(["qa"]));
    store
        .bind_task(
            project,
            Some(issue),
            None,
            serde_json::from_value(json!({"deviceId":"mac","taskId":"issue-chat"})).unwrap(),
            None,
        )
        .unwrap();
    let source = handler
        .training_connection_sources(&store, 7)
        .unwrap()
        .pop()
        .unwrap()["source"]
        .clone();
    let comment = |actor: &str, body: &str, parent: Option<&str>| {
        store.create_comment(&serde_json::from_value(json!({
        "project_id":project,"task_id":issue,"sender_type":"user","sender_id":actor,"sender_name":"Same display name",
        "content":body,"metadata":{},"reply_to_message_id":parent
    })).unwrap()).unwrap()
    };
    let scene = comment("8", "What time?", None);
    let mut request = ExecutionRequest {
        subtask_id: "subtask".into(),
        ..Default::default()
    };
    request.extra.insert("origin".into(), origin.clone());
    request
        .extra
        .insert("issue_comment_trigger_id".into(), json!(scene.message_id));
    request.extra.insert(
        "standInDeliveryContext".into(),
        json!({"issueSource":source,"roleDeviceId":"mac","ghostVersion":"version-at-generation"}),
    );
    request.extra.insert(
        "additionalContext".into(),
        json!({"wework.stand-in.memories":{"value":"current memory"}}),
    );
    let witness = crate::task_runtime::mcp::begin_stand_in_turn_witness(&mut request).unwrap();
    let turn = json!({"origin":origin,"turn":"native","triggerCommentId":scene.message_id});
    let link = RuntimeTaskLink {
        runtime_handle: json!({"turnIdsBySubtask":{"subtask":"native"}}),
        ..Default::default()
    };
    let snapshot =
        super::super::stand_in_issue_training::issue_delivery_at_completion(&link, &turn, &request)
            .unwrap();
    drop(witness);
    assert_eq!(snapshot["ghostVersion"], "version-at-generation");
    assert_eq!(
        snapshot["memoryVersion"],
        format!("{:x}", Sha256::digest("current memory"))
    );
    let report = json!({"origin":origin,"body":"Tuesday","messageId":"client-id","publicTurn":{"trainingDelivery":snapshot}});
    handler
        .publish_public_issue_reply("issue-chat", &report)
        .await
        .unwrap();
    let published = store
        .list_comments(project, issue, 0)
        .unwrap()
        .pop()
        .unwrap();
    assert_ne!(published.message_id, "client-id");
    let followup = comment("7", "I meant Thursday", Some(&published.message_id));
    // Older local clients can explicitly declare assistant origin before native verification.
    let forwarded = store.create_comment(&serde_json::from_value(json!({
        "project_id":project,"task_id":issue,"sender_type":"user","sender_id":"7","sender_name":"Same display name",
        "content":"Forwarded draft","metadata":{"assistant_source":{"taskId":"other"}},"reply_to_message_id":published.message_id
    })).unwrap()).unwrap();
    let page = handler
        .issue_training_page(&store, 7, "default", &source, 0..i64::MAX, None)
        .await
        .unwrap();
    let messages = page["messages"].as_array().unwrap();
    let find = |id: &str| messages.iter().find(|m| m["id"] == id).unwrap();
    assert_eq!(find(&scene.message_id)["author"], "participant");
    assert_eq!(find(&published.message_id)["author"], "assistant");
    assert_eq!(
        find(&published.message_id)["quotedMessageId"],
        scene.message_id
    );
    assert_eq!(find(&followup.message_id)["author"], "owner");
    assert_eq!(find(&forwarded.message_id)["author"], "unknown");
    assert_eq!(
        find(&followup.message_id)["topicId"],
        find(&scene.message_id)["topicId"]
    );
    assert_eq!(
        find(&followup.message_id)["quotedMessageId"],
        published.message_id
    );
    let scope = training_memory_scope(&source);
    let saved = store.save_verified_training_memory(7,"mac",json!({"scope":scope,"content":"Confirm the day",
      "evidence":{"taskId":"source","messageId":followup.message_id,"observedAt":chrono::Utc::now().timestamp_millis(),
        "trainingCase":{"kind":"correction","source":source,"roleId":"default","actualMessageId":published.message_id,
          "sceneMessageId":scene.message_id,"expectedAuthor":"owner"}}})).unwrap();
    assert_eq!(saved["content"], "Confirm the day");
    let visible = handler
        .visible_issue_review_sources(&store, 7, "default")
        .await
        .unwrap();
    assert_eq!(visible.len(), 1);
    let report = || {
        store
            .stand_in_rework_report(7, "mac", "default", "mac", &visible)
            .unwrap()
    };
    assert_eq!(report()["confirmedReworkRequests"], 1);
    set_tags(json!([]));
    assert_eq!(report()["confirmedReworkRequests"], 0);
    assert!(handler
        .visible_issue_review_sources(&store, 7, "default")
        .await
        .unwrap()
        .is_empty());
    assert!(handler
        .issue_training_page(&store, 7, "default", &source, 0..i64::MAX, None)
        .await
        .is_err());
    assert!(store
        .recall_stand_in_memories(7, "mac", Some("default"), Some(&scope))
        .unwrap()
        .is_empty());
    assert!(store
        .stand_in_management_memories(7, "mac", None)
        .unwrap()
        .iter()
        .all(|row| row["content"] != "Confirm the day"));
    set_tags(json!(["qa"]));
    store
        .archive_project(project, store.get_project(project).unwrap().version)
        .unwrap();
    assert_eq!(report()["confirmedReworkRequests"], 0);
    assert!(handler
        .visible_issue_review_sources(&store, 7, "default")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn cloud_issue_review_rechecks_the_actor_and_keeps_only_correction_references() {
    use crate::task_runtime::personal_stand_in::training_memory_scope;
    use axum::{routing::get, Json, Router};
    let root = tempfile::tempdir().unwrap();
    let (mut handler, store, mut origin, mut settings) = paused_issue_fixture(root.path());
    origin["projectStore"] = json!("cloud");
    handler.store.update_task("issue-chat", |link| {
        link.runtime_handle["origin"] = origin.clone()
    });
    let role = &mut settings["roles"][0];
    role["enabled"] = json!(true);
    role["selfLearningEnabled"] = json!(true);
    role["collaboration"]["projects"][0]["store"] = json!("cloud");
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    let project = origin["cloudProjectId"].as_str().unwrap();
    let issue = origin["loopItemId"].as_str().unwrap();
    let actor = Arc::new(std::sync::atomic::AtomicI64::new(7));
    let live = Arc::clone(&actor);
    let view = json!({"id":issue,"cloud_project_id":project});
    let stamp = (chrono::Utc::now() + chrono::Duration::seconds(2))
        .naive_utc()
        .format("%Y-%m-%dT%H:%M:%S%.f")
        .to_string();
    let comments = (0..100).map(|id|json!({"id":id.to_string(),"body":"Visible issue reply","created_at":stamp,
        "actor_user_id":"7","generation_source":"human","publication_source":"human","confirmation_state":"not_required"})).collect::<Vec<_>>();
    let router = Router::new()
        .route(
            "/api/devices/runtime-owner",
            get(move || {
                let id = live.load(std::sync::atomic::Ordering::SeqCst);
                async move { Json(json!({"id":id})) }
            }),
        )
        .route(
            &format!("/api/v1/loop-items/{issue}"),
            get(move || {
                let value = view.clone();
                async move { Json(value) }
            }),
        )
        .route(
            &format!("/api/v1/cloud-projects/{project}/loop-items/{issue}/activity-comments"),
            get(move || {
                let rows = comments.clone();
                async move { Json(rows) }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: format!("http://{}", listener.local_addr().unwrap()),
        auth_token: "wg-test".into(),
        authenticated_user_id: Some(7),
        ..Default::default()
    })));
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    assert!(handler
        .visible_issue_review_sources(&store, 7, "default")
        .await
        .unwrap()
        .is_empty());
    let source = handler
        .training_connection_sources(&store, 7)
        .unwrap()
        .pop()
        .unwrap()["source"]
        .clone();
    let page = handler
        .issue_training_page(&store, 7, "default", &source, 0..i64::MAX, None)
        .await
        .unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 100);
    assert_eq!(page["messages"][0]["author"], "owner");
    assert!(page["coverageGap"].is_object());
    let scope = training_memory_scope(&source);
    let reviewed=store.save_verified_training_memory(7,"mac",json!({"scope":scope,"content":"Private cloud text",
        "evidence":{"taskId":"source","messageId":"f","observedAt":chrono::Utc::now().timestamp_millis(),
            "trainingCase":{"kind":"correction","roleId":"default","source":source,"actualMessageId":"a","sceneMessageId":"q","expectedAuthor":"owner"}}})).unwrap();
    assert_eq!(reviewed["textRetained"], false);
    assert!(store
        .stand_in_management_memories(7, "mac", None)
        .unwrap()
        .is_empty());
    assert_eq!(
        handler
            .visible_issue_review_sources(&store, 7, "default")
            .await
            .unwrap()
            .len(),
        1
    );
    actor.store(8, std::sync::atomic::Ordering::SeqCst);
    assert!(handler
        .visible_issue_review_sources(&store, 7, "default")
        .await
        .unwrap()
        .is_empty());
    assert!(handler
        .issue_training_page(&store, 7, "default", &source, 0..i64::MAX, None)
        .await
        .is_err());
    server.abort();
}

#[tokio::test]
async fn queued_stand_in_turns_recheck_current_issue_execution_permission() {
    use axum::{routing::get, Json, Router};

    let root = tempfile::tempdir().unwrap();
    let (mut handler, _, mut origin, _) = paused_issue_fixture(root.path());
    origin["projectStore"] = json!("cloud");
    handler.store.update_task("issue-chat", |link| {
        link.runtime_handle["origin"] = origin.clone()
    });
    let mut request = ExecutionRequest::default();
    request.extra.insert("origin".into(), origin.clone());
    let issue = Arc::new(Mutex::new(json!({
        "cloud_project_id":origin["cloudProjectId"],"permissions":{"execute":true}
    })));
    let current = issue.clone();
    let router = Router::new()
        .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
        .route(
            &format!(
                "/api/v1/loop-items/{}",
                origin["loopItemId"].as_str().unwrap()
            ),
            get(move || {
                let value = current.lock().unwrap().clone();
                async move { Json(value) }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: format!("http://{}", listener.local_addr().unwrap()),
        auth_token: "test".into(),
        authenticated_user_id: Some(7),
        ..Default::default()
    })));
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    handler
        .validate_project_coordinator_request(&request)
        .await
        .unwrap();
    for permission in [json!(false), Value::Null] {
        issue.lock().unwrap()["permissions"]["execute"] = permission;
        assert_eq!(
            handler
                .validate_project_coordinator_request(&request)
                .await
                .unwrap_err(),
            "Issue execution permission is unavailable"
        );
    }
    issue.lock().unwrap()["permissions"]["execute"] = json!(true);
    handler
        .validate_project_coordinator_request(&request)
        .await
        .unwrap();
    server.abort();
}

#[tokio::test]
async fn a_public_issue_request_cannot_change_its_trusted_origin_kind() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["roles"][0]["enabled"] = json!(true);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    let origin = json!({"type":"issue_dispatch","initiatedBy":"stand_in","publicConversation":true,"runtimeTaskId":"issue-chat","userId":7,"standInId":"default","projectStore":"cloud","cloudProjectId":"project","loopItemId":"one"});
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "issue-chat".into(),
        runtime_handle: json!({"origin":origin}),
        ..Default::default()
    });
    for key in ["type", "initiatedBy"] {
        let mut request = ExecutionRequest::default();
        let mut untrusted = origin.clone();
        untrusted[key] = json!("different-kind");
        request.extra.insert("origin".into(), untrusted);
        assert_eq!(
            handler
                .validate_stand_in_issue_request(&request)
                .await
                .unwrap_err(),
            "Issue conversation owner does not match"
        );
    }
}

#[test]
fn a_failed_outbox_write_never_exposes_an_uncommitted_reply() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state/runtime.json");
    fs::create_dir_all(&path).unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(path.clone());
    let origin = json!({"type":"issue_dispatch","initiatedBy":"stand_in"});
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "issue-chat".into(),
        thread_id: Some("parent".into()),
        runtime_handle: json!({"lastTurnId":"turn","origin":origin,"standInPublicTurn":{"thread":"parent","turn":"turn","generation":0,"origin":origin}}),
        ..Default::default()
    });
    // The conflicting index directory forces a real atomic replacement failure.
    handler.persist_public_issue_reply("issue-chat", &json!({"method":"item/completed","params":{"threadId":"parent","turnId":"turn","item":{"id":"reply","type":"agentMessage","phase":"commentary","text":"Received"}}}).into());
    assert!(handler
        .local_task_link("issue-chat")
        .unwrap()
        .runtime_handle["standInIssueReplies"]
        .is_null());
}

#[test]
fn autonomous_group_turn_only_queues_start_and_final_output() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "issue-chat".into(),
        thread_id: Some("parent".into()),
        runtime_handle: json!({
            "lastTurnId":"turn",
            "origin":{"type":"issue_dispatch","dispatchRole":"member",
                "dispatchId":"dispatch","cloudProjectId":"project","loopItemId":"one"}
        }),
        ..Default::default()
    });
    handler.persist_public_issue_reply(
        "issue-chat",
        &json!({"method":"turn/started","params":{"threadId":"parent","turnId":"turn"}}).into(),
    );
    for (phase, text) in [
        ("commentary", "Routine progress"),
        ("final_answer", "Finished"),
    ] {
        handler.persist_public_issue_reply(
            "issue-chat",
            &json!({"method":"item/completed","params":{"threadId":"parent","turnId":"turn",
                "item":{"id":phase,"type":"agentMessage","phase":phase,"text":text}}})
            .into(),
        );
    }
    let link = handler.local_task_link("issue-chat").unwrap();
    let reports = link.runtime_handle["standInIssueReplies"]
        .as_object()
        .unwrap();
    assert_eq!(reports.len(), 2);
    assert_eq!(reports["turn"]["body"], "开始处理");
    assert_eq!(reports["turn"]["phase"], "start");
    assert!(reports
        .values()
        .any(|report| report["phase"] == "output" && report["body"] == "Finished"));
}

#[test]
fn public_issue_replies_are_distinct_durable_messages_not_turn_aggregates() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    let path = root.path().join("runtime.json");
    handler.store = RuntimeWorkStore::new(path.clone());
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id:"issue-chat".into(), thread_id:Some("parent".into()),
        runtime_handle:json!({"lastTurnId":"turn", "origin":{"type":"issue_dispatch","initiatedBy":"stand_in","userId":7,"standInId":"review","loopItemId":"one","humanAssignmentId":"first"}}),
        ..Default::default()
    });
    handler.persist_public_issue_reply(
        "issue-chat",
        &json!({"method":"turn/started","params":{"threadId":"parent","turnId":"turn"}}).into(),
    );
    let notification = |id: &str, thread: &str, kind: &str, phase: &str| {
        CodexNotification::from(json!({
            "method":"item/completed","params":{"threadId":thread,"turnId":"turn","item":{"id":id,"type":kind,"phase":phase,"text":id}}
        }))
    };
    for id in ["Received", "Result", "Result"] {
        handler.persist_public_issue_reply(
            "issue-chat",
            &notification(id, "parent", "agentMessage", "commentary"),
        );
    }
    for (id, thread, kind, phase) in [
        ("Child raw result", "child", "agentMessage", "final_answer"),
        ("Tool log", "parent", "commandExecution", "commentary"),
        ("Reasoning", "parent", "agentMessage", "analysis"),
    ] {
        handler.persist_public_issue_reply("issue-chat", &notification(id, thread, kind, phase));
    }
    // A reassignment cannot relabel an old turn's late output with its new grant.
    handler.store.update_task("issue-chat", |link| {
        link.runtime_handle["origin"]["humanAssignmentId"] = json!("second")
    });
    handler.persist_public_issue_reply(
        "issue-chat",
        &notification("Late", "parent", "agentMessage", "final_answer"),
    );
    let reopened = RuntimeWorkStore::new(path);
    let link = reopened.get_task("issue-chat").unwrap();
    let reports = link.runtime_handle["standInIssueReplies"]
        .as_object()
        .unwrap();
    assert_eq!(reports.len(), 3);
    assert_eq!(
        reports
            .values()
            .map(|report| report["body"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["Received", "Result", "Late"]
    );
    assert!(reports
        .values()
        .all(|report| report["origin"]["humanAssignmentId"] == "first"));
    handler.store.update_task("issue-chat", |link| {
        link.runtime_handle["origin"]["type"] = json!("stand_in_identity")
    });
    handler.persist_public_issue_reply(
        "issue-chat",
        &json!({"method":"turn/started","params":{"threadId":"parent","turnId":"turn"}}).into(),
    );
    handler.persist_public_issue_reply(
        "issue-chat",
        &notification("Private", "parent", "agentMessage", "final_answer"),
    );
    assert_eq!(
        handler
            .local_task_link("issue-chat")
            .unwrap()
            .runtime_handle["standInIssueReplies"]
            .as_object()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn issue_conversations_reuse_history_but_reassignment_is_a_new_wakeup() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    let config = json!({"id":"review","userId":7,"projectId":"project","projectStore":"cloud"});
    let issue = json!({"id":"one"});
    let id = handler.stand_in_task_id(&config, &issue);
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id:id.clone(), status:"done".into(),
        runtime_handle:json!({"origin":{"type":"issue_dispatch","initiatedBy":"stand_in","standInId":"review","userId":7,"cloudProjectId":"project","projectStore":"cloud","loopItemId":"one","humanAssignmentId":"first"},"standInIssueWakeups":["first"]}),
        ..Default::default()
    });
    assert_eq!(handler.stand_in_task_id(&config, &issue), id);
    assert!(handler.stand_in_assignment_is_handled(
        &config,
        &id,
        &json!({"humanAssignmentId":"first"})
    ));
    assert!(!handler.stand_in_assignment_is_handled(
        &config,
        &id,
        &json!({"humanAssignmentId":"second"})
    ));
    assert_ne!(handler.stand_in_task_id(&config, &json!({"id":"two"})), id);
    for field in ["id", "userId", "projectId", "projectStore"] {
        let mut other = config.clone();
        other[field] = json!("other");
        assert_ne!(handler.stand_in_task_id(&other, &issue), id, "{field}");
    }
}

#[test]
fn a_reserved_legacy_conversation_survives_restart_before_native_task_creation() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("runtime.json");
    let store = RuntimeWorkStore::new(path.clone());
    let config = json!({"id":"review","userId":7,"projectId":"project","projectStore":"cloud"});
    let issue = json!({"id":"one"});
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = store.clone();
    let identity = handler.stand_in_task_id(&config, &issue);
    store
        .bind_issue_conversation(&identity, "stand-in-old-assignment-review")
        .unwrap();
    assert!(store
        .bind_issue_conversation(&identity, "different-reservation")
        .is_err());
    handler.store = RuntimeWorkStore::new(path);
    assert_eq!(
        handler.stand_in_task_id(&config, &issue),
        "stand-in-old-assignment-review"
    );
    assert!(handler
        .local_task_link("stand-in-old-assignment-review")
        .is_none());
}

#[test]
fn mentions_and_assignments_respect_the_same_device_reservation_without_a_current_grant() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    let config = json!({"id":"review","userId":7,"projectId":"project","projectStore":"cloud"});
    let issue = json!({"id":"one"});
    let canonical = handler.stand_in_task_id(&config, &issue);
    for (task, grant) in [
        (canonical.as_str(), Value::Null),
        ("stand-in-old-grant-review", json!("old-grant")),
    ] {
        let rows = json!([{"task_id":task,"task_user_id":7,"device_id":"other-device","human_assignment_id":grant}]);
        assert!(!handler
            .use_stand_in_issue_reservation(&config, &issue, &rows)
            .unwrap());
    }
    let rows = json!([{"task_id":"stand-in-old-grant-review","task_user_id":7,"device_id":"mac","human_assignment_id":"old-grant"}]);
    assert!(handler
        .use_stand_in_issue_reservation(&config, &issue, &rows)
        .unwrap());
    assert_eq!(
        handler.stand_in_task_id(&config, &issue),
        "stand-in-old-grant-review"
    );
    let established = json!([
        {"task_id":"stand-in-old-grant-review","task_user_id":7,"device_id":"mac","human_assignment_id":"old-grant"},
        {"task_id":"another-legacy-thread","task_user_id":7,"device_id":"other-device","stand_in_conversation_id":canonical}
    ]);
    assert!(
        !handler
            .use_stand_in_issue_reservation(&config, &issue, &established)
            .unwrap(),
        "An established reservation takes precedence over an older local alias"
    );
}
