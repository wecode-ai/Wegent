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
