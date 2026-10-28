// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Gemini Interaction API research preserves thought and final-report events.

use crate::{AppState, responses::create::dispatch::ExecutionRequest};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

pub(super) async fn execute(state: &AppState, request: &ExecutionRequest) -> Result<()> {
    super::emit(
        state,
        request,
        "chat:start",
        json!({"type":"start","shell_type":"Chat"}),
    )
    .await?;
    let model = &request.model_config;
    let input = request
        .prompt
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| request.prompt.to_string());
    let create_endpoint = endpoint(model, None)?;
    let response=http(model,brz_http::Method::POST,create_endpoint,30)?.json(&json!({"background":true,"stream":false,"agent":model["model_id"].as_str().unwrap_or("deep-research-pro-preview-12-2025"),"input":input})).send().await?;
    let created = body(response).await?;
    let id = created["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .context("No interaction id returned")?;
    let endpoint = endpoint(model, Some(id))?;
    let mut completed = false;
    for _ in 0..720 {
        if super::cancelled(state, request).await? {
            super::finish(state, request, "CANCELLED", None, None).await?;
            super::emit(
                state,
                request,
                "chat:cancelled",
                json!({"type":"cancelled"}),
            )
            .await?;
            return Ok(());
        }
        let status = match http(model, brz_http::Method::GET, endpoint.clone(), 30)?
            .send()
            .await
        {
            Ok(response) => body(response).await,
            Err(error) => Err(error.into()),
        };
        match status {
            Ok(status) if status["status"] == "completed" => {
                completed = true;
                break;
            }
            Ok(status) if status["status"] == "failed" => bail!(
                "{}",
                status["error"]
                    .as_str()
                    .unwrap_or("Deep research job failed")
            ),
            Ok(_) => {
                if let Ok(events) = stream(model, endpoint.clone(), 30, true).await {
                    let thoughts = thoughts(&events);
                    if !thoughts.is_empty() {
                        super::emit(state,request,"chat:chunk",json!({"type":"chunk","content":"","offset":0,"result":{"shell_type":"Chat","thinking":thoughts}})).await?;
                    }
                }
            }
            Err(_) => {}
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
    if !completed {
        bail!("Deep research job timed out after 1 hour")
    }
    super::emit(state,request,"chat:chunk",json!({"type":"chunk","content":"","offset":0,"result":{"shell_type":"Chat","thinking":[]}})).await?;
    let events = stream(model, endpoint, 300, false).await?;
    let result = report(&events);
    if let Some(text) = result["value"].as_str().filter(|text| !text.is_empty()) {
        super::emit(
            state,
            request,
            "chat:chunk",
            json!({"type":"chunk","content":text,"offset":0}),
        )
        .await?;
    }
    if super::cancelled(state, request).await? {
        super::finish(state, request, "CANCELLED", None, None).await?;
        return Ok(());
    }
    super::finish(state, request, "COMPLETED", Some(&result), None).await?;
    super::emit(
        state,
        request,
        "chat:done",
        json!({"type":"done","result":result}),
    )
    .await?;
    Ok(())
}

fn endpoint(config: &Value, id: Option<&str>) -> Result<url::Url> {
    let base = config["base_url"]
        .as_str()
        .filter(|base| !base.is_empty())
        .unwrap_or("https://generativelanguage.googleapis.com")
        .trim_end_matches('/');
    let mut url = url::Url::parse(&format!("{base}/v1beta/interactions"))?;
    if let Some(id) = id {
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("Invalid research endpoint"))?
            .push(id);
    }
    Ok(url)
}

fn http(
    config: &Value,
    method: brz_http::Method,
    url: url::Url,
    timeout: u64,
) -> Result<brz_http::reqwest::RequestBuilder> {
    let http = brz_http::Client::builder()
        .read_timeout(std::time::Duration::from_secs(timeout))
        .build()?;
    let mut request = http
        .as_reqwest()
        .request(method, url)
        .header("Content-Type", "application/json");
    if let Some(headers) = config["default_headers"].as_object() {
        for (key, value) in headers {
            if let Some(value) = value.as_str() {
                request = request.header(key, value);
            }
        }
    }
    if let Some(key) = config["api_key"].as_str().filter(|key| !key.is_empty()) {
        request = request.header("x-goog-api-key", key);
    }
    Ok(request)
}

async fn body(response: brz_http::reqwest::Response) -> Result<Value> {
    let response = response.error_for_status()?;
    let bytes =
        super::super::super::knowledge::sources::bounded_body(response, 16 * 1024 * 1024).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

async fn stream(
    config: &Value,
    mut endpoint: url::Url,
    timeout: u64,
    thoughts_only: bool,
) -> Result<Vec<(String, Value)>> {
    endpoint.query_pairs_mut().append_pair("stream", "true");
    let mut response = http(config, brz_http::Method::GET, endpoint, timeout)?
        .send()
        .await?
        .error_for_status()?;
    let mut buffer = Vec::new();
    let mut events = Vec::new();
    let mut total = 0;
    while let Some(chunk) = response.chunk().await? {
        total += chunk.len();
        if total > 16 * 1024 * 1024 {
            bail!("Research response exceeded its size limit")
        }
        buffer.extend(chunk.iter().copied().filter(|byte| *byte != b'\r'));
        while let Some(index) = buffer.windows(2).position(|pair| pair == b"\n\n") {
            let bytes = buffer.drain(..index + 2).collect::<Vec<_>>();
            if let Some(event) = parse_frame(&bytes) {
                if thoughts_only && starts_report(&event) {
                    return Ok(events);
                }
                events.push(event);
            }
        }
    }
    if let Some(event) = parse_frame(&buffer)
        && (!thoughts_only || !starts_report(&event))
    {
        events.push(event);
    }
    Ok(events)
}

fn parse_frame(frame: &[u8]) -> Option<(String, Value)> {
    let text = std::str::from_utf8(frame).ok()?;
    let mut kind = "";
    let mut data = Vec::new();
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("event:") {
            kind = value.trim_start();
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.trim_start());
        }
    }
    let value: Value = serde_json::from_str(&data.join("\n")).ok()?;
    Some((
        value["event_type"].as_str().unwrap_or(kind).to_owned(),
        value,
    ))
}

