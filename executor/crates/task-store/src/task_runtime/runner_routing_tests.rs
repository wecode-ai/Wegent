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
fn human_request_reply_keeps_current_identity_and_claim_is_atomic() {
    human_request_reply_dispatch_outcome("accepted");
}

#[test]
fn human_request_explicit_runtime_rejection_releases_reply_atomically() {
    human_request_reply_dispatch_outcome("rejected");
}

#[test]
fn human_request_transport_failure_keeps_claim_uncertain() {
    human_request_reply_dispatch_outcome("uncertain");
}

fn human_request_reply_dispatch_outcome(outcome: &str) {
    let (_directory, store, project, agent, issue, catalog) = setup();
    let comment = |text: &str, root: Option<String>| {
        store
            .create_comment(&LocalCommentCreate {
                project_id: project.id.clone(),
                task_id: issue.id.clone(),
                sender_type: "user".into(),
                sender_id: "0".into(),
                sender_name: "Local".into(),
                content: text.into(),
                metadata: json!({}),
                reply_to_message_id: root,
                client_message_id: None,
            })
            .unwrap()
    };
    let root = comment("Start", None);
    store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({"message":"Start"}),
            Some(&root.message_id),
        )
        .unwrap();
    let original = store
        .claim_next_execution_with_catalog(Some("runner-a"), "instance", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    let task = original.runtime_task_id.as_deref().unwrap();
    let device = original.runtime_device_id.as_deref().unwrap();
    store
        .request_runtime_start(original.id, device, task, 300)
        .unwrap();
    store.mark_runtime_running(task).unwrap();
    let question = store
        .report_issue_human_request(
            crate::task_runtime::IssueHumanRequestScope {
                project_id: &project.id,
                issue_id: &issue.id,
            },
            device,
            task,
            "scope",
            "Choose scope",
            &[],
        )
        .unwrap();
    let id = question["id"].as_str().unwrap();
    store
        .assign_issue_human_request(
            crate::task_runtime::IssueHumanRequestScope {
                project_id: &project.id,
                issue_id: &issue.id,
            },
            id,
            1,
            0,
            "Local",
            None,
        )
        .unwrap();
    store
        .complete_execution(original.id, Some("Independent work finished"))
        .unwrap();
    let answer = comment("Internal", Some(root.message_id.clone()));
    store.connection().unwrap().execute("UPDATE loop_items SET metadata=json_set(metadata,'$.human_requests[0].runtime_task_id','wrong-session') WHERE id=?1", [&issue.id]).unwrap();
    assert!(store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({"human_request_id":id}),
            Some(&answer.message_id)
        )
        .is_err());
    assert_eq!(
        store
            .list_issue_human_requests(&project.id, &issue.id)
            .unwrap()[0]["status"],
        "pending"
    );
    store.connection().unwrap().execute("UPDATE loop_items SET metadata=json_set(metadata,'$.human_requests[0].runtime_task_id',?2) WHERE id=?1", params![issue.id,task]).unwrap();
    store.connection().unwrap().execute("UPDATE loop_item_executions SET execution_payload=json_set(execution_payload,'$.human_request_id','obsolete') WHERE id=?1", [original.id]).unwrap();
    let run = store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({"human_request_id":id}),
            Some(&answer.message_id),
        )
        .unwrap();
    assert_eq!(
        run.execution_payload.as_ref().unwrap()["human_request_id"],
        id
    );
    assert_eq!(
        run.execution_payload.as_ref().unwrap()["continueTaskId"],
        task
    );
    assert_eq!(
        store
            .list_issue_human_requests(&project.id, &issue.id)
            .unwrap()[0]["status"],
        "answering"
    );
    store
        .fail_runtime_preflight(run.id, "Runner setup failed before dispatch")
        .unwrap();
    let rejected = store
        .list_issue_human_requests(&project.id, &issue.id)
        .unwrap()
        .remove(0);
    assert_eq!(rejected["status"], "pending");
    assert_eq!(rejected["delivery_error"], "rejected");
    let retry = comment("Internal retry", Some(root.message_id.clone()));
    store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({"human_request_id":id}),
            Some(&retry.message_id),
        )
        .unwrap();
    let continued = store
        .claim_next_execution_with_catalog(Some(device), "instance", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    assert_eq!(continued.runtime_task_id.as_deref(), Some(task));
    store
        .request_runtime_start(continued.id, device, task, 300)
        .unwrap();
    if outcome == "uncertain" {
        store
            .fail_execution(continued.id, "Transport disconnected", false)
            .unwrap();
        let pending = store
            .list_issue_human_requests(&project.id, &issue.id)
            .unwrap()
            .remove(0);
        assert_eq!(pending["status"], "answering");
        assert_eq!(pending["answer_message_id"], retry.message_id);
        let duplicate = comment("Must not dispatch twice", Some(root.message_id.clone()));
        assert!(store
            .enqueue_execution(
                &project.id,
                &issue.id,
                &agent.id,
                json!({"human_request_id":id}),
                Some(&duplicate.message_id)
            )
            .is_err());
        return;
    }
    if outcome == "rejected" {
        let failed = store
            .reject_runtime_dispatch(continued.id, "Runtime refused dispatch")
            .unwrap()
            .unwrap();
        assert_eq!(failed.status, "failed");
        let pending = store
            .list_issue_human_requests(&project.id, &issue.id)
            .unwrap()
            .remove(0);
        assert_eq!(pending["status"], "pending");
        assert!(pending["answer_message_id"].is_null());
        assert_eq!(pending["delivery_error"], "rejected");
        let version = pending["version"].clone();
        store
            .reject_runtime_dispatch(continued.id, "Duplicate rejection")
            .unwrap();
        assert_eq!(
            store
                .list_issue_human_requests(&project.id, &issue.id)
                .unwrap()[0]["version"],
            version
        );
        let next = comment("After explicit rejection", Some(root.message_id.clone()));
        store
            .enqueue_execution(
                &project.id,
                &issue.id,
                &agent.id,
                json!({"human_request_id":id}),
                Some(&next.message_id),
            )
            .unwrap();
        let claimed = store
            .claim_next_execution_with_catalog(Some(device), "instance", 300, Some(&catalog))
            .unwrap()
            .unwrap();
        store
            .request_runtime_start(claimed.id, device, task, 300)
            .unwrap();
    }
    store.mark_runtime_running(task).unwrap();
    assert_eq!(
        store
            .list_issue_human_requests(&project.id, &issue.id)
            .unwrap()[0]["status"],
        "resolved"
    );
    assert!(store.issue_human_request_inbox(&[0]).unwrap().is_empty());
    let resolved = store
        .list_issue_human_requests(&project.id, &issue.id)
        .unwrap()
        .remove(0);
    assert!(resolved.get("delivery_error").is_none());
    assert!(resolved["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["type"] == "delivery_rejected"));
    let followup = comment("Extra detail", Some(root.message_id));
    let run = store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({}),
            Some(&followup.message_id),
        )
        .unwrap();
    assert!(run
        .execution_payload
        .as_ref()
        .unwrap()
        .get("human_request_id")
        .is_none());
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
    let (_directory, store, project, agent, issue, mut catalog) = setup();
    catalog["models"][0]["default_reasoning_effort"] = json!("low");
    let run = store
        .enqueue_execution(
            &project.id,
            &issue.id,
            &agent.id,
            json!({"message":"First","modelOptions":{"reasoning":"high","speed":"fast"}}),
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
        payload["executionRequest"]["model_config"]["reasoning"]["effort"],
        "high"
    );
    assert_eq!(payload["modelSelection"]["options"]["reasoning"], "high");
    assert_eq!(payload["modelSelection"]["options"]["speed"], "fast");
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
    assert!(payload["message"]
        .as_str()
        .unwrap()
        .starts_with("Review\n\n"));
    assert_eq!(payload["executionRequest"]["prompt"], payload["message"]);
    assert_eq!(payload["collaboration_manager_context"], payload["message"]);
    assert_eq!(
        payload["runtimeHandle"]["collaborationManagerContext"],
        payload["message"]
    );
    assert_eq!(
        payload["memberRuntimeProfiles"][0]["runtimePayload"]["executionRequest"]["model_config"]
            ["model_id"],
        "native-model"
    );
}

fn configure_prompt_rule(
    store: &LocalTaskStore,
    project: &LoopItem,
    agent: &ChatAgent,
    target_kind: &str,
    trigger: &str,
    prompt: &str,
) {
    let mut rule = json!({
        "id":"prompt-rule", "version":1, "enabled":true, "targetKind":target_kind,
        "targetId":if target_kind == "agent" { agent.id.as_str() } else { "group" },
        "triggerType":trigger, "eventType":"task.status_changed",
        "eventConfig":{"statuses":["in_review"],"transition":"any"}, "prompt":prompt,
    });
    if trigger == "schedule" {
        rule["cronExpression"] = json!("0 9 * * *");
        rule["timezone"] = json!("UTC");
    }
    store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                collaboration_groups: Some(json!([{"id":"group","name":"Prompt group",
            "leader":{"kind":"agent","id":agent.id},"members":[]}])),
                automatic_processing_rules: Some(json!([rule])),
                ..Default::default()
            },
        )
        .unwrap();
}

