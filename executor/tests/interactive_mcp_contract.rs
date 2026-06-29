// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use wegent_executor::agents::interactive_mcp::{
    build_deferred_mcp_proxy_request, build_interactive_form_answer_payload,
    build_interactive_form_answer_query, build_interactive_form_resume_plan,
    build_pre_tool_use_defer_response, build_retry_tool_result_query,
    deferred_proxy_exception_failure, deferred_proxy_response_decision,
    is_deferred_user_input_result, normalize_mcp_tool_result, parse_mcp_tool_name,
    ClaudeFollowUpQuery, DeferredMcpProxyResult, DeferredMcpResponseAction, DeferredToolUse,
    TaskTerminalStatus,
};

fn deferred_tool_use(input: Value) -> DeferredToolUse {
    DeferredToolUse {
        id: "tool-1".to_owned(),
        name: "mcp__interactive_wegent-interactive-form-question__interactive_form_question"
            .to_owned(),
        input,
    }
}

fn waiting_proxy_result(tool_use_id: &str) -> DeferredMcpProxyResult {
    let output_text = concat!(
        r#"{"__deferred_user_input__": true, "#,
        r#""success": true, "status": "waiting_for_user_response"}"#
    )
    .to_owned();

    DeferredMcpProxyResult {
        tool_use_id: tool_use_id.to_owned(),
        tool_name: "mcp__interactive_wegent-interactive-form-question__interactive_form_question"
            .to_owned(),
        server_name: "interactive_wegent-interactive-form-question".to_owned(),
        tool_result: json!({
            "content": [{"type": "text", "text": output_text}]
        }),
        output_text,
        is_error: false,
        is_deferred_user_input: true,
    }
}

fn invalid_form_proxy_result(tool_use_id: &str) -> DeferredMcpProxyResult {
    DeferredMcpProxyResult {
        tool_use_id: tool_use_id.to_owned(),
        tool_name: "mcp__interactive_wegent-interactive-form-question__interactive_form_question"
            .to_owned(),
        server_name: "interactive_wegent-interactive-form-question".to_owned(),
        tool_result: json!({
            "content": [{"type": "text", "text": r#"{"error": "question field required"}"#}]
        }),
        output_text: r#"{"error": "question field required"}"#.to_owned(),
        is_error: false,
        is_deferred_user_input: false,
    }
}

#[test]
fn parses_mcp_tool_name_from_claude_code_name() {
    let parsed = parse_mcp_tool_name(
        "mcp__interactive_wegent-interactive-form-question__interactive_form_question",
    )
    .expect("Claude Code MCP tool name should parse");

    assert_eq!(
        parsed.server_name,
        "interactive_wegent-interactive-form-question"
    );
    assert_eq!(parsed.tool_name, "interactive_form_question");
}

#[test]
fn pre_tool_use_defer_response_uses_sdk_permission_decision() {
    assert_eq!(
        build_pre_tool_use_defer_response(),
        json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "defer"
            }
        })
    );
}

#[test]
fn detects_deferred_user_input_result_from_mcp_text_content() {
    let result = json!({
        "content": [
            {
                "type": "text",
                "text": r#"{"__deferred_user_input__": true, "success": true, "status": "waiting_for_user_response"}"#
            }
        ]
    });

    assert!(is_deferred_user_input_result(&result));
}

#[test]
fn ignores_deferred_marker_without_success_waiting_status() {
    let result = json!({
        "content": [
            {
                "type": "text",
                "text": r#"{"__deferred_user_input__": true, "success": false, "status": "failed"}"#
            }
        ]
    });

    assert!(!is_deferred_user_input_result(&result));
}

