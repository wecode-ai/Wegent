// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Follow-up prompts use the prior user/assistant pair and optional secondary LLM.

use crate::{AppState, responses::create::dispatch::ExecutionRequest};
use anyhow::Result;
use brz_mysql::{FromMysqlRow, Json};
use serde_json::{Value, json};

pub(super) struct Intent {
    pub prompt: String,
    pub image: Option<String>,
    pub mode: Option<String>,
}
#[derive(FromMysqlRow)]
struct Previous {
    role: String,
    prompt: Option<String>,
    result: Option<Json<Value>>,
}

pub(super) async fn analyze(
    state: &AppState,
    request: &ExecutionRequest,
    current: &str,
) -> Result<Intent> {
    let tables = state.task_store.table_templates();
    let previous:Vec<Previous>=state.mysql.route(crate::task_routing::ByTaskId(request.task_id as u64)).fetch_all(format!("SELECT role,prompt,result FROM {} WHERE task_id=? AND id<>? AND id<>? ORDER BY message_id,id",tables.subtasks),(request.task_id,request.subtask_id,request.user_subtask_id.unwrap_or(0))).await?;
    if previous.len() < 2 {
        return Ok(Intent {
            prompt: current.into(),
            image: None,
            mode: None,
        });
    }
    let user = previous.iter().rev().find(|row| row.role == "USER");
    let assistant = previous.iter().rev().find(|row| row.role == "ASSISTANT");
    let (Some(user), Some(assistant)) = (user, assistant) else {
        return Ok(Intent {
            prompt: current.into(),
            image: None,
            mode: None,
        });
    };
    let previous = user.prompt.as_deref().unwrap_or("");
    let image = assistant
        .result
        .as_ref()
        .and_then(|result| result.0["image"].as_str())
        .filter(|url| !url.is_empty())
        .map(str::to_owned);
    let secondary = &request.model_config["secondary_model_config"];
    let fallback = || Intent {
        prompt: format!("{previous}\n\n{current}"),
        mode: image.as_ref().map(|_| "reference".into()),
        image: image.clone(),
    };
    if !crate::json_compat::python_truthy(secondary) {
        return Ok(fallback());
    }
    let prompt = format!(
        "You are a video generation intent analysis assistant. The user is in a multi-turn video generation conversation.\n\nPrevious user prompt: {previous}\nCurrent user prompt: {current}\nHas reference image from previous turn: {}\n\nPlease analyze the user intent and output JSON:\n{{\n    \"merged_prompt\": \"Merged and optimized video generation prompt\",\n    \"should_use_image\": true/false,\n    \"image_mode\": \"first_frame\" | \"last_frame\" | \"reference\" | null\n}}\n\nRules:\n- merged_prompt: Merge the two prompts into a complete, coherent video generation description\n- should_use_image: Only true when has_image=true AND user intent implies using the image\n- image_mode:\n  - \"first_frame\": Video starts from this image\n  - \"last_frame\": Video ends with this image\n  - \"reference\": Reference the style/content of this image\n\nOutput JSON only.",
        image.is_some()
    );
    let result = call_llm(secondary, &prompt).await;
    let result = match result {
        Ok(value) => value,
        Err(_error) => return Ok(fallback()),
    };
    Ok(project(&result, current, image))
}

fn project(result: &Value, current: &str, image: Option<String>) -> Intent {
    Intent {
        prompt: result["merged_prompt"].as_str().unwrap_or(current).into(),
        image: if crate::json_compat::python_truthy(&result["should_use_image"]) {
            image
        } else {
            None
        },
        mode: result["image_mode"]
            .as_str()
            .filter(|mode| matches!(*mode, "first_frame" | "last_frame" | "reference"))
            .map(str::to_owned),
    }
}

async fn call_llm(config: &Value, prompt: &str) -> Result<Value> {
    let base = config["base_url"]
        .as_str()
        .filter(|base| !base.is_empty())
        .unwrap_or("https://api.openai.com/v1")
        .trim_end_matches('/');
    let http = brz_http::Client::builder()
        .read_timeout(std::time::Duration::from_secs(600))
        .build()?;
    let response=http.as_reqwest().post(format!("{base}/chat/completions")).bearer_auth(config["api_key"].as_str().unwrap_or("")).json(&json!({"model":config["model_id"].as_str().unwrap_or("gpt-4o-mini"),"messages":[{"role":"user","content":prompt}],"temperature":0,"response_format":{"type":"json_object"}})).send().await?.error_for_status()?;
    let bytes =
        super::super::super::knowledge::sources::bounded_body(response, 4 * 1024 * 1024).await?;
    let response: Value = serde_json::from_slice(&bytes)?;
    Ok(serde_json::from_str(
        response["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or(""),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secondary_intent_cannot_reuse_an_image_without_explicit_intent() {
        let intent = project(
            &json!({"merged_prompt":"optimized","should_use_image":false,"image_mode":"invalid"}),
            "current",
            Some("old".into()),
        );
        assert_eq!(intent.prompt, "optimized");
        assert!(intent.image.is_none());
        assert!(intent.mode.is_none());
        let intent = project(
            &json!({"should_use_image":true,"image_mode":"last_frame"}),
            "current",
            Some("old".into()),
        );
        assert_eq!(intent.prompt, "current");
        assert_eq!(intent.image.as_deref(), Some("old"));
        assert_eq!(intent.mode.as_deref(), Some("last_frame"));
    }
}
