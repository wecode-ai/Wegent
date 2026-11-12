use super::*;

#[test]
fn updating_a_thread_returns_its_canonical_group_and_participation_context() {
    let (_directory, store) = store();
    let response = store
        .chat_group_request("create", json!({"name":"Update response group"}))
        .unwrap();
    let owner = response["group"]["id"].as_str().unwrap();
    let thread = store
        .create_task(
            owner,
            serde_json::from_value(json!({"title":"Original title"})).unwrap(),
        )
        .unwrap();
    store
        .chat_group_request(
            "participation.update",
            json!({"thread_id":thread.id,"joined":false}),
        )
        .unwrap();
    let before = store.get_task(owner, &thread.id).unwrap();
    let updated = store
        .update_task(
            owner,
            &thread.id,
            TaskUpdate {
                version: before.version,
                title: Some("Edited title".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(updated.id, thread.id);
    assert_eq!(updated.cloud_project_id.as_deref(), Some(owner));
    assert_eq!(updated.title.as_deref(), Some("Edited title"));
    let context = updated
        .thread_context
        .expect("a mutation response must preserve the real group owner");
    assert_eq!(context.group_id, owner);
    assert_eq!(context.group_name, "Update response group");
    assert_eq!(context.group_status, "active");
    assert!(!context.joined, "editing metadata must not implicitly join");
    assert!(context.can_join);
    let participation = store
        .chat_group_request("participation.get", json!({"thread_id":thread.id}))
        .unwrap();
    assert_eq!(participation["joined"], false);
}

#[test]
fn project_scope_cannot_publish_or_start_a_group_thread_comment() {
    for state in ["active", "left", "completed", "archived"] {
        let (_directory, store) = store();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Project"})).unwrap())
            .unwrap();
        let agent = make_local_agent(&store, &project.id, "auto");
        let group = store
            .chat_group_request("create", json!({"name":"Group"}))
            .unwrap();
        let owner = group["group"]["id"].as_str().unwrap();
        let thread = store
            .create_task(
                owner,
                serde_json::from_value(json!({"title":"Owned Thread"})).unwrap(),
            )
            .unwrap();
        match state {
            "active" => {}
            "left" => {
                store
                    .chat_group_request(
                        "participation.update",
                        json!({"thread_id":thread.id,"joined":false}),
                    )
                    .unwrap();
            }
            "completed" => {
                store
                    .update_task(
                        owner,
                        &thread.id,
                        TaskUpdate {
                            version: thread.version,
                            status: Some("completed".into()),
                            ..Default::default()
                        },
                    )
                    .unwrap();
            }
            "archived" => {
                store
                    .chat_group_request(
                        "update",
                        json!({"group_id":owner,"name":"Group","version":1,"status":"archived"}),
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let before = store.get_task(owner, &thread.id).unwrap();
        let group_comments = store.list_comments(owner, &thread.id, 0).unwrap().len();
        assert!(
            store
                .create_comment(&LocalCommentCreate {
                    project_id: project.id.clone(),
                    task_id: thread.id.clone(),
                    client_message_id: None,
                    sender_type: "user".into(),
                    sender_id: "0".into(),
                    sender_name: "Me".into(),
                    content: "Wrong scope".into(),
                    metadata: json!({}),
                    reply_to_message_id: None,
                })
                .is_err(),
            "{state}"
        );
        assert!(
            store
                .start_runtime_comment(&LocalRuntimeCommentStart {
                    project_id: &project.id,
                    task_id: &thread.id,
                    agent_id: &agent.id,
                    trigger_message_id: "wrong-scope",
                    runtime_device_id: "local-device",
                    runtime_task_id: "wrong-scope-runtime",
                    prompt: Some("Must not start"),
                    model: None,
                })
                .is_err(),
            "{state}"
        );
        let after = store.get_task(owner, &thread.id).unwrap();
        assert_eq!(after.status, before.status);
        assert_eq!(after.version, before.version);
        assert_eq!(after.cloud_project_id, before.cloud_project_id);
        assert!(store
            .list_comments(&project.id, &thread.id, 0)
            .unwrap()
            .is_empty());
        assert_eq!(
            store.list_comments(owner, &thread.id, 0).unwrap().len(),
            group_comments
        );
    }
}

#[test]
fn deleted_group_rejects_root_and_thread_comments() {
    let (_directory, store) = store();
    let group = store
        .chat_group_request("create", json!({"name":"Deleted group"}))
        .unwrap();
    let owner = group["group"]["id"].as_str().unwrap();
    let thread = store
        .create_task(
            owner,
            serde_json::from_value(json!({"title":"Discussion"})).unwrap(),
        )
        .unwrap();
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE loop_items SET deleted_at=?1 WHERE id=?2",
            params![now(), owner],
        )
        .unwrap();
    for task_id in [String::new(), thread.id] {
        let before = store.list_comments(owner, &task_id, 0).unwrap();
        assert!(store
            .create_comment(&LocalCommentCreate {
                project_id: owner.into(),
                task_id: task_id.clone(),
                client_message_id: None,
                sender_type: "user".into(),
                sender_id: "0".into(),
                sender_name: "Me".into(),
                content: "Must not be published".into(),
                metadata: json!({}),
                reply_to_message_id: None,
            })
            .is_err());
        let after = store.list_comments(owner, &task_id, 0).unwrap();
        assert_eq!(after.len(), before.len());
        assert!(after
            .iter()
            .all(|row| row.content != "Must not be published"));
    }
}

#[test]
fn local_thread_runtime_binding_keeps_owning_group_and_private_context() {
    let (_directory, store) = store();
    let group = store
        .chat_group_request("create", json!({"name":"Runtime bindings"}))
        .unwrap();
    let owner = group["group"]["id"].as_str().unwrap();
    let thread = store
        .create_task(
            owner,
            serde_json::from_value(json!({"title":"Bound Thread"})).unwrap(),
        )
        .unwrap();
    let context = json!({"privateWorkspace":"actor-owned-workspace"});
    let address = RuntimeTaskAddress {
        device_id: "local-device".into(),
        task_id: "group-runtime".into(),
        task_title: Some("Private run".into()),
        backend_task_id: None,
        model_selection: None,
        execution_context: Some(context.clone()),
        workflow_node_id: None,
    };
    let binding = store
        .bind_task(owner, Some(&thread.id), None, address.clone(), None)
        .unwrap();
    assert_eq!(binding.cloud_project_id, owner);
    assert_eq!(binding.task_user_id, 0);
    assert_eq!(binding.execution_context, Some(context));
    let persisted_owner: String = store
        .connection()
        .unwrap()
        .query_row(
            "SELECT cloud_project_id FROM loop_items WHERE id=?1",
            [&binding.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(persisted_owner, owner);
    assert_eq!(
        store
            .project_bound_task_status("local-device", "group-runtime", "running", 1)
            .unwrap(),
        1
    );
    assert_eq!(
        store.get_task(owner, &thread.id).unwrap().status.as_deref(),
        Some("in_progress")
    );
    store
        .chat_group_request(
            "participation.update",
            json!({"thread_id":thread.id,"joined":false}),
        )
        .unwrap();
    assert!(store
        .bind_task(owner, Some(&thread.id), None, address.clone(), None)
        .is_err());
    assert_eq!(
        store.list_task_bindings(&thread.id).unwrap()[0].id,
        binding.id
    );
    store
        .chat_group_request(
            "participation.update",
            json!({"thread_id":thread.id,"joined":true}),
        )
        .unwrap();
    let current = store.get_task(owner, &thread.id).unwrap();
    store
        .update_task(
            owner,
            &thread.id,
            TaskUpdate {
                version: current.version,
                status: Some("completed".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(store
        .bind_task(owner, Some(&thread.id), None, address.clone(), None)
        .is_err());
    assert!(store
        .bind_task(owner, None, Some("EXTERNAL-7"), address.clone(), None)
        .is_err());
    assert_eq!(
        store
            .project_bound_task_status("local-device", "group-runtime", "running", 2)
            .unwrap(),
        0
    );
    assert_eq!(
        store.get_task(owner, &thread.id).unwrap().status.as_deref(),
        Some("completed")
    );
    let other = store
        .chat_group_request("create", json!({"name":"Other owner"}))
        .unwrap();
    assert!(store
        .bind_task(
            other["group"]["id"].as_str().unwrap(),
            Some(&thread.id),
            None,
            address,
            None
        )
        .is_err());
    assert_eq!(
        store.list_task_bindings(&thread.id).unwrap()[0].id,
        binding.id
    );
    store
        .chat_group_request(
            "update",
            json!({"group_id":owner,"name":"Runtime bindings","version":1,"status":"archived"}),
        )
        .unwrap();
    assert!(store
        .project_bound_task_status("local-device", "group-runtime", "running", 3)
        .is_err());
    assert_eq!(
        store.get_task(owner, &thread.id).unwrap().status.as_deref(),
        Some("completed")
    );
}

fn queued_group_execution(store: &LocalTaskStore) -> (String, LoopItem) {
    let group = store
        .chat_group_request("create", json!({"name":"Execution"}))
        .unwrap();
    let owner = group["group"]["id"].as_str().unwrap().to_owned();
    let agent = make_local_agent(store, &owner, "auto");
    let thread = store
        .create_task(
            &owner,
            serde_json::from_value(json!({"title":"Review me"})).unwrap(),
        )
        .unwrap();
    let thread = store
        .update_task(
            &owner,
            &thread.id,
            TaskUpdate {
                version: thread.version,
                assignee_agent_id: Some(Some(agent.id)),
                execution_payload: Some(json!({"message":"run"})),
                ..Default::default()
            },
        )
        .unwrap();
    (owner, thread)
}

#[test]
fn group_comment_runtime_start_rechecks_current_participation_and_lifecycle() {
    for state in ["left", "completed", "archived", "deleted_group"] {
        let (_directory, store) = store();
        let group = store
            .chat_group_request("create", json!({"name":"Execution"}))
            .unwrap();
        let owner = group["group"]["id"].as_str().unwrap().to_owned();
        let agent = make_local_agent(&store, &owner, "auto");
        let thread = store
            .create_task(
                &owner,
                serde_json::from_value(json!({"title":"Discussion"})).unwrap(),
            )
            .unwrap();
        let input = LocalRuntimeCommentStart {
            project_id: &owner,
            task_id: &thread.id,
            agent_id: &agent.id,
            trigger_message_id: "existing-trigger",
            runtime_device_id: "local-device",
            runtime_task_id: "comment-session",
            prompt: Some("Discuss"),
            model: None,
        };
        store.start_runtime_comment(&input).unwrap();
        match state {
            "left" => {
                store
                    .chat_group_request(
                        "participation.update",
                        json!({"thread_id":thread.id,"joined":false}),
                    )
                    .unwrap();
            }
            "completed" => {
                let current = store.get_task(&owner, &thread.id).unwrap();
                store
                    .update_task(
                        &owner,
                        &thread.id,
                        TaskUpdate {
                            version: current.version,
                            status: Some("completed".into()),
                            ..Default::default()
                        },
                    )
                    .unwrap();
            }
            "archived" => {
                store.chat_group_request("update", json!({"group_id":owner,"name":"Execution","version":1,"status":"archived"})).unwrap();
            }
            "deleted_group" => {
                store
                    .connection()
                    .unwrap()
                    .execute(
                        "UPDATE loop_items SET deleted_at=?1 WHERE id=?2",
                        params![now(), owner],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let before = store.list_comments(&owner, &thread.id, 0).unwrap().len();
        let status = store.get_item(&thread.id, "task").unwrap().status;
        assert!(store.start_runtime_comment(&input).is_err(), "{state}");
        assert!(
            store
                .start_runtime_comment(&LocalRuntimeCommentStart {
                    runtime_task_id: "new-comment-session",
                    ..input
                })
                .is_err(),
            "{state}"
        );
        assert_eq!(
            store.list_comments(&owner, &thread.id, 0).unwrap().len(),
            before
        );
        assert_eq!(store.get_item(&thread.id, "task").unwrap().status, status);
    }
}

#[test]
fn group_comment_runtime_completion_preserves_group_ownership() {
    let (_directory, store) = store();
    let group = store
        .chat_group_request("create", json!({"name":"Discussion"}))
        .unwrap();
    let owner = group["group"]["id"].as_str().unwrap();
    let agent = make_local_agent(&store, owner, "auto");
    let thread = store
        .create_task(
            owner,
            serde_json::from_value(json!({"title":"Discuss"})).unwrap(),
        )
        .unwrap();
    store
        .start_runtime_comment(&LocalRuntimeCommentStart {
            project_id: owner,
            task_id: &thread.id,
            agent_id: &agent.id,
            trigger_message_id: "comment",
            runtime_device_id: "local-device",
            runtime_task_id: "group-comment-runtime",
            prompt: Some("Discuss"),
            model: None,
        })
        .unwrap();
    assert_eq!(
        store.get_task(owner, &thread.id).unwrap().status.as_deref(),
        Some("in_progress")
    );
    store
        .finish_runtime_comment("group-comment-runtime", "completed", "Public result")
        .unwrap();
    let current = store.get_task(owner, &thread.id).unwrap();
    assert_eq!(current.status.as_deref(), Some("in_review"));
    assert_eq!(current.cloud_project_id.as_deref(), Some(owner));
    let comments = store.list_comments(owner, &thread.id, 0).unwrap();
    assert_eq!(comments.last().unwrap().content, "Public result");
    assert_eq!(comments.last().unwrap().status, "completed");
    assert!(store
        .list_comments(owner, "", 0)
        .unwrap()
        .iter()
        .all(|row| row.sender_type == "system"));
}

#[test]
fn local_group_execution_claims_and_finishes_in_its_own_container() {
    let (_directory, store) = store();
    let (owner, thread) = queued_group_execution(&store);
    let claimed = store
        .claim_next_execution_for_runtime(Some("local-device"), "runtime-group", 300)
        .unwrap()
        .expect("Group run must be claimable");
    assert_eq!(claimed.cloud_project_id, owner);
    assert_eq!(claimed.loop_item_id, thread.id);
    let payload = claimed.execution_payload.as_ref().unwrap();
    assert_eq!(payload["standaloneChatWorkspace"], true);
    assert!(payload
        .pointer("/execution/environment/environmentId")
        .is_none());
    store.complete_execution(claimed.id, Some("done")).unwrap();
    let current = store.get_task(&owner, &thread.id).unwrap();
    assert_eq!(current.cloud_project_id.as_deref(), Some(owner.as_str()));
    assert_eq!(current.status.as_deref(), Some("in_review"));
    assert_eq!(current.execution_state.as_deref(), Some("succeeded"));
}

#[test]
fn local_group_execution_claim_rechecks_participation_and_settles_refused_queue() {
    let (_directory, store) = store();
    let (owner, thread) = queued_group_execution(&store);
    store
        .chat_group_request(
            "participation.update",
            json!({"thread_id":thread.id,"joined":false}),
        )
        .unwrap();
    let refused = store
        .claim_next_execution_for_runtime(Some("local-device"), "runtime-group", 300)
        .unwrap_err();
    assert!(refused.to_string().contains("Join the Thread"));
    assert!(!store.has_queued_executions().unwrap());
    assert_eq!(
        store
            .get_task(&owner, &thread.id)
            .unwrap()
            .cloud_project_id
            .as_deref(),
        Some(owner.as_str())
    );
}

#[test]
fn group_runtime_start_rechecks_claimed_thread_before_creating_binding() {
    for state in ["left", "completed"] {
        let (_directory, store) = store();
        let (owner, thread) = queued_group_execution(&store);
        let claimed = store
            .claim_next_execution_for_runtime(Some("local-device"), "runtime-group", 300)
            .unwrap()
            .unwrap();
        if state == "left" {
            store
                .chat_group_request(
                    "participation.update",
                    json!({"thread_id":thread.id,"joined":false}),
                )
                .unwrap();
        } else {
            let current = store.get_task(&owner, &thread.id).unwrap();
            store
                .update_task(
                    &owner,
                    &thread.id,
                    TaskUpdate {
                        version: current.version,
                        status: Some("completed".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        let error = store
            .request_runtime_start(
                claimed.id,
                claimed.runtime_device_id.as_deref().unwrap(),
                claimed.runtime_task_id.as_deref().unwrap(),
                300,
            )
            .unwrap_err();
        assert!(error.to_string().contains(if state == "left" {
            "Join the Thread"
        } else {
            "Reopen the Thread"
        }));
        assert!(store.list_task_bindings(&thread.id).unwrap().is_empty());
        let settled = store.list_executions(&owner, None, None, true).unwrap();
        assert_eq!(settled[0].status, "failed");
        assert!(settled[0].start_requested_at.is_none());
    }
}

#[test]
fn deleted_group_thread_does_not_start_its_previously_claimed_execution() {
    let (_directory, store) = store();
    let (owner, thread) = queued_group_execution(&store);
    let claimed = store
        .claim_next_execution_for_runtime(Some("local-device"), "runtime-group", 300)
        .unwrap()
        .unwrap();
    store.archive_task(&owner, &thread.id).unwrap();
    assert!(store
        .request_runtime_start(
            claimed.id,
            claimed.runtime_device_id.as_deref().unwrap(),
            claimed.runtime_task_id.as_deref().unwrap(),
            300
        )
        .unwrap()
        .is_none());
    assert!(store.list_task_bindings(&thread.id).unwrap().is_empty());
}

#[test]
fn group_public_stand_in_replies_recheck_participation_and_archive() {
    for state in ["left", "archived", "deleted_group", "completed"] {
        let (_directory, store) = store();
        let group = store
            .chat_group_request("create", json!({"name":"Public replies"}))
            .unwrap();
        let owner = group["group"]["id"].as_str().unwrap();
        let thread = store
            .create_task(
                owner,
                serde_json::from_value(json!({"title":"Discussion"})).unwrap(),
            )
            .unwrap();
        store
            .bind_task(
                owner,
                Some(&thread.id),
                None,
                RuntimeTaskAddress {
                    device_id: "local-device".into(),
                    task_id: "stand-in-run".into(),
                    task_title: None,
                    backend_task_id: None,
                    model_selection: None,
                    execution_context: None,
                    workflow_node_id: None,
                },
                None,
            )
            .unwrap();
        match state {
            "left" => {
                store
                    .chat_group_request(
                        "participation.update",
                        json!({"thread_id":thread.id,"joined":false}),
                    )
                    .unwrap();
            }
            "archived" => {
                store.chat_group_request("update", json!({"group_id":owner,"name":"Public replies","status":"archived","version":1})).unwrap();
            }
            "completed" => {
                store
                    .update_task(
                        owner,
                        &thread.id,
                        TaskUpdate {
                            version: thread.version,
                            status: Some("completed".into()),
                            ..Default::default()
                        },
                    )
                    .unwrap();
            }
            "deleted_group" => {
                store
                    .connection()
                    .unwrap()
                    .execute(
                        "UPDATE loop_items SET deleted_at=?1 WHERE id=?2",
                        params![now(), owner],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let origin = json!({"cloudProjectId":owner,"loopItemId":thread.id,"userId":0,"standInId":"personal-role"});
        let result = store.publish_stand_in_reply(
            "local-device",
            "stand-in-run",
            0,
            &origin,
            "public-result",
            "Result",
        );
        let comments = store.list_comments(owner, &thread.id, 0).unwrap();
        if state == "completed" {
            assert_eq!(result.unwrap().content, "Result");
            assert_eq!(comments.len(), 1);
        } else {
            assert!(result.is_err());
            assert!(comments.is_empty());
        }
    }
}
