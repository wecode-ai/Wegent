// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET`/`POST /api/mcp/interactive-form-question/sse` — the interactive-form
//! MCP server's stateless streamable-HTTP transport
//! (`app/mcp_server/server.py`, `_INTERACTIVE_FORM_MCP_SPEC` and
//! `app/mcp_server/tools/interactive_form_question.py`).
//!
//! The mounted Starlette app serves the MCP streamable-HTTP transport at
//! `/sse` with `stateless_http=True` and `json_response=True`. `GET` opens the
//! server-to-client SSE stream (`StreamableHTTPServerTransport._handle_get_request`):
//! a `200` event stream that only carries keep-alive comments because the source
//! has no server-initiated messages. `POST` migrates the initialization
//! handshake, the empty prompt/resource listings, the
//! `interactive_form_question` tool listing, and the `tools/call` body. The
//! tool body normalizes the model's question payload, rejects a subtask that
//! already rendered a form, writes
//! the UI-only `render_payload` onto the existing tool block in the Redis
//! session store, publishes the source's `chat:block_updated` Socket.IO event,
//! and returns the deferred-result marker that ends the turn silently.
//!
//! The source applies every registered question normalizer in registration
//! order (`app/services/interactive_form_extensions.py`). The internal
//! deployment registers the one-minute-video clarification normalizer, so the
//! registry here is the public extension point: an application registers its
//! normalizers before route construction.

use std::sync::{Arc, RwLock};

use brz_http_server::{Response, StatusCode};
use serde_json::{Map, Value, json};

use crate::internal_callback::py_json::{python_dumps, python_dumps_utf8};
use crate::internal_callback::session;
use crate::socketio_emit;
use crate::state::AppState;
use crate::task_token;

use super::protocol::{self, InboundMessage, RpcRequest};
use super::tools;

mod render;
mod schema;

use self::render::{build_render_payload, valid_render_payload};
use self::schema::INTERACTIVE_FORM_TOOLS;
use super::transport;

/// `_INTERACTIVE_FORM_MCP_SPEC.service_name` and the FastMCP server name.
const SERVER_NAME: &str = "wegent-interactive-form-question-mcp";

/// `FORM_RENDERED_REASON`: the deferred-result reason.
const FORM_RENDERED_REASON: &str = "interactive_form_question form displayed; STOP here and waiting for user response via new conversation";

/// `ServerEvents.CHAT_BLOCK_UPDATED`.
const CHAT_BLOCK_UPDATED: &str = "chat:block_updated";
/// `WebPageSocketEmitter`'s default namespace.
const SOCKETIO_NAMESPACE: &str = "/chat";
/// `BlockStatus.PENDING.value` in the emitted update.
const BLOCK_STATUS_PENDING: &str = "pending";

/// A registered question normalizer (source
/// `InteractiveFormQuestionNormalizer`). The internal normalizer reads the
/// task row, so the hook is async like the source's task lookup.
#[async_trait::async_trait]
pub trait InteractiveFormQuestionNormalizer: Send + Sync {
    /// Apply this normalizer to the raw `tools/call` question payload.
    async fn normalize(&self, task_id: i64, questions: Vec<Value>) -> Vec<Value>;
}

/// `interactive_form_extensions`' registration list, applied in registration
/// order by every `interactive_form_question` call.
#[derive(Default)]
pub struct InteractiveFormRegistry {
    normalizers: RwLock<Vec<Arc<dyn InteractiveFormQuestionNormalizer>>>,
}

impl InteractiveFormRegistry {
    /// Append one normalizer (`register_interactive_form_question_normalizer`).
    pub fn register(&self, normalizer: Arc<dyn InteractiveFormQuestionNormalizer>) {
        self.normalizers
            .write()
            .expect("interactive form registry lock poisoned")
            .push(normalizer);
    }

    /// `normalize_interactive_form_questions`: apply every normalizer in
    /// registration order.
    async fn normalize(&self, task_id: i64, mut questions: Vec<Value>) -> Vec<Value> {
        // Clone the registration list so the lock is never held across an
        // awaited normalizer.
        let normalizers: Vec<Arc<dyn InteractiveFormQuestionNormalizer>> = self
            .normalizers
            .read()
            .expect("interactive form registry lock poisoned")
            .clone();
        for normalizer in normalizers {
            questions = normalizer.normalize(task_id, questions).await;
        }
        questions
    }
}

