// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{env, future::Future, pin::Pin, process::Stdio, time::Duration};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout, Command},
    time::timeout,
};

use crate::{
    protocol::ExecutionRequest,
    runner::{AgentEngine, ExecutionOutcome},
};

use super::{model_id, prompt_text};

const DEFAULT_CODEX_RPC_TIMEOUT_SECONDS: u64 = 300;

#[derive(Debug, Clone)]
pub struct CodexAppServerEngine {
    binary: String,
}

impl CodexAppServerEngine {
    pub fn new(binary: impl Into<String>) -> Self {
        Self {
            binary: binary.into(),
        }
    }
}

impl AgentEngine for CodexAppServerEngine {
    type RunFuture = Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>;

    fn run(&self, request: ExecutionRequest) -> Self::RunFuture {
        let binary = self.binary.clone();
        Box::pin(async move {
            match run_codex_turn(&binary, request).await {
                Ok(outcome) => outcome,
                Err(message) => ExecutionOutcome::Failed { message },
            }
        })
    }
}

async fn run_codex_turn(
    binary: &str,
    request: ExecutionRequest,
) -> Result<ExecutionOutcome, String> {
    let mut child = Command::new(binary)
        .arg("app-server")
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("failed to start codex app-server: {error}"))?;

    let result = async {
        let timeout_seconds = codex_rpc_timeout_seconds();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "codex app-server stdin was not captured".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "codex app-server stdout was not captured".to_owned())?;
        let mut rpc = JsonRpcConnection::new(stdin, stdout);
        let mut state = CodexRunState::default();

        with_rpc_timeout(
            "initialize",
            timeout_seconds,
            rpc.request("initialize", initialize_params(), &mut state),
        )
        .await?;
        with_rpc_timeout(
            "initialized",
            timeout_seconds,
            rpc.notify("initialized", json!({})),
        )
        .await?;

        let thread = with_rpc_timeout(
            "thread/start",
            timeout_seconds,
            rpc.request("thread/start", thread_start_params(&request), &mut state),
        )
        .await?;
        let thread_id = thread
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| "codex app-server thread/start did not return thread.id".to_owned())?;

        let turn_request_id = with_rpc_timeout(
            "turn/start",
            timeout_seconds,
            rpc.send_request("turn/start", turn_start_params(thread_id, &request)),
        )
        .await?;
        with_rpc_timeout(
            "turn",
            timeout_seconds,
            rpc.read_turn(turn_request_id, &mut state),
        )
        .await
    }
    .await;

    let _ = child.start_kill();
    let _ = child.wait().await;
    result
}

async fn with_rpc_timeout<T>(
    operation: &str,
    timeout_seconds: u64,
    future: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    match timeout(Duration::from_secs(timeout_seconds), future).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "codex app-server {operation} timed out after {timeout_seconds}s"
        )),
    }
}

