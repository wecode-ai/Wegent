// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The per-tool lifecycle `raw_chat_stream` keeps between TOOL_START and
//! TOOL_RESULT (`app/api/endpoints/openapi_responses.py:1458-1620`), and the
//! client chunk each protocol emits for it.
//!
//! The saved state is what keeps a `function_call` a function call when the
//! result event reports `mcp_call` (the recorded chat-shell shape): the
//! renderer's `function:{id}` key then resolves to the same output index. A
//! result that legitimately re-normalizes to another protocol through the
//! exec-name fallback renders under that protocol's own index
//! (`streaming.py:204-213`, `:399`/`:462`/`:538`).
use std::collections::HashMap;

use brz_json::adapters::python_truthy;
use serde_json::{Value, json};

use super::super::super::python_json::python_json_dumps;
use super::events::Chunk;
use crate::internal_callback::event::ExecutionEvent;

/// `_normalize_protocol_type`.
fn normalize_protocol_type(value: Option<&str>, tool_name: Option<&str>) -> &'static str {
    match value {
        Some("mcp" | "mcp_call") => "mcp_call",
        Some("shell_call") => "shell_call",
        _ if tool_name == Some("exec") => "shell_call",
        _ => "function_call",
    }
}

/// The saved per-tool state `raw_chat_stream` keeps between TOOL_START and
/// TOOL_RESULT (`openapi_responses.py:1458-1474`): the protocol, name,
/// arguments, and `server_label` recorded when the tool started.
#[derive(Clone, Debug)]
pub(super) struct ToolState {
    protocol: &'static str,
    name: String,
    arguments: Value,
    server_label: Option<String>,
}

/// `tool_input = event.tool_input if not None else {}`, the shared start/result
/// fallback before protocol-specific rendering.
fn tool_input(event: &ExecutionEvent) -> Value {
    event.tool_input.clone().unwrap_or_else(|| json!({}))
}

