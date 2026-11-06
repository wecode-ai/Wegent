use std::{collections::HashMap, env, time::Duration};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    task::{AbortHandle, JoinSet},
};

const BRIDGE_URL_ENV: &str = "WEWORK_COMPUTER_USE_BRIDGE_URL";
const BRIDGE_TOKEN_ENV: &str = "WEWORK_COMPUTER_USE_BRIDGE_TOKEN";

pub fn is_computer_use_mcp_command() -> bool {
    env::args().nth(1).as_deref() == Some("computer-use-mcp-server")
}

/// Bind the private host bridge and serve the authenticated stdio transport.
pub async fn run() -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(120))
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())?;
    let bridge = BridgeClient {
        client,
        url: env::var(BRIDGE_URL_ENV)
            .map_err(|_| "Computer use bridge URL is unavailable".to_owned())?,
        token: env::var(BRIDGE_TOKEN_ENV)
            .map_err(|_| "Computer use bridge token is unavailable".to_owned())?,
    };
    run_with_io(
        bridge,
        BufReader::new(tokio::io::stdin()),
        tokio::io::stdout(),
    )
    .await
}

/// Keep transport input responsive while HTTP calls run, and cancel them on EOF.
async fn run_with_io(
    bridge: BridgeClient,
    input: impl AsyncBufRead + Unpin,
    mut output: impl AsyncWrite + Unpin,
) -> Result<(), String> {
    let mut lines = input.lines();
    let mut pending = JoinSet::new();
    let mut cancellations: HashMap<String, AbortHandle> = HashMap::new();
    loop {
        let line = tokio::select! {
            line = lines.next_line() => match line.map_err(|error| error.to_string())? {
                Some(line) => line,
                None => break,
            },
            completed = pending.join_next_with_id(), if !pending.is_empty() => {
                match completed {
                    Some(Ok((task_id, (key, response)))) => {
                        if let Some(key) = key {
                            // A cancellation can race a completed response and reuse its public id.
                            if !cancellations.get(&key).is_some_and(|handle| handle.id() == task_id) {
                                continue;
                            }
                            cancellations.remove(&key);
                        }
                        if let Some(response) = response {
                            write_response(&mut output, response).await?;
                        }
                    }
                    Some(Err(error)) if !error.is_cancelled() => return Err(error.to_string()),
                    _ => {},
                }
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let request = match serde_json::from_str::<Value>(&line) {
            Ok(request) => request,
            Err(error) => {
                write_response(
                    &mut output,
                    error_response(Value::Null, -32700, error.to_string()),
                )
                .await?;
                continue;
            }
        };
        if request.get("method").and_then(Value::as_str) == Some("notifications/cancelled") {
            if let Some(id) = request.get("id") {
                write_response(
                    &mut output,
                    error_response(
                        id.clone(),
                        -32600,
                        "notifications/cancelled must not have an id",
                    ),
                )
                .await?;
                continue;
            }
            if let Some(id) = request.pointer("/params/requestId") {
                if let Some(handle) = cancellations.remove(&id.to_string()) {
                    // Dropping the HTTP future closes the request. The host then aborts the SDK call.
                    handle.abort();
                }
            }
            continue;
        }
        let key = request.get("id").map(Value::to_string);
        if key
            .as_ref()
            .is_some_and(|key| cancellations.contains_key(key))
        {
            write_response(
                &mut output,
                error_response(request["id"].clone(), -32600, "Duplicate request id"),
            )
            .await?;
            continue;
        }
        let client = bridge.clone();
        let request_key = key.clone();
        let handle =
            pending.spawn(async move { (request_key, handle_request(&client, &request).await) });
        if let Some(key) = key {
            cancellations.insert(key, handle);
        }
    }
    // Stdin EOF is a transport cancellation boundary, including during a tool call.
    pending.shutdown().await;
    Ok(())
}

/// Serialize and flush one complete JSON-RPC frame without interleaved output.
async fn write_response(
    output: &mut (impl AsyncWrite + Unpin),
    response: Value,
) -> Result<(), String> {
    let mut encoded = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
    encoded.push(b'\n');
    output
        .write_all(&encoded)
        .await
        .map_err(|error| error.to_string())?;
    output.flush().await.map_err(|error| error.to_string())
}

#[derive(Clone)]
struct BridgeClient {
    client: reqwest::Client,
    url: String,
    token: String,
}

/// Dispatch an MCP message, omitting replies for notifications.
async fn handle_request(client: &BridgeClient, request: &Value) -> Option<Value> {
    let id = request.get("id").cloned();
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match method {
        "notifications/initialized" => None,
        "initialize" => id.map(|id| {
            result_response(
                id,
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": {
                        "name": "wegent-computer-use",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
        }),
        "tools/list" => {
            let id = id?;
            Some(
                match bridge_request(client, json!({ "action": "listTools" })).await {
                    Ok(tools) => result_response(id, json!({ "tools": tools })),
                    Err(error) => error_response(id, -32000, error),
                },
            )
        }
        "tools/call" => {
            let id = id?;
            let Some(name) = request.pointer("/params/name").and_then(Value::as_str) else {
                return Some(error_response(
                    id,
                    -32602,
                    "tools/call requires params.name",
                ));
            };
            let arguments = request
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            Some(
                match bridge_request(
                    client,
                    json!({ "action": "callTool", "name": name, "arguments": arguments }),
                )
                .await
                {
                    Ok(result) => result_response(id, mcp_tool_result(result)),
                    Err(error) => error_response(id, -32000, error),
                },
            )
        }
        "ping" => id.map(|id| result_response(id, json!({}))),
        _ => id.map(|id| error_response(id, -32601, format!("Unknown method: {method}"))),
    }
}

/// Forward one operation through the token-protected loopback bridge.
async fn bridge_request(bridge: &BridgeClient, payload: Value) -> Result<Value, String> {
    let client = &bridge.client;
    let response = client
        .post(format!("{}/computer", bridge.url.trim_end_matches('/')))
        .bearer_auth(&bridge.token)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("Computer use bridge is unavailable: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Computer use bridge returned HTTP {}",
            response.status()
        ));
    }
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    if body.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Computer use tool failed")
            .to_owned());
    }
    Ok(body.get("data").cloned().unwrap_or(Value::Null))
}