fn codex_rpc_timeout_seconds() -> u64 {
    env::var("WEGENT_CODEX_RPC_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_CODEX_RPC_TIMEOUT_SECONDS)
}

struct JsonRpcConnection {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl JsonRpcConnection {
    fn new(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        Self {
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        }
    }

    async fn request(
        &mut self,
        method: &str,
        params: Value,
        state: &mut CodexRunState,
    ) -> Result<Value, String> {
        let request_id = self.send_request(method, params).await?;
        loop {
            let message = self.read_message().await?;
            if response_id(&message) == Some(request_id) {
                return response_result(message);
            }
            if let Some(outcome) = state.handle_message(&message) {
                return Err(format!(
                    "codex app-server completed before {method} response: {outcome:?}"
                ));
            }
        }
    }

    async fn send_request(&mut self, method: &str, params: Value) -> Result<u64, String> {
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

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write_message(json!({
            "method": method,
            "params": params,
        }))
        .await
    }

    async fn read_turn(
        &mut self,
        turn_request_id: u64,
        state: &mut CodexRunState,
    ) -> Result<ExecutionOutcome, String> {
        let mut saw_turn_response = false;
        loop {
            let message = self.read_message().await?;
            if response_id(&message) == Some(turn_request_id) {
                response_result(message)?;
                saw_turn_response = true;
                continue;
            }
            if let Some(outcome) = state.handle_message(&message) {
                return Ok(outcome);
            }
            if !saw_turn_response {
                continue;
            }
        }
    }

    async fn write_message(&mut self, message: Value) -> Result<(), String> {
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

    async fn read_message(&mut self) -> Result<Value, String> {
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

#[derive(Default)]
struct CodexRunState {
    final_text: String,
    saw_delta: bool,
}

impl CodexRunState {
    fn handle_message(&mut self, message: &Value) -> Option<ExecutionOutcome> {
        match message.get("method").and_then(Value::as_str) {
            Some("item/agentMessage/delta") => {
                self.append_delta(params(message));
                None
            }
            Some("item/completed") => {
                self.append_completed_message(params(message));
                None
            }
            Some("turn/completed") => Some(self.completed(params(message))),
            Some("error") => Some(ExecutionOutcome::Failed {
                message: params(message)
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("codex app-server error")
                    .to_owned(),
            }),
            _ => None,
        }
    }

    fn append_delta(&mut self, params: &Value) {
        let phase = params
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or("")
            .replace('_', "")
            .to_ascii_lowercase();
        if !phase.is_empty() && phase != "finalanswer" {
            return;
        }
        if let Some(delta) = params.get("delta").and_then(Value::as_str) {
            self.final_text.push_str(delta);
            self.saw_delta = true;
        }
    }

    fn append_completed_message(&mut self, params: &Value) {
        if self.saw_delta {
            return;
        }
        let item = params.get("item").unwrap_or(params);
        let item_type = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .replace('_', "")
            .to_ascii_lowercase();
        if !matches!(item_type.as_str(), "agentmessage" | "message") {
            return;
        }
        if item
            .get("role")
            .and_then(Value::as_str)
            .is_some_and(|role| role != "assistant")
        {
            return;
        }
        if let Some(text) = extract_text(item) {
            self.final_text = text;
            self.saw_delta = true;
        }
    }

    fn completed(&self, params: &Value) -> ExecutionOutcome {
        let status = params
            .get("turn")
            .and_then(|turn| turn.get("status"))
            .or_else(|| params.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("completed")
            .to_ascii_lowercase();
        match status.as_str() {
            "completed" | "complete" | "succeeded" => ExecutionOutcome::Completed {
                content: self.final_text.clone(),
            },
            "cancelled" | "canceled" | "interrupted" => {
                ExecutionOutcome::Cancelled { message: status }
            }
            other => ExecutionOutcome::Failed {
                message: format!("codex turn ended with status {other}"),
            },
        }
    }
}

fn initialize_params() -> Value {
    json!({
        "clientInfo": {
            "name": "wegent_executor",
            "title": "Wegent Executor",
            "version": crate::version::get_version(),
        }
    })
}

fn thread_start_params(request: &ExecutionRequest) -> Value {
    let mut params = serde_json::Map::new();
    if let Some(model) = model_id(request) {
        params.insert("model".to_owned(), Value::String(model));
    }
    if let Some(cwd) = request.cwd() {
        params.insert("cwd".to_owned(), Value::String(cwd.to_owned()));
    }
    params.insert(
        "approvalPolicy".to_owned(),
        Value::String("never".to_owned()),
    );
    Value::Object(params)
}

fn turn_start_params(thread_id: &str, request: &ExecutionRequest) -> Value {
    let mut params = serde_json::Map::new();
    params.insert("threadId".to_owned(), Value::String(thread_id.to_owned()));
    params.insert(
        "input".to_owned(),
        Value::Array(vec![
            json!({"type": "text", "text": prompt_text(&request.prompt)}),
        ]),
    );
    params.insert(
        "approvalPolicy".to_owned(),
        Value::String("never".to_owned()),
    );
    params.insert(
        "sandboxPolicy".to_owned(),
        json!({"type": "dangerFullAccess"}),
    );
    if let Some(cwd) = request.cwd() {
        params.insert("cwd".to_owned(), Value::String(cwd.to_owned()));
    }
    if let Some(model) = model_id(request) {
        params.insert("model".to_owned(), Value::String(model));
    }
    if let Some(effort) = string_config(&request.model_config, "reasoning_effort")
        .or_else(|| nested_string_config(&request.model_config, "reasoning", "effort"))
    {
        params.insert("effort".to_owned(), Value::String(effort));
    }
    if let Some(summary) = string_config(&request.model_config, "reasoning_summary")
        .or_else(|| nested_string_config(&request.model_config, "reasoning", "summary"))
    {
        params.insert("summary".to_owned(), Value::String(summary));
    }
    Value::Object(params)
}

fn response_id(message: &Value) -> Option<u64> {
    message.get("id").and_then(Value::as_u64)
}

fn response_result(message: Value) -> Result<Value, String> {
    if let Some(error) = message.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| error.to_string()));
    }
    Ok(message.get("result").cloned().unwrap_or_else(|| json!({})))
}

fn params(message: &Value) -> &Value {
    message.get("params").unwrap_or(message)
}

fn extract_text(item: &Value) -> Option<String> {
    if let Some(text) = item.get("text").and_then(Value::as_str) {
        return Some(text.to_owned());
    }
    if let Some(content) = item.get("content").and_then(Value::as_str) {
        return Some(content.to_owned());
    }
    let text = item
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| {
            part.get("text")
                .or_else(|| part.get("content"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn string_config(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn nested_string_config(value: &Value, parent: &str, key: &str) -> Option<String> {
    string_config(value.get(parent)?, key)
}
