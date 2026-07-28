// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

use serde_json::{json, Value};

use super::util::{codex_wrapped_item_payload, integer_field, item_type, string_field};

pub(crate) fn rollout_context_usage(thread: &Value) -> Option<Value> {
    normalize_thread_token_usage(
        thread
            .get("tokenUsage")
            .or_else(|| thread.get("token_usage"))
            .unwrap_or(thread),
    )
    .or_else(|| {
        string_field(thread, "path").and_then(|path| rollout_path_context_usage(Path::new(&path)))
    })
}

fn rollout_path_context_usage(path: &Path) -> Option<Value> {
    let reader = BufReader::new(File::open(path).ok()?);
    reader
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter_map(|item| {
            let payload = codex_wrapped_item_payload(&item).unwrap_or(&item);
            if !matches!(item_type(payload).as_str(), "tokencount" | "token_count") {
                return None;
            }
            payload
                .get("info")
                .and_then(normalize_token_usage_info)
                .or_else(|| normalize_thread_token_usage(payload))
        })
        .last()
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