/// `GET /api/mcp/interactive-form-question/sse`: open the server-to-client SSE
/// stream (`StreamableHTTPServerTransport._handle_get_request`).
#[brz_http_server::get("/api/mcp/interactive-form-question/sse", access = public)]
async fn interactive_form_sse_get(
    #[header("accept")] accept: Option<&str>,
    #[header("mcp-protocol-version")] protocol_version: Option<&str>,
) -> Response {
    if !transport::accepts_sse(accept) {
        return transport::json_response(
            StatusCode::NOT_ACCEPTABLE,
            protocol::server_error_body(
                protocol::INVALID_REQUEST,
                "Not Acceptable: Client must accept text/event-stream",
            ),
        );
    }
    if !protocol::protocol_version_supported(protocol_version) {
        return transport::unsupported_protocol_version(protocol_version);
    }
    transport::sse_stream_response()
}

/// `POST /api/mcp/interactive-form-question/sse`: exchange one JSON-RPC
/// message.
#[brz_http_server::post("/api/mcp/interactive-form-question/sse", access = public)]
async fn interactive_form_sse_post(
    #[inject(state)] state: &Arc<AppState>,
    #[header("accept")] accept: Option<&str>,
    #[header("content-type")] content_type: Option<&str>,
    #[header("mcp-protocol-version")] protocol_version: Option<&str>,
    #[header("authorization")] authorization: Option<&str>,
    body: &[u8],
) -> Response {
    let message = match transport::prepare_message(accept, content_type, protocol_version, body) {
        Ok(message) => message,
        Err(response) => return response,
    };
    let request = match message {
        InboundMessage::Request(request) => request,
        // Notifications and client responses are acknowledged with `202` and
        // have no persistent effect in stateless mode.
        InboundMessage::NoReply => return transport::empty_json_response(StatusCode::ACCEPTED),
    };
    if request.method == "tools/call" {
        let reply = call_tool(state, authorization, &request.id, request.params.as_ref()).await;
        return transport::json_response(StatusCode::OK, reply);
    }
    transport::json_response(StatusCode::OK, dispatch(&request))
}

/// Builds the JSON-RPC reply for one request.
fn dispatch(request: &RpcRequest) -> String {
    match request.method.as_str() {
        "initialize" => protocol::success_body(
            &request.id,
            &transport::initialize_result(SERVER_NAME, request.params.as_ref()),
        ),
        "ping" => protocol::success_body(&request.id, &json!({})),
        "prompts/list" => protocol::success_body(&request.id, &json!({ "prompts": [] })),
        "resources/list" => protocol::success_body(&request.id, &json!({ "resources": [] })),
        "resources/templates/list" => {
            protocol::success_body(&request.id, &json!({ "resourceTemplates": [] }))
        }
        "tools/list" => {
            protocol::success_body(&request.id, &tools::tool_listing(INTERACTIVE_FORM_TOOLS))
        }
        "tools/call" => protocol::error_body(
            &request.id,
            protocol::INVALID_PARAMS,
            &transport::unknown_tool_message(request.params.as_ref()),
        ),
        _ => protocol::error_body(&request.id, protocol::METHOD_NOT_FOUND, "Method not found"),
    }
}

/// `Server.call_tool` for `interactive_form_question`; any other tool name
/// keeps the protocol's `Unknown tool` error.
async fn call_tool(
    state: &AppState,
    authorization: Option<&str>,
    id: &Value,
    params: Option<&Value>,
) -> String {
    let Some(request) = params.and_then(Value::as_object) else {
        return invalid_arguments(id);
    };
    let Some(name) = request.get("name").and_then(Value::as_str) else {
        return invalid_arguments(id);
    };
    if name != "interactive_form_question" {
        return protocol::error_body(
            id,
            protocol::INVALID_PARAMS,
            &format!("Unknown tool: {name}"),
        );
    }
    let empty = Map::new();
    let arguments = request
        .get("arguments")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    match run_interactive_form(state, authorization, arguments).await {
        Ok(result) => {
            let text = python_dumps_utf8(&result);
            protocol::success_body(id, &tools::text_result(text))
        }
        // `tool_wrapper` serializes any escaped exception as this payload.
        Err(message) => {
            let payload = json!({
                "error": {
                    "code": "MCP_TOOL_EXECUTION_FAILED",
                    "message": message,
                    "server": "interactive_form_question",
                    "tool": "interactive_form_question",
                    "retryable": false,
                }
            });
            protocol::success_body(id, &tools::text_result(python_dumps_utf8(&payload)))
        }
    }
}