fn claim_prompt_execution(store: &LocalTaskStore, catalog: &Value) -> LocalExecution {
    store
        .claim_next_execution_with_catalog(Some("runner-a"), "instance", 300, Some(catalog))
        .unwrap()
        .unwrap()
}

fn assert_prompt_execution(execution: &LocalExecution, prompt: &str, group: bool) {
    let payload = execution.execution_payload.as_ref().unwrap();
    let message = payload["message"].as_str().unwrap();
    assert!(message.starts_with(&format!("{prompt}\n\n")), "{message}");
    assert!(message.contains("Issue"));
    assert!(message.contains("Original business description"));
    assert_eq!(payload["executionRequest"]["prompt"], message);
    assert!(!payload["executionRequest"]["system_prompt"]
        .as_str()
        .unwrap()
        .contains(prompt));
    if group {
        assert_eq!(payload["collaboration_manager_context"], message);
        assert_eq!(
            payload["runtimeHandle"]["collaborationManagerContext"],
            message
        );
        assert!(message.contains("Prompt group"));
        assert!(payload["executionRequest"]["system_prompt"]
            .as_str()
            .unwrap()
            .contains(COLLABORATION_MANAGER_SYSTEM_INSTRUCTIONS));
    }
}

#[test]
fn automation_prompts_reach_native_event_schedule_and_retry_requests() {
    for target_kind in ["agent", "collaboration_group"] {
        for trigger in ["event", "schedule"] {
            let (_directory, store, project, agent, issue, catalog) = setup();
            store
                .update_task(
                    &project.id,
                    &issue.id,
                    TaskUpdate {
                        version: issue.version,
                        description: Some("Original business description".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
            let prompt = "检查自动化任务。\n保留多行与 `code`，不要改写 Issue 描述。";
            configure_prompt_rule(&store, &project, &agent, target_kind, trigger, prompt);
            if trigger == "event" {
                let issue = store.get_task(&project.id, &issue.id).unwrap();
                store
                    .update_task(
                        &project.id,
                        &issue.id,
                        TaskUpdate {
                            version: issue.version,
                            status: Some("in_review".into()),
                            ..Default::default()
                        },
                    )
                    .unwrap();
            } else {
                store.tick_project_automations().unwrap();
                let mut current = store.get_project(&project.id).unwrap();
                current.metadata["automation_schedule"]["prompt-rule:1"] =
                    json!("2020-01-01T00:00:00Z");
                store
                    .connection()
                    .unwrap()
                    .execute(
                        "UPDATE loop_items SET metadata=?1 WHERE id=?2",
                        params![current.metadata.to_string(), project.id],
                    )
                    .unwrap();
                store.tick_project_automations().unwrap();
            }
            let runs = store
                .list_project_automation_runs(&project.id, "prompt-rule")
                .unwrap();
            assert_eq!(runs.len(), 1);
            assert_eq!(
                runs[0]["trigger"],
                if trigger == "event" {
                    "event"
                } else {
                    "scheduled"
                }
            );
            let claimed = claim_prompt_execution(&store, &catalog);
            assert_prompt_execution(&claimed, prompt, target_kind == "collaboration_group");
            store
                .fail_execution(claimed.id, "Model fixture stopped", false)
                .unwrap()
                .unwrap();
            let retried = store
                .retry_project_automation_run(&project.id, runs[0]["id"].as_str().unwrap())
                .unwrap();
            assert_ne!(retried[0]["id"], runs[0]["id"]);
            let retried = claim_prompt_execution(&store, &catalog);
            assert_prompt_execution(&retried, prompt, target_kind == "collaboration_group");
            assert_eq!(
                store.get_task(&project.id, &issue.id).unwrap().description,
                "Original business description"
            );
        }
    }
}

#[test]
fn group_automation_prompt_survives_manager_resume_after_a_member_round() {
    let (_directory, store, project, agent, issue, catalog) = setup();
    let member = store.create_chat_agent(&project.id, serde_json::from_value(json!({
        "name":"Prompt member", "execution_mode":"auto", "execution_policy":{"mode":"project_pool"},
        "model_policy":{"mode":"fixed","model":{"runtime":"codex","provider":"test","model_id":"model-a"}},
    })).unwrap()).unwrap();
    let prompt = "按验收准则检查交付物。\n在每轮管理决策中保留此指令。";
    configure_prompt_rule(
        &store,
        &project,
        &agent,
        "collaboration_group",
        "schedule",
        prompt,
    );
    let project = store.get_project(&project.id).unwrap();
    let mut groups = project.metadata["collaboration_groups"].clone();
    groups[0]["members"] = json!([{"kind":"agent","id":member.id}]);
    store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                collaboration_groups: Some(groups),
                ..Default::default()
            },
        )
        .unwrap();
    store
        .run_project_automation(&project.id, "prompt-rule", Some(&issue.id))
        .unwrap();
    let manager = claim_prompt_execution(&store, &catalog);
    let payload = manager.execution_payload.as_ref().unwrap();
    let context = payload["collaboration_manager_context"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(context.starts_with(prompt));
    let runtime_id = manager.runtime_task_id.as_deref().unwrap();
    store
        .request_runtime_start(manager.id, "runner-a", runtime_id, 300)
        .unwrap()
        .unwrap();
    store
        .confirm_runtime_accepted(manager.id, "runner-a", runtime_id, 300)
        .unwrap()
        .unwrap();
    store.mark_runtime_running(runtime_id).unwrap().unwrap();
    store
        .submit_collaboration_round(
            runtime_id,
            &json!({"round_id":"prompt-round","items":[{
                "assignment_id":"review", "assignee_type":"agent", "assignee_id":member.id,
                "title":"Review evidence", "instructions":"Inspect the acceptance evidence",
            }]}),
        )
        .unwrap();
    let member_execution = claim_prompt_execution(&store, &catalog);
    assert_eq!(member_execution.agent_id, member.id);
    store
        .complete_execution(member_execution.id, Some("Evidence checked"))
        .unwrap()
        .unwrap();
    let resumed = claim_prompt_execution(&store, &catalog);
    assert_eq!(resumed.agent_id, agent.id);
    let payload = resumed.execution_payload.unwrap();
    let message = payload["message"].as_str().unwrap();
    assert!(message.starts_with(&format!("{context}\n\n<collaboration_round_results>")));
    assert!(message.contains("Evidence checked"));
    assert_eq!(payload["executionRequest"]["prompt"], message);
    assert_eq!(
        payload["runtimeHandle"]["collaborationManagerContext"],
        context
    );
    assert_eq!(payload["collaboration_manager_context"], context);
    assert_eq!(
        store.get_task(&project.id, &issue.id).unwrap().description,
        issue.description
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
