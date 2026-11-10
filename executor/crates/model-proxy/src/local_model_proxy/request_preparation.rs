use super::*;

pub(super) fn diagnostic_upstream_stream<S, E>(
    stream: S,
    api_format: String,
    started_at: Instant,
) -> impl Stream<Item = Result<Bytes, E>>
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
{
    futures_util::stream::unfold(
        (Box::pin(stream), api_format, started_at, false, 0_u64),
        |(mut stream, api_format, started_at, first_seen, total_bytes)| async move {
            match stream.next().await {
                Some(item) => {
                    let chunk_bytes = item.as_ref().map_or(0, Bytes::len) as u64;
                    let next_total = total_bytes.saturating_add(chunk_bytes);
                    if !first_seen {
                        log_executor_event(
                            "local model proxy upstream first chunk received",
                            &[
                                ("api_format", api_format.clone()),
                                ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
                                ("chunk_bytes", chunk_bytes.to_string()),
                            ],
                        );
                    }
                    Some((item, (stream, api_format, started_at, true, next_total)))
                }
                None => {
                    log_executor_event(
                        "local model proxy upstream stream completed",
                        &[
                            ("api_format", api_format),
                            ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
                            ("body_bytes", total_bytes.to_string()),
                        ],
                    );
                    None
                }
            }
        },
    )
}

pub(super) async fn prepare_request_with_history(
    api_format: &str,
    tool_capabilities: ResponsesToolCapabilities,
    max_output_tokens: Option<u64>,
    model_hint: Option<&str>,
    body: &[u8],
    history: &history::CodexToolHistory,
) -> Result<(Vec<u8>, Option<Conversion>, HashSet<String>), HttpError> {
    if api_format == "openai-responses" {
        let mut responses_body =
            serde_json::from_slice::<Value>(body).map_err(|error| HttpError {
                status: StatusCode::BAD_REQUEST,
                detail: format!("Invalid Codex Responses request: {error}"),
            })?;
        let enhanced = history
            .enhance_native_apply_patch_errors(&mut responses_body)
            .await;
        if enhanced > 0 {
            log_executor_event(
                "local model proxy enhanced apply_patch error",
                &[
                    ("api_format", api_format.to_owned()),
                    ("outputs", enhanced.to_string()),
                ],
            );
        }
        let body = serde_json::to_vec(&responses_body).map_err(|error| HttpError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: format!("Failed to serialize enriched Codex request: {error}"),
        })?;
        return prepare_request_with_model_hint(
            api_format,
            tool_capabilities,
            max_output_tokens,
            model_hint,
            &body,
        );
    }
    let mut responses_body = serde_json::from_slice::<Value>(body).map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("Invalid Codex Responses request: {error}"),
    })?;
    let restored = history.enrich_request(&mut responses_body).await;
    if restored > 0 {
        log_executor_event(
            "local model proxy restored tool history",
            &[
                ("api_format", api_format.to_owned()),
                ("restored_items", restored.to_string()),
            ],
        );
    }
    let enriched = serde_json::to_vec(&responses_body).map_err(|error| HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("Failed to serialize enriched Codex request: {error}"),
    })?;
    prepare_request_with_model_hint(
        api_format,
        tool_capabilities,
        max_output_tokens,
        model_hint,
        &enriched,
    )
}

#[allow(clippy::type_complexity)]
#[cfg(test)]
// Test helper for native Codex Responses models, which support both App tool primitives.
pub(super) fn prepare_request(
    api_format: &str,
    convert_custom_tools: bool,
    max_output_tokens: Option<u64>,
    body: &[u8],
) -> Result<(Vec<u8>, Option<Conversion>, HashSet<String>), HttpError> {
    prepare_request_with_model_hint(
        api_format,
        ResponsesToolCapabilities {
            custom_tool_conversion: if convert_custom_tools {
                CustomToolConversion::All
            } else {
                CustomToolConversion::None
            },
            native_tool_search: true,
            native_namespace_tools: true,
            function_tools_only: false,
        },
        max_output_tokens,
        None,
        body,
    )
}

