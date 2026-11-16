use axum::{routing::post, Json, Router};
use serde_json::{json, Value};
use wegent_mcp_runtime::interactive_mcp::{proxy_deferred_mcp_tool, DeferredToolUse};

#[tokio::test]
async fn deferred_mcp_handshake_reports_the_host_application_version() {
    let (sender, mut received) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route(
        "/mcp",
        post(move |Json(payload): Json<Value>| {
            let sender = sender.clone();
            async move {
                sender.send(payload.clone()).unwrap();
                Json(json!({
                    "jsonrpc": "2.0",
                    "id": payload.get("id"),
                    "result": {"content": [{"type": "text", "text": "done"}]}
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let tool = DeferredToolUse {
        id: "tool-identity".to_owned(),
        name: "mcp__identity__echo".to_owned(),
        input: json!({"message": "hello"}),
    };
    let result = proxy_deferred_mcp_tool(
        &tool,
        &json!({"identity": {"url": format!("http://{address}/mcp")}}),
        env!("CARGO_PKG_VERSION"),
    )
    .await;
    server.abort();
    let result = result.unwrap();
    assert_eq!(result.output_text, "done");
    let initialize = received.try_recv().unwrap();
    assert_eq!(initialize["method"], "initialize");
    assert_eq!(
        initialize["params"]["clientInfo"],
        json!({"name": "wegent-executor", "version": env!("CARGO_PKG_VERSION")})
    );
    assert_eq!(
        received.try_recv().unwrap()["method"],
        "notifications/initialized"
    );
    let call = received.try_recv().unwrap();
    assert_eq!(call["method"], "tools/call");
    assert_eq!(
        call["params"],
        json!({"name": "echo", "arguments": tool.input})
    );
}