fn starts_report(event: &(String, Value)) -> bool {
    (event.0 == "content.start" && event.1["index"] == 1)
        || (event.0 == "content.delta"
            && event.1["index"] == 0
            && event.1["delta"]["type"] == "text")
}

fn thoughts(events: &[(String, Value)]) -> Vec<Value> {
    let mut result = Vec::new();
    for (kind, event) in events {
        if kind != "content.delta"
            || event["index"] != 0
            || event["delta"]["type"] != "thought_summary"
        {
            continue;
        }
        let text = event["delta"]["content"]["text"]
            .as_str()
            .unwrap_or("")
            .trim();
        let text = text
            .strip_prefix("```json")
            .or_else(|| text.strip_prefix("```"))
            .unwrap_or(text);
        let text = text.strip_suffix("```").unwrap_or(text).trim();
        if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(text) {
            result=items.into_iter().map(|item|json!({"title":item["title"].as_str().unwrap_or("Research Progress"),"next_action":"continue","details":{"type":"text","text":item["content"].as_str().unwrap_or("")}})).collect();
        }
    }
    result
}

fn report(events: &[(String, Value)]) -> Value {
    let mut text = String::new();
    let mut annotations = Vec::new();
    for (kind, event) in events {
        if kind == "content.delta"
            && (event["index"] == 1 || (event["index"] == 0 && event["delta"]["type"] == "text"))
        {
            text.push_str(event["delta"]["text"].as_str().unwrap_or(""));
            if let Some(values) = event["delta"]["annotations"].as_array() {
                annotations.extend(values.iter().cloned());
            }
        }
    }
    let mut result = json!({"value":text});
    if !annotations.is_empty() {
        result["annotations"] = json!(annotations);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interaction_events_separate_thoughts_from_the_report_and_keep_annotations() {
        let thought = (
            "content.delta".into(),
            json!({"index":0,"delta":{"type":"thought_summary","content":{"text":"```json\n[{\"title\":\"Searching\",\"content\":\"sources\"}]\n```"}}}),
        );
        let report_event = (
            "content.delta".into(),
            json!({"index":1,"delta":{"type":"text","text":"报告","annotations":[{"url":"https://example.test"}]}}),
        );
        assert_eq!(
            thoughts(std::slice::from_ref(&thought))[0]["details"]["text"],
            "sources"
        );
        assert_eq!(report(&[thought, report_event])["value"], "报告");
        assert!(starts_report(&(
            "content.delta".into(),
            json!({"index":0,"delta":{"type":"text"}})
        )));
    }
    #[test]
    fn sse_event_json_can_override_the_envelope_event_type() {
        let event=parse_frame("event: message\ndata: {\"event_type\":\"content.delta\",\"index\":0,\"delta\":{\"type\":\"text\",\"text\":\"研究\"}}\n\n".as_bytes()).unwrap();
        assert_eq!(event.0, "content.delta");
        assert_eq!(report(&[event])["value"], "研究");
    }
}
