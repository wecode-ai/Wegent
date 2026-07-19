// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Cross-request tool history for Responses-to-stateless-protocol bridges.
//!
//! Codex may send a tool result using only `previous_response_id` and the
//! output item. Chat Completions and Anthropic Messages both require the
//! original assistant tool call in the same request, so converted providers
//! need a bounded response cache to restore that call before conversion.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    pin::Pin,
    sync::Arc,
};

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use serde_json::Value;
use tokio::sync::RwLock;

const MAX_CACHED_RESPONSES: usize = 512;

#[derive(Debug, Clone, Default)]
struct CachedResponse {
    calls: HashMap<String, Value>,
    order: Vec<String>,
}

#[derive(Debug, Default)]
struct HistoryInner {
    responses: HashMap<String, CachedResponse>,
    response_order: VecDeque<String>,
    responses_by_call: HashMap<String, VecDeque<String>>,
}

#[derive(Debug, Default)]
pub(super) struct CodexToolHistory {
    inner: RwLock<HistoryInner>,
}

impl CodexToolHistory {
    async fn record_response(&self, response: &Value) -> usize {
        let Some(response_id) = response
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            return 0;
        };
        let calls = response
            .get("output")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| call_id(item).map(|id| (id, item.clone())))
            .filter(|(_, item)| is_call(item))
            .collect::<Vec<_>>();
        if calls.is_empty() {
            return 0;
        }
        self.inner.write().await.insert(response_id, calls)
    }

    pub(super) async fn enrich_request(&self, body: &mut Value) -> usize {
        let previous_response_id = body
            .get("previous_response_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let Some(input) = body.get_mut("input") else {
            return 0;
        };
        let original = std::mem::take(input);
        let was_object = original.is_object();
        let items = match original {
            Value::Array(items) => items,
            Value::Object(object) => vec![Value::Object(object)],
            other => {
                *input = other;
                return 0;
            }
        };

        let output_ids = items
            .iter()
            .filter(|item| is_call_output(item))
            .filter_map(call_id)
            .collect::<HashSet<_>>();
        let existing_ids = items
            .iter()
            .filter(|item| is_call(item))
            .filter_map(call_id)
            .collect::<HashSet<_>>();
        let requested_ids = output_ids
            .union(&existing_ids)
            .cloned()
            .collect::<HashSet<_>>();
        let cached = self
            .lookup(previous_response_id.as_deref(), &requested_ids)
            .await;

        let mut restored_group = cached
            .ordered_calls()
            .into_iter()
            .filter(|(id, _)| output_ids.contains(id) && !existing_ids.contains(id))
            .collect::<Vec<_>>();
        let restored_group_ids = restored_group
            .iter()
            .map(|(id, _)| id.clone())
            .collect::<HashSet<_>>();
        let mut group_pending = true;
        let mut seen = HashSet::new();
        let mut changed = 0usize;
        let mut enriched = Vec::with_capacity(items.len() + restored_group.len());

        for mut item in items {
            if is_call(&item) {
                if let Some(id) = call_id(&item) {
                    if let Some(cached_call) = cached.call(&id) {
                        changed += enrich_call(&mut item, cached_call) as usize;
                    }
                    seen.insert(id);
                }
                enriched.push(item);
                continue;
            }
            if is_call_output(&item) {
                if group_pending {
                    for (id, call) in std::mem::take(&mut restored_group) {
                        seen.insert(id);
                        enriched.push(call);
                        changed += 1;
                    }
                    group_pending = false;
                }
                if let Some(id) = call_id(&item) {
                    if !seen.contains(&id) && !restored_group_ids.contains(&id) {
                        if let Some(call) = cached.call(&id).cloned() {
                            seen.insert(id);
                            enriched.push(call);
                            changed += 1;
                        }
                    }
                }
            }
            enriched.push(item);
        }

        if changed == 0 && was_object && enriched.len() == 1 {
            *input = enriched.pop().unwrap_or(Value::Null);
        } else {
            *input = Value::Array(enriched);
        }
        changed
    }

    async fn lookup(
        &self,
        previous_response_id: Option<&str>,
        requested_ids: &HashSet<String>,
    ) -> CachedLookup {
        let inner = self.inner.read().await;
        let previous = previous_response_id.and_then(|id| inner.responses.get(id).cloned());
        let fallback = inner.unique_calls(requested_ids, previous.as_ref());
        CachedLookup { previous, fallback }
    }
}

