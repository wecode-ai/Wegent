// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Hidden Chat tasks reuse the ordinary stream persistence and terminal hooks.

use anyhow::{Context, Result};
use brz_mysql::MysqlTransaction;
use chrono::Utc;
use serde_json::{Value, json};

use crate::{
    AppState,
    responses::create::{dispatch::ExecutionRequest, sse_sync},
    task_store_background::BackgroundRecords,
};

pub struct BackgroundChat<'a> {
    pub user_id: i64,
    pub title: &'a str,
    pub task_type: &'a str,
    pub summary_type: &'a str,
    pub document_id: Option<i64>,
    pub knowledge_base_id: Option<i64>,
    pub system_prompt: &'a str,
    pub prompt: &'a str,
    pub model_config: Value,
}

pub struct ChatResult {
    pub task_id: i64,
    pub content: String,
    pub parsed: Option<Value>,
}

pub async fn execute(state: &AppState, input: BackgroundChat<'_>) -> Result<ChatResult> {
    let now = Utc::now()
        .naive_utc()
        .format("%Y-%m-%dT%H:%M:%S%.f")
        .to_string();
    let records = BackgroundRecords {
        user_id: input.user_id,
        title: input.title,
        task_type: input.task_type,
        summary_type: input.summary_type,
        document_id: input.document_id,
        knowledge_base_id: input.knowledge_base_id,
        prompt: input.prompt,
        now: &now,
    };
    let ids = state
        .task_store
        .create_background_task_records(&state.mysql, &records)
        .await?;
    let request_id = crate::task_creation::pending_task_name();
    let request = ExecutionRequest {
        task_id: ids.task_id,
        subtask_id: ids.assistant_subtask_id,
        user_subtask_id: Some(ids.user_subtask_id),
        team_id: 0,
        team_name: "system-background".into(),
        user: json!({"id":input.user_id,"name":"system"}),
        user_id: input.user_id,
        user_name: "system".into(),
        bot: json!([{"name":"system-background","shell_type":"Chat","system_prompt":input.system_prompt,"mcp_servers":[],"skills":[]}]),
        model_config: input.model_config,
        system_prompt: input.system_prompt.into(),
        prompt: input.prompt.into(),
        enable_tools: false,
        enable_web_search: false,
        enable_deep_thinking: false,
        message_id: Some(ids.assistant_subtask_id),
        request_id: request_id.clone(),
        ..ExecutionRequest::default()
    };
    let base = crate::config::env_or_dotenv("CHAT_SHELL_URL")
        .unwrap_or_else(|| "http://localhost:8001".into());
    let consumer = sse_sync::ConsumerContext::from_app(state);
    let content = sse_sync::collect(&consumer, &base, &request, &request_id, request.message_id)
        .await
        .map_err(anyhow::Error::msg)?
        .content;
    let parsed = parse_json(&content);
    let result = json!({"value":content,"parsed":parsed});
    // SSE has already persisted the terminal status. Attach the parsed result
    // without reviving a cancelled or concurrently deleted attempt.
    let tables = state.task_store.table_templates();
    let mysql = state
        .mysql
        .route(crate::task_routing::ByTaskId(ids.task_id as u64));
    mysql.with_transaction(async |tx| {
        tx.execute(format!("UPDATE {} SET result=?,updated_at=NOW() WHERE id=? AND task_id=? AND user_id=? AND status='COMPLETED'",tables.subtasks),
            (brz_mysql::Json(&result),ids.assistant_subtask_id,ids.task_id,input.user_id)).await?;
        Ok(())
    }).await?;
    Ok(ChatResult {
        task_id: ids.task_id,
        content,
        parsed,
    })
}

pub fn parse_json(text: &str) -> Option<Value> {
    let text = text.trim();
    if let Ok(value) = serde_json::from_str::<Value>(text)
        && value.is_object()
    {
        return Some(value);
    }
    // Models may wrap their response in a Markdown fence or leading prose.
    // The streaming JSON parser identifies the matching closing delimiter,
    // including braces inside quoted strings.
    for (offset, ch) in text.char_indices() {
        if ch != '{' {
            continue;
        }
        let mut stream = serde_json::Deserializer::from_str(&text[offset..]).into_iter::<Value>();
        if let Some(Ok(value)) = stream.next()
            && value.is_object()
        {
            return Some(value);
        }
    }
    None
}

pub async fn model_config(
    _state: &AppState,
    spec: &Value,
    user_id: i64,
    user_name: &str,
) -> Result<Value> {
    let mut full = crate::responses::create::model_config::extract_model_config(spec)
        .map_err(|_| anyhow::anyhow!("Summary model configuration is invalid"))?;
    let processed =
        crate::llm_proxy::model_config::extract_and_process_model_config(spec, user_id, user_name)
            .map_err(|_| anyhow::anyhow!("Summary model credentials could not be resolved"))?;
    full.insert("api_key".into(), processed.api_key.into());
    full.insert("base_url".into(), processed.base_url.into());
    full.insert("model_id".into(), processed.model_id.into());
    full.insert(
        "default_headers".into(),
        serde_json::to_value(
            processed
                .default_headers
                .into_iter()
                .collect::<std::collections::BTreeMap<_, _>>(),
        )?,
    );
    if let Some(protocol) = processed.protocol {
        full.insert("protocol".into(), protocol.into());
    }
    if let Some(format) = processed.api_format {
        full.insert("api_format".into(), format.into());
    }
    let value = Value::Object(full);
    value
        .as_object()
        .context("Model configuration must be an object")?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_fenced_json_without_splitting_quoted_braces() {
        assert_eq!(
            parse_json("text\n```json\n{\"short_summary\":\"a } b\"}\n```"),
            Some(json!({"short_summary":"a } b"}))
        );
        assert_eq!(parse_json("no JSON"), None);
    }
}
