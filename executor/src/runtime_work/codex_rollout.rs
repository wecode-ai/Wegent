// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

use serde::Deserialize;
use serde_json::{json, value::RawValue, Value};

use super::util::{codex_wrapped_item_payload, integer_field, item_type, string_field};

pub(crate) fn rollout_context_usage(thread: &Value) -> Option<Value> {
    normalize_thread_token_usage(
        thread
            .get("tokenUsage")
            .or_else(|| thread.get("token_usage"))
            .unwrap_or(thread),
    )
    .or_else(|| {
        if thread["rolloutContextIndexed"] == true {
            None
        } else {
            string_field(thread, "path")
                .and_then(|path| rollout_path_context_usage(Path::new(&path)))
        }
    })
}

pub(super) fn record_context_usage(item: &Value) -> Option<Value> {
    let payload = codex_wrapped_item_payload(item).unwrap_or(item);
    if item_type(payload) != "tokencount" {
        return None;
    }
    payload
        .get("info")
        .and_then(normalize_token_usage_info)
        .or_else(|| normalize_thread_token_usage(payload))
}

fn rollout_path_context_usage(path: &Path) -> Option<Value> {
    let mut reader = BufReader::new(File::open(path).ok()?);
    let mut line = String::new();
    let mut usage = None;
    while reader.read_line(&mut line).is_ok_and(|read| read > 0) {
        if may_contain_context_usage(&line) {
            if let Some(next) = serde_json::from_str(&line)
                .ok()
                .and_then(|item| record_context_usage(&item))
            {
                usage = Some(next);
            }
        }
        line.clear();
    }
    usage
}

#[derive(Deserialize)]
struct RolloutHeader<'a> {
    #[serde(rename = "type", borrow)]
    kind: Option<&'a RawValue>,
    #[serde(borrow)]
    payload: Option<&'a RawValue>,
}

impl RolloutHeader<'_> {
    fn kind(&self) -> String {
        self.kind
            .and_then(|kind| serde_json::from_str::<String>(kind.get()).ok())
            .unwrap_or_default()
            .replace('_', "")
            .to_ascii_lowercase()
    }
}

fn may_contain_context_usage(line: &str) -> bool {
    let Ok(record) = serde_json::from_str::<RolloutHeader>(line) else {
        return true;
    };
    match record.kind().as_str() {
        "tokencount" => true,
        "responseitem" | "eventmsg" => record.payload.is_some_and(|payload| {
            serde_json::from_str::<RolloutHeader>(payload.get())
                .map_or(true, |payload| payload.kind() == "tokencount")
        }),
        _ => false,
    }
}

fn normalize_token_usage_info(info: &Value) -> Option<Value> {
    let total = normalize_token_usage_breakdown(
        info.get("total_token_usage")
            .or_else(|| info.get("totalTokenUsage"))
            .or_else(|| info.get("total"))?,
    )?;
    let last = normalize_token_usage_breakdown(
        info.get("last_token_usage")
            .or_else(|| info.get("lastTokenUsage"))
            .or_else(|| info.get("last"))?,
    )?;
    let model_context_window = integer_field(info, "model_context_window")
        .or_else(|| integer_field(info, "modelContextWindow"))?;

    Some(json!({
        "total": total,
        "last": last,
        "modelContextWindow": model_context_window,
    }))
}

fn normalize_thread_token_usage(value: &Value) -> Option<Value> {
    Some(json!({
        "total": normalize_token_usage_breakdown(value.get("total")?)?,
        "last": normalize_token_usage_breakdown(value.get("last")?)?,
        "modelContextWindow": integer_field(value, "modelContextWindow")
            .or_else(|| integer_field(value, "model_context_window"))?,
    }))
}

fn normalize_token_usage_breakdown(value: &Value) -> Option<Value> {
    Some(json!({
        "totalTokens": integer_field(value, "total_tokens")
            .or_else(|| integer_field(value, "totalTokens"))?,
        "inputTokens": integer_field(value, "input_tokens")
            .or_else(|| integer_field(value, "inputTokens"))
            .unwrap_or(0),
        "cachedInputTokens": integer_field(value, "cached_input_tokens")
            .or_else(|| integer_field(value, "cachedInputTokens"))
            .unwrap_or(0),
        "outputTokens": integer_field(value, "output_tokens")
            .or_else(|| integer_field(value, "outputTokens"))
            .unwrap_or(0),
        "reasoningOutputTokens": integer_field(value, "reasoning_output_tokens")
            .or_else(|| integer_field(value, "reasoningOutputTokens"))
            .unwrap_or(0),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rollout_usage_uses_the_latest_valid_token_count_record() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let counts = |total| {
            json!({"type":"token_count","info":{
                "total_token_usage":{"total_tokens":total},
                "last_token_usage":{"total_tokens":2},
                "model_context_window":200
            }})
        };
        let lines = [
            counts(10),
            json!({"type":"response_item","payload":{"type":"message","content":[counts(90)]}}),
            json!({"type":"event_msg","payload":counts(20)}),
            json!({"type":"event_msg","payload":{"type":"token_count","info":null}}),
        ];
        let contents = lines.map(|line| line.to_string()).join("\n");
        std::fs::write(file.path(), contents).unwrap();

        let usage = rollout_path_context_usage(file.path()).unwrap();
        assert_eq!(usage["total"]["totalTokens"], 20);
        assert_eq!(usage["last"]["totalTokens"], 2);
    }
}