impl HistoryInner {
    fn insert(&mut self, response_id: &str, calls: Vec<(String, Value)>) -> usize {
        if !self.responses.contains_key(response_id) {
            self.response_order.push_back(response_id.to_owned());
        }
        let cached = self.responses.entry(response_id.to_owned()).or_default();
        let mut indexed = Vec::new();
        for (id, call) in calls {
            if !cached.calls.contains_key(&id) {
                cached.order.push(id.clone());
            }
            cached.calls.insert(id.clone(), call);
            indexed.push(id);
        }
        for id in &indexed {
            let response_ids = self.responses_by_call.entry(id.clone()).or_default();
            if !response_ids
                .iter()
                .any(|cached_id| cached_id == response_id)
            {
                response_ids.push_back(response_id.to_owned());
            }
        }
        self.prune();
        indexed.len()
    }

    fn prune(&mut self) {
        while self.response_order.len() > MAX_CACHED_RESPONSES {
            let Some(response_id) = self.response_order.pop_front() else {
                break;
            };
            self.responses.remove(&response_id);
            for response_ids in self.responses_by_call.values_mut() {
                response_ids.retain(|id| id != &response_id);
            }
            self.responses_by_call
                .retain(|_, response_ids| !response_ids.is_empty());
        }
    }

    fn unique_calls(
        &self,
        requested_ids: &HashSet<String>,
        previous: Option<&CachedResponse>,
    ) -> CachedResponse {
        let mut selected = HashMap::new();
        for id in requested_ids {
            if previous.is_some_and(|response| response.calls.contains_key(id)) {
                continue;
            }
            let Some(response_ids) = self.responses_by_call.get(id) else {
                continue;
            };
            let matches = response_ids
                .iter()
                .filter_map(|response_id| self.responses.get(response_id)?.calls.get(id))
                .collect::<Vec<_>>();
            if matches.len() == 1 {
                selected.insert(id.clone(), matches[0].clone());
            }
        }
        let mut result = CachedResponse::default();
        for response_id in &self.response_order {
            let Some(response) = self.responses.get(response_id) else {
                continue;
            };
            for id in &response.order {
                if let Some(call) = selected.remove(id) {
                    result.order.push(id.clone());
                    result.calls.insert(id.clone(), call);
                }
            }
        }
        result
    }
}

#[derive(Debug, Default)]
struct CachedLookup {
    previous: Option<CachedResponse>,
    fallback: CachedResponse,
}

impl CachedLookup {
    fn call(&self, id: &str) -> Option<&Value> {
        self.previous
            .as_ref()
            .and_then(|response| response.calls.get(id))
            .or_else(|| self.fallback.calls.get(id))
    }

    fn ordered_calls(&self) -> Vec<(String, Value)> {
        let mut seen = HashSet::new();
        let mut calls = Vec::new();
        for response in self.previous.iter().chain(std::iter::once(&self.fallback)) {
            for id in &response.order {
                if seen.insert(id.clone()) {
                    if let Some(call) = response.calls.get(id) {
                        calls.push((id.clone(), call.clone()));
                    }
                }
            }
        }
        calls
    }
}

