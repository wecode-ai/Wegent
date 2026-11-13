// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Unit tests for the streaming bridge.

use super::events::message_id;
use super::*;

/// The HTTP+Callback consumer must not repeat the producer's side effects.
/// Source sequence (`openapi_responses.py:1372-1379`, `session.py:267-291`,
/// `:324-344`, `:460-479`): one `DEL chat:cancel` in `register_stream`,
/// one `GET chat:cancel` per delivered event, then `close()` and one
/// `DEL chat:cancel` plus `DEL chat:streaming` on cleanup. The
/// `/internal/callback` producer owns every streaming-state write and the
/// terminal completion, so this mode never persists or completes.
#[test]
fn the_callback_consumer_keeps_the_source_side_effect_sequence() {
    let source = include_str!("mod.rs");
    let open_start = source.find("async fn open(&mut self)").expect("open");
    let open_end = source[open_start..]
        .find("self.registered = true;")
        .map(|offset| open_start + offset)
        .expect("registered");
    let open = &source[open_start..open_end];
    let callback_arm = open
        .split("Mode::Callback { .. } => {")
        .nth(1)
        .expect("callback open arm");
    assert_eq!(
        callback_arm
            .matches("redis.del(self.cancel_key.as_str())")
            .count(),
        1,
        "register_stream clears the cancellation flag exactly once"
    );
    assert!(
        !callback_arm.contains("is_cancelled"),
        "register_stream issues no cancellation read"
    );

    let cleanup_start = source.find("async fn cleanup(&mut self)").expect("cleanup");
    let cleanup_end = source[cleanup_start..]
        .find("self.registered = false;")
        .map(|offset| cleanup_start + offset)
        .expect("cleanup end");
    let cleanup = &source[cleanup_start..cleanup_end];
    assert_eq!(
        cleanup
            .matches("redis.del(self.cancel_key.as_str())")
            .count(),
        1,
        "raw_chat_stream's finally runs one unregister_stream DEL: the dispatch \
         task's own unregister is the separate dispatch_exit_unregister stage"
    );
    assert!(
        cleanup.contains("chat:streaming:"),
        "delete_streaming_content releases the streaming key"
    );
    assert!(
        !cleanup.contains("self.callback_mode()"),
        "both modes run raw_chat_stream's single outer unregister"
    );
    assert!(
        cleanup.find("subscription.close()").is_some_and(|close| {
            cleanup
                .find("if !self.registered")
                .is_some_and(|guard| close < guard)
        }),
        "the subscription closes before the cancellation cleanup"
    );

    // The chat-shell dispatch task owns a single inner `unregister_stream`;
    // callback mode has no dispatch task in this process.
    let inner_start = source
        .find("async fn dispatch_exit_unregister(&mut self)")
        .expect("dispatch_exit_unregister");
    let inner = &source[inner_start..]
        .split("\n    async fn cleanup(&mut self)")
        .next()
        .expect("helper body");
    assert!(
        inner.contains("self.callback_mode()"),
        "the producer owns a callback stream's registration"
    );
    assert_eq!(
        inner.matches("redis.del(self.cancel_key.as_str())").count(),
        1,
        "the dispatch exit emits exactly one unregister DEL"
    );

    // No periodic cancel read: the source checks once per delivered event.
    let select_start = source.find("subscription.next_message()").expect("select");
    let select = source[select_start..]
        .split("} else {")
        .next()
        .expect("callback select arm");
    assert!(
        !select.contains("self.poll.tick()"),
        "the callback source has no periodic cancellation poll"
    );

    // The per-event body and the terminal paths skip producer-side work.
    assert!(
        source.contains("if !self.callback_mode()\n            && let Some(emitter)"),
        "callback events are not persisted again"
    );
    assert!(
            source.contains("if self.callback_mode() {\n            // `/internal/callback` owns the terminal persistence"),
            "the callback terminal path does not complete the task"
        );
}

