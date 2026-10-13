// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/v1/responses` request body
//! (`app/schemas/openapi_response.py:ResponseCreateInput`) and the input-text
//! extraction (`app/services/openapi/helpers.py:extract_input_text`).
use serde::Deserialize;

/// The create request fields the flow reads. `tools`, `reasoning`,
/// `attachment_ids`, and the wegent options are added with the slices that
/// consume them.
#[derive(Debug, Deserialize)]
pub struct ResponseCreateInput {
    pub model: String,
    #[serde(default)]
    pub input: serde_json::Value,
    // Pydantic coerces `"false"`/`"true"`/`"1"`/`"0"` (and `0`/`1`) to `bool`,
    // and the recorded `queued` case sends `"stream": "false"` as a string, so
    // the booleans are lenient here too.
    #[serde(default, deserialize_with = "brz_json::adapters::legacy_boolean")]
    pub stream: bool,
    #[serde(default, deserialize_with = "brz_json::adapters::legacy_boolean")]
    pub background: bool,
    #[serde(default)]
    pub previous_response_id: Option<String>,
    /// The Wegent tool declarations (`parse_wegent_tools`). Only the
    /// `wegent_chat_bot` / `skill` shapes the recorded create cases carry are
    /// projected.
    #[serde(default)]
    pub tools: Vec<serde_json::Value>,
}

/// `parse_wegent_tools`: the request tool settings the create flow reads.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WegentToolSettings {
    pub enable_chat_bot: bool,
    pub preload_skills: Vec<String>,
}

/// `parse_wegent_tools` (the reachable half): `wegent_chat_bot` flips
/// `enable_chat_bot`, `skill` tools extend `preload_skills`.
pub fn parse_wegent_tools(tools: &[serde_json::Value]) -> WegentToolSettings {
    let mut settings = WegentToolSettings::default();
    for tool in tools {
        match tool.get("type").and_then(serde_json::Value::as_str) {
            Some("wegent_chat_bot") => settings.enable_chat_bot = true,
            Some("skill") => {
                if let Some(skills) = tool
                    .get("preload_skills")
                    .and_then(serde_json::Value::as_array)
                {
                    settings.preload_skills.extend(
                        skills
                            .iter()
                            .filter_map(|skill| skill.as_str().map(str::to_string)),
                    );
                }
            }
            _ => {}
        }
    }
    settings
}

/// `extract_input_text`: a string input is returned verbatim; a message list
/// takes the last `user` message, whose content is either the text or a list
/// of `text` parts joined with a space. No user message yields an empty string.
pub fn extract_input_text(input: &serde_json::Value) -> String {
    match input {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .rev()
            .find(|item| item.get("role").and_then(serde_json::Value::as_str) == Some("user"))
            .map(content_text)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

/// The `content` of one message item: a string, or the `text` parts joined
/// with a space.
fn content_text(item: &serde_json::Value) -> String {
    match item.get("content") {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Array(parts)) => {
            let texts: Vec<&str> = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(serde_json::Value::as_str))
                .collect();
            texts.join(" ")
        }
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_string_input_is_returned_verbatim() {
        assert_eq!(extract_input_text(&json!("不吃糊饼")), "不吃糊饼");
    }

    #[test]
    fn a_message_list_takes_the_last_user_message() {
        let input = json!([
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "reply"},
            {"role": "user", "content": "second"},
        ]);
        assert_eq!(extract_input_text(&input), "second");
    }

    #[test]
    fn content_parts_join_with_a_space() {
        let input = json!([
            {"role": "user", "content": [{"type": "input_text", "text": "a"}, {"type": "input_text", "text": "b"}]},
        ]);
        assert_eq!(extract_input_text(&input), "a b");
    }

    #[test]
    fn a_list_without_a_user_message_is_empty() {
        let input = json!([{"role": "assistant", "content": "reply"}]);
        assert_eq!(extract_input_text(&input), "");
    }

    #[test]
    fn parses_the_recorded_create_body() {
        let body: ResponseCreateInput = serde_json::from_value(json!({
            "model": "ns-b#team-beta#deepseek-flash-not-think(公网)",
            "input": "不吃糊饼",
            "stream": false,
        }))
        .expect("parse");
        assert_eq!(body.model, "ns-b#team-beta#deepseek-flash-not-think(公网)");
        assert!(!body.stream);
        assert!(!body.background);
        assert!(body.previous_response_id.is_none());
    }

    #[test]
    fn coerces_the_recorded_string_booleans() {
        // The `queued` cases send `"stream": "false"` as a string; Pydantic
        // coerces it, so the Rust parse must too.
        let body: ResponseCreateInput = serde_json::from_value(json!({
            "model": "ns-a#team-alpha",
            "input": "go",
            "stream": "false",
        }))
        .expect("parse");
        assert!(!body.stream);
        assert!(!body.background);

        let truthy: ResponseCreateInput = serde_json::from_value(json!({
            "model": "m",
            "stream": 1,
            "background": "true",
        }))
        .expect("parse");
        assert!(truthy.stream);
        assert!(truthy.background);

        assert!(
            serde_json::from_value::<ResponseCreateInput>(json!({"model": "m", "stream": "maybe"}))
                .is_err()
        );
    }
}