#[allow(clippy::type_complexity)]
pub(super) fn prepare_request_with_model_hint(
    api_format: &str,
    tool_capabilities: ResponsesToolCapabilities,
    max_output_tokens: Option<u64>,
    model_hint: Option<&str>,
    body: &[u8],
) -> Result<(Vec<u8>, Option<Conversion>, HashSet<String>), HttpError> {
    let mut responses_body = serde_json::from_slice::<Value>(body).map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("Invalid Codex Responses request: {error}"),
    })?;
    normalize_responses_request_ids(&mut responses_body);
    image_budget::limit_request_images(&mut responses_body);

    if api_format == "openai-responses" {
        apply_configured_max_output_tokens(&mut responses_body, max_output_tokens);
        let (converted, context) = chat::responses_to_responses(
            &responses_body,
            tool_capabilities.custom_tool_conversion,
            tool_capabilities.native_tool_search,
            tool_capabilities.native_namespace_tools,
        )
        .map_err(|error| HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: format!("Failed to convert local model request: {error}"),
        })?;
        responses_body = converted;
        if tool_capabilities.function_tools_only {
            request_policy::retain_function_tools(&mut responses_body)?;
        }
        let conversion = (!context.is_empty()).then_some(Conversion::Responses(context));
        let expanded_browser_tools = HashSet::new();
        let body = serde_json::to_vec(&responses_body).map_err(|error| HttpError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: format!("Failed to serialize local model request: {error}"),
        })?;
        return Ok((body, conversion, expanded_browser_tools));
    }
    apply_default_max_output_tokens(&mut responses_body, max_output_tokens);
    let (converted, context) = match api_format {
        "openai-chat-completions" => {
            chat::responses_to_chat_with_model_hint(&responses_body, model_hint)
                .map(|(body, context)| (body, Conversion::Chat(context)))
        }
        "anthropic-messages" => anthropic::responses_to_anthropic(&responses_body)
            .map(|(body, context)| (body, Conversion::Anthropic(context))),
        _ => return Ok((body.to_vec(), None, HashSet::new())),
    }
    .map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("Failed to convert local model request: {error}"),
    })?;
    let body = serde_json::to_vec(&converted).map_err(|error| HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("Failed to serialize local model request: {error}"),
    })?;
    Ok((body, Some(context), HashSet::new()))
}

pub(super) fn apply_configured_max_output_tokens(body: &mut Value, max_output_tokens: Option<u64>) {
    let Some(max_output_tokens) = max_output_tokens else {
        return;
    };
    apply_max_output_tokens(body, max_output_tokens);
}

pub(super) fn apply_default_max_output_tokens(body: &mut Value, max_output_tokens: Option<u64>) {
    apply_max_output_tokens(body, max_output_tokens.unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS));
}

pub(super) fn apply_max_output_tokens(body: &mut Value, max_output_tokens: u64) {
    let Some(object) = body.as_object_mut() else {
        return;
    };
    if ["max_output_tokens", "max_completion_tokens", "max_tokens"]
        .iter()
        .any(|field| object.contains_key(*field))
    {
        return;
    }
    object.insert(
        "max_output_tokens".to_owned(),
        Value::Number(max_output_tokens.into()),
    );
}

pub(super) fn normalize_responses_request_ids(body: &mut Value) -> usize {
    let Some(input) = body.get_mut("input") else {
        return 0;
    };
    let items = match input {
        Value::Array(items) => items.as_mut_slice(),
        Value::Object(_) => std::slice::from_mut(input),
        _ => return 0,
    };
    let mut changed = 0;

    for item in items {
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        for field in ["id", "call_id"] {
            let Some(value) = object.get_mut(field) else {
                continue;
            };
            let Some(raw) = value.as_str() else {
                continue;
            };
            let normalized = normalized_responses_api_id(raw);
            if normalized != raw {
                *value = Value::String(normalized);
                changed += 1;
            }
        }
    }

    changed
}

pub(super) fn normalized_responses_api_id(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return value.to_owned();
    }

    let mut prefix = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .take(NORMALIZED_API_ID_PREFIX_LENGTH)
        .collect::<String>();
    if prefix.is_empty() {
        prefix.push_str("id");
    }
    let digest = Sha256::digest(value.as_bytes());
    let suffix = digest[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{prefix}_{suffix}")
}
