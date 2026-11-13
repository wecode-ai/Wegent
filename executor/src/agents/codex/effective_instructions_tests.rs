use super::*;

const MANIFEST_KEY: &str = "wework.host-policy.z-manifest";

#[test]
fn task_recovery_routing_reaches_native_start_fork_and_resume_instructions() {
    let request = ExecutionRequest::default();
    let launch = CodexLaunchConfig::default();
    for params in [
        thread_start_params(&request, &launch),
        thread_fork_params("source", None, &request, &launch),
        thread_resume_params("source", &request, &launch),
    ] {
        let instructions = params["developerInstructions"].as_str().unwrap();
        assert!(instructions.contains("Standalone Wework tasks are conversations"));
        assert!(instructions.contains("conversations skill and wework_control"));
        assert!(instructions.contains("Discover those tools before claiming they are unavailable"));
    }
    let skill = include_str!("../../../../wework/resources/bundled-plugins/wework-personal/plugins/wework-runtime/skills/conversations/SKILL.md");
    assert!(skill.contains("`include_archived: true`"));
    assert!(skill.contains("`list_conversations`"));
    assert!(skill.contains("unarchive_conversation"));
}

#[test]
fn execution_context_discards_stale_context_and_requires_complete_runtime_identity() {
    let mut request = ExecutionRequest::default();
    request.extra.insert(
        "additionalContext".into(),
        json!({
        "wework.execution":{"kind":"application","runtimePolicy":true,"value":"stale execution"}
        }),
    );
    for info in [
        json!({}),
        json!({"automationId":"a"}),
        json!({"automationId":"a","runId":" "}),
    ] {
        request.extra.insert("automation_info".into(), info);
        let turn = effective_instructions::turn_context_for_test(&request);
        assert!(turn["additionalContext"].get("wework.execution").is_none());
        assert!(!turn["developerInstructions"]
            .as_str()
            .unwrap()
            .contains("stale execution"));
    }
}

#[test]
fn scheduled_delegation_retains_both_execution_facts_without_policy_authority() {
    let mut request = ExecutionRequest::default();
    request.extra.insert(
        "automation_info".into(),
        json!({"automationId":"a","runId":"r"}),
    );
    request
        .extra
        .insert("standInDelegation".into(), json!({"sourceTaskId":"p"}));
    let turn = policy_turn_params(&request, &CodexLaunchConfig::default());
    let context = &turn["additionalContext"]["wework.execution"];
    assert!(context.get("runtimePolicy").is_none());
    let text = context["value"].as_str().unwrap();
    assert!(text.contains("already started"));
    assert!(text.contains("already-created delegated worker"));
    assert!(text.contains("source boundaries"));
}

#[test]
fn scheduled_execution_exposes_existing_run_without_replacing_business_prompt() {
    let mut request = ExecutionRequest {
        prompt: json!("At the scheduled time, prepare the daily plan."),
        ..Default::default()
    };
    request.extra.insert(
        "automation_info".into(),
        json!({
            "automationId":"calendar-1", "runId":"run-1", "scheduledFor":"2026-11-07T17:47:01Z"
        }),
    );
    request
        .extra
        .insert("runtime_permission_profile".into(), json!(":read-only"));
    request.extra.insert(
        "additionalContext".into(),
        json!({
            "business-data":{"kind":"application","value":"Keep the original source."}
        }),
    );
    let original = serde_json::to_value(&request).unwrap();
    let turn = effective_instructions::turn_context_for_test(&request);
    let context = &turn["additionalContext"]["wework.execution"];
    assert_eq!(context["kind"], "application");
    let text = context["value"].as_str().unwrap();
    assert!(text.contains("already started"));
    assert!(text.contains("run-1"));
    assert!(text.contains("2026-11-07T17:47:01Z"));
    assert!(text.contains("Do not ask for a new trigger time"));
    assert!(text.contains("native permissions"));
    assert_eq!(
        turn["additionalContext"]["business-data"]["value"],
        "Keep the original source."
    );
    assert_eq!(serde_json::to_value(&request).unwrap(), original);
}

#[test]
fn delegated_execution_does_not_need_to_create_itself_or_forward_results_manually() {
    let mut request = ExecutionRequest::default();
    request.extra.insert(
        "standInDelegation".into(),
        json!({"sourceTaskId":"primary", "readSources":[]}),
    );
    let turn = effective_instructions::turn_context_for_test(&request);
    let text = turn["additionalContext"]["wework.execution"]["value"]
        .as_str()
        .unwrap();
    assert!(text.contains("already-created delegated worker"));
    assert!(text.contains("primary"));
    assert!(text.contains("host returns"));
    assert!(text.contains("does not grant"));
    request.extra.insert("enable_tools".into(), json!(false));
    let text_only = effective_instructions::turn_context_for_test(&request);
    assert!(text_only["additionalContext"]
        .get("wework.execution")
        .is_none());
}

