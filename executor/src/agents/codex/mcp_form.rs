// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;

use crate::agents::interactive_mcp::is_deferred_user_input_result;

/// A backend-validated form returned by the web interactive MCP tool.
pub(super) struct DeferredMcpForm<'a> {
    pub tool_use_id: &'a str,
    pub input: &'a Value,
    pub output: &'a Value,
}

pub(super) fn form_item(message: &Value) -> Option<&Value> {
    if !matches!(
        message["method"].as_str(),
        Some("item/started" | "item/completed")
    ) {
        return None;
    }
    let item = message.pointer("/params/item")?;
    (item["type"] == "mcpToolCall" && item["tool"] == "interactive_form_question").then_some(item)
}

pub(super) fn deferred_form(message: &Value) -> Option<DeferredMcpForm<'_>> {
    if message["method"] != "item/completed" {
        return None;
    }
    let item = form_item(message)?;
    let result = item.get("result")?;
    if item["status"] != "completed"
        || !item["error"].is_null()
        || result["isError"] == true
        || !is_deferred_user_input_result(result)
    {
        return None;
    }
    Some(DeferredMcpForm {
        tool_use_id: item["id"].as_str()?,
        input: item.get("arguments")?,
        output: result,
    })
}