/// The recorded connection-failure streams (`608bc1c3`, `b950c3b5`): the
/// chat-shell dispatch task exits before `ExecutionDispatcher.dispatch`
/// persists the error. The dispatch's own `unregister_stream` DEL must
/// therefore precede the FAILED completion, whose `collect_completed_result`
/// reads `chat:streaming`. `raw_chat_stream`'s per-event cancel read and its
/// outer unregister/streaming-delete follow the completion.
#[test]
fn a_transport_failure_runs_the_dispatch_unregister_before_the_completion() {
    let source = include_str!("mod.rs");
    let start = source
        .find("async fn fail_with_order")
        .expect("fail_with_order");
    let body = &source[start..]
        .split("\n    async fn complete(")
        .next()
        .expect("fail body");
    let inner = body
        .find("self.dispatch_exit_unregister().await")
        .expect("inner unregister");
    let complete = body.find(".complete(").expect("FAILED completion");
    let per_event_read = body
        .find("let _ = self.cancelled().await")
        .expect("per-event cancel read");
    let cleanup = body.rfind("self.cleanup().await").expect("outer cleanup");
    assert!(
        inner < complete,
        "the dispatch exits before the dispatcher persists the failure"
    );
    assert!(
        complete < per_event_read,
        "the failed event's cancel read follows the completion"
    );
    assert!(
        per_event_read < cleanup,
        "raw_chat_stream's outer unregister follows the cancel read"
    );
    assert!(
        !body.contains("FailureOrder::DispatchExitFirst => \"network_error\""),
        "cleanup order must not decide the error classification"
    );
}

/// `classify_error` is an input separate from the cleanup stage: the recorded
/// `Connection error.` is a network failure, and other failure kinds must not
/// inherit that code merely because their dispatch exits first.
#[test]
fn a_failure_carries_its_own_classified_error_type() {
    assert_eq!(
        BridgeFailure::network("Connection error.".to_string()).error_code,
        Some("network_error")
    );
    assert_eq!(
        BridgeFailure::from_message("connection reset by peer".to_string()).error_code,
        Some("network_error")
    );
    assert_eq!(
        BridgeFailure::from_message("connection timed out".to_string()).error_code,
        Some("timeout_error")
    );
    assert_eq!(
        BridgeFailure::from_message("error decoding response body".to_string()).error_code,
        Some("generic_error")
    );
    assert_eq!(BridgeFailure::status(429).error_code, Some("rate_limit"));
    assert_eq!(BridgeFailure::status(401).error_code, Some("forbidden"));
    assert_eq!(
        BridgeFailure::status(404).error_code,
        Some("model_unavailable")
    );
    assert_eq!(BridgeFailure::status(400).error_code, Some("generic_error"));
    assert_eq!(
        BridgeFailure::generic("boom".to_string()).error_code,
        Some("generic_error")
    );
}

#[test]
fn message_ids_are_msg_plus_twelve_lower_hex() {
    let id = message_id();
    assert!(id.starts_with("msg_"));
    assert_eq!(id.len(), 16);
    assert!(
        id[4..]
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    );
}

const TEST_TASK_ID: i64 = 847_036_270_404_273;
const TEST_SUBTASK_ID: i64 = 847_036_270_404_276;
const TEST_CREATED_AT: i64 = 1_793_599_488;

