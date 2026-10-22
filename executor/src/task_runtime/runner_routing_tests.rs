use super::*;
use tempfile::TempDir;

fn setup() -> (
    TempDir,
    LocalTaskStore,
    LoopItem,
    ChatAgent,
    LoopItem,
    Value,
) {
    let directory = TempDir::new().unwrap();
    let store = LocalTaskStore::open(directory.path().join("routing.sqlite")).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Routing"})).unwrap())
        .unwrap();
    let project = store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                execution_environment: Some(
                    json!({"repositories":[],"setup_steps":[],"devices":{}}),
                ),
                ..Default::default()
            },
        )
        .unwrap();
    let model = json!({"runtime":"codex","provider":"test","model_id":"model-a"});
    let agent = store.create_chat_agent(&project.id, serde_json::from_value(json!({
        "name":"Runner agent", "execution_mode":"auto", "execution_policy":{"mode":"project_pool"},
        "model_policy":{"mode":"fixed","model":model}, "additional_skills":["review"]
    })).unwrap()).unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Issue"})).unwrap(),
        )
        .unwrap();
    let catalog = json!({"models":[{"runtime":"codex","provider":"test","model_id":"model-a","local_model_id":"native-model","account_label":"Shared account"}]});
    (directory, store, project, agent, issue, catalog)
}

#[test]
fn queued_nested_runtime_payload_requires_catalog_before_claim() {
    let (_directory, store, project, agent, issue, catalog) = setup();
    assert!(!store.has_queued_executions().unwrap());
    let run = store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({"message":"Resume manager"}),
            None,
        )
        .unwrap();
    let payload = json!({"runtimePayload": run.execution_payload});
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE loop_item_executions SET execution_payload=?1 WHERE id=?2",
            params![payload.to_string(), run.id],
        )
        .unwrap();
    assert!(store.has_queued_executions().unwrap());
    let claimed = store
        .claim_next_execution_with_catalog(Some("runner-a"), "instance", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    assert!(claimed.execution_payload.unwrap()["runnerRouting"].is_object());
    assert!(!store.has_queued_executions().unwrap());
}

#[test]
fn native_claim_binds_issue_and_rechecks_removed_model_and_can_cancel() {
    let (_directory, store, project, agent, issue, catalog) = setup();
    let run = store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({"message":"First"}),
            None,
        )
        .unwrap();
    let claimed = store
        .claim_next_execution_with_catalog(Some("runner-a"), "instance-a", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    assert_eq!(claimed.id, run.id);
    let payload = claimed.execution_payload.as_ref().unwrap();
    assert_eq!(
        payload["executionRequest"]["task_id"],
        claimed.runtime_task_id.as_ref().unwrap().as_str()
    );
    assert_eq!(
        payload["executionRequest"]["model_config"]["model_provider"],
        "test"
    );
    assert_eq!(
        payload["executionRequest"]["preload_skills"],
        json!(["review"])
    );
    store.complete_execution(run.id, Some("Done")).unwrap();
    let second = store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({"message":"Second"}),
            None,
        )
        .unwrap();
    assert!(store
        .claim_next_execution_with_catalog(
            Some("runner-a"),
            "instance-a",
            300,
            Some(&json!({"models":[]}))
        )
        .is_err());
    assert_eq!(
        store.cancel_execution(second.id, None).unwrap().status,
        "cancelled"
    );
    assert_eq!(
        store.get_task(&project.id, &issue.id).unwrap().metadata["runner_binding"]
            ["environment_id"],
        "runner-a"
    );
    drop(store);
    let reopened = LocalTaskStore::open(_directory.path().join("routing.sqlite")).unwrap();
    let third = reopened
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({"message":"Third"}),
            None,
        )
        .unwrap();
    assert!(reopened
        .claim_next_execution_with_catalog(Some("runner-b"), "instance-b", 300, Some(&catalog))
        .is_err());
    assert_eq!(
        reopened.cancel_execution(third.id, None).unwrap().status,
        "cancelled"
    );
}

