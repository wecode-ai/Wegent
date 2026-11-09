//! Claude block-to-response event translation.
use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) fn emit_claude_message_blocks(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    blocks: Vec<ClaudeMessageBlock>,
    tool_uses: &mut HashMap<String, ClaudeToolUse>,
    anonymous_block_count: &mut usize,
    output_text_state: &mut ClaudeOutputTextState,
    emit_root_text: bool,
    task_id: &str,
    subtask_id: &str,
) {
    for block in blocks {
        match block {
            ClaudeMessageBlock::Root(block) if block.block_type != "text" || emit_root_text => {
                output_text_state.finish_segment();
                emit_claude_root_block(
                    dispatcher,
                    builder,
                    block,
                    anonymous_block_count,
                    task_id,
                    subtask_id,
                );
            }
            ClaudeMessageBlock::Root(_) => output_text_state.finish_segment(),
            ClaudeMessageBlock::OutputText(text) if emit_root_text => {
                emit_claude_output_text(
                    dispatcher,
                    builder,
                    &text.content,
                    output_text_state,
                    task_id,
                    subtask_id,
                );
            }
            ClaudeMessageBlock::OutputText(_) => output_text_state.finish_segment(),
            ClaudeMessageBlock::ToolUse(tool_use) => {
                output_text_state.finish_segment();
                emit_claude_tool_use(dispatcher, builder, &tool_use, task_id, subtask_id);
                tool_uses.insert(tool_use.id.clone(), tool_use);
            }
            ClaudeMessageBlock::ToolResult(tool_result) => {
                output_text_state.finish_segment();
                emit_claude_tool_result_from_state(
                    dispatcher,
                    builder,
                    tool_uses,
                    tool_result,
                    task_id,
                    subtask_id,
                );
            }
            ClaudeMessageBlock::Child(block) => {
                output_text_state.finish_segment();
                emit_claude_child_block(dispatcher, builder, block, task_id, subtask_id);
            }
        }
    }
}

pub(super) fn emit_claude_output_text(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    text: &str,
    state: &mut ClaudeOutputTextState,
    task_id: &str,
    subtask_id: &str,
) {
    let item_id = state.item_id(task_id, subtask_id);
    emit_text_chunks_with_log(
        dispatcher,
        builder,
        text,
        &mut state.offset,
        task_id,
        subtask_id,
        Some((&item_id, state.segment_start)),
    );
}

pub(super) fn emit_claude_root_block(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    block: crate::stream::ClaudeRootBlock,
    anonymous_block_count: &mut usize,
    task_id: &str,
    subtask_id: &str,
) {
    let block_id = resolve_claude_block_id(
        block.id,
        &block.block_type,
        anonymous_block_count,
        task_id,
        subtask_id,
    );
    let event = builder.response_process_block_created(
        &block_id,
        &block.block_type,
        &block.process_kind,
        &block.content,
    );
    dispatcher.send(
        event,
        "streaming Claude process block callback failed",
        vec![
            ("task_id", task_id.to_owned()),
            ("subtask_id", subtask_id.to_owned()),
            ("block_id", block_id),
        ],
    );
}

pub(super) fn resolve_claude_block_id(
    block_id: Option<String>,
    block_type: &str,
    anonymous_block_count: &mut usize,
    task_id: &str,
    subtask_id: &str,
) -> String {
    block_id.unwrap_or_else(|| {
        *anonymous_block_count += 1;
        format!(
            "claude-{task_id}-{subtask_id}-{block_type}-{}",
            *anonymous_block_count
        )
    })
}

pub(super) fn emit_claude_child_block(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    block: ClaudeChildBlock,
    task_id: &str,
    subtask_id: &str,
) {
    let event = builder.response_child_block_created(
        &block.id,
        &block.block_type,
        &block.parent_tool_use_id,
        &block.content,
    );
    dispatcher.send(
        event,
        "streaming child agent block callback failed",
        vec![
            ("task_id", task_id.to_owned()),
            ("subtask_id", subtask_id.to_owned()),
            ("parent_tool_use_id", block.parent_tool_use_id),
        ],
    );
}

pub(super) fn emit_claude_tool_result_from_state(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    tool_uses: &mut HashMap<String, ClaudeToolUse>,
    tool_result: ClaudeToolResult,
    task_id: &str,
    subtask_id: &str,
) {
    let tool_use = tool_uses
        .remove(&tool_result.tool_use_id)
        .unwrap_or_else(|| ClaudeToolUse {
            id: tool_result.tool_use_id.clone(),
            name: "Tool".to_owned(),
            input: Value::Object(Default::default()),
            parent_tool_use_id: tool_result.parent_tool_use_id.clone(),
        });
    emit_claude_tool_result(
        dispatcher,
        builder,
        &tool_use,
        tool_result.content.as_deref(),
        tool_result.is_error,
        task_id,
        subtask_id,
    );
}

pub(super) fn emit_claude_tool_use(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    tool_use: &ClaudeToolUse,
    task_id: &str,
    subtask_id: &str,
) {
    let event = if is_claude_subagent_tool(&tool_use.name) {
        builder.response_subagent_block_created(
            &tool_use.id,
            &tool_use.name,
            &tool_use.input,
            tool_use.parent_tool_use_id.as_deref(),
        )
    } else {
        builder.response_tool_block_created(
            &tool_use.id,
            &tool_use.name,
            &tool_use.input,
            tool_use.parent_tool_use_id.as_deref(),
        )
    };
    dispatcher.send(
        event,
        "streaming tool use callback failed",
        vec![
            ("task_id", task_id.to_string()),
            ("subtask_id", subtask_id.to_string()),
            ("tool_use_id", tool_use.id.clone()),
        ],
    );
}