/// A callback-mode bridge fed by a scripted subscription and no Redis: the
/// per-event transform and the terminal/close lifecycle run without the
/// dedicated transport.
fn callback_bridge(payloads: Vec<Vec<u8>>) -> (Bridge, std::sync::Arc<std::sync::Mutex<bool>>) {
    let (subscription, connected) =
        super::super::callback_source::test_support::scripted_source(payloads);
    let mut queue = VecDeque::new();
    for event in framing_events(TEST_TASK_ID, TEST_CREATED_AT, "test-model", None) {
        queue.push_back(event);
    }
    let mut poll = tokio::time::interval(CANCEL_POLL_INTERVAL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let bridge = Bridge {
        app: std::sync::Weak::new(),
        http: HttpClient::builder().build().expect("client"),
        url: String::new(),
        body: Value::Null,
        request_id: "test".to_string(),
        task_id: TEST_TASK_ID,
        subtask_id: TEST_SUBTASK_ID,
        message_id: Some(2),
        model_string: "test-model".to_string(),
        redis: None,
        mysql: MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test?ssl-mode=disabled")
            .expect("lazy pool"),
        tables: Tables {
            tasks: "tasks",
            subtasks: "subtasks",
        },
        executor_manager: crate::executor_manager::ExecutorManager::from_env()
            .expect("executor manager"),
        emitter: None,
        cancel_key: "chat:cancel:test".to_string(),
        mode: Mode::Callback { dispatch_url: None },
        response: None,
        subscription: Some(subscription),
        callback_dispatch: None,
        frames: SseFrames::default(),
        poll,
        queue,
        state: ResponseState::new(
            format!("resp_{TEST_TASK_ID}"),
            "test-model".to_string(),
            TEST_CREATED_AT,
            None,
        ),
        tool_states: HashMap::new(),
        registered: false,
        inner_unregistered: false,
        terminal: false,
        finished: false,
        failed_terminal: false,
    };
    (bridge, connected)
}

fn event(payload: Value) -> Vec<u8> {
    serde_json::to_vec(&payload).expect("event json")
}

async fn drain(bridge: &mut Bridge) -> String {
    let mut body = Vec::new();
    while let Some(bytes) = bridge.next().await {
        body.extend_from_slice(&bytes);
    }
    String::from_utf8(body).expect("utf8 sse")
}

/// The recorded case's event shape: `start`/`chunk`/`done` callback pushes
/// produce the same SSE frames the chat-shell source produces, and the
/// terminal event closes the dedicated subscription.
#[tokio::test]
async fn callback_pushes_stream_the_source_frames_and_close_the_subscription() {
    let (mut bridge, connected) = callback_bridge(vec![
        event(
            json!({"type": "start", "task_id": TEST_TASK_ID, "subtask_id": TEST_SUBTASK_ID,
                "content": "", "result": null, "data": {"shell_type": "claudecode"}}),
        ),
        event(
            json!({"type": "chunk", "task_id": TEST_TASK_ID, "subtask_id": TEST_SUBTASK_ID,
                "content": "hello", "result": null, "data": {}}),
        ),
        event(
            json!({"type": "chunk", "task_id": TEST_TASK_ID, "subtask_id": TEST_SUBTASK_ID,
                "content": " world", "result": null, "data": {}}),
        ),
        event(
            json!({"type": "done", "task_id": TEST_TASK_ID, "subtask_id": TEST_SUBTASK_ID,
                "content": "", "result": {"content": "hello world"}, "data": {}}),
        ),
    ]);

    let body = drain(&mut bridge).await;

    assert!(body.contains("response.created"), "{body}");
    assert!(body.contains("response.in_progress"), "{body}");
    assert!(body.contains("response.output_text.delta"), "{body}");
    assert!(body.contains("hello"), "{body}");
    assert!(body.contains(" world"), "{body}");
    assert!(body.contains("response.completed"), "{body}");
    assert!(
        !*connected.lock().unwrap(),
        "the terminal event releases the dedicated subscription"
    );
}

/// The recorded case's 184 pushes are `ExecutionEvent` JSON: 1 start,
/// 152 chunks, 15 block_created, 15 block_updated, and the terminal done.
/// Every one parses, and the terminal event is the stream end.
#[test]
fn every_recorded_callback_shape_parses_as_an_execution_event() {
    let mut payloads = Vec::new();
    payloads.push(
        json!({"type": "start", "task_id": TEST_TASK_ID, "subtask_id": TEST_SUBTASK_ID,
            "content": "", "result": null, "data": {"shell_type": "claudecode"}}),
    );
    for index in 0..152 {
        payloads.push(
            json!({"type": "chunk", "task_id": TEST_TASK_ID, "subtask_id": TEST_SUBTASK_ID,
                "content": format!("piece {index}"), "offset": index, "result": null,
                "message_id": 2, "data": {"block_id": null, "block_offset": 0}}),
        );
    }
    for index in 0..15 {
        payloads.push(
            json!({"type": "block_created", "task_id": TEST_TASK_ID, "subtask_id": TEST_SUBTASK_ID,
                "content": "", "result": null,
                "data": {"block": {"id": format!("b{index}"), "type": "text"}}}),
        );
        payloads.push(
            json!({"type": "block_updated", "task_id": TEST_TASK_ID, "subtask_id": TEST_SUBTASK_ID,
                "content": "", "result": null,
                "data": {"block_id": format!("b{index}"), "updates": {"content": "x"}}}),
        );
    }
    payloads.push(
        json!({"type": "done", "task_id": TEST_TASK_ID, "subtask_id": TEST_SUBTASK_ID,
            "content": "", "result": {"content": "done"}, "data": {}}),
    );
    assert_eq!(payloads.len(), 184);
    for payload in &payloads {
        let parsed = crate::internal_callback::event::ExecutionEvent::from_value(payload);
        assert!(!parsed.event_type.is_empty(), "{payload}");
        assert_eq!(parsed.task_id, TEST_TASK_ID);
        assert_eq!(parsed.subtask_id, TEST_SUBTASK_ID);
    }
    let last =
        crate::internal_callback::event::ExecutionEvent::from_value(payloads.last().unwrap());
    assert_eq!(
        completion::terminal_status(&last.event_type),
        Some("COMPLETED")
    );
}

/// A payload that is not JSON fails the stream instead of being skipped.
#[tokio::test]
async fn an_unparsable_callback_payload_fails_the_stream() {
    let (mut bridge, connected) = callback_bridge(vec![b"not-json".to_vec()]);
    let body = drain(&mut bridge).await;
    assert!(body.contains("response.failed"), "{body}");
    assert!(!*connected.lock().unwrap());
}

/// An `error` push ends the stream with the source's failed frame.
#[tokio::test]
async fn a_callback_error_event_fails_the_stream() {
    let (mut bridge, connected) = callback_bridge(vec![event(json!({
            "type": "error", "task_id": TEST_TASK_ID, "subtask_id": TEST_SUBTASK_ID,
            "content": "", "error": "boom", "data": {}}))]);

    let body = drain(&mut bridge).await;

    assert!(body.contains("response.failed"), "{body}");
    assert!(body.contains("boom"), "{body}");
    assert!(!*connected.lock().unwrap());
}

/// The recorded payload carries every `ExecutionEvent` member;
/// `from_value` keeps the dataclass defaults for the absent ones.
#[test]
fn a_callback_payload_round_trips_through_the_event_model() {
    let payload = json!({
        "type": "tool_result",
        "task_id": TEST_TASK_ID,
        "subtask_id": TEST_SUBTASK_ID,
        "content": "",
        "offset": 12,
        "result": null,
        "progress": 0,
        "status": "",
        "error": null,
        "error_code": null,
        "tool_name": "exec",
        "tool_use_id": "toolu_1",
        "tool_input": {"command": "ls"},
        "tool_output": "out",
        "message_id": 2,
        "executor_name": null,
        "executor_namespace": null,
        "timestamp": null,
        "data": {"block_id": "b1"}
    });
    let parsed = crate::internal_callback::event::ExecutionEvent::from_value(&payload);
    assert_eq!(parsed.event_type, "tool_result");
    assert_eq!(parsed.offset, 12);
    assert_eq!(parsed.tool_use_id.as_deref(), Some("toolu_1"));
    assert_eq!(parsed.tool_input.as_ref().unwrap()["command"], "ls");
    assert_eq!(parsed.data.get("block_id").unwrap(), "b1");
    assert_eq!(parsed.to_value(), payload, "the wire shape is preserved");
}