#[test]
fn proxy_request_targets_configured_mcp_server_and_normalizes_result() {
    let request = build_deferred_mcp_proxy_request(
        &deferred_tool_use(json!({"questions": [{"id": "q", "question": "Q?"}]})),
        &json!({
            "interactive_wegent-interactive-form-question": {
                "type": "http",
                "url": "http://backend/mcp/interactive-form-question/sse",
                "headers": {"Authorization": "Bearer task-token"},
                "timeout": 12
            }
        }),
    )
    .expect("configured MCP server should produce a proxy request");

    assert_eq!(
        request.server_name,
        "interactive_wegent-interactive-form-question"
    );
    assert_eq!(request.tool_name, "interactive_form_question");
    assert_eq!(
        request.server_url,
        "http://backend/mcp/interactive-form-question/sse"
    );
    assert_eq!(
        request.headers["Authorization"],
        Value::String("Bearer task-token".to_owned())
    );
    assert_eq!(request.timeout_seconds, Some(12));
    assert_eq!(
        request.arguments,
        json!({"questions": [{"id": "q", "question": "Q?"}]})
    );

    let normalized = normalize_mcp_tool_result(
        &request,
        json!({
            "content": [{"type": "text", "text": r#"{"__deferred_user_input__": true, "success": true, "status": "waiting_for_user_response"}"#}],
            "isError": false
        }),
    );

    assert!(normalized.is_deferred_user_input);
    assert_eq!(normalized.tool_result["content"][0]["type"], "text");
}

#[test]
fn proxy_request_resolves_nested_mcp_servers_and_normalized_server_names() {
    let request = build_deferred_mcp_proxy_request(
        &deferred_tool_use(json!({"questions": [{"id": "q", "question": "Q?"}]})),
        &json!({
            "mcpServers": {
                "interactive-wegent-interactive-form-question": {
                    "type": "http",
                    "url": "http://backend/mcp/interactive-form-question/sse"
                }
            }
        }),
    )
    .expect("normalized MCP server name should resolve");

    assert_eq!(
        request.server_url,
        "http://backend/mcp/interactive-form-question/sse"
    );
}

#[test]
fn response_decision_completes_when_interactive_form_waits_for_user() {
    let decision = deferred_proxy_response_decision(
        &waiting_proxy_result("tool-1"),
        "tool_deferred",
        json!({"input_tokens": 1}),
        0,
        2,
    );

    assert_eq!(
        decision.action,
        DeferredMcpResponseAction::CompleteWaitingForUser
    );
    assert_eq!(decision.status, TaskTerminalStatus::Completed);
    assert_eq!(decision.done.as_ref().unwrap().content, "");
    assert_eq!(decision.done.as_ref().unwrap().stop_reason, "tool_deferred");
    assert!(decision.done.as_ref().unwrap().silent_exit);
    assert_eq!(
        decision
            .done
            .as_ref()
            .unwrap()
            .silent_exit_reason
            .as_deref(),
        Some("waiting_for_user_input")
    );
    assert_eq!(decision.tool_start.as_ref().unwrap().call_id, "tool-1");
    assert_eq!(
        decision.tool_done.as_ref().unwrap().server_label,
        "interactive_wegent-interactive-form-question"
    );
}

#[test]
fn response_decision_completes_when_unavailable_form_waits_for_user() {
    let decision = deferred_proxy_response_decision(
        &waiting_proxy_result("tool-2"),
        "tool_deferred_unavailable",
        json!({"input_tokens": 1}),
        0,
        2,
    );

    assert_eq!(
        decision.action,
        DeferredMcpResponseAction::CompleteWaitingForUser
    );
    assert_eq!(decision.status, TaskTerminalStatus::Completed);
    assert_eq!(
        decision.done.as_ref().unwrap().stop_reason,
        "tool_deferred_unavailable"
    );
    assert_eq!(
        decision
            .done
            .as_ref()
            .unwrap()
            .silent_exit_reason
            .as_deref(),
        Some("waiting_for_user_input")
    );
}

#[test]
fn response_decision_retries_invalid_form_without_leaking_input() {
    let result = DeferredMcpProxyResult {
        tool_use_id: "tool-3".to_owned(),
        output_text: r#"{"error": "question field required"}"#.to_owned(),
        ..invalid_form_proxy_result("tool-3")
    };
    let decision = deferred_proxy_response_decision(&result, "tool_deferred", json!({}), 0, 2);

    assert_eq!(decision.action, DeferredMcpResponseAction::Retry);
    assert!(decision.retry_query.is_some());

    let retry_query = build_retry_tool_result_query(
        "tool-3",
        &json!({
            "questions": [{"id": "q1", "input_type": "single_choice"}],
            "api_key": "super-secret"
        }),
        &result.output_text,
    );
    let tool_result = &retry_query["message"]["content"][0];
    assert_eq!(tool_result["type"], "tool_result");
    assert_eq!(tool_result["tool_use_id"], "tool-3");
    assert_eq!(tool_result["is_error"], true);

    let retry_text = tool_result["content"][0]["text"].as_str().unwrap();
    assert!(retry_text.contains("Call interactive_form_question again"));
    assert!(!retry_text.contains("invalid_arguments"));
    assert!(!retry_text.contains("super-secret"));
}

#[test]
fn response_decision_reports_simple_error_after_deferred_retries() {
    let decision = deferred_proxy_response_decision(
        &invalid_form_proxy_result("tool-4"),
        "tool_deferred",
        json!({}),
        2,
        2,
    );

    assert_eq!(decision.action, DeferredMcpResponseAction::Fail);
    assert_eq!(decision.status, TaskTerminalStatus::Failed);
    assert_eq!(
        decision.user_error.as_deref(),
        Some("模型给出的表单格式不对")
    );
    assert!(decision.retry_query.is_none());
}

#[test]
fn response_decision_hides_proxy_exception_details() {
    let failure = deferred_proxy_exception_failure(
        &deferred_tool_use(json!({"questions": [{"id": "q1", "question": "Question?"}]})),
        "Deferred MCP proxy failed internally",
    );

    assert_eq!(failure.status, TaskTerminalStatus::Failed);
    assert_eq!(failure.user_error.as_deref(), Some("交互式表单生成失败"));
    assert_eq!(
        failure.tool_done.as_ref().unwrap().output.as_deref(),
        Some("交互式表单生成失败")
    );
    assert_eq!(
        failure.tool_done.as_ref().unwrap().error.as_deref(),
        Some("交互式表单生成失败")
    );
    assert_eq!(
        failure.internal_error.as_deref(),
        Some("Deferred MCP proxy failed internally")
    );
}

#[test]
fn interactive_form_answer_query_sends_tool_result_for_deferred_call() {
    let answer = json!({
        "type": "interactive_form_question",
        "tool_use_id": "tool-1",
        "answers": {"target": ["readme"], "scope": "all"},
        "success": true,
        "status": "answered",
        "message": "User answered the form."
    });

    let query = build_interactive_form_answer_query(&answer)
        .expect("interactive form answer should build a tool result query");

    assert_eq!(query["type"], "user");
    assert_eq!(query["message"]["role"], "user");
    let tool_result = &query["message"]["content"][0];
    assert_eq!(tool_result["type"], "tool_result");
    assert_eq!(tool_result["tool_use_id"], "tool-1");
    assert_eq!(tool_result["is_error"], false);

    let text = tool_result["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("\"type\": \"interactive_form_question\""));
    assert!(text.contains("\"tool_use_id\": \"tool-1\""));
    assert!(text.contains("\"target\": ["));
    assert_eq!(query["parent_tool_use_id"], Value::Null);
}

#[test]
fn interactive_form_answer_payload_ignores_unknown_fields() {
    let payload = build_interactive_form_answer_payload(&json!({
        "type": "interactive_form_question",
        "tool_use_id": "tool-1",
        "task_id": 10,
        "subtask_id": 20,
        "answers": {"scope": "all"},
        "success": true,
        "status": "answered",
        "message": "User answered the form.",
        "auth_token": "secret-token",
        "backend_url": "https://backend.example",
        "workspace": {"repository": {"gitUrl": "https://example/repo.git"}}
    }));

    assert_eq!(
        payload,
        json!({
            "type": "interactive_form_question",
            "tool_use_id": "tool-1",
            "task_id": 10,
            "subtask_id": 20,
            "answers": {"scope": "all"},
            "success": true,
            "status": "answered",
            "message": "User answered the form."
        })
    );
}

#[test]
fn interactive_form_answer_payload_ignores_ask_id() {
    let payload = build_interactive_form_answer_payload(&json!({
        "type": "interactive_form_question",
        "ask_id": "ask_6683514",
        "tool_use_id": "tool-1",
        "answers": {"target": "readme"}
    }));

    assert_eq!(
        payload,
        json!({
            "type": "interactive_form_question",
            "tool_use_id": "tool-1",
            "answers": {"target": "readme"}
        })
    );
}

#[test]
fn agent_sends_interactive_form_answer_as_tool_result() {
    let plan = build_interactive_form_resume_plan(
        "This should not be sent as the follow-up prompt",
        Some("/tmp/workspace"),
        Some(&json!({
            "type": "interactive_form_question",
            "tool_use_id": "tool-1",
            "answers": {"scope": "all"},
            "success": true,
            "status": "answered",
            "message": "User answered the form."
        })),
        Some("session-1"),
    )
    .expect("interactive answer should create a resume plan");

    let ClaudeFollowUpQuery::ToolResult(query) = plan.query else {
        panic!("interactive answer should be sent as a tool result");
    };
    let tool_result = &query["message"]["content"][0];
    assert_eq!(tool_result["type"], "tool_result");
    assert_eq!(tool_result["tool_use_id"], "tool-1");
    assert!(!tool_result["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("This should not be sent"));
    assert_eq!(plan.session_id.as_deref(), Some("session-1"));
}

#[test]
fn agent_drains_answered_form_defer_before_tool_result() {
    let plan = build_interactive_form_resume_plan(
        "User answer",
        None,
        Some(&json!({
            "type": "interactive_form_question",
            "tool_use_id": "tool-1",
            "answers": {"scope": "all"}
        })),
        Some("old-claude-session"),
    )
    .expect("interactive answer should create a resume plan");

    assert!(plan.drain_stale_defer_before_query);
    assert!(matches!(plan.query, ClaudeFollowUpQuery::ToolResult(_)));
}

#[test]
fn agent_preserves_resume_when_answering_interactive_form() {
    let plan = build_interactive_form_resume_plan(
        "User answer",
        None,
        Some(&json!({
            "type": "interactive_form_question",
            "tool_use_id": "tool-1",
            "answers": {"scope": "all"}
        })),
        Some("old-claude-session"),
    )
    .expect("interactive answer should create a resume plan");

    assert_eq!(plan.session_id.as_deref(), Some("old-claude-session"));
}

#[test]
fn agent_keeps_normal_follow_up_on_prompt_channel() {
    let plan = build_interactive_form_resume_plan(
        "Continue with the implementation",
        Some("/tmp/project"),
        None,
        Some("session-1"),
    )
    .expect("normal follow-up should create a prompt plan");

    let ClaudeFollowUpQuery::Prompt(prompt) = plan.query else {
        panic!("normal follow-up should stay on the prompt channel");
    };
    assert!(prompt.contains("Continue with the implementation"));
    assert!(prompt.contains("Current working directory:"));
    assert_eq!(plan.session_id.as_deref(), Some("session-1"));
    assert!(!plan.drain_stale_defer_before_query);
}

#[test]
fn claude_code_executor_implements_interactive_form_deferred_proxy() {
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));

    let agent_source = std::fs::read_to_string(repo_root.join("src").join("agents").join("mod.rs"))
        .expect("agent module should be readable");
    let runtime_source = std::fs::read_to_string(
        repo_root
            .join("src")
            .join("agents")
            .join("runtime_capabilities.rs"),
    )
    .expect("runtime capabilities module should be readable");
    let proxy_source = std::fs::read_to_string(
        repo_root
            .join("src")
            .join("agents")
            .join("interactive_mcp.rs"),
    )
    .unwrap_or_default();

    assert!(agent_source.contains("prepare_claude_runtime"));
    assert!(runtime_source.contains("install_deferred_mcp_hook"));
    assert!(proxy_source.contains("proxy_deferred_mcp_tool"));
    assert!(proxy_source.contains("call_streamable_http_mcp"));
}
