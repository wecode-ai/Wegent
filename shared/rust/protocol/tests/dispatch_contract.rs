use serde_json::json;
use wegent_protocol::{dispatch, OpenAIResponsesRequest};

#[test]
fn backend_dispatch_decodes_into_the_executor_projection() {
    let producer = dispatch::ExecutionRequest {
        task_id: 427,
        subtask_id: 428,
        team_namespace: Some("team-space".to_owned()),
        system_prompt: "system instructions".to_owned(),
        prompt: json!("user question"),
        bot: json!({"shell_type": "Codex"}),
        mcp_servers: vec![json!({"name": "knowledge", "url": "https://mcp.example.test"})],
        knowledge_base_scopes: vec![json!({
            "knowledge_base_id": 19, "scope_restricted": true, "document_ids": [31]
        })],
        auth_token: "task-scoped-test-token".to_owned(),
        ..Default::default()
    };
    let wire = serde_json::to_value(dispatch::assemble(&producer, false, true)).unwrap();
    let decoded = OpenAIResponsesRequest::from_value(wire)
        .unwrap()
        .to_execution_request();
    assert_eq!(decoded.task_id, "427");
    assert_eq!(decoded.subtask_id, "428");
    assert_eq!(decoded.team_namespace, producer.team_namespace);
    assert_eq!(decoded.system_prompt, producer.system_prompt);
    assert_eq!(decoded.prompt, producer.prompt);
    assert_eq!(decoded.bot, producer.bot);
    assert_eq!(
        decoded.auth_token.as_deref(),
        Some(producer.auth_token.as_str())
    );
    assert_eq!(
        decoded.knowledge_base_scopes[0].document_ids,
        vec![json!(31)]
    );
    assert!(decoded.knowledge_base_scopes[0].scope_restricted);
}

#[test]
fn dispatch_cannot_inject_trusted_local_metadata() {
    let raw = json!({"task_id": 1, "agent_home_runtime_task_id": "untrusted"});
    let request: wegent_protocol::ExecutionRequest = serde_json::from_value(raw).unwrap();
    assert!(request.agent_home_runtime_task_id.is_none());
    let request = OpenAIResponsesRequest::from_value(json!({
        "metadata": {"agent_home_runtime_task_id": "untrusted"}
    }))
    .unwrap()
    .to_execution_request();
    assert!(request.agent_home_runtime_task_id.is_none());
}