fn call_id(item: &Value) -> Option<String> {
    item.get("call_id")
        .or_else(|| item.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn item_type(item: &Value) -> Option<&str> {
    item.get("type").and_then(Value::as_str)
}

fn is_call(item: &Value) -> bool {
    matches!(
        item_type(item),
        Some("function_call" | "custom_tool_call" | "tool_search_call")
    )
}

fn is_call_output(item: &Value) -> bool {
    matches!(
        item_type(item),
        Some("function_call_output" | "custom_tool_call_output" | "tool_search_output")
    )
}

fn is_empty(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(value) => value.trim().is_empty(),
        Value::Array(value) => value.is_empty(),
        Value::Object(value) => value.is_empty(),
        _ => false,
    }
}

fn enrich_call(item: &mut Value, cached: &Value) -> bool {
    let mut changed = false;
    for key in [
        "name",
        "namespace",
        "arguments",
        "input",
        "status",
        "execution",
        "reasoning_content",
        "reasoning",
    ] {
        if item.get(key).is_some_and(|value| !is_empty(value)) {
            continue;
        }
        let Some(value) = cached.get(key).filter(|value| !is_empty(value)) else {
            continue;
        };
        if let Some(object) = item.as_object_mut() {
            object.insert(key.to_owned(), value.clone());
            changed = true;
        }
    }
    changed
}

pub(super) fn record_responses_stream<S>(
    stream: S,
    history: Arc<CodexToolHistory>,
) -> impl Stream<Item = Result<Bytes, std::io::Error>>
where
    S: Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static,
{
    let state = (Box::pin(stream), history);
    futures_util::stream::unfold(
        state,
        |(mut stream, history): (Pin<Box<S>>, Arc<CodexToolHistory>)| async move {
            let item = stream.next().await?;
            if let Ok(bytes) = &item {
                inspect_completed_events(bytes, history.as_ref()).await;
            }
            Some((item, (stream, history)))
        },
    )
}

async fn inspect_completed_events(bytes: &Bytes, history: &CodexToolHistory) {
    let text = String::from_utf8_lossy(bytes);
    for line in text.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<Value>(data.trim()) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) == Some("response.completed") {
            if let Some(response) = event.get("response") {
                history.record_response(response).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use serde_json::json;

    #[tokio::test]
    async fn restores_custom_call_before_tool_output() {
        let history = CodexToolHistory::default();
        history
            .record_response(&json!({
                "id": "resp_1",
                "output": [{
                    "type": "custom_tool_call",
                    "call_id": "call_patch",
                    "name": "apply_patch",
                    "input": "*** Begin Patch\n*** End Patch"
                }]
            }))
            .await;
        let mut request = json!({
            "previous_response_id": "resp_1",
            "input": [{
                "type": "custom_tool_call_output",
                "call_id": "call_patch",
                "output": "Done"
            }]
        });

        assert_eq!(history.enrich_request(&mut request).await, 1);
        assert_eq!(request["input"][0]["type"], "custom_tool_call");
        assert_eq!(request["input"][1]["type"], "custom_tool_call_output");
    }

    #[tokio::test]
    async fn restores_parallel_calls_in_original_order() {
        let history = CodexToolHistory::default();
        history
            .record_response(&json!({
                "id": "resp_parallel",
                "output": [
                    {"type": "function_call", "call_id": "call_1", "name": "first", "arguments": "{}"},
                    {"type": "function_call", "call_id": "call_2", "name": "second", "arguments": "{}"}
                ]
            }))
            .await;
        let mut request = json!({
            "previous_response_id": "resp_parallel",
            "input": [
                {"type": "function_call_output", "call_id": "call_1", "output": "one"},
                {"type": "function_call_output", "call_id": "call_2", "output": "two"}
            ]
        });

        assert_eq!(history.enrich_request(&mut request).await, 2);
        assert_eq!(request["input"][0]["call_id"], "call_1");
        assert_eq!(request["input"][1]["call_id"], "call_2");
        assert_eq!(request["input"][2]["type"], "function_call_output");
    }

    #[tokio::test]
    async fn restores_a_unique_call_without_previous_response_id() {
        let history = CodexToolHistory::default();
        history
            .record_response(&json!({
                "id": "resp_unique",
                "output": [{
                    "type": "custom_tool_call",
                    "call_id": "call_unique",
                    "name": "apply_patch",
                    "input": "*** Begin Patch\n*** End Patch"
                }]
            }))
            .await;
        let mut request = json!({
            "input": [{
                "type": "custom_tool_call_output",
                "call_id": "call_unique",
                "output": "Done"
            }]
        });

        assert_eq!(history.enrich_request(&mut request).await, 1);
        assert_eq!(request["input"][0]["name"], "apply_patch");
    }

    #[tokio::test]
    async fn does_not_guess_an_ambiguous_call_without_previous_response_id() {
        let history = CodexToolHistory::default();
        for response_id in ["resp_1", "resp_2"] {
            history
                .record_response(&json!({
                    "id": response_id,
                    "output": [{
                        "type": "function_call",
                        "call_id": "reused_call",
                        "name": response_id,
                        "arguments": "{}"
                    }]
                }))
                .await;
        }
        let mut request = json!({
            "input": [{
                "type": "function_call_output",
                "call_id": "reused_call",
                "output": "Done"
            }]
        });

        assert_eq!(history.enrich_request(&mut request).await, 0);
        assert_eq!(request["input"].as_array().map(Vec::len), Some(1));
    }

    #[tokio::test]
    async fn records_completed_stream_for_next_request() {
        let history = Arc::new(CodexToolHistory::default());
        let event = format!(
            "event: response.completed\ndata: {}\n\n",
            json!({
                "type": "response.completed",
                "response": {
                    "id": "resp_stream",
                    "output": [{"type": "function_call", "call_id": "call_1", "name": "read", "arguments": "{}"}]
                }
            })
        );
        let stream = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from(event))]);
        record_responses_stream(stream, history.clone())
            .collect::<Vec<_>>()
            .await;
        let mut request = json!({
            "previous_response_id": "resp_stream",
            "input": [{"type": "function_call_output", "call_id": "call_1", "output": "ok"}]
        });

        assert_eq!(history.enrich_request(&mut request).await, 1);
        assert_eq!(request["input"][0]["name"], "read");
    }
}
