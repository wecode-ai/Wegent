// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/v1/responses` request body
//! (`app/schemas/openapi_response.py:ResponseCreateInput`) and the input-text
//! extraction (`app/services/openapi/helpers.py:extract_input_text`).
use brz_http_server::StatusCode;
use serde::Deserialize;

use crate::http_compat::FastApiError;

/// The create request fields the flow reads. `attachment_ids` and the wegent
/// options are added with the slices that consume them.
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
    /// The API `reasoning` selection (`ReasoningConfig`). Absent leaves the
    /// Model's own default in place.
    #[serde(default)]
    pub reasoning: Option<super::reasoning::ReasoningConfig>,
}

/// `parse_wegent_tools`: the request tool settings the create flow reads.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WegentToolSettings {
    pub enable_chat_bot: bool,
    pub preload_skills: Vec<String>,
    /// `knowledge_base_refs` (`_parse_knowledge_base_tool`'s normalized refs).
    pub knowledge_base_refs: Vec<KbToolRef>,
    /// `knowledge_base_names`: the same refs without scope, the `namespace#name`
    /// fallback callers may pass to `build_execution_request`.
    pub knowledge_base_names: Vec<KbToolRef>,
}

/// One normalized `knowledge_base` tool ref
/// (`KnowledgeBaseRefConfig` after `_parse_knowledge_base_tool`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KbToolRef {
    pub namespace: String,
    pub name: String,
    pub folder_ids: Option<Vec<i64>>,
    pub document_ids: Option<Vec<i64>>,
    pub include_subfolders: bool,
    /// `scope_specified`: the request narrowed this knowledge base to a folder
    /// or document selection.
    pub scope_specified: bool,
}

/// `parse_wegent_tools`: `wegent_chat_bot` flips `enable_chat_bot`, `skill`
/// tools extend `preload_skills`, and `knowledge_base` tools contribute the
/// normalized refs plus their name-only projection
/// (`app/services/openapi/helpers.py:95-190`).
pub fn parse_wegent_tools(tools: &[serde_json::Value]) -> Result<WegentToolSettings, FastApiError> {
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
            Some("knowledge_base") => {
                let refs = parse_knowledge_base_tool(tool)?;
                // `result["knowledge_base_names"]`: the name-only projection of
                // the same refs, kept for the legacy fallback parameter.
                settings
                    .knowledge_base_names
                    .extend(refs.iter().map(|reference| KbToolRef {
                        namespace: reference.namespace.clone(),
                        name: reference.name.clone(),
                        folder_ids: None,
                        document_ids: None,
                        include_subfolders: true,
                        scope_specified: false,
                    }));
                settings.knowledge_base_refs.extend(refs);
            }
            _ => {}
        }
    }
    Ok(settings)
}

/// `_parse_knowledge_base_tool`: normalize one `knowledge_base` tool's
/// `knowledge_base_names` / `knowledge_base_refs` (mutually exclusive) and its
/// top-level scope compatibility fields.
fn parse_knowledge_base_tool(tool: &serde_json::Value) -> Result<Vec<KbToolRef>, FastApiError> {
    let names = string_list(tool.get("knowledge_base_names"))?;
    let raw_refs = tool
        .get("knowledge_base_refs")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let top_level_scope = tool.get("folder_ids").is_some() || tool.get("document_ids").is_some();
    let has_names = !names.is_empty();
    let has_refs = !raw_refs.is_empty();

    if has_names && has_refs {
        return Err(invalid_knowledge_base_tool(
            "knowledge_base_names and knowledge_base_refs are mutually exclusive",
        ));
    }
    if !has_names && !has_refs && !top_level_scope {
        return Ok(Vec::new());
    }
    if !has_names && !has_refs {
        return Err(invalid_knowledge_base_tool(
            "knowledge_base tool requires knowledge_base_names or knowledge_base_refs",
        ));
    }
    if has_refs && top_level_scope {
        return Err(invalid_knowledge_base_tool(
            "Top-level folder_ids/document_ids are only valid with knowledge_base_names",
        ));
    }

    if has_refs {
        let mut refs = Vec::with_capacity(raw_refs.len());
        for raw in raw_refs {
            // `KnowledgeBaseRefConfig.name: str = Field(..., min_length=1)`: a
            // missing, non-string or empty name is a body-validation failure,
            // not a silently dropped ref.
            let Some(name) = raw.get("name").and_then(serde_json::Value::as_str) else {
                return Err(invalid_body_field("knowledge_base_refs[].name is required"));
            };
            if name.is_empty() {
                return Err(invalid_body_field(
                    "knowledge_base_refs[].name must not be empty",
                ));
            }
            let Some((namespace, name)) = parse_knowledge_base_name(Some(name))? else {
                continue;
            };
            let folder_ids = validate_scope_field("folder_ids", raw.get("folder_ids"))?;
            let document_ids = validate_scope_field("document_ids", raw.get("document_ids"))?;
            refs.push(KbToolRef {
                namespace,
                name,
                scope_specified: folder_ids.is_some() || document_ids.is_some(),
                folder_ids,
                document_ids,
                include_subfolders: raw
                    .get("include_subfolders")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true),
            });
        }
        return Ok(refs);
    }

    if top_level_scope && names.len() != 1 {
        return Err(invalid_knowledge_base_tool(
            "Top-level folder_ids/document_ids can only be used with one knowledge_base_names entry",
        ));
    }
    let folder_ids = validate_scope_field("folder_ids", tool.get("folder_ids"))?;
    let document_ids = validate_scope_field("document_ids", tool.get("document_ids"))?;
    let include_subfolders = tool
        .get("include_subfolders")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let mut refs = Vec::with_capacity(names.len());
    for raw_name in names {
        let Some((namespace, name)) = parse_knowledge_base_name(Some(raw_name.as_str()))? else {
            continue;
        };
        refs.push(KbToolRef {
            namespace,
            name,
            scope_specified: folder_ids.is_some() || document_ids.is_some(),
            folder_ids: folder_ids.clone(),
            document_ids: document_ids.clone(),
            include_subfolders,
        });
    }
    Ok(refs)
}