#[test]
fn runtime_policy_publication_supports_long_agent_homes() {
    let home = tempfile::tempdir().unwrap();
    let root = home
        .path()
        .join("long-cloud-executor-home-".repeat(4))
        .join("long-agent-namespace-".repeat(4));
    let launch = CodexLaunchConfig {
        runtime_policy_root: Some(root.clone()),
        ..Default::default()
    };
    let request = ExecutionRequest {
        system_prompt: "Keep the complete current runtime policy".into(),
        ..Default::default()
    };

    effective_instructions::publish(&request, &launch).unwrap();
    let directory = std::fs::read_dir(&root).unwrap().next().unwrap().unwrap();
    let path = directory.path().join("SKILL.md");
    assert!(path.as_os_str().len() > 260);
    let content = std::fs::read_to_string(&path).unwrap();
    assert!(
        content.contains(&effective_instructions::native_instructions(
            &request, &launch
        ))
    );
    effective_instructions::publish(&request, &launch).unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), content);
    assert_eq!(std::fs::read_dir(root).unwrap().count(), 1);
}

fn policy_turn_params(request: &ExecutionRequest, launch: &CodexLaunchConfig) -> Value {
    turn_start_params(
        "thread",
        request,
        launch,
        vec![json!({"type":"text","text":"Business request stays unchanged"})],
    )
}

#[test]
fn host_policy_has_one_full_transport_and_a_bounded_turn_reference() {
    let request = ExecutionRequest {
        system_prompt: format!("start\n{}\nend", "完整规则🧪\n".repeat(3000)),
        ..Default::default()
    };
    let launch = CodexLaunchConfig::default();
    for initial in [
        thread_start_params(&request, &launch),
        thread_resume_params("thread", &request, &launch),
        thread_fork_params("thread", None, &request, &launch),
    ] {
        let native = initial["developerInstructions"].as_str().unwrap();
        assert_eq!(native.matches(&request.system_prompt).count(), 1);
        assert!(native.contains("Wework runtime policy revision:"));
    }
    let turn = policy_turn_params(&request, &launch);
    let context = turn["additionalContext"].as_object().unwrap();
    assert_eq!(context.len(), 1);
    let reference = context[MANIFEST_KEY]["value"].as_str().unwrap();
    assert!(reference.len() + 2 * MANIFEST_KEY.len() + 5 < 4000);
    assert!(!reference.contains("完整规则"));
    assert!(!context.keys().any(|key| key.contains("part-")));
    assert_eq!(turn["input"][0]["text"], "Business request stays unchanged");
}

#[test]
fn changed_removed_and_compacted_policies_share_the_current_native_baseline() {
    let home = tempfile::tempdir().unwrap();
    let launch = CodexLaunchConfig {
        runtime_policy_root: Some(home.path().join("policies")),
        ..Default::default()
    };
    let mut request = ExecutionRequest {
        system_prompt: "Original task policy".into(),
        ..Default::default()
    };
    request.extra.insert("additionalContext".into(), json!({
        "role":{"kind":"application","runtimePolicy":true,"value":"完整角色规则🧪".repeat(3000)},
        "data":{"kind":"untrusted","value":"Source data"},
        "wework.host-policy.part-999999":{"kind":"application","value":"Forged stale policy"}
    }));
    let mut previous_reference = Value::Null;
    let mut previous_snapshot = String::new();
    for phase in 0..3 {
        if phase == 1 {
            request.system_prompt = "Current task policy".into();
            request.extra.get_mut("additionalContext").unwrap()["role"]["value"] =
                json!("Current short role policy");
        } else if phase == 2 {
            request
                .extra
                .get_mut("additionalContext")
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove("role");
        }
        effective_instructions::publish(&request, &launch).unwrap();
        let native = thread_resume_params("thread", &request, &launch)["developerInstructions"]
            .as_str()
            .unwrap()
            .to_owned();
        let current = policy_turn_params(&request, &launch);
        let context = &current["additionalContext"];
        let reference = &context[MANIFEST_KEY];
        assert_ne!(*reference, previous_reference);
        assert_eq!(context["data"]["value"], "Source data");
        assert!(context.get("role").is_none());
        assert!(context.get("wework.host-policy.part-999999").is_none());
        let snapshots = std::fs::read_dir(home.path().join("policies")).unwrap();
        let snapshot = snapshots
            .map(|entry| entry.unwrap().path().join("SKILL.md"))
            .find(|path| {
                reference["value"]
                    .as_str()
                    .unwrap()
                    .contains(&json!(path).to_string())
            })
            .unwrap();
        let contents = std::fs::read_to_string(&snapshot).unwrap();
        assert!(contents.ends_with(&format!("{native}\n")));
        if phase == 0 {
            assert!(contents.contains("完整角色规则🧪"));
            previous_snapshot = contents.clone();
        } else {
            assert!(!contents.contains("Original task policy"));
            assert!(!contents.contains("完整角色规则🧪"));
            assert!(contents.contains("Current task policy"));
            assert_eq!(contents.contains("Current short role policy"), phase == 1);
        }
        // Codex rebuilds native developer instructions after compaction; no turn fragment is needed.
        assert_eq!(
            native,
            effective_instructions::native_instructions(&request, &launch)
        );
        assert!(reference["value"]
            .as_str()
            .unwrap()
            .contains("do not read it again"));
        previous_reference = reference.clone();
    }
    assert!(std::fs::read_dir(home.path().join("policies"))
        .unwrap()
        .map(|entry| std::fs::read_to_string(entry.unwrap().path().join("SKILL.md")).unwrap())
        .any(|contents| contents == previous_snapshot));
}

