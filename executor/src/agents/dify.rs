// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::HashMap, future::Future, pin::Pin, sync::Mutex};

use reqwest::Client;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

use crate::{
    agents::prompt_text,
    protocol::ExecutionRequest,
    runner::{AgentEngine, ExecutionOutcome},
};

const DEFAULT_DIFY_BASE_URL: &str = "https://api.dify.ai";
const PARAMS_START: &str = "[EXTERNAL_API_PARAMS]";
const PARAMS_END: &str = "[/EXTERNAL_API_PARAMS]";

#[derive(Debug, Clone)]
pub struct DifyEngine {
    client: Client,
}

impl DifyEngine {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
        }
    }
}

impl Default for DifyEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentEngine for DifyEngine {
    type RunFuture = Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>;

    fn run(&self, request: ExecutionRequest) -> Self::RunFuture {
        let client = self.client.clone();
        Box::pin(async move {
            match run_dify(client, request).await {
                Ok(answer) if !answer.is_empty() => ExecutionOutcome::Completed { content: answer },
                Ok(_) => ExecutionOutcome::Failed {
                    message: "No answer received from Dify application".to_owned(),
                },
                Err(message) => ExecutionOutcome::Failed { message },
            }
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DifyRequestConfig {
    pub api_key: String,
    pub base_url: String,
    pub app_id: String,
    pub prompt: String,
    pub params: Map<String, Value>,
}

pub fn build_dify_config(request: &ExecutionRequest) -> DifyRequestConfig {
    let bot = first_bot(&request.bot);
    let env = bot
        .and_then(|bot| bot.get("agent_config"))
        .and_then(|agent_config| agent_config.get("env"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let bot_prompt = bot
        .and_then(|bot| bot.get("bot_prompt"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let (prompt, prompt_params) = extract_params_from_prompt(&prompt_text(&request.prompt));
    let (bot_app_id, mut params) = parse_bot_prompt(bot_prompt);
    params.extend(parse_dify_params(env.get("DIFY_PARAMS")));
    params.extend(prompt_params);

    DifyRequestConfig {
        api_key: string_env(&env, "DIFY_API_KEY").unwrap_or_default(),
        base_url: string_env(&env, "DIFY_BASE_URL")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_DIFY_BASE_URL.to_owned()),
        app_id: bot_app_id
            .or_else(|| string_env(&env, "DIFY_APP_ID"))
            .unwrap_or_default(),
        prompt,
        params,
    }
}

async fn run_dify(client: Client, request: ExecutionRequest) -> Result<String, String> {
    let config = build_dify_config(&request);
    validate_config(&config)?;
    let app_mode = fetch_app_mode(&client, &config).await;
    if app_mode == "workflow" {
        call_workflow_api(&client, &config, request.task_id).await
    } else {
        call_chat_api(&client, &config, request.task_id).await
    }
}

async fn fetch_app_mode(client: &Client, config: &DifyRequestConfig) -> String {
    let response = client
        .get(format!("{}/v1/info", config.base_url.trim_end_matches('/')))
        .bearer_auth(&config.api_key)
        .send()
        .await;
    match response {
        Ok(response) => response
            .json::<Value>()
            .await
            .ok()
            .and_then(|value| value.get("mode").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_else(|| "chat".to_owned()),
        Err(_) => "chat".to_owned(),
    }
}

async fn call_chat_api(
    client: &Client,
    config: &DifyRequestConfig,
    task_id: i64,
) -> Result<String, String> {
    let mut payload = json!({
        "inputs": config.params,
        "query": config.prompt,
        "response_mode": "streaming",
        "user": format!("task-{task_id}"),
        "auto_generate_name": true,
    });
    if let Some(conversation_id) = conversation_id(task_id) {
        payload["conversation_id"] = Value::String(conversation_id);
    }

    let response = client
        .post(format!(
            "{}/v1/chat-messages",
            config.base_url.trim_end_matches('/')
        ))
        .bearer_auth(&config.api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("Failed to connect to Dify Chat API: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Dify Chat API HTTP error: {error}"))?;

    let body = response
        .text()
        .await
        .map_err(|error| format!("Failed to read Dify Chat API response: {error}"))?;
    let mut answer = String::new();
    let mut conversation_id = None;
    for event in parse_sse_lines(&body)? {
        if let Some(dify_task_id) = event.get("task_id").and_then(Value::as_str) {
            save_dify_task_id(task_id, dify_task_id);
        }
        if conversation_id.is_none() {
            conversation_id = event
                .get("conversation_id")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        match event.get("event").and_then(Value::as_str) {
            Some("message" | "agent_message") => {
                answer.push_str(event.get("answer").and_then(Value::as_str).unwrap_or(""));
            }
            Some("error") => {
                return Err(format!(
                    "Dify API error: {}",
                    event
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Unknown error")
                ));
            }
            _ => {}
        }
    }
    if let Some(conversation_id) = conversation_id {
        save_conversation_id(task_id, conversation_id);
    }
    Ok(answer)
}

async fn call_workflow_api(
    client: &Client,
    config: &DifyRequestConfig,
    task_id: i64,
) -> Result<String, String> {
    let mut inputs = config.params.clone();
    if !inputs.contains_key("query") && !inputs.contains_key("user_query") {
        inputs.insert("query".to_owned(), Value::String(config.prompt.clone()));
    }
    let response = client
        .post(format!(
            "{}/v1/workflows/run",
            config.base_url.trim_end_matches('/')
        ))
        .bearer_auth(&config.api_key)
        .json(&json!({
            "inputs": inputs,
            "response_mode": "streaming",
            "user": format!("task-{task_id}"),
        }))
        .send()
        .await
        .map_err(|error| format!("Failed to connect to Dify Workflow API: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Dify Workflow API HTTP error: {error}"))?;

    let body = response
        .text()
        .await
        .map_err(|error| format!("Failed to read Dify Workflow API response: {error}"))?;
    let mut outputs = Map::new();
    for event in parse_sse_lines(&body)? {
        if let Some(dify_task_id) = event.get("task_id").and_then(Value::as_str) {
            save_dify_task_id(task_id, dify_task_id);
        }
        match event.get("event").and_then(Value::as_str) {
            Some("workflow_finished") => {
                outputs = event
                    .get("data")
                    .and_then(|data| data.get("outputs"))
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
            }
            Some("error") => {
                return Err(format!(
                    "Dify Workflow error: {}",
                    event
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Unknown error")
                ));
            }
            _ => {}
        }
    }
    serde_json::to_string_pretty(&Value::Object(outputs))
        .map_err(|error| format!("Failed to encode Dify workflow outputs: {error}"))
}

fn validate_config(config: &DifyRequestConfig) -> Result<(), String> {
    if config.api_key.trim().is_empty() {
        return Err("DIFY_API_KEY is not configured".to_owned());
    }
    if config.base_url.trim().is_empty() {
        return Err("DIFY_BASE_URL is not configured".to_owned());
    }
    Ok(())
}

fn first_bot(bot: &Value) -> Option<&Map<String, Value>> {
    match bot {
        Value::Object(object) => Some(object),
        Value::Array(items) => items.first()?.as_object(),
        _ => None,
    }
}

fn parse_bot_prompt(bot_prompt: &str) -> (Option<String>, Map<String, Value>) {
    if bot_prompt.trim().is_empty() {
        return (None, Map::new());
    }
    let Ok(value) = serde_json::from_str::<Value>(bot_prompt) else {
        return (None, Map::new());
    };
    let app_id = value
        .get("difyAppId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let params = value
        .get("params")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    (app_id, params)
}

fn parse_dify_params(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(object)) => object.clone(),
        Some(Value::String(raw)) => serde_json::from_str::<Value>(raw)
            .ok()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default(),
        _ => Map::new(),
    }
}

fn extract_params_from_prompt(prompt: &str) -> (String, Map<String, Value>) {
    let Some(start) = prompt.find(PARAMS_START) else {
        return (prompt.to_owned(), Map::new());
    };
    let content_start = start + PARAMS_START.len();
    let Some(relative_end) = prompt[content_start..].find(PARAMS_END) else {
        return (prompt.to_owned(), Map::new());
    };
    let end = content_start + relative_end;
    let params = serde_json::from_str::<Value>(prompt[content_start..end].trim())
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let cleaned = format!("{}{}", &prompt[..start], &prompt[end + PARAMS_END.len()..])
        .trim()
        .to_owned();
    (cleaned, params)
}

fn parse_sse_lines(body: &str) -> Result<Vec<Value>, String> {
    body.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(|line| {
            serde_json::from_str::<Value>(line)
                .map_err(|error| format!("Failed to parse Dify streaming data: {error}"))
        })
        .collect()
}

fn string_env(env: &Map<String, Value>, key: &str) -> Option<String> {
    env.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn conversations() -> &'static Mutex<HashMap<i64, String>> {
    static CONVERSATIONS: OnceLock<Mutex<HashMap<i64, String>>> = OnceLock::new();
    CONVERSATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn dify_task_ids() -> &'static Mutex<HashMap<i64, String>> {
    static DIFY_TASK_IDS: OnceLock<Mutex<HashMap<i64, String>>> = OnceLock::new();
    DIFY_TASK_IDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn conversation_id(task_id: i64) -> Option<String> {
    conversations().lock().ok()?.get(&task_id).cloned()
}

fn save_conversation_id(task_id: i64, conversation_id: String) {
    if let Ok(mut conversations) = conversations().lock() {
        conversations.insert(task_id, conversation_id);
    }
}

pub fn saved_dify_task_id(task_id: i64) -> Option<String> {
    dify_task_ids().lock().ok()?.get(&task_id).cloned()
}

fn save_dify_task_id(task_id: i64, dify_task_id: &str) {
    let dify_task_id = dify_task_id.trim();
    if dify_task_id.is_empty() {
        return;
    }
    if let Ok(mut task_ids) = dify_task_ids().lock() {
        task_ids.insert(task_id, dify_task_id.to_owned());
    }
}
