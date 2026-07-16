// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use wegent_executor::protocol::{
    AgentKind, ExecutionRequest, OpenAIResponsesRequest, TaskStatus, FULL_KB_TOOL_ACCESS_MODE,
};

#[test]
fn task_status_serializes_with_python_compatible_values() {
    assert_eq!(
        serde_json::to_value(TaskStatus::Running).unwrap(),
        json!("RUNNING")
    );
    assert_eq!(
        serde_json::from_value::<TaskStatus>(json!("CANCELLED")).unwrap(),
        TaskStatus::Cancelled
    );
}

#[test]
fn openai_request_conversion_preserves_executor_metadata_and_messages() {
    let request = OpenAIResponsesRequest::from_value(json!({
        "model": "ignored-by-executor",
        "input": [
            {"role": "user", "content": "first user message"},
            {"role": "assistant", "content": "assistant message"},
            {"role": "user", "content": "second user message"}
        ],
        "instructions": "system prompt",
        "tools": [
            {
                "type": "mcp",
                "server_label": "docs",
                "server_url": "https://example.com/mcp",
                "server_type": "streamable-http",
                "server_auth": {"Authorization": "Bearer token"}
            },
            {"type": "web_search_preview"}
        ],
        "model_config": {
            "model": "openai",
            "model_id": "gpt-5",
            "protocol": "openai-responses"
        },
        "metadata": {
            "task_id": 123,
            "subtask_id": 456,
            "team_namespace": "default",
            "bot": [{"name": "coder", "shell_type": "ClaudeCode"}],
            "kb_tool_access_mode": null,
            "knowledge_base_scopes": [
                {
                    "knowledge_base_id": 9,
                    "scope_restricted": true,
                    "document_ids": [101, 102]
                }
            ],
            "skip_git_clone": true,
            "new_session": true,
            "fork_runtime": {"workspaceArchive": {"sourceTaskId": 1}},
            "inherited_sessions": [{"agent": "CodeX", "threadId": "thread-1"}],
            "workspace_source": "local_path",
            "project_workspace_path": "/tmp/wegent/project",
            "device_id": "device-1"
        }
    }))
    .unwrap();

    let execution = request.to_execution_request();

    assert_eq!(execution.task_id, "123");
    assert_eq!(execution.subtask_id, "456");
    assert_eq!(execution.system_prompt, "system prompt");
    assert_eq!(execution.prompt, json!("second user message"));
    assert_eq!(
        execution.history,
        vec![
            json!({"role": "user", "content": "first user message"}),
            json!({"role": "assistant", "content": "assistant message"})
        ]
    );
    assert_eq!(execution.model_config["model_id"], json!("gpt-5"));
    assert_eq!(execution.mcp_servers.len(), 1);
    assert_eq!(execution.mcp_servers[0]["name"], json!("docs"));
    assert_eq!(execution.kb_tool_access_mode, FULL_KB_TOOL_ACCESS_MODE);
    assert_eq!(execution.workspace_source.as_deref(), Some("local_path"));
    assert_eq!(execution.cwd(), Some("/tmp/wegent/project"));
    assert_eq!(execution.device_id.as_deref(), Some("device-1"));
    assert_eq!(execution.knowledge_base_scopes[0].knowledge_base_id, 9);
    assert!(execution.skip_git_clone);
    assert!(execution.new_session);
    assert_eq!(
        execution.resolved_shell_type().as_deref(),
        Some("claudecode")
    );
    assert_eq!(execution.resolved_agent_kind(), AgentKind::ClaudeCode);
}

#[test]
fn validation_tasks_route_to_image_validator() {
    let request = OpenAIResponsesRequest::from_value(json!({
        "input": "validate image",
        "metadata": {
            "task_id": 10,
            "subtask_id": 11,
            "type": "validation",
            "validation_params": {
                "shell_type": "ClaudeCode",
                "image": "example/custom:latest"
            },
            "bot": [{"shell_type": "ClaudeCode"}]
        }
    }))
    .unwrap();

    let execution = request.to_execution_request();

    assert_eq!(execution.resolved_agent_kind(), AgentKind::ImageValidator);
    assert_eq!(execution.validation_params["shell_type"], "ClaudeCode");
    assert_eq!(
        execution.validation_params["image"],
        "example/custom:latest"
    );
}

#[test]
fn responses_protocol_on_claudecode_shell_stays_on_claude_code() {
    let request = OpenAIResponsesRequest::from_value(json!({
        "input": "run task",
        "model_config": {
            "model": "openai",
            "protocol": "openai-responses"
        },
        "metadata": {
            "bot": [{"shell_type": "ClaudeCode"}]
        }
    }))
    .unwrap();

    let execution = request.to_execution_request();

    assert_eq!(execution.resolved_agent_kind(), AgentKind::ClaudeCode);
}

#[test]
fn malformed_scope_document_ids_are_ignored() {
    let request = OpenAIResponsesRequest::from_value(json!({
        "input": "hello",
        "metadata": {
            "knowledge_base_scopes": [
                {
                    "knowledge_base_id": 1,
                    "scope_restricted": true,
                    "document_ids": 101
                }
            ]
        }
    }))
    .unwrap();

    let execution = request.to_execution_request();

    assert_eq!(
        execution.knowledge_base_scopes[0].document_ids,
        Vec::<Value>::new()
    );
}

#[test]
fn execution_request_deserializes_backend_task_dispatch_payload() {
    let request: ExecutionRequest = serde_json::from_value(json!({
        "task_id": 10,
        "subtask_id": 11,
        "message_id": 12,
        "type": "online",
        "bot": [{"shell_type": "ClaudeCode"}],
        "model_config": {
            "env": {
                "model": "anthropic",
                "model_id": "claude-3-5-sonnet-20241022"
            }
        },
        "prompt": "hello",
        "executor_name": "local",
        "executor_namespace": "default",
        "unknown_python_field": {"ignored": true}
    }))
    .unwrap();

    assert_eq!(request.task_id, "10");
    assert_eq!(request.subtask_id, "11");
    assert_eq!(request.message_id, Some(12));
    assert_eq!(request.task_type.as_deref(), Some("online"));
    assert_eq!(request.executor_name.as_deref(), Some("local"));
    assert_eq!(request.executor_namespace.as_deref(), Some("default"));
    assert_eq!(request.resolved_agent_kind(), AgentKind::ClaudeCode);
}