fn invalid_knowledge_base_tool(message: &str) -> FastApiError {
    FastApiError::detail(StatusCode::BAD_REQUEST, message.to_string())
}

/// A body-shape failure (`WegentTool.knowledge_base_names: List[str]` /
/// `KnowledgeBaseRefConfig.name: str`, Pydantic's `422`).
fn invalid_body_field(message: &str) -> FastApiError {
    FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, message.to_string())
}

fn string_list(value: Option<&serde_json::Value>) -> Result<Vec<String>, FastApiError> {
    let Some(items) = value.and_then(serde_json::Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut names = Vec::with_capacity(items.len());
    for item in items {
        let Some(text) = item.as_str() else {
            return Err(invalid_body_field(
                "knowledge_base_names must be a list of strings",
            ));
        };
        names.push(text.to_string());
    }
    Ok(names)
}

/// `parse_knowledge_base_name`: `namespace#name`, or `name` in `default`.
fn parse_knowledge_base_name(raw: Option<&str>) -> Result<Option<(String, String)>, FastApiError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Err(invalid_knowledge_base_tool(
            "Knowledge base name cannot be empty",
        ));
    }
    let parts: Vec<&str> = raw.split('#').collect();
    match parts.as_slice() {
        [namespace, name] => Ok(Some((namespace.to_string(), name.to_string()))),
        [name] => Ok(Some(("default".to_string(), name.to_string()))),
        _ => Err(invalid_knowledge_base_tool(&format!(
            "Invalid knowledge base name format: '{raw}'. Expected format: 'namespace#name' or 'name'"
        ))),
    }
}

