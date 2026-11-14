// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET`/`POST /api/mcp/connectors/sse` — the dynamic connector MCP surface.
//!
//! Mirrors `app/mcp_server/connectors_app.py` plus the shared
//! `app/mcp_server/server.py` mount for `_CONNECTORS_MCP_SPEC`. The server is a
//! low-level `Server("wegent-connectors-mcp")` with only `ping`, `tools/list`,
//! and `tools/call` handlers, so `initialize` advertises just the `tools`
//! capability and the prompt/resource listings answer `Method not found`.
//!
//! Every listing and call resolves the calling user's visible apps, the
//! administrator's `toolAllowlist`, and that user's OAuth credentials through
//! the connector runtime; exposing each upstream directly would bypass the
//! allowlist.

use std::sync::Arc;

use brz_http_server::{Response, StatusCode};
use serde_json::{Value, json};

use crate::apps_installed::db::{self, UserRow};
use crate::apps_installed::http_tools;
use crate::apps_installed::mcp;
use crate::apps_installed::service::{self, ConnectorApp, SessionError};
use crate::apps_installed::{connection, refresh};
use crate::state::AppState;
use crate::task_token;

use super::protocol::{self, InboundMessage, RpcRequest};
use super::transport;

/// `build_connector_mcp_server`'s `Server` name.
const SERVER_NAME: &str = "wegent-connectors-mcp";
/// `GET /api/mcp/connectors/sse`: open the server-to-client SSE stream.
#[brz_http_server::get("/api/mcp/connectors/sse", access = public)]
async fn connectors_sse_get(
    #[header("accept")] accept: Option<&str>,
    #[header("mcp-protocol-version")] protocol_version: Option<&str>,
) -> Response {
    if !transport::accepts_sse(accept) {
        return transport::json_response(
            StatusCode::NOT_ACCEPTABLE,
            protocol::server_error_body(
                protocol::INVALID_REQUEST,
                "Not Acceptable: Client must accept text/event-stream",
            ),
        );
    }
    if !protocol::protocol_version_supported(protocol_version) {
        return transport::unsupported_protocol_version(protocol_version);
    }
    transport::sse_stream_response()
}

/// `POST /api/mcp/connectors/sse`: exchange one JSON-RPC message.
#[brz_http_server::post("/api/mcp/connectors/sse", access = public)]
// The route macro binds each optional protocol and connector header separately.
#[allow(clippy::too_many_arguments)]
async fn connectors_sse_post(
    #[inject(state)] state: &Arc<AppState>,
    #[header("accept")] accept: Option<&str>,
    #[header("content-type")] content_type: Option<&str>,
    #[header("mcp-protocol-version")] protocol_version: Option<&str>,
    #[header("authorization")] authorization: Option<&str>,
    #[header("x-connector-app")] app_scope: Option<&str>,
    #[header("x-connector-loading")] loading: Option<&str>,
    body: &[u8],
) -> Response {
    let message = match transport::prepare_message(accept, content_type, protocol_version, body) {
        Ok(message) => message,
        Err(response) => return response,
    };
    let request = match message {
        InboundMessage::Request(request) => request,
        InboundMessage::NoReply => {
            return transport::empty_json_response(StatusCode::ACCEPTED);
        }
    };
    let app_scope = app_scope.map(str::trim).filter(|slug| !slug.is_empty());
    match request.method.as_str() {
        "tools/list" => {
            let tools = if loading == Some("lazy") {
                list_deferred_tools(state, authorization, app_scope).await
            } else {
                list_tools(state, authorization, app_scope).await
            };
            transport::json_response(
                StatusCode::OK,
                protocol::success_body(&request.id, &json!({ "tools": tools })),
            )
        }
        "tools/call" => {
            let result = if loading == Some("lazy") {
                call_deferred_tool(state, authorization, app_scope, request.params.as_ref()).await
            } else {
                call_tool(state, authorization, app_scope, request.params.as_ref()).await
            };
            transport::json_response(StatusCode::OK, protocol::success_body(&request.id, &result))
        }
        _ => transport::json_response(StatusCode::OK, dispatch(&request)),
    }
}

