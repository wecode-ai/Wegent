use super::*;

fn group_owner(store: &LocalTaskStore) -> String {
    store
        .chat_group_request("create", json!({"name":"Agent owner"}))
        .unwrap()["group"]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn direct_group_agent_assignment_keeps_the_group_execution_owner() {
    let (_dir, store) = store();
    let owner = group_owner(&store);
    let agent = make_local_agent(&store, &owner, "auto");
    let thread = store
        .create_task(
            &owner,
            serde_json::from_value(json!({
                "title":"Direct Group Agent", "assignee_agent_id":agent.id
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(store.list_chat_agents(&owner).unwrap()[0].id, agent.id);
    let runs = store.list_executions(&owner, None, None, true).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].cloud_project_id, owner);
    assert_eq!(runs[0].loop_item_id, thread.id);
    assert_eq!(runs[0].agent_id, agent.id);
}

#[test]
fn linked_project_agent_can_be_selected_during_group_thread_creation() {
    let (_dir, store) = store();
    let project = local_project(&store);
    let agent = make_local_agent(&store, &project.id, "auto");
    let owner = group_owner(&store);
    let thread = store
        .create_task_with_context(
            &owner,
            serde_json::from_value(json!({
                "title":"Project resource, Group owner", "assignee_agent_id":agent.id
            }))
            .unwrap(),
            None,
            None,
            Some(project.id.clone()),
        )
        .unwrap();
    let runs = store.list_executions(&owner, None, None, true).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].cloud_project_id, owner);
    assert_eq!(runs[0].loop_item_id, thread.id);
    assert_eq!(runs[0].agent_id, agent.id);
    assert!(store
        .list_executions(&project.id, None, None, true)
        .unwrap()
        .is_empty());
}

#[test]
fn linked_project_agent_can_be_assigned_to_an_existing_group_thread() {
    let (_dir, store) = store();
    let project = local_project(&store);
    let agent = make_local_agent(&store, &project.id, "auto");
    let owner = group_owner(&store);
    let thread = store
        .create_task_with_context(
            &owner,
            serde_json::from_value(json!({"title":"Existing Thread"})).unwrap(),
            None,
            None,
            Some(project.id),
        )
        .unwrap();
    let updated = store
        .update_task(
            &owner,
            &thread.id,
            TaskUpdate {
                version: thread.version,
                assignee_agent_id: Some(Some(agent.id.clone())),
                execution_payload: Some(json!({"message":"Run using the linked project resource"})),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(updated.cloud_project_id.as_deref(), Some(owner.as_str()));
    assert_eq!(
        updated.assignee_agent_id.as_deref(),
        Some(agent.id.as_str())
    );
}

#[test]
fn group_does_not_inherit_default_project_agent_authority() {
    let (_dir, store) = store();
    let agent = make_local_agent(&store, DEFAULT_WORK_ITEM_PROJECT_ID, "auto");
    let owner = group_owner(&store);
    assert!(store
        .create_task(
            &owner,
            serde_json::from_value(json!({
                "title":"Unauthorized default resource", "assignee_agent_id":agent.id
            }))
            .unwrap()
        )
        .is_err());
    assert!(store.list_tasks(&owner).unwrap().is_empty());
    assert!(store
        .list_executions(&owner, None, None, true)
        .unwrap()
        .is_empty());
}

#[test]
fn queued_group_execution_revalidates_archived_agent_before_claim() {
    let (_dir, store) = store();
    let owner = group_owner(&store);
    let agent = make_local_agent(&store, &owner, "auto");
    store
        .create_task(
            &owner,
            serde_json::from_value(json!({
                "title":"Agent revoked while queued", "assignee_agent_id":agent.id
            }))
            .unwrap(),
        )
        .unwrap();
    store
        .archive_chat_agent(&owner, &agent.id, agent.version)
        .unwrap();
    assert!(store
        .claim_next_execution_for_runtime(Some("local-device"), "runtime", 300)
        .is_err());
}

#[test]
fn foreign_project_agent_assignment_is_atomic_and_does_not_change_the_group_thread() {
    let (_dir, store) = store();
    let project = local_project(&store);
    let agent = make_local_agent(&store, &project.id, "auto");
    let owner = group_owner(&store);
    let thread = store
        .create_task(
            &owner,
            serde_json::from_value(json!({"title":"No resource authorization"})).unwrap(),
        )
        .unwrap();
    assert!(store
        .update_task(
            &owner,
            &thread.id,
            TaskUpdate {
                version: thread.version,
                assignee_agent_id: Some(Some(agent.id)),
                ..Default::default()
            }
        )
        .is_err());
    let unchanged = store.get_task(&owner, &thread.id).unwrap();
    assert_eq!(unchanged.version, thread.version);
    assert!(unchanged
        .assignee_agent_id
        .as_deref()
        .unwrap_or_default()
        .is_empty());
    assert!(store
        .list_executions(&owner, None, None, true)
        .unwrap()
        .is_empty());
}

#[test]
fn queued_project_resource_is_rejected_after_its_classification_link_is_removed() {
    let (_dir, store) = store();
    let project = local_project(&store);
    let agent = make_local_agent(&store, &project.id, "auto");
    let owner = group_owner(&store);
    let thread = store
        .create_task_with_context(
            &owner,
            serde_json::from_value(json!({
                "title":"Remove source before claim", "assignee_agent_id":agent.id
            }))
            .unwrap(),
            None,
            None,
            Some(project.id),
        )
        .unwrap();
    store
        .chat_group_request(
            "project_link.update",
            json!({
                "thread_id":thread.id,"version":thread.version,"project_id":null
            }),
        )
        .unwrap();
    assert!(store
        .claim_next_execution_for_runtime(Some("local-device"), "runtime", 300)
        .is_err());
}

#[test]
fn linked_project_agent_comment_execution_keeps_its_real_group_scope() {
    let (_dir, store) = store();
    let project = local_project(&store);
    let agent = make_local_agent(&store, &project.id, "auto");
    let owner = group_owner(&store);
    let thread = store
        .create_task_with_context(
            &owner,
            serde_json::from_value(json!({"title":"Run from a comment"})).unwrap(),
            None,
            None,
            Some(project.id),
        )
        .unwrap();
    let run = store
        .enqueue_execution(
            &owner,
            &thread.id,
            &agent.id,
            json!({"message":"Use the same source Agent"}),
            None,
        )
        .unwrap();
    assert_eq!(run.cloud_project_id, owner);
    assert_eq!(run.loop_item_id, thread.id);
    assert_eq!(run.agent_id, agent.id);
}

#[test]
fn direct_group_crew_dispatch_keeps_the_existing_leader_configuration() {
    let (_dir, store) = store();
    let owner = group_owner(&store);
    let agent = make_local_agent(&store, &owner, "auto");
    store.connection().unwrap().execute(
        "UPDATE loop_items SET metadata=json_set(metadata,'$.collaboration_groups',json(?1)) WHERE id=?2",
        params![json!([{"id":"direct-crew","name":"Group crew", "leader":{"kind":"agent","id":agent.id},"members":[]}]).to_string(),owner]
    ).unwrap();
    let thread = store
        .create_task(
            &owner,
            serde_json::from_value(json!({
                "title":"Crew using Group resources", "assignee_group_id":"direct-crew"
            }))
            .unwrap(),
        )
        .unwrap();
    let runs = store.list_executions(&owner, None, None, true).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].cloud_project_id, owner);
    assert_eq!(runs[0].loop_item_id, thread.id);
    assert_eq!(runs[0].agent_id, agent.id);
}

#[test]
fn linked_project_resource_claim_keeps_the_original_device_binding() {
    let (_dir, store) = store();
    let project = local_project(&store);
    let agent = make_local_agent(&store, &project.id, "auto");
    let owner = group_owner(&store);
    let thread = store
        .create_task_with_context(
            &owner,
            serde_json::from_value(json!({
                "title":"Original runner authority", "assignee_agent_id":agent.id
            }))
            .unwrap(),
            None,
            None,
            Some(project.id),
        )
        .unwrap();
    assert!(store
        .claim_next_execution_for_runtime(Some("foreign-device"), "runtime", 300)
        .unwrap()
        .is_none());
    let claimed = store
        .claim_next_execution_for_runtime(Some("local-device"), "runtime", 300)
        .unwrap()
        .unwrap();
    assert_eq!(claimed.cloud_project_id, owner);
    assert_eq!(claimed.loop_item_id, thread.id);
    assert_eq!(claimed.agent_id, agent.id);
    assert_eq!(claimed.runtime_device_id.as_deref(), Some("local-device"));
}

#[test]
fn direct_group_crew_can_create_a_human_handoff_in_the_same_group() {
    let (_dir, store) = store();
    let owner = group_owner(&store);
    let agent = make_local_agent(&store, &owner, "auto");
    store.connection().unwrap().execute(
        "UPDATE loop_items SET metadata=json_set(metadata,'$.collaboration_groups',json(?1)) WHERE id=?2",
        params![json!([{"id":"direct-crew","name":"Group crew",
            "leader":{"kind":"agent","id":agent.id},
            "members":[{"kind":"human","id":"0","name":"Local owner"}]}]).to_string(),owner]
    ).unwrap();
    let thread = store
        .create_task(
            &owner,
            serde_json::from_value(json!({
                "title":"Human handoff", "assignee_group_id":"direct-crew"
            }))
            .unwrap(),
        )
        .unwrap();
    let claimed = store
        .claim_next_execution_for_runtime(Some("local-device"), "runtime", 300)
        .unwrap()
        .unwrap();
    let running = accept_and_start(&store, &claimed);
    let round = store.submit_collaboration_round(running.runtime_task_id.as_deref().unwrap(),
        &json!({"round_id":"round-group","items":[{
            "assignment_id":"confirm","title":"Confirm result","instructions":"Check the evidence",
            "assignee_type":"human","assignee_id":"0"
        }]})).unwrap();
    let id = round["assignments"][0]["human_assignment_id"]
        .as_str()
        .unwrap();
    let handoff = store.get_task(&owner, id).unwrap();
    assert_eq!(handoff.cloud_project_id.as_deref(), Some(owner.as_str()));
    assert_eq!(handoff.parent_id.as_deref(), Some(thread.id.as_str()));
    assert_eq!(handoff.assignee_user_id, Some(0));
    assert!(handoff.thread_context.unwrap().joined);
}

#[test]
fn group_runtime_comment_cannot_use_an_unlinked_foreign_agent() {
    let (_dir, store) = store();
    let foreign = local_project(&store);
    let agent = make_local_agent(&store, &foreign.id, "auto");
    let owner = group_owner(&store);
    let thread = store
        .create_task(
            &owner,
            serde_json::from_value(json!({"title":"Foreign comment resource"})).unwrap(),
        )
        .unwrap();
    assert!(store
        .start_runtime_comment(&LocalRuntimeCommentStart {
            project_id: &owner,
            task_id: &thread.id,
            agent_id: &agent.id,
            trigger_message_id: "foreign-trigger",
            runtime_device_id: "local-device",
            runtime_task_id: "foreign-session",
            prompt: Some("Do not start"),
            model: None
        })
        .is_err());
    assert!(store
        .list_comments(&owner, &thread.id, 0)
        .unwrap()
        .is_empty());
}

fn assert_comment_replay_revalidates_resource(revocation: &str) {
    let (_dir, store) = store();
    let project = local_project(&store);
    let agent = make_local_agent(&store, &project.id, "auto");
    let owner = group_owner(&store);
    let thread = store
        .create_task_with_context(
            &owner,
            serde_json::from_value(json!({"title":"Replay after resource revocation"})).unwrap(),
            None,
            None,
            Some(project.id.clone()),
        )
        .unwrap();
    let input = LocalRuntimeCommentStart {
        project_id: &owner,
        task_id: &thread.id,
        agent_id: &agent.id,
        trigger_message_id: "original-trigger",
        runtime_device_id: "local-device",
        runtime_task_id: "original-session",
        prompt: Some("Original run"),
        model: None,
    };
    let original = store.start_runtime_comment(&input).unwrap();
    assert_eq!(
        store.start_runtime_comment(&input).unwrap().message_id,
        original.message_id
    );
    match revocation {
        "archive" => store
            .archive_chat_agent(&project.id, &agent.id, agent.version)
            .unwrap(),
        "unlink" => {
            let current = store.get_task(&owner, &thread.id).unwrap();
            store
                .chat_group_request(
                    "project_link.update",
                    json!({
                        "thread_id":thread.id,"version":current.version,"project_id":null
                    }),
                )
                .unwrap();
        }
        _ => unreachable!(),
    }
    let before = store.get_task(&owner, &thread.id).unwrap();
    let comments =
        serde_json::to_value(store.list_comments(&owner, &thread.id, 0).unwrap()).unwrap();
    assert!(
        store.start_runtime_comment(&input).is_err(),
        "{revocation} must invalidate replay"
    );
    let after = store.get_task(&owner, &thread.id).unwrap();
    assert_eq!(after.version, before.version);
    assert_eq!(after.status, before.status);
    assert_eq!(
        serde_json::to_value(store.list_comments(&owner, &thread.id, 0).unwrap()).unwrap(),
        comments
    );
}

#[test]
fn group_comment_replay_rejects_an_archived_agent_without_mutating_state() {
    assert_comment_replay_revalidates_resource("archive");
}

#[test]
fn group_comment_replay_rejects_a_removed_source_link_without_mutating_state() {
    assert_comment_replay_revalidates_resource("unlink");
}

#[test]
fn group_comment_replay_requires_the_original_agent_binding_identity() {
    let (_dir, store) = store();
    let owner = group_owner(&store);
    let first = make_local_agent(&store, &owner, "auto");
    let second = make_local_agent(&store, &owner, "auto");
    let thread = store
        .create_task(
            &owner,
            serde_json::from_value(json!({"title":"Exact replay Agent"})).unwrap(),
        )
        .unwrap();
    let mut input = LocalRuntimeCommentStart {
        project_id: &owner,
        task_id: &thread.id,
        agent_id: &first.id,
        trigger_message_id: "original-trigger",
        runtime_device_id: "local-device",
        runtime_task_id: "original-session",
        prompt: Some("Original run"),
        model: None,
    };
    store.start_runtime_comment(&input).unwrap();
    let before = store.get_task(&owner, &thread.id).unwrap();
    let comments =
        serde_json::to_value(store.list_comments(&owner, &thread.id, 0).unwrap()).unwrap();
    input.agent_id = &second.id;
    assert!(store.start_runtime_comment(&input).is_err());
    let after = store.get_task(&owner, &thread.id).unwrap();
    assert_eq!(after.version, before.version);
    assert_eq!(after.status, before.status);
    assert_eq!(
        serde_json::to_value(store.list_comments(&owner, &thread.id, 0).unwrap()).unwrap(),
        comments
    );
}