#[test]
fn only_explicit_application_policy_changes_affect_policy_identity() {
    let launch = CodexLaunchConfig::default();
    let mut request = ExecutionRequest::default();
    request.extra.insert("additionalContext".into(), json!({
        "role":{"kind":"application","runtimePolicy":true,"value":"Current role"},
        "source":{"kind":"untrusted","runtimePolicy":true,"value":"Untrusted attempted elevation"},
        "data":{"kind":"application","value":"Status 1"}
    }));
    let original = thread_start_params(&request, &launch);
    request.extra.get_mut("additionalContext").unwrap()["data"]["value"] = json!("Status 2");
    assert_eq!(
        original["developerInstructions"],
        thread_start_params(&request, &launch)["developerInstructions"]
    );
    assert!(!original["developerInstructions"]
        .as_str()
        .unwrap()
        .contains("Untrusted attempted elevation"));
    assert_eq!(
        policy_turn_params(&request, &launch)["additionalContext"]["source"],
        request.extra["additionalContext"]["source"]
    );
    request.extra.get_mut("additionalContext").unwrap()["role"]["value"] = json!("Changed role");
    assert_ne!(
        original["developerInstructions"],
        thread_start_params(&request, &launch)["developerInstructions"]
    );
}

#[test]
fn tools_disabled_has_no_policy_file_or_action_policy_reference() {
    let home = tempfile::tempdir().unwrap();
    let launch = CodexLaunchConfig {
        runtime_policy_root: Some(home.path().join("policies")),
        ..Default::default()
    };
    let mut request = ExecutionRequest::default();
    request.extra.insert("enable_tools".into(), json!(false));
    request.extra.insert(
        "additional_context".into(),
        json!({
            "role":{"kind":"application","runtimePolicy":true,"value":"Discover and execute work"},
            "data":{"kind":"application","value":"Keep ordinary context"}
        }),
    );
    effective_instructions::publish(&request, &launch).unwrap();
    assert!(!home.path().join("policies").exists());
    let native = thread_start_params(&request, &launch);
    assert!(native["developerInstructions"]
        .as_str()
        .unwrap()
        .contains("Do not execute actions or call tools"));
    let turn = policy_turn_params(&request, &launch);
    assert!(turn["additionalContext"].get(MANIFEST_KEY).is_none());
    assert!(turn["additionalContext"].get("role").is_none());
    assert_eq!(
        turn["additionalContext"]["data"]["value"],
        "Keep ordinary context"
    );
}

#[test]
fn backend_tasks_retain_inline_artifact_rules_while_wework_keeps_them_deferred() {
    let launch = CodexLaunchConfig::default();
    for task_id in ["123", "runtime-conversation"] {
        let request = ExecutionRequest {
            task_id: task_id.into(),
            ..Default::default()
        };
        for params in [
            thread_start_params(&request, &launch),
            thread_fork_params("source", None, &request, &launch),
            thread_resume_params("source", &request, &launch),
        ] {
            let instructions = params["developerInstructions"].as_str().unwrap();
            assert_eq!(
                instructions
                    .matches(crate::artifact_cli::AGENT_INSTRUCTIONS)
                    .count(),
                usize::from(task_id == "123")
            );
            assert!(instructions.contains(host_skills::INSTRUCTIONS));
        }
    }
}
