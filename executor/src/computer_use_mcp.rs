use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    task::{AbortHandle, JoinSet},
};

#[derive(Deserialize)]
pub(crate) struct BridgeRecord {
    pub address: String,
    pub token: String,
}

pub(crate) fn read_bridge_record(path: &Path) -> Result<BridgeRecord, String> {
    let contents =
        fs::read(path).map_err(|_| "Computer use bridge record is unavailable".to_owned())?;
    let record: BridgeRecord = serde_json::from_slice(&contents)
        .map_err(|_| "Computer use bridge record is invalid".to_owned())?;
    if record.address.trim().is_empty() || record.token.trim().is_empty() {
        return Err("Computer use bridge record is incomplete".to_owned());
    }
    Ok(record)
}

pub fn is_computer_use_mcp_command() -> bool {
    env::args().nth(1).as_deref() == Some("computer-use-mcp-server")
}

/// Bind the private host bridge and serve the authenticated stdio transport.
pub async fn run() -> Result<(), String> {
    let path = env::args_os()
        .nth(2)
        .ok_or_else(|| "Computer use bridge record path is required".to_owned())?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(120))
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())?;
    let bridge = BridgeClient {
        client,
        runtime_path: PathBuf::from(path),
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
    runtime_path: PathBuf,
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
    // Each operation observes enable/disable and token rotation without restarting Codex.
    let record = read_bridge_record(&bridge.runtime_path)?;
    let client = &bridge.client;
    let response = client
        .post(format!("http://{}/computer", record.address.trim()))
        .bearer_auth(record.token.trim())
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
    use super::{bridge_request, read_bridge_record, run_with_io, BridgeClient};
    use serde_json::json;
    use std::time::Duration;
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
        sync::oneshot,
        task::JoinHandle,
        time::timeout,
    };

    #[test]
    fn bridge_record_tracks_enable_rotation_and_disable_without_process_environment() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("computer-use-bridge.json");
        assert!(read_bridge_record(&path).is_err());
        for (address, token) in [("127.0.0.1:1234", "first"), ("127.0.0.1:5678", "rotated")] {
            std::fs::write(&path, json!({"address":address,"token":token}).to_string()).unwrap();
            let record = read_bridge_record(&path).unwrap();
            assert_eq!(record.address, address);
            assert_eq!(record.token, token);
        }
        std::fs::remove_file(&path).unwrap();
        assert!(read_bridge_record(&path).is_err());
    }

    #[test]
    fn bridge_record_rejects_invalid_credentials_without_disclosing_them() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("computer-use-bridge.json");
        for contents in [
            r#"{"address":"127.0.0.1:1234","token":"private-token""#,
            r#"{"address":"127.0.0.1:1234"}"#,
            r#"{"address":" ","token":"private-token"}"#,
            r#"{"address":"127.0.0.1:1234","token":" "}"#,
        ] {
            std::fs::write(&path, contents).unwrap();
            let error = read_bridge_record(&path)
                .err()
                .expect("invalid record accepted");
            assert!(!error.contains("private-token"));
        }
    }

    #[tokio::test]
    async fn existing_client_uses_rotated_bridge_and_fails_closed_after_disable() {
        let home = tempfile::tempdir().unwrap();
        let bridge = BridgeClient {
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            runtime_path: home.path().join("bridge.json"),
        };
        for token in ["first", "rotated"] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let app = axum::Router::new().route(
                "/computer",
                axum::routing::post(move |headers: axum::http::HeaderMap| async move {
                    assert_eq!(headers["authorization"], format!("Bearer {token}"));
                    axum::Json(json!({"ok":true,"data":{"generation":token}}))
                }),
            );
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            std::fs::write(
                &bridge.runtime_path,
                json!({"address":address.to_string(),"token":token}).to_string(),
            )
            .unwrap();
            assert_eq!(
                bridge_request(&bridge, json!({"action":"listTools"}))
                    .await
                    .unwrap(),
                json!({"generation":token})
            );
            server.abort();
        }
        std::fs::remove_file(&bridge.runtime_path).unwrap();
        assert_eq!(
            bridge_request(&bridge, json!({"action":"listTools"}))
                .await
                .unwrap_err(),
            "Computer use bridge record is unavailable"
        );
    }

    async fn pending_bridge() -> (
        BridgeClient,
        oneshot::Receiver<()>,
        JoinHandle<()>,
        tempfile::TempDir,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let home = tempfile::tempdir().unwrap();
        let runtime_path = home.path().join("bridge.json");
        std::fs::write(
            &runtime_path,
            json!({"address":listener.local_addr().unwrap().to_string(),"token":"test-token"})
                .to_string(),
        )
        .unwrap();
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
                runtime_path,
            },
            received,
            closed,
            home,
        )
    }

    #[tokio::test]
    async fn cancellation_closes_http_while_pending_calls_do_not_block_ping() {
        for request_id in [json!(1), json!("session-start")] {
            let (bridge, entered, closed, _home) = pending_bridge().await;
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
        let (bridge, entered, closed, _home) = pending_bridge().await;
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
}