/// Builds the JSON-RPC reply for one request.
fn dispatch(request: &RpcRequest) -> String {
    match request.method.as_str() {
        "initialize" => protocol::success_body(
            &request.id,
            &transport::initialize_result_with(
                SERVER_NAME,
                request.params.as_ref(),
                connector_capabilities(),
            ),
        ),
        "ping" => protocol::success_body(&request.id, &json!({})),
        _ => protocol::error_body(&request.id, protocol::METHOD_NOT_FOUND, "Method not found"),
    }
}

/// `Server.get_capabilities` for the low-level connector server: only the tool
/// handlers are registered, and `experimental` is always present.
fn connector_capabilities() -> Value {
    json!({
        "experimental": {},
        "tools": { "listChanged": false },
    })
}

async fn list_deferred_tools(
    state: &AppState,
    authorization: Option<&str>,
    app_scope: Option<&str>,
) -> Vec<Value> {
    let Some(user) = resolve_user(state, authorization).await else {
        tracing::warn!("deferred connector MCP listing could not resolve its user");
        return vec![];
    };
    let rows = match db::list_connector_app_kinds(&state.mysql).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "deferred connector MCP catalog read failed");
            return vec![];
        }
    };
    let catalog = rows.iter().map(service::row_to_app).collect::<Vec<_>>();
    deferred_tools_for_user(&state.mysql, &catalog, &user, app_scope).await
}

async fn deferred_tools_for_user<M: brz_mysql::Mysql>(
    mysql: &M,
    catalog: &[ConnectorApp],
    user: &UserRow,
    app_scope: Option<&str>,
) -> Vec<Value> {
    let connected = match service::connected_apps(mysql, catalog, user).await {
        Ok(connected) => connected,
        Err(error) => {
            tracing::error!(%error, "deferred connector MCP grant read failed");
            return vec![];
        }
    };
    let tools: Vec<_> = connected
        .into_iter()
        .filter(|app| {
            app.tool_loading_mode == "lazy" && app_scope.is_none_or(|slug| app.slug == slug)
        })
        .flat_map(crate::connector_runtime::loading::deferred_tools)
        .collect();
    tracing::info!(
        user_id = user.users_id,
        app_scope,
        tool_count = tools.len(),
        "deferred connector MCP listing completed"
    );
    tools
}

