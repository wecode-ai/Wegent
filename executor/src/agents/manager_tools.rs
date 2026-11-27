// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use crate::protocol::ExecutionRequest;
use crate::task_runtime::{mcp, mcp_http, TaskRuntime};
use serde_json::{json, Value};
use std::{collections::BTreeMap, future::Future, pin::Pin};

pub(crate) struct ManagerTools {
    runtime: TaskRuntime,
    context: mcp::SpaceMcpRequestContext,
    tools: BTreeMap<String, Value>,
}

impl std::fmt::Debug for ManagerTools {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ManagerTools").finish_non_exhaustive()
    }
}

impl ManagerTools {
    pub(crate) fn new(request: &ExecutionRequest) -> Result<Self, String> {
        let runtime = TaskRuntime::from_env().map_err(|error| error.to_string())?;
        let mut context = mcp::project_space_request_context(request)?;
        mcp_http::bind_runtime_services(&mut context);
        let tools = mcp::visible_tools(&runtime, &context)
            .into_iter()
            .map(|tool| {
                (
                    tool["name"]
                        .as_str()
                        .expect("static MCP tool name")
                        .to_owned(),
                    tool,
                )
            })
            .collect();
        Ok(Self {
            runtime,
            context,
            tools,
        })
    }

    pub(crate) fn specs(&self) -> Value {
        let tools = self
            .tools
            .values()
            .map(|tool| {
                json!({
                    "type":"function", "name":tool["name"], "description":tool["description"],
                    "inputSchema":tool["inputSchema"]
                })
            })
            .collect::<Vec<_>>();
        json!([{"type":"namespace","name":mcp::SPACE_MCP_SERVER_NAME,
            "description":"Project and Issue operations for the current manager", "tools":tools}])
    }
}

pub(crate) async fn respond(
    manager: Option<&ManagerTools>,
    params: &Value,
    thread: &str,
    turn: Option<&str>,
    cancelled: bool,
) -> Value {
    let manager = manager.filter(|_| {
        !cancelled
            && params["threadId"] == thread
            && turn.is_some_and(|id| params["turnId"] == id)
            && params["namespace"] == mcp::SPACE_MCP_SERVER_NAME
    });
    let name = params["tool"].as_str().unwrap_or_default();
    let Some(manager) = manager.filter(|manager| manager.tools.contains_key(name)) else {
        return json!({"success":false,"contentItems":[{"type":"inputText","text":"Manager tool unavailable for this caller"}]});
    };
    let result = mcp::call_tool_with_context(
        &manager.runtime,
        name,
        params["arguments"].clone(),
        &manager.context,
    )
    .await;
    json!({"success":result["isError"] != true,"contentItems":[{"type":"inputText","text":result["content"].to_string()}]})
}

impl wegent_claude_harness::process::ManagerOperations for ManagerTools {
    fn schema(&self) -> Value {
        let mut names = self.tools.keys().cloned().collect::<Vec<_>>();
        names.push("finish".into());
        json!({"type":"object","description":"Select an authorized project operation with its arguments. Select finish to return a final reply after receiving the host receipt.",
            "properties":{"operation":{"type":"string","enum":names},"arguments":{"type":"object","description":self.tools.values().map(|t|format!("{} {} {}", t["name"],t["description"],t["inputSchema"])).collect::<Vec<_>>().join("\n")},
                "message":{"type":"string","description":"Final reply when operation is finish"}},
            "required":["operation","arguments","message"]})
    }
    fn call<'a>(
        &'a self,
        name: &'a str,
        arguments: Value,
    ) -> Pin<Box<dyn Future<Output = Value> + Send + 'a>> {
        Box::pin(async move {
            if !self.tools.contains_key(name) {
                return json!({"isError":true,"content":"Unavailable manager operation"});
            }
            mcp::call_tool_with_context(&self.runtime, name, arguments, &self.context).await
        })
    }
}

pub(super) fn shell_request(request: &ExecutionRequest) -> ExecutionRequest {
    let mut member = request.clone();
    member.auth_token = None;
    member.runtime_auth_token = None;
    member.skill_identity_token = None;
    member
}

pub(super) fn check_shell_values<'a>(
    request: &ExecutionRequest,
    values: impl IntoIterator<Item = &'a str>,
) -> Result<(), String> {
    let fallback = std::env::var("WEGENT_AUTH_TOKEN").ok();
    let space = std::env::var("WEWORK_SPACE_AUTH_TOKEN").ok();
    let tokens = [
        request.auth_token.as_deref(),
        request.runtime_auth_token.as_deref(),
        request.skill_identity_token.as_deref(),
        fallback.as_deref(),
        space.as_deref(),
    ];
    if values.into_iter().any(|value| {
        tokens
            .iter()
            .flatten()
            .any(|token| !token.is_empty() && value.contains(*token))
    }) {
        return Err("A Bot transport would expose a host-owned manager credential".into());
    }
    Ok(())
}