#[test]
fn top_level_comments_use_distinct_sessions_and_reply_reuses_thread_session() {
    let (_directory, store, project, agent, issue, catalog) = setup();
    let comment = |text: &str, reply: Option<String>| {
        store
            .create_comment(&LocalCommentCreate {
                project_id: project.id.clone(),
                task_id: issue.id.clone(),
                sender_type: "user".into(),
                sender_id: "0".into(),
                sender_name: "Me".into(),
                content: text.into(),
                metadata: json!({}),
                reply_to_message_id: reply,
                client_message_id: None,
            })
            .unwrap()
    };
    let root = comment("Root", None);
    let root_run = store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({"message":root.content}),
            Some(&root.message_id),
        )
        .unwrap();
    assert_eq!(
        store
            .enqueue_execution(
                &project.id,
                &issue.id,
                &agent.id,
                json!({}),
                Some(&root.message_id)
            )
            .unwrap()
            .id,
        root_run.id
    );
    let first = store
        .claim_next_execution_with_catalog(Some("runner-a"), "instance", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    store.complete_execution(first.id, Some("Answer")).unwrap();
    assert_eq!(
        store
            .get_task(&project.id, &issue.id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_review")
    );
    let reply = comment("Follow up", Some(root.message_id.clone()));
    store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({}),
            Some(&reply.message_id),
        )
        .unwrap();
    let continuation = store
        .claim_next_execution_with_catalog(Some("runner-a"), "instance", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    assert_eq!(
        store
            .mark_runtime_running(continuation.runtime_task_id.as_ref().unwrap())
            .unwrap()
            .unwrap()
            .id,
        continuation.id
    );
    assert_eq!(
        store
            .get_task(&project.id, &issue.id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_progress")
    );
    assert_eq!(continuation.runtime_task_id, first.runtime_task_id);
    assert_eq!(
        continuation.execution_payload.as_ref().unwrap()["runtimeAction"],
        "send"
    );
    assert_eq!(
        continuation.execution_payload.as_ref().unwrap()["executionRequest"]["new_session"],
        false
    );
    let queued_reply = comment("Queued follow up", Some(root.message_id.clone()));
    store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({}),
            Some(&queued_reply.message_id),
        )
        .unwrap();
    assert!(store
        .claim_next_execution_with_catalog(Some("runner-a"), "instance", 300, Some(&catalog))
        .unwrap()
        .is_none());
    store
        .complete_execution(continuation.id, Some("Answer 2"))
        .unwrap();
    assert_eq!(
        store
            .get_task(&project.id, &issue.id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_progress")
    );
    let queued = store
        .claim_next_execution_with_catalog(Some("runner-a"), "instance", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    assert_eq!(queued.runtime_task_id, first.runtime_task_id);
    store
        .mark_runtime_running(queued.runtime_task_id.as_ref().unwrap())
        .unwrap();
    store
        .complete_execution(queued.id, Some("Answer 3"))
        .unwrap();
    assert_eq!(
        store
            .get_task(&project.id, &issue.id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_review")
    );
    let other = comment("Other root", None);
    store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({"message":other.content}),
            Some(&other.message_id),
        )
        .unwrap();
    let independent = store
        .claim_next_execution_with_catalog(Some("runner-a"), "instance", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    assert_ne!(independent.runtime_task_id, first.runtime_task_id);
    assert_eq!(
        independent.execution_payload.as_ref().unwrap()["executionRequest"]["new_session"],
        true
    );
}

#[test]
fn group_automation_materializes_member_models_without_desktop() {
    let (_directory, store, project, agent, issue, catalog) = setup();
    let group =
        json!({"id":"group","name":"Group","leader":{"kind":"agent","id":agent.id},"members":[]});
    store.update_project(&project.id, ProjectUpdate {
        version:project.version, collaboration_groups:Some(json!([group])),
        automatic_processing_rules:Some(json!([{"id":"rule","targetKind":"collaboration_group","targetId":"group","enabled":true,
            "triggerType":"schedule","cronExpression":"0 9 * * *","timezone":"UTC","prompt":"Review"}])),
        ..Default::default()
    }).unwrap();
    let run = store
        .run_project_automation(&project.id, "rule", Some(&issue.id))
        .unwrap();
    let run = &run[0];
    assert_eq!(run["status"], "queued", "{run}");
    let claimed = store
        .claim_next_execution_with_catalog(Some("runner-a"), "instance", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    let payload = claimed.execution_payload.unwrap();
    assert_eq!(payload["dispatch_role"], "manager");
    assert_eq!(payload["automation_run_id"], run["id"]);
    assert_eq!(
        payload["memberRuntimeProfiles"][0]["runtimePayload"]["executionRequest"]["model_config"]
            ["model_id"],
        "native-model"
    );
}

#[test]
fn historical_comment_binding_is_queued_without_creating_a_new_session() {
    let (_directory, store, project, agent, issue, catalog) = setup();
    store
        .bind_task(
            &project.id,
            Some(&issue.id),
            None,
            serde_json::from_value(json!({
                "device_id":"runner-a", "task_id":"historical-session"
            }))
            .unwrap(),
            None,
        )
        .unwrap();
    let root = store.create_comment(&LocalCommentCreate {
        project_id:project.id.clone(), task_id:issue.id.clone(), sender_type:"agent".into(),
        sender_id:agent.id.clone(), sender_name:"Agent".into(), content:"Historical answer".into(),
        metadata:json!({"runtime_address":{"deviceId":"runner-a","taskId":"historical-session"}}),
        reply_to_message_id:None, client_message_id:None,
    }).unwrap();
    let reply = store
        .create_comment(&LocalCommentCreate {
            project_id: project.id.clone(),
            task_id: issue.id.clone(),
            sender_type: "user".into(),
            sender_id: "0".into(),
            sender_name: "Me".into(),
            content: "Continue".into(),
            metadata: json!({}),
            reply_to_message_id: Some(root.message_id),
            client_message_id: None,
        })
        .unwrap();
    store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({}),
            Some(&reply.message_id),
        )
        .unwrap();
    let claimed = store
        .claim_next_execution_with_catalog(Some("runner-a"), "instance", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    assert_eq!(
        claimed.runtime_task_id.as_deref(),
        Some("historical-session")
    );
    assert_eq!(
        claimed.execution_payload.unwrap()["executionRequest"]["new_session"],
        false
    );
}

#[test]
fn routing_uses_original_schema_and_preserves_issue_metadata() {
    let (_directory, store, project, agent, issue, catalog) = setup();
    {
        let db = store.connection().unwrap();
        let columns = db
            .prepare("PRAGMA table_info(loop_items)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(!columns.iter().any(|name| name == "runner_environment_id"));
        db.execute("UPDATE loop_items SET metadata=json_set(metadata,'$.tags', json('[\"keep\"]')) WHERE id=?1", [&issue.id]).unwrap();
    }
    store
        .enqueue_execution(&project.id, &issue.id, &agent.id, json!({}), None)
        .unwrap();
    let claimed = store
        .claim_next_execution_with_catalog(Some("runner-a"), "instance", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    assert_eq!(
        claimed.execution_payload.unwrap()["runnerRouting"]["version"],
        1
    );
    let metadata: Value = serde_json::from_str(
        &store
            .connection()
            .unwrap()
            .query_row(
                "SELECT metadata FROM loop_items WHERE id=?1",
                [&issue.id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(metadata["tags"], json!(["keep"]));
    assert_eq!(metadata["runner_binding"]["environment_id"], "runner-a");
    store.complete_execution(claimed.id, Some("Done")).unwrap();
    drop(store);
    let reopened = LocalTaskStore::open(_directory.path().join("routing.sqlite")).unwrap();
    assert_eq!(
        reopened.get_task(&project.id, &issue.id).unwrap().metadata["runner_binding"]
            ["environment_id"],
        "runner-a"
    );
}

#[test]
fn concurrent_first_claims_on_independent_connections_bind_one_runner() {
    use std::sync::{Arc, Barrier};
    let (_directory, store, project, agent, issue, catalog) = setup();
    for text in ["First thread", "Second thread"] {
        let comment = store
            .create_comment(&LocalCommentCreate {
                project_id: project.id.clone(),
                task_id: issue.id.clone(),
                sender_type: "user".into(),
                sender_id: "0".into(),
                sender_name: "Me".into(),
                content: text.into(),
                metadata: json!({}),
                reply_to_message_id: None,
                client_message_id: None,
            })
            .unwrap();
        store
            .enqueue_execution(
                &project.id,
                &issue.id,
                &agent.id,
                json!({}),
                Some(&comment.message_id),
            )
            .unwrap();
    }
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = ["runner-a", "runner-b"]
        .into_iter()
        .map(|runner| {
            let barrier = barrier.clone();
            let path = _directory.path().join("routing.sqlite");
            let catalog = catalog.clone();
            std::thread::spawn(move || {
                let worker = LocalTaskStore::open(path).unwrap();
                barrier.wait();
                worker.claim_next_execution_with_catalog(Some(runner), runner, 300, Some(&catalog))
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Ok(Some(_))))
            .count(),
        1
    );
    for result in results {
        if let Err(error) = result {
            assert!(
                error.to_string().contains("ISSUE_RUNNER_CONFLICT"),
                "unexpected claim error: {error}"
            );
        }
    }
    let binding = store.get_task(&project.id, &issue.id).unwrap().metadata["runner_binding"]
        ["environment_id"]
        .clone();
    assert!(binding == "runner-a" || binding == "runner-b");
}