fn tool_server_label(event: &ExecutionEvent) -> Option<String> {
    event
        .data
        .get("server_label")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// `openapi_responses.py:1458-1506`'s TOOL_START branch: record the state and
/// emit the protocol's added chunk.
pub(super) fn tool_start_chunk(
    states: &mut HashMap<String, ToolState>,
    event: &ExecutionEvent,
) -> Option<Chunk> {
    let tool_use_id = event.tool_use_id.clone().filter(|id| !id.is_empty())?;
    let protocol = normalize_protocol_type(
        event.data.get("tool_protocol").and_then(Value::as_str),
        event.tool_name.as_deref(),
    );
    let name = event.tool_name.clone().unwrap_or_default();
    let arguments = tool_input(event);
    let server_label = tool_server_label(event);
    states.insert(
        tool_use_id.clone(),
        ToolState {
            protocol,
            name: name.clone(),
            arguments: arguments.clone(),
            server_label: server_label.clone(),
        },
    );
    match protocol {
        "mcp_call" => Some(Chunk::McpCallAdded {
            item_id: tool_use_id,
            name,
            server_label: server_label.unwrap_or_default(),
        }),
        "shell_call" => Some(Chunk::ShellCallAdded {
            call_id: tool_use_id,
            name,
            arguments,
        }),
        // `json.dumps(tool_input, ensure_ascii=False) if tool_input is not None
        // else ""` (`:1499-1506`): the `{}` fallback is never None, so an empty
        // input renders `"{}"` instead of an empty string.
        _ => Some(Chunk::FunctionCallAdded {
            call_id: tool_use_id,
            name,
            arguments: python_json_dumps(&arguments),
        }),
    }
}

/// `openapi_responses.py:1511-1519`: a saved `mcp_call` takes the arguments
/// carried by the TOOL update; every other protocol ignores it. No chunk.
pub(super) fn tool_update(states: &mut HashMap<String, ToolState>, event: &ExecutionEvent) {
    let Some(tool_use_id) = event.tool_use_id.clone().filter(|id| !id.is_empty()) else {
        return;
    };
    let Some(state) = states.get_mut(&tool_use_id) else {
        return;
    };
    if state.protocol == "mcp_call" {
        state.arguments = tool_input(event);
    }
}

/// `openapi_responses.py:1529-1620`'s TOOL_RESULT branch: pop the saved state
/// and prefer its protocol, name, and arguments; an orphan result infers them
/// from the event itself.
pub(super) fn tool_result_chunk(
    states: &mut HashMap<String, ToolState>,
    event: &ExecutionEvent,
) -> Option<Chunk> {
    let tool_use_id = event.tool_use_id.clone().filter(|id| !id.is_empty())?;
    let saved = states.remove(&tool_use_id);
    let (saved_protocol, saved_name, saved_arguments, saved_label) = match saved {
        Some(state) => (
            Some(state.protocol),
            state.name,
            state.arguments,
            state.server_label,
        ),
        None => (
            None,
            event.tool_name.clone().unwrap_or_default(),
            tool_input(event),
            tool_server_label(event),
        ),
    };
    // `tool_state.get("name") or event.tool_name or ""`: an unnamed start still
    // renders the result's name.
    let name = if saved_name.is_empty() {
        event.tool_name.clone().unwrap_or_default()
    } else {
        saved_name
    };
    // `_normalize_protocol_type(tool_state.protocol or data.protocol,
    // tool_state.name or event.tool_name)`: the saved protocol is re-normalized
    // against the effective name, so an unnamed `function_call` start whose
    // result name is `exec` classifies as `shell_call` like the source.
    let inferred = normalize_protocol_type(
        event.data.get("tool_protocol").and_then(Value::as_str),
        event.tool_name.as_deref(),
    );
    let protocol = normalize_protocol_type(
        Some(saved_protocol.unwrap_or(inferred)),
        Some(name.as_str()),
    );
    // `event.tool_input if not None else (tool_state.arguments or {})`.
    let arguments = match event.tool_input.clone() {
        Some(arguments) => arguments,
        None if python_truthy(&saved_arguments) => saved_arguments,
        None => json!({}),
    };
    let status = if event.data.get("status").and_then(Value::as_str) == Some("failed") {
        "failed"
    } else {
        "completed"
    };
    match protocol {
        "mcp_call" => Some(Chunk::McpCallDone {
            item_id: tool_use_id,
            name,
            server_label: saved_label.unwrap_or_default(),
            // `json.dumps(arguments, ensure_ascii=False) if arguments else ""`.
            arguments: if python_truthy(&arguments) {
                python_json_dumps(&arguments)
            } else {
                String::new()
            },
            output: event.tool_output.clone(),
            status: status.to_string(),
            error: event.error.clone().or_else(|| {
                event
                    .data
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }),
        }),
        "shell_call" => Some(Chunk::ShellCallDone {
            call_id: tool_use_id,
            name,
            arguments,
            status: status.to_string(),
        }),
        _ => Some(Chunk::FunctionCallDone {
            call_id: tool_use_id,
            name,
            arguments: if python_truthy(&arguments) {
                python_json_dumps(&arguments)
            } else {
                String::new()
            },
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::super::events::ResponseState;
    use super::*;
    use serde_json::json;
    use std::collections::VecDeque;

    fn tool_event(
        id: &str,
        name: Option<&str>,
        input: Option<Value>,
        protocol: Option<&str>,
    ) -> ExecutionEvent {
        let mut event = ExecutionEvent {
            tool_use_id: Some(id.to_string()),
            tool_name: name.map(str::to_string),
            tool_input: input,
            ..ExecutionEvent::default()
        };
        if let Some(protocol) = protocol {
            event
                .data
                .insert("tool_protocol".into(), Value::String(protocol.into()));
        }
        event
    }

    fn result_event(
        id: &str,
        name: Option<&str>,
        input: Option<Value>,
        protocol: Option<&str>,
    ) -> ExecutionEvent {
        let mut event = tool_event(id, name, input, protocol);
        event
            .data
            .insert("status".into(), Value::String("completed".into()));
        event.tool_output = Some(json!({"ok": true}));
        event
    }

    fn frames(chunks: Vec<Chunk>) -> Vec<Value> {
        let mut state = ResponseState::new("resp_test".into(), "m".into(), 1, None);
        let mut queue = VecDeque::new();
        for chunk in chunks {
            state.handle_chunk(&mut queue, chunk);
        }
        queue
            .iter()
            .map(|bytes| {
                let text = std::str::from_utf8(bytes).expect("utf8");
                let rest = text.strip_prefix("data: ").expect("data prefix");
                let rest = rest.strip_suffix("\n\n").expect("frame suffix");
                serde_json::from_str(rest).expect("json")
            })
            .collect()
    }

    fn types(frames: &[Value]) -> Vec<&str> {
        frames
            .iter()
            .map(|frame| frame["type"].as_str().unwrap_or_default())
            .collect()
    }

    #[test]
    fn a_function_start_keeps_its_protocol_and_index_through_an_mcp_result() {
        // Recorded shape: `output_item.added(function_call)` followed by
        // `mcp_call.completed` for the same id. The saved state wins.
        let mut states = HashMap::new();
        let start = tool_start_chunk(
            &mut states,
            &tool_event(
                "toolu_1",
                Some("market-cmapi00074002_weather"),
                Some(json!({})),
                Some("function_call"),
            ),
        )
        .expect("start chunk");
        let done = tool_result_chunk(
            &mut states,
            &result_event(
                "toolu_1",
                Some("market-cmapi00074002_weather"),
                Some(json!({})),
                Some("mcp_call"),
            ),
        )
        .expect("result chunk");
        let frames = frames(vec![start, done]);
        assert_eq!(
            types(&frames),
            [
                "response.output_item.added",
                "response.function_call_arguments.done",
                "response.output_item.done",
            ]
        );
        assert_eq!(frames[0]["item"]["type"], "function_call");
        assert_eq!(frames[2]["item"]["type"], "function_call");
        assert_eq!(frames[0]["output_index"], frames[2]["output_index"]);
    }

    #[test]
    fn a_genuine_mcp_call_stays_mcp_with_one_index() {
        let mut states = HashMap::new();
        let start = tool_start_chunk(
            &mut states,
            &tool_event("mcp_1", Some("search"), None, Some("mcp_call")),
        )
        .expect("start chunk");
        let done = tool_result_chunk(
            &mut states,
            &result_event("mcp_1", Some("search"), None, Some("mcp_call")),
        )
        .expect("result chunk");
        let frames = frames(vec![start, done]);
        assert_eq!(
            types(&frames),
            [
                "response.output_item.added",
                "response.mcp_call.in_progress",
                "response.mcp_call_arguments.done",
                "response.mcp_call.completed",
                "response.output_item.done",
            ]
        );
        assert_eq!(frames[0]["item"]["type"], "mcp_call");
        for index in [0, 1, 2, 3, 4] {
            assert_eq!(frames[index]["output_index"], frames[0]["output_index"]);
        }
    }

    #[test]
    fn interleaved_tool_ids_keep_their_own_state() {
        let mut states = HashMap::new();
        let start_a = tool_start_chunk(
            &mut states,
            &tool_event(
                "toolu_a",
                Some("fn"),
                Some(json!({"a": 1})),
                Some("function_call"),
            ),
        )
        .expect("a start");
        let start_b = tool_start_chunk(
            &mut states,
            &tool_event("toolu_b", Some("mcp"), None, Some("mcp_call")),
        )
        .expect("b start");
        let done_b = tool_result_chunk(
            &mut states,
            &result_event("toolu_b", Some("mcp"), None, Some("mcp_call")),
        )
        .expect("b result");
        let done_a = tool_result_chunk(
            &mut states,
            &result_event(
                "toolu_a",
                Some("fn"),
                Some(json!({"a": 1})),
                Some("mcp_call"),
            ),
        )
        .expect("a result");
        let frames = frames(vec![start_a, start_b, done_b, done_a]);
        // a: function added (1) + function done (2); b: mcp added (2) + done (3).
        assert_eq!(frames.len(), 8);
        assert_eq!(frames[0]["item"]["type"], "function_call");
        assert_eq!(frames[1]["item"]["type"], "mcp_call");
        assert_eq!(frames[7]["item"]["type"], "function_call");
        assert_eq!(frames[0]["output_index"], frames[7]["output_index"]);
        for index in 1..=5 {
            assert_eq!(frames[index]["output_index"], frames[1]["output_index"]);
        }
        assert_ne!(frames[0]["output_index"], frames[1]["output_index"]);
    }

    #[test]
    fn an_orphan_result_infers_its_protocol_and_a_fresh_index() {
        let mut states = HashMap::new();
        let done = tool_result_chunk(
            &mut states,
            &result_event(
                "orphan_1",
                Some("search"),
                Some(json!({"q": "x"})),
                Some("mcp_call"),
            ),
        )
        .expect("result chunk");
        let frames = frames(vec![done]);
        assert_eq!(
            types(&frames),
            [
                "response.mcp_call_arguments.done",
                "response.mcp_call.completed",
                "response.output_item.done",
            ]
        );
        assert_eq!(frames[0]["arguments"], "{\"q\": \"x\"}");
    }

    #[test]
    fn an_unnamed_exec_result_renders_the_shell_protocol_under_its_own_index() {
        // Saved protocol `function_call` with an empty name; the result name
        // `exec` re-normalizes to `shell_call` at the producer, so the renderer
        // allocates the `shell:{id}` index rather than reusing `function:{id}`.
        let mut states = HashMap::new();
        let start = tool_start_chunk(
            &mut states,
            &tool_event(
                "toolu_exec",
                None,
                Some(json!({"command": "ls"})),
                Some("function_call"),
            ),
        )
        .expect("start chunk");
        let done = tool_result_chunk(
            &mut states,
            &result_event("toolu_exec", Some("exec"), None, Some("function_call")),
        )
        .expect("result chunk");
        let frames = frames(vec![start, done]);
        // Producer side: the start is a function item. The result re-normalizes
        // to `shell_call` through the `exec` name fallback, and
        // `streaming.py:457-487` renders the shell done as one
        // `output_item.done` with the new `shell:{id}` index.
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["item"]["name"], "");
        assert_eq!(frames[0]["item"]["type"], "function_call");
        assert_eq!(frames[1]["item"]["name"], "exec");
        assert_eq!(frames[1]["item"]["type"], "shell_call");
        assert_ne!(frames[0]["output_index"], frames[1]["output_index"]);
    }

    #[test]
    fn start_arguments_serialize_like_python_json_dumps() {
        let mut states = HashMap::new();
        for (input, expected) in [
            (json!({}), "{}"),
            (json!(false), "false"),
            (json!([]), "[]"),
            (json!(0), "0"),
            (
                json!({"lat": 29.879473099964205, "name": "经纬度"}),
                "{\"lat\": 29.879473099964205, \"name\": \"经纬度\"}",
            ),
        ] {
            let chunk = tool_start_chunk(
                &mut states,
                &tool_event("toolu_args", Some("fn"), Some(input), Some("function_call")),
            )
            .expect("start chunk");
            let frames = frames(vec![chunk]);
            assert_eq!(frames[0]["item"]["arguments"], expected);
        }
    }

    #[test]
    fn result_arguments_require_truthiness_and_keep_python_separators() {
        let mut states = HashMap::new();
        for (input, expected) in [
            (json!({}), ""),
            (json!(false), ""),
            (json!([]), ""),
            (
                json!({"a": 1, "b": "经纬度"}),
                "{\"a\": 1, \"b\": \"经纬度\"}",
            ),
        ] {
            let chunk = tool_result_chunk(
                &mut states,
                &result_event(
                    "toolu_result",
                    Some("fn"),
                    Some(input),
                    Some("function_call"),
                ),
            )
            .expect("result chunk");
            let frames = frames(vec![chunk]);
            // `function_call_arguments.done` is the first frame of the pair.
            assert_eq!(frames[0]["arguments"], expected);
        }
    }
}
