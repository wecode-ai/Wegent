//! Background reads reuse Codex's plugin/MCP runtime without starting model turns.
use super::connection_dependencies::installed_dependency;
use crate::{agents::CodexAppServerClient, local::app_ipc::AppIpcError};
use serde_json::{json, Value};
use std::{future::Future, pin::Pin, time::Duration};

type Reply = Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send>>;

trait McpRpc: Send + Sync {
    fn request(&self, method: &'static str, params: Value) -> Reply;
}

impl McpRpc for CodexAppServerClient {
    fn request(&self, method: &'static str, params: Value) -> Reply {
        let client = self.clone();
        Box::pin(async move {
            client.request_connection_mcp(method, params).await.map_err(|error| {
                if error == "connection_interaction_required" {
                    failure("connection_interaction_required", "Authorize this plugin interactively before using the background connection")
                } else {
                    // App-server errors can contain endpoint/configuration details. Do not log them.
                    failure("connection_mcp_failed", format!("Codex MCP request failed: {method}"))
                }
            })
        })
    }
}

fn failure(code: &str, message: impl Into<String>) -> AppIpcError {
    AppIpcError::new(code, message)
}

pub(super) async fn request(
    client: CodexAppServerClient,
    payload: Value,
) -> Result<Value, AppIpcError> {
    validate_request(&payload)?;
    // Keep ownership through IPC cancellation so every created thread is released.
    owned_request(client, payload).await
}

async fn owned_request(
    client: impl McpRpc + 'static,
    payload: Value,
) -> Result<Value, AppIpcError> {
    tokio::spawn(async move {
        let started = std::time::Instant::now();
        let result = execute(&client, payload.clone()).await;
        crate::logging::log_executor_event(
            "connection MCP operation finished",
            &[
                (
                    "provider_id",
                    payload["providerId"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                ),
                (
                    "operation",
                    payload["operation"].as_str().unwrap_or_default().to_owned(),
                ),
                (
                    "code",
                    result
                        .as_ref()
                        .err()
                        .map(|error| error.code.clone())
                        .unwrap_or_else(|| "ok".to_owned()),
                ),
                ("elapsed_ms", started.elapsed().as_millis().to_string()),
            ],
        );
        result
    })
    .await
    .map_err(|_| failure("connection_mcp_failed", "Background MCP worker failed"))?
}

fn validate_request(payload: &Value) -> Result<(), AppIpcError> {
    let string = |value: &Value| {
        value
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 512)
    };
    if !string(&payload["source"]["marketplaceId"])
        || !string(&payload["source"]["pluginId"])
        || !matches!(
            payload["operation"].as_str(),
            Some("listTools" | "callTool")
        )
        || (payload["operation"] == "callTool"
            && (!string(&payload["server"])
                || !string(&payload["tool"])
                || !payload["arguments"].is_object()))
    {
        return Err(failure("bad_request", "Invalid background MCP request"));
    }
    Ok(())
}

async fn execute(client: &impl McpRpc, payload: Value) -> Result<Value, AppIpcError> {
    let installed = client
        .request("plugin/installed", json!({"cwds":[]}))
        .await?;
    let target = installed_dependency(&installed, &payload)?;
    let detail = client.request("plugin/read", json!({
        "marketplacePath": target["marketplacePath"],
        "remoteMarketplaceName": if target["marketplacePath"].is_string() { Value::Null } else { payload["source"]["marketplaceId"].clone() },
        "pluginName":target["name"],
    })).await?;
    validate_detail(&detail, &payload)?;
    let started = client
        .request(
            "thread/start",
            json!({
                "ephemeral":true,
                "cwd":crate::agents::wework_codex_home(),
                "approvalPolicy":"never",
                "sandbox":"read-only",
                "baseInstructions":"Background MCP transport. Never start a model turn.",
                "config":{"project_doc_max_bytes":0},
            }),
        )
        .await?;
    let id = started["thread"]["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            failure(
                "connection_mcp_failed",
                "Codex did not return a background thread ID",
            )
        })?;
    let result = tokio::time::timeout(
        Duration::from_secs(45),
        run_operation(client, id, &payload, &detail),
    )
    .await
    .unwrap_or_else(|_| {
        Err(failure(
            "connection_mcp_timeout",
            "Background MCP request timed out",
        ))
    });
    let cleanup = client
        .request("thread/unsubscribe", json!({"threadId":id}))
        .await;
    // Never retry a tool call after an unknown outcome or a cleanup failure.
    match result {
        Ok(value) => cleanup.map(|_| value),
        Err(error) => Err(error),
    }
}

