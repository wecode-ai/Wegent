// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Unit tests for the streaming bridge.

use super::events::message_id;
use super::*;

/// The HTTP+Callback consumer must not repeat the producer's side effects.
/// Registration guards committed cancel intents atomically. Each delivered
/// event still reads cancellation once; cleanup closes the intent and flag
/// before deleting streaming content. The
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
            .matches("register_stream(self.redis.as_ref(), self.subtask_id).await")
            .count(),
        1,
        "register_stream performs exactly one intent-guarded registration"
    );
    assert!(
        !callback_arm.contains("is_cancelled"),
        "register_stream issues no cancellation read"
    );

    let cleanup_start = source.find("async fn cleanup(&mut self)").expect("cleanup");
    let cleanup_end = source[cleanup_start..]
        .find("\n    }\n}")
        .map(|offset| cleanup_start + offset)
        .expect("cleanup end");
    let cleanup = &source[cleanup_start..cleanup_end];
    assert_eq!(
        cleanup
            .matches("unregister_stream(Some(redis), self.subtask_id).await")
            .count(),
        1,
        "raw_chat_stream's finally runs one atomic unregister: the dispatch \
         task's own unregister is the separate dispatch_exit_unregister stage"
    );
    assert!(
        cleanup.contains("chat:streaming:"),
        "delete_streaming_content releases the streaming key"
    );
    assert!(
        !cleanup.contains("self.callback_mode()"),
        "chat-shell and executor callbacks retain their outer unregister"
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
        inner
            .matches("unregister_stream(self.redis.as_ref(), self.subtask_id).await")
            .count(),
        1,
        "the dispatch exit emits exactly one atomic unregister"
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
    let settled = FastApiError::detail(
        brz_http_server::StatusCode::CONFLICT,
        "Assistant subtask is no longer dispatchable",
    );
    assert!(BridgeFailure::dispatch(&settled).terminal_winner);
    let unrelated = FastApiError::detail(brz_http_server::StatusCode::CONFLICT, "Device busy");
    assert!(!BridgeFailure::dispatch(&unrelated).terminal_winner);
    assert!(!BridgeFailure::network("Connection error.".to_owned()).terminal_winner);
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
        mode: Mode::Callback {
            target: CallbackDispatchTarget::Executor { url: None },
        },
        response: None,
        subscription: Some(subscription),
        callback_dispatch: None,
        callback_dispatch_settled: true,
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
        device_text: DeviceTextOffsets::default(),
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

#[tokio::test]
async fn device_terminal_snapshots_preserve_text_and_block_identity() {
    for delta in [None, Some("部分🙂")] {
        let mut payloads = vec![event(json!({
            "type": "block_created", "task_id": TEST_TASK_ID, "subtask_id": TEST_SUBTASK_ID,
            "data": {"block": {"id": "text-1", "type": "text", "content": ""}}
        }))];
        if let Some(delta) = delta {
            payloads.push(event(json!({
                "type": "chunk", "task_id": TEST_TASK_ID, "subtask_id": TEST_SUBTASK_ID,
                "content": delta, "offset": 0, "data": {"block_id": "text-1", "block_offset": 0}
            })));
        }
        payloads.push(event(json!({
            "type": "done", "task_id": TEST_TASK_ID, "subtask_id": TEST_SUBTASK_ID,
            "result": {"value": "完整回复🙂", "blocks": [
                {"id": "text-1", "type": "text", "content": "完整回复🙂", "status": "done"}
            ]}
        })));
        let (mut bridge, connected) = callback_bridge(payloads);
        bridge.mode = Mode::Callback {
            target: CallbackDispatchTarget::Device {
                route: "test-device".to_owned(),
            },
        };

        let body = drain(&mut bridge).await;
        let frames: Vec<Value> = body
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .map(|line| serde_json::from_str(line).expect("SSE frame"))
            .collect();
        let completed = frames
            .iter()
            .find(|frame| frame["type"] == "response.completed")
            .expect("completed frame");
        assert_eq!(
            completed["response"]["output"][0]["content"][0]["text"],
            "完整回复🙂"
        );
        assert_eq!(
            frames
                .iter()
                .filter(|frame| frame["type"] == "response.output_text.delta")
                .count(),
            1
        );
        assert_eq!(
            frames
                .iter()
                .filter(|frame| frame["type"] == "response.block.created")
                .count(),
            1
        );
        assert_eq!(
            frames
                .iter()
                .filter(|frame| frame["type"] == "response.block.updated")
                .count(),
            1
        );
        assert!(!*connected.lock().unwrap());
    }
}

#[tokio::test]
async fn device_cancellation_waits_for_the_canonical_terminal_event() {
    use crate::responses::test_redis::RecordingRedis;

    let redis = RecordingRedis::default();
    redis.mark_cancelled();
    for (device, terminal) in [(false, "done"), (true, "done"), (true, "cancelled")] {
        let (mut bridge, connected) = callback_bridge(Vec::new());
        bridge.cancel_key = format!("chat:cancel:{}", crate::responses::test_mysql::SUBTASK_ID);
        if device {
            bridge.mode = Mode::Callback {
                target: CallbackDispatchTarget::Device {
                    route: "test-device".to_owned(),
                },
            };
        }
        let chunk = ExecutionEvent::from_value(&json!({
            "type": "chunk", "content": "部分🙂"
        }));
        assert_eq!(
            bridge.handle_parsed_from_source(chunk, Some(&redis)).await,
            !device
        );
        assert_eq!(bridge.finished, !device);
        assert_eq!(*connected.lock().unwrap(), device);
        if device {
            let terminal = ExecutionEvent::from_value(&json!({
                "type": terminal, "result": {"value": "已提交回复🙂"}
            }));
            bridge
                .handle_parsed_from_source(terminal, Some(&redis))
                .await;
        }

        let frames: Vec<Value> = drain(&mut bridge)
            .await
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .map(|line| serde_json::from_str(line).expect("SSE frame"))
            .collect();
        let completed = frames
            .iter()
            .find(|frame| frame["type"] == "response.completed")
            .expect("completed frame");
        if device {
            assert_eq!(
                completed["response"]["output"][0]["content"][0]["text"],
                "已提交回复🙂"
            );
        } else {
            assert!(
                frames
                    .iter()
                    .all(|frame| frame["type"] != "response.output_text.delta")
            );
        }
        assert!(!*connected.lock().unwrap());
    }
}

#[tokio::test]
async fn an_unsettled_device_dispatch_keeps_its_reader_for_cancellation() {
    let (mut bridge, connected) = callback_bridge(vec![event(json!({
        "type": "cancelled", "result": {"value": "取消时已提交的回复🙂"}
    }))]);
    bridge.mode = Mode::Callback {
        target: CallbackDispatchTarget::Device {
            route: "test-device".to_owned(),
        },
    };

    bridge.finish_committed_winner_result(Ok(None)).await;

    assert!(!bridge.finished);
    assert!(*connected.lock().unwrap());
    let body = drain(&mut bridge).await;
    assert!(body.contains("response.completed"), "{body}");
    assert!(body.contains("取消时已提交的回复🙂"), "{body}");
    assert!(!body.contains("response.failed"), "{body}");
    assert!(!*connected.lock().unwrap());
}

#[tokio::test]
async fn a_nondispatchable_device_turn_fails_when_no_producer_exists() {
    let (mut bridge, connected) = callback_bridge(Vec::new());
    bridge.mode = Mode::Callback {
        target: CallbackDispatchTarget::Device {
            route: "test-device".to_owned(),
        },
    };
    bridge.callback_dispatch_settled = false;

    bridge
        .fail(BridgeFailure::dispatch(&FastApiError::detail(
            brz_http_server::StatusCode::CONFLICT,
            "Assistant subtask is no longer dispatchable",
        )))
        .await;

    let body = drain(&mut bridge).await;
    assert!(body.contains("response.failed"), "{body}");
    assert!(
        body.contains("Assistant subtask is no longer dispatchable"),
        "{body}"
    );
    assert!(!*connected.lock().unwrap());
}

#[tokio::test]
async fn a_queue_rejection_is_not_reported_as_settled_dispatch() {
    use super::super::callback_source::test_support::ScriptedSubscriptions;
    use crate::sql_test_support::mysql_rows::{MysqlRows, Value as MysqlValue};

    let fixture =
        MysqlRows::start_results(|_| (vec![("id", MysqlValue::I64(TEST_TASK_ID))], Vec::new()))
            .await;
    let mut app = crate::app_test_support::app(fixture.mysql.clone());
    {
        let state = std::sync::Arc::get_mut(&mut app).expect("uniquely owned test app");
        state.callback_subscriptions =
            Some(std::sync::Arc::new(ScriptedSubscriptions::new(Vec::new())));
    }
    assert!(
        app.completion_app
            .set(std::sync::Arc::downgrade(&app))
            .is_ok()
    );
    let request = ExecutionRequest {
        task_id: TEST_TASK_ID,
        subtask_id: TEST_SUBTASK_ID,
        message_id: Some(2),
        prompt: json!("hello"),
        model_config: json!({"model_id": "test-model"}),
        ..ExecutionRequest::default()
    };
    let input = BridgeInput {
        model_string: "test-model",
        previous_response_id: None,
        request_id: "request-id",
        created_at: TEST_CREATED_AT,
        target_url: None,
    };
    let mut bridge = test_bridge(
        &app,
        &request,
        &input,
        CallbackDispatchTarget::Device {
            route: "test-device".to_owned(),
        },
    )
    .expect("callback bridge");
    let permits: Vec<_> = std::iter::from_fn(|| app.responses_dispatch.reserve()).collect();
    assert!(!permits.is_empty());
    let failure = bridge
        .open_callback()
        .await
        .expect_err("the full device queue must reject callback dispatch");
    assert!(bridge.subscription.is_some());
    assert!(!bridge.callback_dispatch_settled);
    assert_eq!(failure.message, "Device dispatch queue unavailable");
    drop(permits);
    bridge.fail(failure).await;
    let body = drain(&mut bridge).await;
    assert!(body.contains("response.failed"), "{body}");
    assert!(body.contains("Device dispatch queue unavailable"), "{body}");
}

async fn drain_stream(mut body: BodyStream) -> String {
    let mut text = String::new();
    while let Some(chunk) = futures_util::StreamExt::next(&mut body).await {
        text.push_str(&String::from_utf8_lossy(&chunk.expect("body chunk")));
    }
    text
}

#[tokio::test]
async fn a_committed_device_dispatch_winner_replaces_partial_text() {
    let (mut bridge, connected) = callback_bridge(Vec::new());
    bridge.mode = Mode::Callback {
        target: CallbackDispatchTarget::Device {
            route: "test-device".to_owned(),
        },
    };
    bridge
        .handle_parsed(ExecutionEvent::from_value(&json!({
            "type": "chunk", "content": "部分🙂"
        })))
        .await;

    bridge
        .finish_committed_winner_result(Ok(Some(completion::StoredTerminal {
            status: "COMPLETED".to_owned(),
            result: Some(json!({"value": "竞争方已提交🙂"})),
            error: None,
        })))
        .await;

    let frames: Vec<Value> = drain(&mut bridge)
        .await
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(|line| serde_json::from_str(line).expect("SSE frame"))
        .collect();
    let completed = frames
        .iter()
        .find(|frame| frame["type"] == "response.completed")
        .expect("completed frame");
    assert_eq!(
        completed["response"]["output"][0]["content"][0]["text"],
        "竞争方已提交🙂"
    );
    assert_eq!(
        frames
            .iter()
            .filter(|frame| frame["type"] == "response.output_text.delta")
            .count(),
        1
    );
    assert!(!*connected.lock().unwrap());
}

#[tokio::test]
async fn device_text_replays_and_overlaps_use_unicode_item_offsets() {
    for gap in [false, true] {
        let mut deltas = vec![
            ("one", 0, "检查🙂"),
            ("one", 0, "检查🙂"),
            ("one", 2, "🙂中"),
        ];
        if gap {
            deltas.push(("one", 6, "尾"));
        }
        deltas.extend([("two", 0, "完成"), ("two", 0, "完成"), ("two", 1, "成🚀")]);
        let streamed = if gap {
            "检查🙂中尾完成🚀"
        } else {
            "检查🙂中完成🚀"
        };
        let canonical = if gap {
            "检查🙂中缺失尾完成🚀"
        } else {
            streamed
        };
        let mut payloads: Vec<_> = deltas
            .into_iter()
            .map(|(id, offset, text)| {
                event(json!({
                    "type": "chunk", "task_id": TEST_TASK_ID, "subtask_id": TEST_SUBTASK_ID,
                    "content": text, "data": {"block_id": id, "block_offset": offset}
                }))
            })
            .collect();
        payloads.push(event(json!({
            "type": "done", "task_id": TEST_TASK_ID, "subtask_id": TEST_SUBTASK_ID,
            "result": {"value": canonical}
        })));
        let (mut bridge, _) = callback_bridge(payloads);
        bridge.mode = Mode::Callback {
            target: CallbackDispatchTarget::Device {
                route: "test-device".to_owned(),
            },
        };

        let body = drain(&mut bridge).await;
        let frames: Vec<Value> = body
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .map(|line| serde_json::from_str(line).expect("SSE frame"))
            .collect();
        let deltas: Vec<_> = frames
            .iter()
            .filter(|frame| frame["type"] == "response.output_text.delta")
            .map(|frame| frame["delta"].as_str().expect("text delta"))
            .collect();
        assert_eq!(deltas.concat(), streamed);
        assert_eq!(
            deltas.len(),
            if gap { 5 } else { 4 },
            "terminal snapshots must not add deltas"
        );
        let completed = frames
            .iter()
            .find(|frame| frame["type"] == "response.completed")
            .expect("completed frame");
        assert_eq!(
            completed["response"]["output"][0]["content"][0]["text"],
            canonical
        );
    }
}

#[tokio::test]
async fn an_immediate_dispatch_reply_is_retained_after_subscription() {
    use super::super::callback_source::{CallbackSourceError, CallbackSubscriptions};
    struct LiveSubscriptions(tokio::sync::broadcast::Sender<Vec<u8>>);
    struct LiveSource(tokio::sync::broadcast::Receiver<Vec<u8>>);
    #[async_trait::async_trait]
    impl CallbackSubscriptions for LiveSubscriptions {
        async fn subscribe(
            &self,
            _channel: &str,
        ) -> Result<Box<dyn CallbackEventSource>, CallbackSourceError> {
            Ok(Box::new(LiveSource(self.0.subscribe())))
        }
    }
    #[async_trait::async_trait]
    impl CallbackEventSource for LiveSource {
        async fn next_message(&mut self) -> Result<Option<CallbackMessage>, CallbackSourceError> {
            self.0
                .recv()
                .await
                .map(|payload| {
                    Some(CallbackMessage {
                        payload: Bytes::from(payload),
                    })
                })
                .map_err(|error| CallbackSourceError {
                    message: error.to_string(),
                })
        }
        async fn close(self: Box<Self>) {}
    }
    let (sender, initial) = tokio::sync::broadcast::channel(1);
    drop(initial);
    let provider = LiveSubscriptions(sender);
    let terminal = event(json!({"type": "done", "result": {"value": "立即完成🙂"}}));
    let mut subscription = None;

    callback::subscribe_before_dispatch(
        &provider,
        "callback:channel:test",
        &mut subscription,
        || async {
            let _ = provider.0.send(terminal.clone());
            Ok(())
        },
    )
    .await
    .expect("subscribe and dispatch");

    let reply = tokio::time::timeout(
        Duration::from_secs(1),
        subscription.as_mut().unwrap().next_message(),
    )
    .await
    .expect("first event must be retained")
    .expect("read")
    .expect("reply");
    assert_eq!(reply.payload.as_ref(), terminal.as_slice());
    subscription.take().unwrap().close().await;
}

#[tokio::test]
async fn dropping_a_device_stream_closes_its_reader() {
    struct CloseSignal(tokio::sync::oneshot::Sender<()>);
    #[async_trait::async_trait]
    impl CallbackEventSource for CloseSignal {
        async fn next_message(&mut self) -> Result<Option<CallbackMessage>, CallbackSourceError> {
            std::future::pending().await
        }
        async fn close(self: Box<Self>) {
            let _ = self.0.send(());
        }
    }
    let (closed, close_received) = tokio::sync::oneshot::channel();
    let (mut bridge, _) = callback_bridge(Vec::new());
    bridge.subscription.take().unwrap().close().await;
    bridge.subscription = Some(Box::new(CloseSignal(closed)));
    bridge.mode = Mode::Callback {
        target: CallbackDispatchTarget::Device {
            route: "test-device".to_owned(),
        },
    };

    drop(bridge);

    tokio::time::timeout(Duration::from_secs(1), close_received)
        .await
        .expect("reader teardown must finish")
        .expect("reader closed");
}

#[tokio::test]
async fn an_unavailable_callback_reader_prevents_submission() {
    let provider = super::super::callback_source::test_support::ScriptedSubscriptions::failing();
    let mut subscription = None;
    let result = callback::subscribe_before_dispatch(
        &provider,
        "callback:channel:test",
        &mut subscription,
        || async { panic!("A device turn cannot start without its callback reader") },
    )
    .await;
    assert!(result.is_err());
    assert!(subscription.is_none());
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
