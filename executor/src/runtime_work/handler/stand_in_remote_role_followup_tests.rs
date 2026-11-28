use super::*;

fn owner_conversation(
    handler: &RuntimeWorkRpcHandler,
    workspace: &std::path::Path,
    role: Option<&str>,
    command: &str,
) -> (ExecutionRequest, RuntimeTaskLink) {
    let id = super::super::stand_in_conversations::conversation_task_id(7, role);
    let mut request: ExecutionRequest = serde_json::from_value(json!({
        "task_id":id,"user_id":7,"runtime_command_id":command,
        "origin":{"type":"stand_in_identity","userId":7,"deviceId":"mac","standInId":role}
    }))
    .unwrap();
    handler
        .stamp_stand_in_owner_request(&id, &mut request, false, true)
        .unwrap();
    let link = RuntimeTaskLink {
        local_task_id: id.clone(),
        runtime: "codex".into(),
        thread_id: Some(format!("thread-{id}")),
        workspace_path: workspace.display().to_string(),
        runtime_handle: json!({"origin":request.extra["origin"],"executionRequest":request}),
        ..Default::default()
    };
    handler.upsert_local_task(link.clone());
    (request, link)
}

#[tokio::test]
async fn remote_role_followup_recovers_only_after_the_parent_accepts_the_result() {
    let root = tempfile::tempdir().unwrap();
    let handler = {
        let _guard = crate::test_env::lock();
        let _home = super::super::tests::ScalarEnv::set(
            "WEGENT_EXECUTOR_HOME",
            root.path().to_str().unwrap(),
        );
        RuntimeWorkRpcHandler::new("mac", "unused")
    };
    *handler.backend_connection.lock().unwrap() = Some(ConnectionConfig {
        backend_url: "http://192.0.2.1".into(),
        auth_token: "fixture".into(),
        authenticated_user_id: Some(7),
        ..Default::default()
    });
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    let mut coordinator = crate::test_env::stand_in_role("mac");
    coordinator["id"] = json!("coordinator");
    coordinator["name"] = json!("Coordinator");
    coordinator["enabled"] = json!(true);
    settings["roles"] = json!([coordinator]);
    let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    store
        .save_stand_in_delegation_route(
            7,
            "mac",
            &json!({
                "version":settings["version"],"roleId":"writer","route":{"id":"writer",
                    "name":"Writer","prompt":"Write","enabled":true,"executionDeviceId":"remote"}
            }),
        )
        .unwrap();
    let (request, parent) =
        owner_conversation(&handler, root.path(), Some("coordinator"), "owner-request");
    let parent_id = parent.local_task_id.as_str();
    let identity = crate::task_runtime::mcp::stand_in_identity(&request).unwrap();
    let delegate = |command, args| {
        handler.role_delegation_operation(&identity, "delegate_role_task", args, Some(command))
    };
    let first = json!({"roleId":"writer","requestId":"first","title":"Draft","message":"Write"});
    let accepted = delegate("owner-request", &first).await.unwrap();
    let id = accepted["taskId"].as_str().unwrap();
    assert_eq!(accepted["deviceId"], "remote");
    store
        .record_stand_in_role_task_address(id, 7, 0, "remote")
        .unwrap();
    let receipt = result_command(id, &json!("first-result"));
    let result = json!({"taskId":id,"attempt":0,"status":"done","resultId":receipt});
    assert!(store
        .stage_remote_stand_in_role_result(id, 7, 0, &result)
        .unwrap());
    let followup = json!({"roleId":"writer","taskId":id,"requestId":"second","message":"Revise"});
    assert_eq!(
        delegate("obsolete-command", &followup)
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
    assert_eq!(
        delegate("owner-request", &followup).await.unwrap_err().code,
        "conflict"
    );

    let row = store.stand_in_role_request(id, 7).unwrap().unwrap();
    let delivery = remote_result_message(&parent, 7, &row["intent"], &result, &receipt);
    let (cancel, _cancelled) = oneshot::channel();
    let (_stopped, stopped) = oneshot::channel();
    let execution = handler.start_local_task_execution(parent_id.into(), cancel, stopped);
    assert_eq!(
        handler.send_stand_in_role_result(delivery).await.unwrap()["accepted"],
        true
    );
    // The parent has the command, but the publisher has not stored its receipt yet.
    assert!(store.stand_in_role_request(id, 7).unwrap().unwrap()["resultReceipt"].is_null());

    let activate = |request: &ExecutionRequest| {
        handler.store.update_task(parent_id, |link| {
            link.runtime_handle["executionRequest"] = json!(request);
        });
    };
    let mut next_owner = request.clone();
    next_owner
        .extra
        .insert("runtime_command_id".into(), json!("later-owner-message"));
    handler
        .stamp_stand_in_owner_request(parent_id, &mut next_owner, false, true)
        .unwrap();
    activate(&next_owner);
    let empty_args = json!({"scope":null,"cursor":null});
    let history_args = json!({"scope":"conversation","cursor":null});
    let current_group = |command| {
        handler.role_delegation_operation(&identity, "list_role_tasks", &empty_args, command)
    };
    let history = |command| {
        handler.role_delegation_operation(&identity, "list_role_tasks", &history_args, command)
    };
    let current = current_group(Some("later-owner-message")).await.unwrap();
    assert_eq!(current["tasks"], json!([]));
    let previous = history(Some("later-owner-message")).await.unwrap();
    assert_eq!(previous["tasks"][0]["taskId"], id);
    assert_eq!(current["previousAssignments"], previous);
    assert_eq!(current_group(None).await.unwrap(), json!({"tasks":[]}));
    assert_eq!(history(None).await.unwrap_err().code, "permission_denied");
    assert_eq!(
        history(Some("owner-request")).await.unwrap_err().code,
        "permission_denied"
    );

    let independent_args = json!({"roleId":"writer","requestId":"independent","title":"Another draft","message":"Write another draft"});
    let independent = delegate("later-owner-message", &independent_args)
        .await
        .unwrap();
    let other_id = independent["taskId"].as_str().unwrap();
    assert_ne!(id, other_id);
    let other = store.stand_in_role_request(other_id, 7).unwrap().unwrap();
    assert_ne!(row["root"], other["root"]);

    assert_eq!(
        current_group(None).await.unwrap()["tasks"][0]["taskId"],
        other_id
    );
    assert_eq!(
        current_group(Some("owner-request")).await.unwrap_err().code,
        "permission_denied"
    );
    let stale_branch =
        json!({"roleId":"writer","requestId":"obsolete","title":"Draft","message":"Write"});
    assert_eq!(
        delegate("owner-request", &stale_branch)
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
    let history_page = history(Some("later-owner-message")).await.unwrap();
    let history_ids: HashSet<_> = history_page["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|task| task["taskId"].as_str().unwrap())
        .collect();
    assert_eq!(history_ids, HashSet::from([id, other_id]));

    // An automatic result in the same conversation inherits its own delegation group.
    let mut activity = next_owner.clone();
    activity
        .extra
        .insert("standInRoleResultRoot".into(), other["root"].clone());
    let activity_command = result_command(other_id, &json!("done"));
    activity
        .extra
        .insert("runtime_command_id".into(), json!(activity_command));
    handler
        .stamp_stand_in_owner_request(parent_id, &mut activity, true, false)
        .unwrap();
    activate(&activity);
    assert_eq!(
        history(Some(&activity_command)).await.unwrap_err().code,
        "permission_denied"
    );
    let current = current_group(Some(&activity_command)).await.unwrap();
    assert_eq!(current["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(current["tasks"][0]["taskId"], other_id);
    assert!(current.get("previousAssignments").is_none());
    let error = delegate(&activity_command, &followup).await.unwrap_err();
    assert_eq!(error.code, "permission_denied");
    assert_eq!(store.stand_in_role_request(id, 7).unwrap().unwrap(), row);

    // An automatic wakeup without any branches still sees only its own empty group.
    activity.extra.remove("standInRoleResultRoot");
    activate(&activity);
    assert_eq!(
        current_group(Some(&activity_command)).await.unwrap(),
        json!({"tasks":[]})
    );

    activate(&next_owner);
    // Even this account's primary assistant cannot resume another conversation's task.
    let (primary_request, _) = owner_conversation(&handler, root.path(), None, "primary-command");
    let primary = crate::task_runtime::mcp::stand_in_identity(&primary_request).unwrap();
    let separate = handler
        .role_delegation_operation(
            &primary,
            "list_role_tasks",
            &history_args,
            Some("primary-command"),
        )
        .await
        .unwrap();
    assert_eq!(separate["tasks"], json!([]));
    let separate = handler
        .role_delegation_operation(
            &primary,
            "list_role_tasks",
            &empty_args,
            Some("primary-command"),
        )
        .await
        .unwrap();
    assert_eq!(separate["tasks"], json!([]));
    assert!(separate["previousAssignments"]["tasks"]
        .as_array()
        .is_none_or(Vec::is_empty));
    let error = handler
        .role_delegation_operation(
            &primary,
            "delegate_role_task",
            &followup,
            Some("primary-command"),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "permission_denied");
    assert_eq!(
        delegate("owner-request", &followup).await.unwrap_err().code,
        "permission_denied"
    );
    let continued = delegate("later-owner-message", &followup).await.unwrap();
    assert_eq!(continued["taskId"], id);
    assert_eq!(continued["attempt"], 1);
    let replay = delegate("later-owner-message", &followup).await.unwrap();
    assert_eq!(replay["alreadyAccepted"], true);
    assert_eq!(replay["attempt"], 1);
    let resumed = store.stand_in_role_request(id, 7).unwrap().unwrap();
    assert_eq!(
        resumed["intent"]["roleDelegation"],
        row["intent"]["roleDelegation"]
    );
    assert_eq!(
        store.stand_in_role_request(other_id, 7).unwrap().unwrap(),
        other
    );
    store
        .record_stand_in_role_route_failure(other_id, 7, 0, "route_rejected", false)
        .unwrap();
    let failed = delegate("later-owner-message", &independent_args)
        .await
        .unwrap();
    assert_eq!(failed["alreadyAccepted"], true);
    assert_eq!(failed["taskId"], other_id);
    assert_eq!(failed["accepted"], false);
    assert_eq!(failed["status"], "failed");
    assert_eq!(failed["errorCode"], "route_rejected");
    let queue = handler.turn_scheduler.lock().unwrap();
    assert_eq!(queue.queued_turns.len(), 1);
    assert_eq!(
        queue.queued_turns[0].request.extra["runtime_command_id"],
        receipt
    );
    drop(queue);
    assert!(handler.finish_local_task_execution(parent_id, execution));
}
