use super::runner_routing_tests::setup;
use super::*;

fn selection(previous: &str) -> Value {
    json!({"runnerRouting":{
        "version":1,"environment_id":"runner-b",
        "execution_policy":{"mode":"fixed","environment_id":"runner-b"},
        "model":{"runtime":"codex","provider":"test","model_id":"model-a"},
        "recovery_from_environment_id":previous,
    }})
}

#[test]
fn failed_assignment_recovery_changes_only_the_new_execution_device() {
    let (_directory, store, project, agent, issue, catalog) = setup();
    let comment = |message: &str, reply: Option<String>| {
        store
            .create_comment(&LocalCommentCreate {
                project_id: project.id.clone(),
                task_id: issue.id.clone(),
                sender_type: "user".into(),
                sender_id: "0".into(),
                sender_name: "Me".into(),
                content: message.into(),
                metadata: json!({}),
                reply_to_message_id: reply,
                client_message_id: None,
            })
            .unwrap()
    };
    let root = comment("Original", None);
    let recovered_root = comment("Recover on B", None);
    store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({}),
            Some(&root.message_id),
        )
        .unwrap();
    let original = store
        .claim_next_execution_with_catalog(Some("runner-a"), "first", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    store.complete_execution(original.id, Some("Done")).unwrap();

    let rejected = store
        .enqueue_execution(&project.id, &issue.id, &agent.id, json!({}), None)
        .unwrap();
    assert!(store
        .claim_next_execution_with_catalog(Some("runner-b"), "second", 300, Some(&catalog))
        .is_err());
    store.cancel_execution(rejected.id, None).unwrap();
    assert_eq!(
        store.get_task(&project.id, &issue.id).unwrap().metadata["runner_binding"]
            ["environment_id"],
        "runner-a"
    );

    store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            selection("runner-a"),
            Some(&recovered_root.message_id),
        )
        .unwrap();
    let recovered = store
        .claim_next_execution_with_catalog(Some("runner-b"), "second", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    assert_eq!(recovered.runtime_device_id.as_deref(), Some("runner-b"));
    assert_ne!(recovered.runtime_task_id, original.runtime_task_id);
    store
        .complete_execution(recovered.id, Some("Recovered"))
        .unwrap();

    let recovered_reply = comment("Reply after recovery", Some(recovered_root.message_id));
    store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({}),
            Some(&recovered_reply.message_id),
        )
        .unwrap();
    let on_new_device = store
        .claim_next_execution_with_catalog(Some("runner-b"), "second", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    assert_eq!(on_new_device.runtime_task_id, recovered.runtime_task_id);
    store
        .complete_execution(on_new_device.id, Some("Continued on B"))
        .unwrap();

    let reply = comment("Reply to original", Some(root.message_id));
    store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({}),
            Some(&reply.message_id),
        )
        .unwrap();
    let continued = store
        .claim_next_execution_with_catalog(Some("runner-a"), "first", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    assert_eq!(continued.runtime_task_id, original.runtime_task_id);
    assert_eq!(
        store.get_task(&project.id, &issue.id).unwrap().metadata["runner_binding"]
            ["environment_id"],
        "runner-b"
    );
    let history = store
        .list_executions(&project.id, None, None, true)
        .unwrap();
    assert_eq!(
        history
            .iter()
            .find(|row| row.id == original.id)
            .unwrap()
            .runtime_device_id
            .as_deref(),
        Some("runner-a")
    );
}

#[test]
fn stale_or_automatic_recovery_does_not_replace_a_successful_binding() {
    for (previous, automatic) in [("stale", false), ("runner-a", true)] {
        let (_directory, store, project, agent, issue, catalog) = setup();
        store
            .enqueue_execution(&project.id, &issue.id, &agent.id, json!({}), None)
            .unwrap();
        let original = store
            .claim_next_execution_with_catalog(Some("runner-a"), "first", 300, Some(&catalog))
            .unwrap()
            .unwrap();
        store.complete_execution(original.id, Some("Done")).unwrap();
        let mut payload = selection(previous);
        if automatic {
            payload["automation_run_id"] = json!("automatic-run");
        }
        let error = store
            .enqueue_execution(&project.id, &issue.id, &agent.id, payload, None)
            .unwrap_err();
        assert!(error.to_string().contains("ISSUE_RUNNER_CONFLICT"));
        assert_eq!(
            store.get_task(&project.id, &issue.id).unwrap().metadata["runner_binding"]
                ["environment_id"],
            "runner-a"
        );
    }
}

#[test]
fn live_execution_rejects_recovery_before_admission() {
    let (_directory, store, project, agent, issue, catalog) = setup();
    store
        .enqueue_execution(&project.id, &issue.id, &agent.id, json!({}), None)
        .unwrap();
    let original = store
        .claim_next_execution_with_catalog(Some("runner-a"), "first", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    let error = store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            selection("runner-a"),
            None,
        )
        .unwrap_err();
    assert!(error.to_string().contains("ISSUE_RUNNER_CONFLICT"));
    let history = store
        .list_executions(&project.id, None, None, true)
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].id, original.id);
    assert_eq!(history[0].status, "claimed");
    assert_eq!(
        store.get_task(&project.id, &issue.id).unwrap().metadata["runner_binding"]
            ["environment_id"],
        "runner-a"
    );
}