/// `_validate_scope_field`: the deduplicated scope ids, or the Source's `400`.
fn validate_scope_field(
    field_name: &str,
    value: Option<&serde_json::Value>,
) -> Result<Option<Vec<i64>>, FastApiError> {
    let Some(items) = value.and_then(serde_json::Value::as_array) else {
        return Ok(None);
    };
    let ids: Vec<i64> = items.iter().filter_map(serde_json::Value::as_i64).collect();
    if ids.is_empty() {
        return Err(invalid_knowledge_base_tool(&format!(
            "{field_name} must not be empty"
        )));
    }
    let invalid = if field_name == "folder_ids" {
        ids.iter().any(|id| *id < 0)
    } else {
        ids.iter().any(|id| *id < 1)
    };
    if invalid {
        let message = if field_name == "folder_ids" {
            "folder_ids must contain non-negative integers"
        } else {
            "document_ids must contain positive integers"
        };
        return Err(invalid_knowledge_base_tool(message));
    }
    let mut seen = std::collections::HashSet::new();
    Ok(Some(
        ids.into_iter().filter(|id| seen.insert(*id)).collect(),
    ))
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

    /// `parse_wegent_tools` collects the `knowledge_base` tool's normalized
    /// refs and their name-only projection (`helpers.py:131-190`).
    #[test]
    fn knowledge_base_tools_expose_refs_and_names() {
        let settings = parse_wegent_tools(&[json!({
            "type": "knowledge_base",
            "knowledge_base_names": [
                "engineering/platform#业务逻辑知识库",
                "预案知识库",
            ],
        })])
        .expect("parse");
        assert!(!settings.enable_chat_bot);
        let refs = &settings.knowledge_base_refs;
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].namespace, "engineering/platform");
        assert_eq!(refs[0].name, "业务逻辑知识库");
        assert!(!refs[0].scope_specified);
        assert_eq!(refs[1].namespace, "default");
        assert_eq!(refs[1].name, "预案知识库");
        // The names projection keeps namespace/name only.
        assert_eq!(settings.knowledge_base_names.len(), 2);
        assert_eq!(
            settings.knowledge_base_names[0].name,
            "业务逻辑知识库".to_string()
        );
        assert!(settings.knowledge_base_names[0].folder_ids.is_none());
    }

    /// A ref with a folder/document scope marks `scope_specified`
    /// (`_parse_knowledge_base_tool`'s `has_refs` branch).
    #[test]
    fn knowledge_base_refs_carry_their_scope() {
        let settings = parse_wegent_tools(&[json!({
            "type": "knowledge_base",
            "knowledge_base_refs": [
                {"name": "ns#kb", "folder_ids": [3, 3, 0], "include_subfolders": false},
                {"name": "ns#other", "document_ids": [7]},
            ],
        })])
        .expect("parse");
        let refs = &settings.knowledge_base_refs;
        assert_eq!(refs.len(), 2);
        assert!(refs[0].scope_specified);
        assert_eq!(refs[0].folder_ids, Some(vec![3, 0]));
        assert!(!refs[0].include_subfolders);
        assert_eq!(refs[1].document_ids, Some(vec![7]));
        assert!(refs[1].scope_specified);
    }

    /// The Source's `knowledge_base` tool errors
    /// (`helpers.py:150-196`).
    #[test]
    fn knowledge_base_tool_errors_match_the_source() {
        let mutual = parse_wegent_tools(&[json!({
            "type": "knowledge_base",
            "knowledge_base_names": ["ns#kb"],
            "knowledge_base_refs": [{"name": "ns#kb"}],
        })]);
        assert!(mutual.is_err());

        let empty = parse_wegent_tools(&[json!({
            "type": "knowledge_base",
            "folder_ids": [1],
        })]);
        assert!(empty.is_err());

        let top_level_scope = parse_wegent_tools(&[json!({
            "type": "knowledge_base",
            "knowledge_base_names": ["ns#a", "ns#b"],
            "folder_ids": [1],
        })]);
        assert!(top_level_scope.is_err());

        let bad_name = parse_wegent_tools(&[json!({
            "type": "knowledge_base",
            "knowledge_base_names": ["a#b#c"],
        })]);
        assert!(bad_name.is_err());
    }

    /// A plain `name` ref defaults to the `default` namespace and the
    /// `namespace#name` split keeps the rest of the name intact.
    #[test]
    fn knowledge_base_name_parsing_follows_the_source() {
        assert_eq!(
            parse_knowledge_base_name(Some("kb")).unwrap(),
            Some(("default".to_string(), "kb".to_string()))
        );
        assert_eq!(
            parse_knowledge_base_name(Some("ns#kb")).unwrap(),
            Some(("ns".to_string(), "kb".to_string()))
        );
        assert!(parse_knowledge_base_name(Some("")).is_err());
        assert!(parse_knowledge_base_name(Some("a#b#c")).is_err());
        assert_eq!(parse_knowledge_base_name(None).unwrap(), None);
    }

    /// A missing/empty `knowledge_base_refs[].name` and a non-string
    /// `knowledge_base_names` entry are body-validation failures
    /// (`KnowledgeBaseRefConfig.name: str = Field(..., min_length=1)`,
    /// `knowledge_base_names: List[str]`), not silently dropped refs.
    #[test]
    fn knowledge_base_ref_shapes_are_validated() {
        for tool in [
            json!({"type": "knowledge_base", "knowledge_base_refs": [{"folder_ids": [1]}]}),
            json!({"type": "knowledge_base", "knowledge_base_refs": [{"name": null}]}),
            json!({"type": "knowledge_base", "knowledge_base_refs": [{"name": ""}]}),
            json!({"type": "knowledge_base", "knowledge_base_refs": [{"name": 7}]}),
        ] {
            let error = parse_wegent_tools(&[tool]).expect_err("body validation");
            assert_eq!(
                error.status(),
                brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
            );
        }

        let error = parse_wegent_tools(&[json!({
            "type": "knowledge_base",
            "knowledge_base_names": ["ns#kb", 7],
        })])
        .expect_err("body validation");
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
    }

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