pub(super) fn emit_claude_tool_result(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    tool_use: &ClaudeToolUse,
    output: Option<&str>,
    is_error: bool,
    task_id: &str,
    subtask_id: &str,
) {
    let event = if is_claude_subagent_tool(&tool_use.name) {
        builder.response_subagent_block_updated(
            &tool_use.id,
            Some(if is_error { "error" } else { "completed" }),
            output,
            None,
            tool_use.parent_tool_use_id.as_deref(),
        )
    } else {
        builder.response_tool_block_updated(
            &tool_use.id,
            &tool_use.input,
            output,
            is_error,
            tool_use.parent_tool_use_id.as_deref(),
        )
    };
    dispatcher.send(
        event,
        "streaming tool result callback failed",
        vec![
            ("task_id", task_id.to_string()),
            ("subtask_id", subtask_id.to_string()),
            ("tool_use_id", tool_use.id.clone()),
        ],
    );
}

#[allow(clippy::too_many_arguments)]
pub(super) fn emit_claude_subagent_update(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    tool_use_id: &str,
    status: &str,
    output: Option<&str>,
    summary: Option<&str>,
    parent_tool_use_id: Option<&str>,
    task_id: &str,
    subtask_id: &str,
) {
    let event = builder.response_subagent_block_updated(
        tool_use_id,
        Some(status),
        output,
        summary,
        parent_tool_use_id,
    );
    dispatcher.send(
        event,
        "streaming child agent status callback failed",
        vec![
            ("task_id", task_id.to_owned()),
            ("subtask_id", subtask_id.to_owned()),
            ("tool_use_id", tool_use_id.to_owned()),
        ],
    );
}

pub(super) fn is_claude_subagent_tool(name: &str) -> bool {
    name.eq_ignore_ascii_case("Task") || name.eq_ignore_ascii_case("Agent")
}

pub(super) fn emit_reasoning_chunks(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    reasoning: &str,
    task_id: &str,
    subtask_id: &str,
) {
    let chunks = split_stream_text(reasoning, stream_reasoning_chunk_chars());
    let chunk_count = chunks.len();
    for delta in chunks {
        let event = builder.response_reasoning_delta(&delta);
        dispatcher.send_text_delta(
            event,
            "streaming reasoning callback failed",
            vec![
                ("task_id", task_id.to_string()),
                ("subtask_id", subtask_id.to_string()),
            ],
            delta.chars().count(),
        );
    }
    let fields = vec![
        ("task_id", task_id.to_string()),
        ("subtask_id", subtask_id.to_string()),
        ("reasoning_chars", reasoning.chars().count().to_string()),
        ("chunk_count", chunk_count.to_string()),
    ];
    log_executor_event("streaming reasoning chunks emitted", &fields);
}

pub(super) fn emit_text_chunks(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    text: &str,
    offset: &mut usize,
    task_id: &str,
    subtask_id: &str,
    item: Option<(&str, usize)>,
) -> usize {
    let chunks = split_stream_text(text, stream_text_chunk_chars());
    let chunk_count = chunks.len();
    for delta in chunks {
        let event = match item {
            Some((item_id, segment_start)) => {
                let mut event = builder.response_text_delta_for_item(item_id, &delta, *offset);
                event.data["block_offset"] = Value::from(*offset - segment_start);
                event
            }
            None => builder.response_text_delta(&delta, *offset),
        };
        let delta_chars = delta.chars().count();
        *offset += delta_chars;
        dispatcher.send_text_delta(
            event,
            "streaming chunk callback failed",
            vec![
                ("task_id", task_id.to_string()),
                ("subtask_id", subtask_id.to_string()),
            ],
            delta_chars,
        );
    }
    chunk_count
}

pub(super) fn emit_text_chunks_with_log(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    text: &str,
    offset: &mut usize,
    task_id: &str,
    subtask_id: &str,
    item: Option<(&str, usize)>,
) {
    let emitted = emit_text_chunks(dispatcher, builder, text, offset, task_id, subtask_id, item);
    let fields = vec![
        ("task_id", task_id.to_owned()),
        ("subtask_id", subtask_id.to_owned()),
        ("chunk_count", emitted.to_string()),
        ("text_chars", text.chars().count().to_string()),
    ];
    log_executor_event("streaming text chunks emitted", &fields);
}

pub(super) fn split_stream_text(text: &str, chunk_chars: usize) -> Vec<String> {
    let chunk_chars = chunk_chars.max(1);
    let mut chunks = Vec::new();
    let mut current = String::new();
    for character in text.chars() {
        current.push(character);
        if current.chars().count() >= chunk_chars {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

pub(super) fn stream_text_chunk_chars() -> usize {
    env::var("WEGENT_EXECUTOR_STREAM_CHUNK_CHARS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_STREAM_TEXT_CHUNK_CHARS)
}

pub(super) fn stream_reasoning_chunk_chars() -> usize {
    env::var("WEGENT_EXECUTOR_STREAM_REASONING_CHUNK_CHARS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_STREAM_REASONING_CHUNK_CHARS)
}