/// `Server.call_tool`'s envelope-level argument rejection.
fn invalid_arguments(id: &Value) -> String {
    protocol::error_body(id, protocol::INVALID_PARAMS, "Invalid arguments")
}

/// `interactive_form_question`: validate the questions, reject a duplicate
/// form, render and persist the payload, then return the deferred marker.
async fn run_interactive_form(
    state: &AppState,
    authorization: Option<&str>,
    arguments: &Map<String, Value>,
) -> Result<Value, String> {
    // `tool_wrapper`: without an authenticated identity the source returns
    // this payload as an ordinary (non-error) tool result.
    let Some(identity) = task_token::verify(&state.auth, authorization) else {
        return Ok(json!({ "error": "Authentication required" }));
    };
    let questions = arguments
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if questions.is_empty() {
        return Err("questions must contain at least one item".to_string());
    }
    let subtask_id = identity.subtask_id;
    // The source's session reads and writes swallow dependency errors, so an
    // unavailable Redis leaves the deferred result intact.
    if let Some(redis) = state.redis.as_ref()
        && has_existing_interactive_form(redis, subtask_id).await
    {
        return Err(format!(
            "interactive_form_question already displayed for subtask {subtask_id}"
        ));
    }
    let question_data = build_render_payload(
        &state.interactive_form,
        identity.task_id,
        subtask_id,
        arguments.get("questions"),
    )
    .await
    .ok_or_else(|| "questions must contain at least one item".to_string())?;
    if let Some(redis) = state.redis.as_ref() {
        notify_frontend(
            redis,
            identity.task_id,
            subtask_id,
            &question_data,
            &deferred_tool_result(),
        )
        .await;
    }
    Ok(deferred_tool_result())
}

/// `_build_deferred_tool_result`.
fn deferred_tool_result() -> Value {
    json!({
        "__silent_exit__": true,
        "__deferred_user_input__": true,
        "reason": FORM_RENDERED_REASON,
        "success": true,
        "status": "waiting_for_user_response",
    })
}

/// `_has_existing_interactive_form`: a subtask that already carries a valid
/// rendered form rejects a second call.
async fn has_existing_interactive_form<R: brz_redis::Redis>(redis: &R, subtask_id: i64) -> bool {
    let blocks = session::get_blocks(redis, subtask_id).await;
    blocks
        .iter()
        .any(|block| is_interactive_form_block(block) && valid_render_payload(block))
}

