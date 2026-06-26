// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{future::Future, io::Read, pin::Pin};

use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::read::GzDecoder;
use serde_json::{json, Value};
use wegent_executor::local::app_ipc::{AppIpcError, AppIpcServer, RuntimeWorkHandler};

#[tokio::test]
async fn app_ipc_compresses_large_runtime_rpc_success_results() {
    let server = AppIpcServer::new().with_runtime_work_handler(LargeRuntimeHandler);

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-large",
                "method": "runtime.tasks.transcript",
                "params": {"localTaskId": "large-1"}
            })
            .to_string(),
        )
        .await
        .expect("large runtime response should be returned");

    assert_eq!(response["type"], "response");
    assert_eq!(response["id"], "req-large");
    assert_eq!(response["ok"], true);
    assert_eq!(
        response["result"]["__runtimeRpcEncoding"],
        "gzip+base64+json"
    );

    let decoded = decode_payload(response["result"]["payload"].as_str().unwrap());
    assert_eq!(decoded["success"], true);
    assert_eq!(
        decoded["messages"][0]["content"],
        "large transcript ".repeat(50000)
    );
}

fn decode_payload(payload: &str) -> Value {
    let compressed = STANDARD
        .decode(payload.as_bytes())
        .expect("payload should be valid base64");
    let mut decoder = GzDecoder::new(compressed.as_slice());
    let mut json_text = String::new();
    decoder
        .read_to_string(&mut json_text)
        .expect("payload should be valid gzip");
    serde_json::from_str(&json_text).expect("payload should be valid JSON")
}

struct LargeRuntimeHandler;

impl RuntimeWorkHandler for LargeRuntimeHandler {
    fn handle_runtime_rpc<'a>(
        &'a self,
        _data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(json!({
                "success": true,
                "messages": [{
                    "id": "m1",
                    "role": "assistant",
                    "content": "large transcript ".repeat(50000)
                }]
            }))
        })
    }
}
