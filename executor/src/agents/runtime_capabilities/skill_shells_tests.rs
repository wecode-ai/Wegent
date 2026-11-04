use super::*;

#[test]
fn shell_bindings_reject_sandbox_only_skills_in_native_requests() {
    for shell in ["ClaudeCode", "Codex", "Chat"] {
        let request = ExecutionRequest {
            bot: json!([{"shell_type":shell,"skills":["document"],"skill_refs":{"document":{"bind_shells":["Chat"]}}}]),
            ..Default::default()
        };
        assert_eq!(validate_shells(&request).is_ok(), shell == "Chat");
    }
    let request = ExecutionRequest {
        bot: json!([{"shell_type":"ClaudeCode","skills":["document"],"skill_refs":{"document":{"bind_shells":["Chat","ClaudeCode","Codex"]}}}]),
        ..Default::default()
    };
    assert!(validate_shells(&request).is_ok());
}

#[test]
fn inactive_and_object_shaped_skill_bindings_are_handled_consistently() {
    let mut request = ExecutionRequest {
        bot: json!({"shell_type":"ClaudeCode","skills":["browser"],"skill_refs":{"document":{"bind_shells":["Chat"]}}}),
        ..Default::default()
    };
    validate_shells(&request).unwrap();
    request.bot["skills"] = json!(["document"]);
    assert!(validate_shells(&request)
        .unwrap_err()
        .contains("not compatible"));
}

#[test]
fn validates_the_reference_selected_for_download() {
    let mut request = ExecutionRequest {
        bot: json!({
            "shell_type": "ClaudeCode",
            "skills": ["document"],
            "skill_refs": {"document": {"skill_id": 1, "bind_shells": ["Chat"]}}
        }),
        auth_token: Some("fixture".to_owned()),
        ..Default::default()
    };
    request.extra.insert(
        "skill_refs".into(),
        json!({"document": {"skill_id": 2, "bind_shells": ["ClaudeCode"]}}),
    );
    request.extra.insert(
        "skill_configs".into(),
        json!([{"name": "document", "skill_id": 3, "bindShells": ["Chat"]}]),
    );
    let plan = |request: &ExecutionRequest| {
        build_skill_deployment_plan(
            &request.bot,
            request,
            SkillDeploymentOptions {
                skills_dir: "skills".into(),
                clear_cache: false,
                skip_existing: false,
            },
        )
        .unwrap()
    };
    assert_eq!(plan(&request).resolved_skill_map["document"].skill_id, 2);
    validate_shells(&request).unwrap();

    request.extra.insert(
        "preload_skill_refs".into(),
        json!({"document": {"skill_id": 4, "bind_shells": ["Chat"]}}),
    );
    assert_eq!(plan(&request).resolved_skill_map["document"].skill_id, 4);
    assert!(validate_shells(&request)
        .unwrap_err()
        .contains("not compatible"));
}