/// `_is_interactive_form_tool_block`: a `tool` block whose name mentions the
/// tool (the Chat Shell and Claude Code executors name it differently).
fn is_interactive_form_block(block: &Map<String, Value>) -> bool {
    block.get("type").and_then(Value::as_str) == Some("tool")
        && block
            .get("tool_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name.contains("interactive_form_question"))
}

/// `_notify_frontend`: update the existing tool block and publish the
/// `chat:block_updated` Socket.IO event.
async fn notify_frontend<R: brz_redis::Redis>(
    redis: &R,
    task_id: i64,
    subtask_id: i64,
    render_payload: &Value,
    tool_result: &Value,
) {
    let blocks = session::get_blocks(redis, subtask_id).await;
    let Some(tool_use_id) = blocks
        .iter()
        .rev()
        .find(|block| is_interactive_form_block(block))
        .and_then(|block| block.get("tool_use_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        // The execution event pipeline attaches the render payload to the real
        // tool_use_id block when no session block exists yet.
        return;
    };
    let updated = session::update_tool_block_status(
        redis,
        subtask_id,
        &tool_use_id,
        None,
        Some(tool_result),
        None,
        Some(render_payload),
        None,
        None,
    )
    .await;
    if updated.is_err() {
        return;
    }

    let mut payload = Map::new();
    payload.insert("task_id".into(), json!(task_id));
    payload.insert("subtask_id".into(), json!(subtask_id));
    payload.insert("block_id".into(), json!(tool_use_id));
    payload.insert("tool_output".into(), tool_result.clone());
    payload.insert("render_payload".into(), render_payload.clone());
    payload.insert("status".into(), json!(BLOCK_STATUS_PENDING));
    let data = Value::Array(vec![Value::Object(payload)]);
    let message = socketio_emit::emit_message(
        CHAT_BLOCK_UPDATED,
        &python_dumps(&data),
        SOCKETIO_NAMESPACE,
        &format!("task:{task_id}"),
    );
    let _ = redis
        .publish(socketio_emit::SOCKETIO_CHANNEL, message)
        .await;
}

#[cfg(test)]
mod tests {
    use super::render::validate_rendered_form;
    use super::*;

    fn request(method: &str, id: Value, params: Option<Value>) -> RpcRequest {
        RpcRequest {
            id,
            method: method.to_string(),
            params,
        }
    }

    #[test]
    fn tools_list_publishes_the_recorded_form_surface() {
        let value: Value =
            serde_json::from_str(&dispatch(&request("tools/list", json!(2), None))).unwrap();
        let tools = value["result"]["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "interactive_form_question");
        assert_eq!(
            tools[0]["description"],
            INTERACTIVE_FORM_TOOLS[0].docstring()
        );
        let schema = &tools[0]["inputSchema"];
        assert_eq!(schema["title"], "interactive_form_questionArguments");
        assert_eq!(
            schema["properties"]["questions"],
            json!({
                "items": { "$ref": "#/$defs/InteractiveFormQuestionItem" },
                "title": "Questions",
                "type": "array",
            })
        );
        assert_eq!(
            schema["$defs"]["InteractiveFormOption"]["required"],
            json!(["label", "value"])
        );
        assert_eq!(
            schema["$defs"]["InteractiveFormQuestionItem"]["properties"]["default"]["anyOf"][0],
            json!({ "items": { "type": "string" }, "type": "array" })
        );
    }

    #[tokio::test]
    async fn render_payload_matches_the_recorded_shape() {
        let registry = InteractiveFormRegistry::default();
        let tool_input = json!({
            "questions": [
                {
                    "id": "position1_uv",
                    "question": "请确认推荐第1位播放人数指标。",
                    "options": [{"label": "甲", "value": "1_13208"}]
                },
                {
                    "id": "page_structure",
                    "question": "页面结构？",
                    "input_type": "choice",
                    "options": [{"label": "乙", "value": "with_tabs", "recommended": true}],
                    "required": true
                }
            ]
        });
        let payload = build_render_payload(&registry, 1, 2, tool_input.get("questions"))
            .await
            .expect("payload");
        assert_eq!(payload["type"], "interactive_form_question");
        assert_eq!(payload["questions"][0]["input_type"], "choice");
        assert_eq!(
            payload["questions"][0]["options"][0],
            json!({"label": "甲", "value": "1_13208", "recommended": false})
        );
        assert_eq!(payload["questions"][0]["default"], Value::Null);
        assert_eq!(payload["questions"][0]["placeholder"], Value::Null);
        assert_eq!(payload["questions"][1]["options"][0]["recommended"], true);
    }

    #[tokio::test]
    async fn embedded_question_values_are_recovered() {
        let registry = InteractiveFormRegistry::default();
        let questions = json!([{"id": "q", "input_type": "choice(question(请选择))"}]);
        let payload = build_render_payload(&registry, 1, 2, Some(&questions))
            .await
            .expect("payload");
        assert_eq!(payload["questions"][0]["question"], "请选择");
        assert_eq!(payload["questions"][0]["input_type"], "text");
    }

    #[tokio::test]
    async fn text_questions_clear_multi_select() {
        let registry = InteractiveFormRegistry::default();
        let tool_input = json!({
            "questions": [{
                "id": "free",
                "question": "补充说明",
                "input_type": "textarea",
                "multi_select": true
            }]
        });
        let payload = build_render_payload(&registry, 1, 2, tool_input.get("questions"))
            .await
            .expect("payload");
        assert_eq!(payload["questions"][0]["input_type"], "text");
        assert_eq!(payload["questions"][0]["options"], Value::Null);
        assert_eq!(payload["questions"][0]["multi_select"], false);
    }

    #[tokio::test]
    async fn text_questions_with_options_are_rejected() {
        // `RenderedInteractiveFormQuestion` rejects a text question that still
        // carries choice options; the source surfaces this as a tool error.
        let registry = InteractiveFormRegistry::default();
        let tool_input = json!({
            "questions": [{
                "id": "free",
                "question": "补充说明",
                "input_type": "textarea",
                "options": [{"label": "应拒绝", "value": "drop"}]
            }]
        });
        assert!(
            build_render_payload(&registry, 1, 2, tool_input.get("questions"))
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn registered_normalizers_apply_in_order() {
        struct Append;
        #[async_trait::async_trait]
        impl InteractiveFormQuestionNormalizer for Append {
            async fn normalize(&self, _task_id: i64, questions: Vec<Value>) -> Vec<Value> {
                let mut questions = questions;
                questions.push(json!({"id": "added", "question": "added", "input_type": "text"}));
                questions
            }
        }
        let registry = InteractiveFormRegistry::default();
        registry.register(Arc::new(Append));
        let questions = json!([{"id": "a", "question": "q"}]);
        let payload = build_render_payload(&registry, 1, 2, Some(&questions))
            .await
            .expect("payload");
        assert_eq!(payload["questions"].as_array().unwrap().len(), 2);
        assert_eq!(payload["questions"][1]["id"], "added");
    }

    fn body_bytes(response: &Response) -> &[u8] {
        match response.body() {
            brz_http_server::ResponseBody::Empty => &[],
            brz_http_server::ResponseBody::Owned(bytes) => bytes,
            other => panic!("unexpected response body: {other:?}"),
        }
    }

    #[test]
    fn post_cutover_preserves_python_get_ownership() {
        const PATH: &str = "/api/mcp/interactive-form-question/sse";
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        const POST: u16 = 1 << 5;
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).expect("routes file loads");
        let table = crate::RouteTable::compile(config).expect("routes compile");
        assert!(!table.matches(&http::Method::GET, PATH));
        assert!(table.matches(&http::Method::POST, PATH));
        let mut selected = 0u16;
        for entry in
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
        {
            for route in (entry.0.routes)() {
                if route.path == PATH {
                    selected |= route.methods;
                }
            }
        }
        assert_eq!(selected & GET, GET, "GET {PATH} must be registered");
        assert_eq!(selected & POST, POST, "POST {PATH} must be registered");
    }

    #[tokio::test]
    async fn get_requires_the_event_stream_accept_header() {
        let rejected = interactive_form_sse_get(Some("application/json"), Some("2025-11-25")).await;
        assert_eq!(rejected.status(), StatusCode::NOT_ACCEPTABLE);
        assert_eq!(
            serde_json::from_slice::<Value>(body_bytes(&rejected)).unwrap()["error"]["code"],
            json!(-32600)
        );

        let opened = interactive_form_sse_get(Some("text/event-stream"), Some("2025-11-25")).await;
        assert_eq!(opened.status(), StatusCode::OK);
        assert!(matches!(
            opened.body(),
            brz_http_server::ResponseBody::Stream(_)
        ));
    }

    #[tokio::test]
    async fn get_rejects_an_unsupported_protocol_version() {
        let response =
            interactive_form_sse_get(Some("text/event-stream"), Some("1999-01-01")).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: Value = serde_json::from_slice(body_bytes(&response)).unwrap();
        assert!(
            body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Unsupported protocol version: 1999-01-01")
        );
    }

    #[test]
    fn deferred_result_matches_the_recorded_payload() {
        assert_eq!(
            python_dumps_utf8(&deferred_tool_result()),
            "{\"__silent_exit__\": true, \"__deferred_user_input__\": true, \"reason\": \"interactive_form_question form displayed; STOP here and waiting for user response via new conversation\", \"success\": true, \"status\": \"waiting_for_user_response\"}"
        );
    }

    #[test]
    fn rendered_form_validation_rejects_unrenderable_shapes() {
        assert!(!validate_rendered_form(&json!({
            "type": "interactive_form_question",
            "task_id": 1,
            "subtask_id": 2,
            "questions": [{"id": "a", "question": "q", "input_type": "choice", "options": []}]
        })));
        assert!(validate_rendered_form(&json!({
            "type": "interactive_form_question",
            "task_id": 1,
            "subtask_id": 2,
            "questions": [{"id": "a", "question": "q", "input_type": "text", "options": null}]
        })));
    }
}