async fn call_deferred_tool(
    state: &AppState,
    authorization: Option<&str>,
    app_scope: Option<&str>,
    params: Option<&Value>,
) -> Value {
    use crate::connector_runtime::loading::{CALL_PREFIX, DISCOVER_PREFIX};
    let name = params
        .and_then(|p| p.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let (discover, slug) = if let Some(slug) = name.strip_prefix(DISCOVER_PREFIX) {
        (true, slug)
    } else if let Some(slug) = name.strip_prefix(CALL_PREFIX) {
        (false, slug)
    } else {
        return failure("Invalid deferred connector tool");
    };
    if app_scope.is_some_and(|scope| scope != slug) {
        return failure("Connector tool is outside this app scope");
    }
    if discover {
        let Some(user) = resolve_user(state, authorization).await else {
            return failure("Connector user unavailable");
        };
        let Some(app) = visible_app(state, &user, slug).await else {
            return failure("Connector app not found");
        };
        if let Err(error) = service::session_headers(&state.mysql, &app, &user).await {
            return match error {
                SessionError::AuthorizationRequired => failure(connector_auth_required(slug)),
                other => failure(other.to_string()),
            };
        }
        let mut tools = list_tools(state, authorization, Some(slug)).await;
        add_upstream_names(&mut tools);
        if tools.is_empty() {
            return failure("Connector discovery returned no available tools");
        }
        return json!({"content": [{"type": "text", "text": json!({"tools": tools}).to_string()}], "isError": false});
    }
    let args = params.and_then(|p| p.get("arguments"));
    let Some(tool) = args
        .and_then(|a| a.get("name"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
    else {
        return failure("Connector call requires an upstream tool name");
    };
    let Some(arguments) = args
        .and_then(|a| a.get("arguments"))
        .filter(|a| a.is_object())
    else {
        return failure("Connector call arguments must be an object");
    };
    let params = json!({"name": wegent_protocol::connector::qualify_tool(slug, tool), "arguments": arguments});
    call_tool(state, authorization, Some(slug), Some(&params)).await
}

/// `_active_user`: the caller of the task token, when still active.
async fn resolve_user(state: &AppState, authorization: Option<&str>) -> Option<UserRow> {
    let identity = task_token::verify(&state.auth, authorization)?;
    let user = match db::find_user_by_id(&state.mysql, identity.user_id).await {
        Ok(user) => user?,
        Err(error) => {
            tracing::error!(%error, "connector MCP user lookup failed");
            return None;
        }
    };
    user.users_is_active.then_some(user)
}

/// `get_app_by_slug` + `list_visible_apps` for this caller.
async fn visible_app(state: &AppState, user: &UserRow, slug: &str) -> Option<ConnectorApp> {
    visible_app_for_user(&state.mysql, user, slug).await
}

async fn visible_app_for_user<M: brz_mysql::Mysql>(
    mysql: &M,
    user: &UserRow,
    slug: &str,
) -> Option<ConnectorApp> {
    let rows = db::list_connector_app_kinds(mysql).await.ok()?;
    let apps: Vec<ConnectorApp> = rows.iter().map(service::row_to_app).collect();
    service::list_visible_apps(&apps, user)
        .into_iter()
        .find(|app| app.slug == slug)
        .cloned()
}

/// `ConnectorRuntimeService.list_tools` restricted to this endpoint: per
/// connected app, MCP tools filtered by the allowlist. Apps whose discovery
/// fails are skipped with a warning, like the source's `except HTTPException`.
async fn list_tools(
    state: &AppState,
    authorization: Option<&str>,
    app_scope: Option<&str>,
) -> Vec<Value> {
    let Some(user) = resolve_user(state, authorization).await else {
        return Vec::new();
    };
    let Ok(rows) = db::list_connector_app_kinds(&state.mysql).await else {
        tracing::error!("connector MCP listing could not read the app catalog");
        return Vec::new();
    };
    let apps: Vec<ConnectorApp> = rows.iter().map(service::row_to_app).collect();
    let scoped: Vec<ConnectorApp> = apps
        .into_iter()
        .filter(|app| in_surface(app, app_scope))
        .collect();
    list_tools_for_user(&state.mysql, &scoped, &user).await
}

/// Discover one authenticated user's connector surface. This is the production
/// MCP listing path, kept independent of transport authentication for focused
/// compatibility tests.
pub(crate) async fn list_tools_for_user<M>(
    mysql: &M,
    scoped: &[ConnectorApp],
    user: &UserRow,
) -> Vec<Value>
where
    M: brz_mysql::Mysql,
{
    let Ok(connected) = service::connected_apps(mysql, scoped, user).await else {
        tracing::error!("connector MCP listing could not read connections");
        return Vec::new();
    };

    let mut tools = Vec::new();
    for app in connected {
        if app.transport == "http" {
            match http_tools::definitions(app) {
                Ok(definitions) => {
                    let entries: Vec<Value> = definitions
                        .iter()
                        .filter(|tool| {
                            app.tool_allowlist.is_empty() || app.tool_allowlist.contains(&tool.name)
                        })
                        .map(|tool| http_tools::listing_entry(app, tool))
                        .collect();
                    tools.extend(entries.into_iter().map(listing_entry));
                }
                Err(error) => {
                    tracing::warn!(connector = %app.slug, %error, "skipping invalid HTTP connector");
                }
            }
            continue;
        }
        let row = if app.auth_type == "none" {
            None
        } else {
            db::find_connector_connection(mysql, &app.slug, user.users_id)
                .await
                .ok()
                .flatten()
        };
        let stored = row.as_ref().map(connection::ConnectorConnection::from_row);
        if let Some(cached) = stored
            .as_ref()
            .and_then(|stored| stored.cached_tool_entries(&app.slug, &app.tool_allowlist))
        {
            tools.extend(cached);
            continue;
        }
        let (headers, attempted_access) = match service::session_headers(mysql, app, user).await {
            Ok(headers) => headers,
            Err(error) => {
                refresh::record_session_error(mysql, row.as_ref(), &error).await;
                tracing::warn!(connector = %app.slug, %error, "skipping unavailable connector");
                continue;
            }
        };
        let upstream =
            match mcp::list_tools_for_transport(&app.transport, &app.mcp_url, &headers).await {
                Ok(tools) => tools,
                Err(error) => {
                    refresh::record_directory_error(
                        mysql,
                        row.as_ref(),
                        attempted_access.as_deref(),
                        &error,
                    )
                    .await;
                    tracing::warn!(connector = %app.slug, %error, "skipping unavailable connector");
                    continue;
                }
            };
        let mut discovered = Vec::new();
        for tool in upstream {
            if !app.tool_allowlist.is_empty() && !app.tool_allowlist.contains(&tool.name) {
                continue;
            }
            let schema = tool
                .input_schema
                .as_ref()
                .map(brz_json::OpaqueJson::to_value)
                .unwrap_or_else(connection::default_input_schema);
            let mut entry = json!({
                "name": wegent_protocol::connector::qualify_tool(&app.slug, &tool.name),
                "description": tool.description.clone().unwrap_or_default(),
                "rawToolName": tool.name,
                "inputSchema": schema,
            });
            if let Some(title) = tool.title.clone().filter(|title| !title.is_empty()) {
                entry["title"] = Value::String(title);
            }
            discovered.push(entry);
        }
        // `_cache_tool_summaries`: the settings view and the next listing read
        // this surface instead of probing the upstream again.
        if let (Some(row), Some(attempted_access)) = (row.as_ref(), attempted_access.as_deref()) {
            let discovered_at = chrono::Utc::now().to_rfc3339();
            let _ = refresh::write_discovery_state(
                mysql,
                row,
                attempted_access,
                &refresh::DiscoveryState {
                    discovered_at: Some(&discovered_at),
                    tool_summaries: Some(&discovered),
                    last_error: None,
                    expired: false,
                },
            )
            .await;
        }
        tools.extend(discovered.into_iter().map(listing_entry));
    }
    tools
}

/// Drop the cache-only members the tool listing does not expose.
fn listing_entry(mut entry: Value) -> Value {
    if let Some(object) = entry.as_object_mut() {
        object.remove("rawToolName");
    }
    entry
}

fn add_upstream_names(tools: &mut [Value]) {
    for tool in tools {
        if let Some((_, raw_name)) = tool["name"]
            .as_str()
            .and_then(wegent_protocol::connector::split_tool)
        {
            tool["rawToolName"] = json!(raw_name);
        }
    }
}

/// `_connected_apps`' scope rule: a scoped request addresses exactly one app,
/// while the unscoped surface is the eager `wegent-connectors` MCP and carries
/// only `static` apps. Lazy apps stay reachable through their scoped server
/// after `load_skill` activates them.
fn in_surface(app: &ConnectorApp, app_scope: Option<&str>) -> bool {
    match app_scope {
        Some(slug) => app.slug == slug,
        None => app.tool_loading_mode == "static",
    }
}

/// `call_connector_tool`: run one `app__tool` call against its upstream.
async fn call_tool(
    state: &AppState,
    authorization: Option<&str>,
    app_scope: Option<&str>,
    params: Option<&Value>,
) -> Value {
    let Some(user) = resolve_user(state, authorization).await else {
        return failure("Connector user unavailable");
    };
    call_tool_for_user(&state.mysql, &user, app_scope, params).await
}

async fn call_tool_for_user<M: brz_mysql::Mysql>(
    mysql: &M,
    user: &UserRow,
    app_scope: Option<&str>,
    params: Option<&Value>,
) -> Value {
    let name = params
        .and_then(|params| params.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let arguments = params
        .and_then(|params| params.get("arguments"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let Some((slug, upstream_name)) = wegent_protocol::connector::split_tool(name) else {
        return failure("Invalid connector tool name");
    };
    if app_scope.is_some_and(|scope| scope != slug) {
        return failure(format!(
            "Connector tool '{name}' is outside this Skill's app scope"
        ));
    }
    let Some(app) = visible_app_for_user(mysql, user, &slug).await else {
        return failure("Connector app not found");
    };
    if !app.tool_allowlist.is_empty()
        && !app.tool_allowlist.iter().any(|tool| tool == upstream_name)
    {
        return failure("Connector tool is disabled");
    }
    let (headers, attempted_access) = match service::session_headers(mysql, &app, user).await {
        Ok(headers) => headers,
        Err(SessionError::AuthorizationRequired) => {
            return failure(connector_auth_required(&app.slug));
        }
        Err(error) => {
            tracing::warn!(connector = %app.slug, %error, "connector tool session failed");
            return failure(error.to_string());
        }
    };
    if app.transport == "http" {
        return match call_http_tool(&app, upstream_name, &arguments, &headers).await {
            HttpToolOutcome::Result(result) => result,
            HttpToolOutcome::Unauthorized(message) => {
                unauthorized(mysql, &app, user.users_id, &message, attempted_access).await
            }
        };
    }
    match mcp::call_tool_for_transport(
        &app.transport,
        &app.mcp_url,
        &headers,
        upstream_name,
        &arguments,
    )
    .await
    {
        Ok(call) => success(&call),
        Err(mcp::McpError::Unauthorized(message)) => {
            unauthorized(mysql, &app, user.users_id, &message, attempted_access).await
        }
        Err(error) => {
            tracing::warn!(connector = %app.slug, %error, "connector tool call failed");
            failure("Connector tool failed")
        }
    }
}

/// Run one configured HTTP operation for a `transport = "http"` app.
async fn call_http_tool(
    app: &ConnectorApp,
    upstream_name: &str,
    arguments: &Value,
    headers: &[(String, String)],
) -> HttpToolOutcome {
    let definitions = match http_tools::definitions(app) {
        Ok(definitions) => definitions,
        Err(error) => return HttpToolOutcome::Result(failure(error.to_string())),
    };
    let Some(tool) = definitions.iter().find(|tool| tool.name == upstream_name) else {
        return HttpToolOutcome::Result(failure("Connector tool not found"));
    };
    match http_tools::call(app, tool, arguments, headers).await {
        Ok(call) => HttpToolOutcome::Result(success(&call)),
        Err(http_tools::HttpToolError::InvalidArguments(message)) => {
            HttpToolOutcome::Result(failure(message))
        }
        Err(http_tools::HttpToolError::Unauthorized(message)) => {
            HttpToolOutcome::Unauthorized(message)
        }
        Err(error) => {
            tracing::warn!(connector = %app.slug, %error, "connector HTTP tool failed");
            HttpToolOutcome::Result(failure(error.to_string()))
        }
    }
}

/// An HTTP 401/403 keeps its credential-scoped recovery semantics; every
/// other result already has the MCP content/error envelope.
enum HttpToolOutcome {
    Result(Value),
    Unauthorized(String),
}

/// The upstream rejected a still-unexpired credential: flip the connection to
/// `expired` so the desktop offers re-authorization, and report the structured
/// hint the agent is instructed to surface.
async fn unauthorized<M: brz_mysql::Mysql>(
    mysql: &M,
    app: &ConnectorApp,
    user_id: i64,
    message: &str,
    attempted_access: Option<String>,
) -> Value {
    tracing::warn!(connector = %app.slug, %message, "connector rejected its credential");
    if app.auth_type == "none" {
        // Fixed administrator headers have no user OAuth grant to repair.
        return failure("Connector upstream rejected administrator credentials or permissions");
    }
    if let Some(row) = db::find_connector_connection(mysql, &app.slug, user_id)
        .await
        .ok()
        .flatten()
        && let Some(expected_access) = attempted_access
    {
        let _ = refresh::reject_credential_if_current(
            mysql,
            row.kinds_id,
            &expected_access,
            Some(message),
        )
        .await;
    }
    failure(connector_auth_required(&app.slug))
}

/// The structured hint the agent is instructed to surface when a connector
/// needs a fresh user grant (`wegent_apps` proxy contract).
fn connector_auth_required(slug: &str) -> String {
    serde_json::to_string(&json!({
        "error": "connector_auth_required",
        "connectorSlug": slug,
        "message": format!("Connector '{slug}' requires authorization"),
    }))
    .unwrap_or_default()
}

/// `_content_blocks` plus `CallToolResult`: text blocks join into one readable
/// block, JSON-only payloads stay serialized, and the upstream error flag is
/// preserved.
fn success(call: &mcp::ToolCall) -> Value {
    let texts: Vec<&str> = call
        .content
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    let text = if texts.is_empty() {
        call.content.to_string()
    } else {
        texts.join("\n")
    };
    let mut result = json!({
        "content": [{"type": "text", "text": text}],
        "isError": call.is_error,
    });
    if let Some(structured) = &call.structured_content {
        result["structuredContent"] = structured.clone();
    }
    result
}

/// The `CallToolResult` the source returns for a failed call.
fn failure(message: impl Into<String>) -> Value {
    json!({
        "content": [{"type": "text", "text": message.into()}],
        "isError": true,
    })
}

#[cfg(test)]
#[path = "connectors_identity_tests.rs"]
mod identity_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, id: Value, params: Option<Value>) -> RpcRequest {
        RpcRequest {
            id,
            method: method.to_string(),
            params,
        }
    }

    #[test]
    fn initialize_advertises_only_the_tool_capability() {
        let reply = dispatch(&request(
            "initialize",
            json!(0),
            Some(json!({ "protocolVersion": "2025-11-25" })),
        ));
        let value: Value = serde_json::from_str(&reply).unwrap();

        assert_eq!(value["result"]["serverInfo"]["name"], json!(SERVER_NAME));
        assert_eq!(
            value["result"]["capabilities"],
            json!({"experimental": {}, "tools": {"listChanged": false}})
        );
    }

    /// The low-level connector server registers no prompt or resource handler.
    #[test]
    fn prompt_and_resource_listings_are_unknown_methods() {
        for method in ["prompts/list", "resources/list", "resources/templates/list"] {
            let value: Value =
                serde_json::from_str(&dispatch(&request(method, json!(1), None))).unwrap();
            assert_eq!(value["error"]["code"], json!(protocol::METHOD_NOT_FOUND));
        }
    }

    #[test]
    fn ping_succeeds() {
        let value: Value =
            serde_json::from_str(&dispatch(&request("ping", json!(2), None))).unwrap();
        assert_eq!(value["result"], json!({}));
    }

    #[test]
    fn text_blocks_join_into_one_readable_block() {
        let call = mcp::ToolCall {
            content: json!([{"type": "text", "text": "a"}, {"type": "image", "data": "x"}]),
            structured_content: None,
            is_error: false,
        };
        assert_eq!(
            success(&call)["content"],
            json!([{"type": "text", "text": "a"}])
        );
    }

    #[test]
    fn non_text_payloads_stay_serialized() {
        let call = mcp::ToolCall {
            content: json!({"rows": [1, 2]}),
            structured_content: Some(json!({"rows": [1, 2]})),
            is_error: true,
        };
        let result = success(&call);
        assert_eq!(result["isError"], json!(true));
        assert_eq!(result["content"][0]["text"], json!("{\"rows\":[1,2]}"));
        assert_eq!(result["structuredContent"], json!({"rows": [1, 2]}));
    }

    #[test]
    fn failures_report_the_source_message() {
        assert_eq!(
            failure("Connector app not found"),
            json!({
                "content": [{"type": "text", "text": "Connector app not found"}],
                "isError": true,
            })
        );
    }

    #[test]
    fn route_table_selects_the_registered_transport() {
        const PATH: &str = "/api/mcp/connectors/sse";
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).expect("routes file loads");
        let table = crate::RouteTable::compile(config).expect("routes compile");
        assert!(table.matches(&http::Method::GET, PATH));
        assert!(table.matches(&http::Method::POST, PATH));
        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH);
        assert!(registered, "{PATH} must be registered by the router");
    }

    pub(super) fn app(slug: &str, loading_mode: &str) -> ConnectorApp {
        let row = crate::apps_installed::db::KindRow {
            kinds_id: 1,
            kinds_user_id: 0,
            kinds_kind: "ConnectorApp".to_string(),
            kinds_name: slug.to_string(),
            kinds_namespace: "system".to_string(),
            kinds_json: brz_mysql::Json(
                json!({
                    "kind": "ConnectorApp",
                    "spec": {
                        "name": slug,
                        "mcpUrl": "https://mcp.example.invalid/mcp",
                        "enabled": true,
                        "authType": "oauth2",
                        "transport": "streamable-http",
                        "visibility": "all",
                        "description": "d",
                        "allowedRoles": [],
                        "toolAllowlist": [],
                        "toolLoadingMode": loading_mode,
                    }
                })
                .into(),
            ),
            kinds_is_active: true,
            kinds_created_at: chrono::NaiveDateTime::default(),
            kinds_updated_at: chrono::NaiveDateTime::default(),
        };
        service::row_to_app(&row)
    }

    /// The shared surface carries only eager apps; lazy ones wait for their
    /// Skill to open a scoped session.
    #[test]
    fn the_unscoped_surface_lists_static_apps_only() {
        assert!(in_surface(&app("dingtalk", "static"), None));
        assert!(!in_surface(&app("dingtalk", "lazy"), None));
    }

    /// A scoped session addresses its own app even when it loads lazily.
    #[test]
    fn a_scoped_surface_lists_its_app_only() {
        assert!(in_surface(&app("dingtalk", "lazy"), Some("dingtalk")));
        assert!(!in_surface(&app("github", "static"), Some("dingtalk")));
    }

    fn http_app(slug: &str, allowlist: Vec<String>) -> ConnectorApp {
        let row = crate::apps_installed::db::KindRow {
            kinds_id: 7,
            kinds_user_id: 0,
            kinds_kind: "ConnectorApp".to_string(),
            kinds_name: slug.to_string(),
            kinds_namespace: "system".to_string(),
            kinds_json: brz_mysql::Json(
                json!({
                    "kind": "ConnectorApp",
                    "spec": {
                        "name": slug,
                        "mcpUrl": "https://api.example.invalid/v1",
                        "enabled": true,
                        "authType": "oauth2",
                        "transport": "http",
                        "visibility": "all",
                        "description": "d",
                        "allowedRoles": [],
                        "toolAllowlist": allowlist,
                        "httpTools": [{
                            "name": "lookup",
                            "description": "Lookup a record",
                            "method": "GET",
                            "path": "/records/{id}",
                            "input_schema": {"type": "object", "required": ["id"]},
                        }],
                    }
                })
                .into(),
            ),
            kinds_is_active: true,
            kinds_created_at: chrono::NaiveDateTime::default(),
            kinds_updated_at: chrono::NaiveDateTime::default(),
        };
        service::row_to_app(&row)
    }

    /// A `transport = "http"` app publishes its configured operations instead of
    /// being skipped by the MCP listing.
    #[test]
    fn http_transport_apps_publish_their_configured_tools() {
        let app = http_app("erp", vec![]);
        assert_eq!(app.transport, "http");
        let definitions = http_tools::definitions(&app).expect("valid configuration");
        assert_eq!(definitions.len(), 1);
        let entry = http_tools::listing_entry(&app, &definitions[0]);
        assert_eq!(entry["name"], json!("erp__lookup"));
        assert_eq!(entry["rawToolName"], json!("lookup"));
        assert_eq!(entry["inputSchema"]["required"], json!(["id"]));
    }

    /// The allowlist still bounds the configured surface.
    #[test]
    fn http_transport_tools_respect_the_allowlist() {
        let app = http_app("erp", vec!["other".to_string()]);
        let entries: Vec<_> = http_tools::definitions(&app)
            .expect("valid configuration")
            .iter()
            .filter(|tool| app.tool_allowlist.is_empty() || app.tool_allowlist.contains(&tool.name))
            .map(|tool| http_tools::listing_entry(&app, tool))
            .collect();
        assert!(entries.is_empty());
    }

    /// A rejected credential surfaces the structured re-authorization hint.
    #[test]
    fn rejected_credentials_report_the_auth_required_hint() {
        let value: Value = serde_json::from_str(&connector_auth_required("erp")).unwrap();
        assert_eq!(value["error"], json!("connector_auth_required"));
        assert_eq!(value["connectorSlug"], json!("erp"));
        assert_eq!(
            value["message"],
            json!("Connector 'erp' requires authorization")
        );
    }

    #[tokio::test]
    async fn administrator_credential_rejection_never_requests_user_oauth_or_reads_a_grant() {
        for transport in ["http", "streamable-http", "sse"] {
            for status in [401, 403] {
                let mysql = crate::sql_test_support::KindQueryCapture::default();
                let mut app = app("records", "static");
                app.auth_type = "none".to_string();
                app.transport = transport.to_string();
                let result =
                    unauthorized(&mysql, &app, 7, &format!("Upstream status {status}"), None).await;
                assert_eq!(result["isError"], true);
                let text = result["content"][0]["text"].as_str().unwrap();
                assert!(text.contains("administrator credentials or permissions"));
                assert!(!text.contains("connector_auth_required"));
                assert!(mysql.queries().is_empty(), "No user grant exists to expire");
            }
        }
    }
}
