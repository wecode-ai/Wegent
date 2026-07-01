// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{future::Future, pin::Pin};

use serde_json::{json, Value};
use wegent_executor::local::app_ipc::{AppIpcError, AppIpcServer, RuntimeWorkHandler};

#[tokio::test]
async fn app_ipc_returns_large_runtime_rpc_success_results_inline() {
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
    assert_eq!(response["result"]["success"], true);
    assert_eq!(
        response["result"]["messages"][0]["content"],
        "large transcript ".repeat(50000)
    );
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
