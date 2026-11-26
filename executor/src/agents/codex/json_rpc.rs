// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use tokio::{io::AsyncWriteExt, process::ChildStdin};

use super::{
    codex_error_message, debug_stdout::CodexStdout, message_params, response_id, response_result,
};

pub(super) struct JsonRpcConnection {
    stdin: ChildStdin,
    stdout: CodexStdout,
    next_id: u64,
}

impl JsonRpcConnection {
    pub(super) fn new(stdin: ChildStdin, stdout: CodexStdout, next_id: u64) -> Self {
        Self {
            stdin,
            stdout,
            next_id,
        }
    }

    pub(super) fn into_parts(self) -> (ChildStdin, CodexStdout, u64) {
        (self.stdin, self.stdout, self.next_id)
    }

    pub(super) async fn request_ignoring_notifications(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let request_id = self.send_request(method, params).await?;
        loop {
            let message = self.read_message().await?;
            if response_id(&message) == Some(request_id) {
                return response_result(message);
            }
            if message.get("method").and_then(Value::as_str) == Some("error") {
                return Err(codex_error_message(message_params(&message)));
            }
        }
    }

    pub(super) async fn send_request(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<u64, String> {
        let request_id = self.next_id;
        self.next_id += 1;
        self.write_message(json!({
            "method": method,
            "id": request_id,
            "params": params,
        }))
        .await?;
        Ok(request_id)
    }

    pub(super) async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write_message(json!({
            "method": method,
            "params": params,
        }))
        .await
    }

    pub(super) async fn write_message(&mut self, message: Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(&message)
            .map_err(|error| format!("failed to encode codex JSON-RPC message: {error}"))?;
        line.push(b'\n');
        self.stdin
            .write_all(&line)
            .await
            .map_err(|error| format!("failed to write codex JSON-RPC message: {error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("failed to flush codex JSON-RPC message: {error}"))
    }

    pub(super) async fn read_message(&mut self) -> Result<Value, String> {
        let mut line = String::new();
        let bytes_read = self
            .stdout
            .read_line(&mut line)
            .await
            .map_err(|error| format!("failed to read codex JSON-RPC message: {error}"))?;
        if bytes_read == 0 {
            return Err("codex app-server exited before completing the turn".to_owned());
        }
        serde_json::from_str(&line)
            .map_err(|error| format!("failed to parse codex JSON-RPC message: {error}"))
    }
}
