// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Defer upstream schemas while reusing the existing connector gateway.

use super::*;
use crate::connector_gateway::ConnectorGatewayConfig;

pub(super) const DISCOVER_PREFIX: &str = "_wegent_discover__";
pub(super) const CALL_PREFIX: &str = "_wegent_call__";

pub(super) async fn call_deferred_tool(name: &str, arguments: &Value) -> Value {
    let config = match load_connector_gateway_config() {
        Ok(config) => config,
        Err(message) => return text_result(message, true),
    };
    call_with_config(&config, name, arguments).await
}

async fn call_with_config(config: &ConnectorGatewayConfig, name: &str, arguments: &Value) -> Value {
    let (discover, slug) = match deferred_target(name, arguments) {
        Ok(target) => target,
        Err(message) => return text_result(message, true),
    };
    if discover {
        return match config
            .request_scoped(reqwest::Method::GET, "tools", None, Some(slug), false)
            .await
        {
            Ok(catalog) => {
                let mut tools = mcp_tools(&catalog);
                for tool in &mut tools {
                    if let Some((_, raw_name)) = tool["name"]
                        .as_str()
                        .and_then(wegent_protocol::connector::split_tool)
                    {
                        tool["rawToolName"] = json!(raw_name);
                    }
                }
                text_result(json!({"tools": tools}).to_string(), tools.is_empty())
            }
            Err(error) => gateway_error_result(
                &wegent_protocol::connector::qualify_tool(slug, "discover"),
                &error,
            ),
        };
    }
    let tool = arguments["name"].as_str().expect("validated upstream name");
    let qualified = wegent_protocol::connector::qualify_tool(slug, tool);
    let normalized = match normalize_tool_arguments(&qualified, arguments["arguments"].clone()) {
        Ok(arguments) => arguments,
        Err(message) => return text_result(message, true),
    };
    match config
        .request(
            reqwest::Method::POST,
            "call",
            Some(json!({
                "name": qualified, "arguments": normalized,
            })),
        )
        .await
    {
        Ok(value) => tool_result(&value),
        Err(error) => gateway_error_result(&qualified, &error),
    }
}

fn deferred_target<'a>(name: &'a str, arguments: &Value) -> Result<(bool, &'a str), &'static str> {
    if let Some(slug) = name
        .strip_prefix(DISCOVER_PREFIX)
        .filter(|slug| !slug.is_empty())
    {
        return Ok((true, slug));
    }
    let slug = name
        .strip_prefix(CALL_PREFIX)
        .filter(|slug| !slug.is_empty())
        .ok_or("Invalid deferred connector tool")?;
    if !arguments
        .get("name")
        .and_then(Value::as_str)
        .is_some_and(|name| !name.is_empty())
        || !arguments.get("arguments").is_some_and(Value::is_object)
    {
        return Err("Connector call requires a tool name and an arguments object");
    }
    Ok((false, slug))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        http::HeaderMap,
        routing::{get, post},
        Json, Router,
    };
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn failed_discovery_preserves_the_app_authorization_boundary() {
        let router = Router::new().route(
            "/connector-runtime/tools",
            get(|headers: HeaderMap| async move {
                let slug = headers["x-connector-app"].to_str().unwrap();
                if slug == "records" {
                    return (
                        axum::http::StatusCode::UNAUTHORIZED,
                        Json(json!({
                            "detail": "Connector 'records' requires authorization",
                        })),
                    );
                }
                (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({
                        "detail": "Connector administrator credentials unavailable",
                    })),
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = ConnectorGatewayConfig {
            api_base_url: format!("http://{}", listener.local_addr().unwrap()),
            connector_token: "synthetic".to_string(),
            expires_at_ms: i64::MAX,
        };
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let missing = call_with_config(&config, "_wegent_discover__records", &json!({})).await;
        assert_eq!(missing["isError"], true);
        let marker: Value =
            serde_json::from_str(missing["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(marker["error"], "connector_auth_required");
        assert_eq!(marker["connectorSlug"], "records");
        let administrator = call_with_config(&config, "_wegent_discover__public", &json!({})).await;
        assert_eq!(administrator["isError"], true);
        assert!(!administrator["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("connector_auth_required"));
        server.abort();
    }

    #[tokio::test]
    async fn discovery_is_scoped_and_calls_preserve_argument_types() {
        let received = Arc::new(Mutex::new(vec![]));
        let calls = Arc::clone(&received);
        let router = Router::new()
            .route("/connector-runtime/tools", get(|headers: HeaderMap| async move {
                assert_eq!(headers["x-connector-app"], "records");
                assert!(!headers.contains_key("x-connector-loading"));
                Json(json!({"tools": [{
                    "name": "records__lookup", "connector_id": "records",
                    "input_schema": {"type": "object", "properties": {"id": {"type": "string"}}}
                }]}))
            }))
            .route("/connector-runtime/call", post(move |Json(body): Json<Value>| {
                calls.lock().unwrap().push(body);
                async { Json(json!({"content": [{"type": "text", "text": "success"}], "is_error": false})) }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = ConnectorGatewayConfig {
            api_base_url: format!("http://{}", listener.local_addr().unwrap()),
            connector_token: "synthetic".to_string(),
            expires_at_ms: i64::MAX,
        };
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let discovery = call_with_config(&config, "_wegent_discover__records", &json!({})).await;
        assert_eq!(discovery["isError"], false);
        assert!(discovery["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("inputSchema"));
        assert!(received.lock().unwrap().is_empty());
        let invalid = call_with_config(
            &config,
            "_wegent_call__records",
            &json!({"name": "lookup", "arguments": []}),
        )
        .await;
        assert_eq!(invalid["isError"], true);
        assert!(received.lock().unwrap().is_empty());
        let result = call_with_config(
            &config,
            "_wegent_call__records",
            &json!({"name": "lookup", "arguments": {"id": "123"}}),
        )
        .await;
        assert_eq!(result["isError"], false);
        assert_eq!(
            *received.lock().unwrap(),
            vec![json!({"name": "records__lookup", "arguments": {"id": "123"}})]
        );
        server.abort();
    }

    #[tokio::test]
    async fn raw_names_resembling_app_prefixes_are_not_stripped_or_rerouted() {
        let received = Arc::new(Mutex::new(vec![]));
        let calls = Arc::clone(&received);
        let router = Router::new().route(
            "/connector-runtime/call",
            post(move |Json(body): Json<Value>| {
                calls.lock().unwrap().push(body);
                async { Json(json!({"content":[],"is_error":false})) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = ConnectorGatewayConfig {
            api_base_url: format!("http://{}", listener.local_addr().unwrap()),
            connector_token: "synthetic".into(),
            expires_at_ms: i64::MAX,
        };
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        for (slug, raw) in [
            ("reports", "reports__lookup"),
            ("reports__archive", "reports_u_uarchive__lookup"),
        ] {
            let result = call_with_config(
                &config,
                &format!("_wegent_call__{slug}"),
                &json!({"name":raw,"arguments":{"id":42}}),
            )
            .await;
            assert_eq!(result["isError"], false);
        }
        assert_eq!(
            *received.lock().unwrap(),
            vec![
                json!({"name":"reports__reports__lookup","arguments":{"id":42}}),
                json!({"name":"reports_u_uarchive__reports_u_uarchive__lookup","arguments":{"id":42}}),
            ]
        );
        server.abort();
    }
}