fn validate_detail(detail: &Value, payload: &Value) -> Result<(), AppIpcError> {
    if detail["plugin"]["summary"]["id"] != payload["source"]["pluginId"]
        || detail["plugin"]["marketplaceName"] != payload["source"]["marketplaceId"]
    {
        return Err(failure(
            "connection_dependency_denied",
            "Codex plugin detail identity does not match",
        ));
    }
    Ok(())
}

async fn discover_tools(
    client: &impl McpRpc,
    id: &str,
    payload: &Value,
    detail: &Value,
) -> Result<Vec<Value>, AppIpcError> {
    let mut tools = Vec::new();
    let mut cursor = Value::Null;
    let mut cursors = std::collections::HashSet::new();
    loop {
        let page = client
            .request(
                "mcpServerStatus/list",
                json!({
                    "threadId":id,"detail":"toolsAndAuthOnly","limit":100,"cursor":cursor,
                }),
            )
            .await?;
        for server in page["data"]
            .as_array()
            .ok_or_else(|| failure("connection_mcp_failed", "Invalid MCP catalog"))?
        {
            let owned_server = server["pluginId"] == payload["source"]["pluginId"];
            let dependency_server = owned_server
                || (server["name"] == "codex_apps"
                    && server["pluginId"].is_null()
                    && detail["plugin"]["apps"]
                        .as_array()
                        .is_some_and(|apps| !apps.is_empty()));
            if dependency_server
                && (server["runtimeStatus"] == "authenticationRequired"
                    || server["authStatus"] == "notLoggedIn")
            {
                return Err(failure(
                    "connection_auth_required",
                    "The Codex MCP server requires authorization",
                ));
            }
            for tool in server["tools"]
                .as_object()
                .into_iter()
                .flat_map(|tools| tools.values())
            {
                if tool_belongs_to_dependency(server, tool, payload, detail)
                    && read_only(server, tool, payload)
                {
                    tools.push(json!({"server":server["name"],"name":tool["name"],
                        "description":tool["description"],"inputSchema":tool["inputSchema"],
                        "annotations":tool["annotations"]}));
                }
            }
            if dependency_server && server["toolsError"].is_string() {
                return Err(failure(
                    "connection_mcp_catalog_failed",
                    "Codex could not discover dependency tools",
                ));
            }
        }
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
        if !cursor.is_string() || !cursors.insert(cursor.to_string()) || cursors.len() >= 100 {
            return Err(failure(
                "connection_mcp_catalog_failed",
                "Invalid MCP pagination cursor",
            ));
        }
    }
    Ok(tools)
}

async fn run_operation(
    client: &impl McpRpc,
    id: &str,
    payload: &Value,
    detail: &Value,
) -> Result<Value, AppIpcError> {
    let tools = discover_tools(client, id, payload, detail).await?;
    if payload["operation"] == "listTools" {
        return Ok(json!({"tools":tools}));
    }
    if tools
        .iter()
        .filter(|tool| tool["server"] == payload["server"] && tool["name"] == payload["tool"])
        .count()
        != 1
    {
        return Err(failure(
            "connection_tool_denied",
            "Tool is not a unique read-only tool of this dependency",
        ));
    }
    // Recheck the shared dependency after discovery and before the external operation.
    installed_dependency(
        &client
            .request("plugin/installed", json!({"cwds":[]}))
            .await?,
        payload,
    )?;
    client.request("mcpServer/tool/call", json!({
        "threadId":id,"server":payload["server"],"tool":payload["tool"],"arguments":payload["arguments"],
    })).await
}

fn tool_belongs_to_dependency(
    server: &Value,
    tool: &Value,
    payload: &Value,
    detail: &Value,
) -> bool {
    if server["pluginId"] == payload["source"]["pluginId"] {
        return true;
    }
    // Hosted apps share a server. Only its trusted connector metadata establishes ownership.
    server["name"] == "codex_apps"
        && server["pluginId"].is_null()
        && tool["_meta"]["connector_id"].as_str().is_some_and(|id| {
            detail["plugin"]["apps"]
                .as_array()
                .is_some_and(|apps| apps.iter().any(|app| app["id"].as_str() == Some(id)))
        })
}

fn read_only(server: &Value, tool: &Value, payload: &Value) -> bool {
    let declared = payload["readTools"].as_array().is_some_and(|tools| {
        tools
            .iter()
            .any(|item| item["server"] == server["name"] && item["tool"] == tool["name"])
    });
    (tool["annotations"]["readOnlyHint"] == true || declared)
        && tool["annotations"]["readOnlyHint"] != false
        && tool["annotations"]["destructiveHint"] != true
        && tool["name"].as_str().is_some_and(|name| !name.is_empty())
}

#[cfg(test)]
#[path = "connection_mcp_tests.rs"]
mod tests;
