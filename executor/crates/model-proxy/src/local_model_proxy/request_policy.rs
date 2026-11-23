// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{borrow::Cow, collections::HashSet};

use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::Value;

use super::{
    prepare_fork_request, prepare_model_switch_request, prepare_request_with_history,
    rewrite_request_model, vision, Conversion, HttpError, LocalModelProxyUpstream,
    VisionSidecarUpstream,
};

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodexRequestMode {
    #[default]
    Auto,
    Standard,
    Passthrough,
}

impl CodexRequestMode {
    pub(super) fn validate(self, api_format: &str) -> Result<(), String> {
        if self == Self::Passthrough && api_format != "openai-responses" {
            return Err("Codex passthrough requires an OpenAI Responses model".to_owned());
        }
        Ok(())
    }

    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Standard => "standard",
            Self::Passthrough => "passthrough",
        }
    }
}

pub(super) struct PreparedRequest {
    pub body: Vec<u8>,
    pub conversion: Option<Conversion>,
    pub expanded_browser_tools: HashSet<String>,
    pub stripped_encrypted_content: usize,
    pub normalized_reasoning_items: usize,
    pub foreign_history_keys: HashSet<String>,
}

/// Standard providers can execute client functions but cannot supply hosted tools.
/// Validate forced choices instead of silently changing the requested tool.
pub(super) fn retain_function_tools(request: &mut Value) -> Result<(), HttpError> {
    if let Some(tools) = request.get_mut("tools").and_then(Value::as_array_mut) {
        tools.retain(|tool| tool.get("type").and_then(Value::as_str) == Some("function"));
    }
    let choice = &request["tool_choice"];
    let valid_choice = match choice.get("type").and_then(Value::as_str) {
        Some("function") => true,
        Some("allowed_tools") => {
            choice
                .get("tools")
                .and_then(Value::as_array)
                .is_some_and(|tools| {
                    !tools.is_empty()
                        && tools.iter().all(|tool| {
                            tool.get("type").and_then(Value::as_str) == Some("function")
                        })
                })
        }
        Some(_) => false,
        None => {
            choice.as_str() != Some("required")
                || request
                    .get("tools")
                    .and_then(Value::as_array)
                    .is_some_and(|tools| !tools.is_empty())
        }
    };
    if !valid_choice {
        return Err(HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: "Codex standard mode tool_choice requires client function tools".to_owned(),
        });
    }
    Ok(())
}

// Older native Goal histories contain synthetic user message IDs that Responses
// rejects. The ID is only a local receipt key, so omit it from the replayed input.
fn strip_legacy_event_message_ids(body: &[u8]) -> Result<Cow<'_, [u8]>, HttpError> {
    const LEGACY_PREFIX: &str = "wework_event_";
    if !std::str::from_utf8(body)
        .is_ok_and(|body| body.contains(LEGACY_PREFIX) || body.contains(r"\u"))
    {
        return Ok(Cow::Borrowed(body));
    }
    let mut request: Value = serde_json::from_slice(body).map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("Invalid Codex Responses request: {error}"),
    })?;
    let Some(items) = request.get_mut("input").and_then(Value::as_array_mut) else {
        return Ok(Cow::Borrowed(body));
    };
    let mut changed = false;
    for item in items.iter_mut().filter_map(Value::as_object_mut) {
        if item.get("type").and_then(Value::as_str) == Some("message")
            && item.get("role").and_then(Value::as_str) == Some("user")
            && item
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with(LEGACY_PREFIX))
        {
            item.remove("id");
            changed = true;
        }
    }
    if !changed {
        return Ok(Cow::Borrowed(body));
    }
    serde_json::to_vec(&request)
        .map(Cow::Owned)
        .map_err(|error| HttpError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: format!("Failed to encode Codex event history: {error}"),
        })
}

/// Preserve the routed request in passthrough mode or apply protocol adaptations.
pub(super) async fn prepare(
    upstream: &LocalModelProxyUpstream,
    body: &[u8],
    vision_sidecar: Option<&VisionSidecarUpstream>,
    history: &super::history::CodexToolHistory,
    model_switched: bool,
    forked: bool,
    known_foreign_history_keys: &HashSet<String>,
) -> Result<PreparedRequest, HttpError> {
    upstream
        .codex_request_mode
        .validate(&upstream.api_format)
        .map_err(|detail| HttpError {
            status: StatusCode::BAD_REQUEST,
            detail,
        })?;
    let body = strip_legacy_event_message_ids(body)?;
    let body = match upstream.model_id.as_deref() {
        Some(model_id) => rewrite_request_model(&body, model_id)?,
        None => body.into_owned(),
    };
    let (body, normalized_reasoning_items, foreign_history_keys) =
        if upstream.is_official_chatgpt_codex() {
            super::openai_reasoning::normalize_official_reasoning_history(
                body,
                known_foreign_history_keys,
                model_switched,
            )?
        } else {
            (body, 0, HashSet::new())
        };
    if upstream.codex_request_mode == CodexRequestMode::Passthrough {
        return Ok(PreparedRequest {
            body,
            conversion: None,
            expanded_browser_tools: HashSet::new(),
            stripped_encrypted_content: 0,
            normalized_reasoning_items,
            foreign_history_keys,
        });
    }
    let body = if upstream.is_official_chatgpt_codex() {
        body
    } else {
        prepare_model_switch_request(upstream, body, model_switched)?
    };
    let conversation_id = super::request_thread_identity(&body).map(|identity| identity.thread_id);
    let body =
        vision::replace_images_with_descriptions(vision_sidecar, conversation_id.as_deref(), &body)
            .await?;
    // Fork cleanup needs the native item types before Responses normalization.
    let (body, stripped_encrypted_content) =
        prepare_fork_request(body, forked && upstream.api_format == "openai-responses")?;
    let (body, conversion, expanded_browser_tools) = prepare_request_with_history(
        &upstream.api_format,
        upstream.responses_tool_capabilities(),
        upstream.max_output_tokens,
        upstream.routing_model_id.as_deref(),
        &body,
        history,
    )
    .await?;
    Ok(PreparedRequest {
        body,
        conversion,
        expanded_browser_tools,
        stripped_encrypted_content,
        normalized_reasoning_items,
        foreign_history_keys,
    })
}