fn mcp_tool_result(result: Value) -> Value {
    let mut content = Vec::new();
    if let Some(text) = result.get("text").and_then(Value::as_str) {
        if !text.is_empty() {
            content.push(json!({ "type": "text", "text": text }));
        }
    }
    if let Some(images) = result.get("images").and_then(Value::as_array) {
        for image in images {
            if let (Some(data), Some(mime_type)) = (
                image.get("dataBase64").and_then(Value::as_str),
                image.get("mimeType").and_then(Value::as_str),
            ) {
                content.push(json!({ "type": "image", "data": data, "mimeType": mime_type }));
            }
        }
    }
    if content.is_empty() {
        content.push(json!({ "type": "text", "text": result.to_string() }));
    }
    let structured_content = result
        .get("structuredJson")
        .and_then(Value::as_str)
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    let mut response = json!({
        "content": content,
        "isError": result.get("isError").and_then(Value::as_bool).unwrap_or(false)
    });
    if let Some(structured_content) = structured_content {
        response["structuredContent"] = structured_content;
    }
    response
}

fn result_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

#[cfg(test)]
mod tests {
    use super::{mcp_tool_result, run_with_io, BridgeClient};
    use serde_json::json;
    use std::time::Duration;
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
        sync::oneshot,
        task::JoinHandle,
        time::timeout,
    };

    async fn pending_bridge() -> (BridgeClient, oneshot::Receiver<()>, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (entered, received) = oneshot::channel();
        let closed = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            assert!(stream.read(&mut buffer).await.unwrap() > 0);
            entered.send(()).unwrap();
            while stream.read(&mut buffer).await.unwrap() != 0 {}
        });
        (
            BridgeClient {
                client: reqwest::Client::builder().no_proxy().build().unwrap(),
                url,
                token: "test-token".into(),
            },
            received,
            closed,
        )
    }

    #[tokio::test]
    async fn cancellation_closes_http_while_pending_calls_do_not_block_ping() {
        for request_id in [json!(1), json!("session-start")] {
            let (bridge, entered, closed) = pending_bridge().await;
            let (client, server) = tokio::io::duplex(8192);
            let (input, output) = tokio::io::split(server);
            let adapter = tokio::spawn(run_with_io(bridge, BufReader::new(input), output));
            let (reader, mut writer) = tokio::io::split(client);
            let mut reader = BufReader::new(reader).lines();
            let request = json!({"jsonrpc":"2.0", "id":request_id, "method":"tools/call",
                "params":{"name":"start_session", "arguments":{}}});
            writer
                .write_all(format!("{request}\n").as_bytes())
                .await
                .unwrap();
            timeout(Duration::from_secs(2), entered)
                .await
                .unwrap()
                .unwrap();
            let invalid_cancel = json!({"id":99,"method":"notifications/cancelled",
                "params":{"requestId":request_id}});
            writer
                .write_all(format!("{invalid_cancel}\n").as_bytes())
                .await
                .unwrap();
            let response = timeout(Duration::from_secs(2), reader.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let response: serde_json::Value = serde_json::from_str(&response).unwrap();
            assert_eq!(response["id"], 99);
            assert_eq!(response["error"]["code"], -32600);
            writer
                .write_all(b"{\"id\":2,\"method\":\"ping\"}\n")
                .await
                .unwrap();
            let response = timeout(Duration::from_secs(2), reader.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&response).unwrap(),
                json!({"jsonrpc":"2.0","id":2,"result":{}})
            );
            let cancel =
                json!({"method":"notifications/cancelled", "params":{"requestId":request_id}});
            writer
                .write_all(format!("{cancel}\n").as_bytes())
                .await
                .unwrap();
            timeout(Duration::from_secs(2), closed)
                .await
                .unwrap()
                .unwrap();
            writer.shutdown().await.unwrap();
            timeout(Duration::from_secs(2), adapter)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(
                reader.next_line().await.unwrap().is_none(),
                "cancelled calls must not send late replies"
            );
        }
    }

    #[tokio::test]
    async fn stdin_eof_closes_pending_http_requests() {
        let (bridge, entered, closed) = pending_bridge().await;
        let (mut writer, input) = tokio::io::duplex(8192);
        let adapter = tokio::spawn(run_with_io(
            bridge,
            BufReader::new(input),
            tokio::io::sink(),
        ));
        writer
            .write_all(
                b"{\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"list_apps\"}}\n",
            )
            .await
            .unwrap();
        timeout(Duration::from_secs(2), entered)
            .await
            .unwrap()
            .unwrap();
        writer.shutdown().await.unwrap();
        timeout(Duration::from_secs(2), closed)
            .await
            .unwrap()
            .unwrap();
        timeout(Duration::from_secs(2), adapter)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }

    #[test]
    fn maps_cua_text_images_and_structured_output_to_mcp() {
        let result = mcp_tool_result(json!({
            "text": "done",
            "images": [{ "mimeType": "image/png", "dataBase64": "abc" }],
            "structuredJson": "{\"value\":42}",
            "isError": false
        }));

        assert_eq!(
            result["content"][0],
            json!({ "type": "text", "text": "done" })
        );
        assert_eq!(
            result["content"][1],
            json!({ "type": "image", "data": "abc", "mimeType": "image/png" })
        );
        assert_eq!(result["structuredContent"], json!({ "value": 42 }));
        assert_eq!(result["isError"], false);
    }
}
