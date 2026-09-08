// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use wegent_executor::local::session::{LocalSession, TerminalEvent};

fn fixture(output: VecDeque<Vec<u8>>) -> (LocalSessionHandler, Arc<Mutex<RecordingTerminal>>) {
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        output,
        ..RecordingTerminal::default()
    }));
    let mut handler = test_session_handler_with_terminal(Arc::clone(&terminal));
    handler.sessions.insert(
        "terminal-compat".to_owned(),
        LocalSession::terminal(
            "terminal-compat",
            "test-token",
            1,
            handler.workspace_root.clone(),
            Box::new(SharedTerminal(Arc::clone(&terminal))),
            u64::MAX,
        ),
    );
    (handler, terminal)
}

fn wire_runner(
    handler: LocalSessionHandler,
    transport: RecordingTransport,
) -> LocalBackendRunner<RecordingTransport, RecordingTaskRunner> {
    let mut config = local_backend_config();
    config.reconnect_delay = Duration::from_millis(1);
    config.reconnect_delay_max = Duration::from_millis(2);
    LocalBackendRunner::with_task_runner(config, transport, RecordingTaskRunner::default())
        .with_session_handler(handler)
}

async fn attach(transport: &RecordingTransport, version: Option<u64>) -> Value {
    let mut payload = json!({"session_id": "terminal-compat"});
    if let Some(version) = version {
        payload["protocol_version"] = json!(version);
    }
    if version == Some(2) {
        payload["consumer_id"] = json!("consumer-1");
        payload["last_acked_sequence"] = json!(0);
    }
    transport.handler("terminal:attach").unwrap()(payload)
        .await
        .unwrap()
}

#[tokio::test]
async fn absent_and_explicit_v1_attach_preserve_legacy_controls_and_close_idempotence() {
    for version in [None, Some(1)] {
        let (handler, terminal) = fixture(VecDeque::new());
        let transport = RecordingTransport::default();
        let runner = wire_runner(handler, transport.clone());
        runner.register_handlers();

        let response = attach(&transport, version).await;
        assert_eq!(response["success"], true, "{response}");
        assert_eq!(response["protocol_version"], 1);
        for (event, payload) in [
            (
                "terminal:input",
                json!({"session_id": "terminal-compat", "data": "pwd\r"}),
            ),
            (
                "terminal:resize",
                json!({"session_id": "terminal-compat", "rows": 40, "cols": 120}),
            ),
            ("terminal:close", json!({"session_id": "terminal-compat"})),
            ("terminal:close", json!({"session_id": "terminal-compat"})),
        ] {
            let response = transport.handler(event).unwrap()(payload).await.unwrap();
            assert_eq!(response["success"], true, "{event}: {response}");
        }
        let terminal = terminal.lock().unwrap();
        assert_eq!(terminal.writes, [b"pwd\r".to_vec()]);
        assert_eq!(terminal.resizes, [(40, 120)]);
        assert!(terminal.closed && terminal.terminated);
    }
}

#[tokio::test]
async fn attach_rejects_unknown_versions_and_malformed_v2_without_pinning_session() {
    let (handler, _) = fixture(VecDeque::new());
    let transport = RecordingTransport::default();
    let runner = wire_runner(handler, transport.clone());
    runner.register_handlers();
    let valid = json!({
        "session_id": "terminal-compat", "protocol_version": 2,
        "consumer_id": "consumer-1", "last_acked_sequence": 0
    });
    let mut invalid = Vec::new();
    for version in [
        json!(0),
        json!(3),
        json!(-1),
        json!(2.0),
        json!("2"),
        json!(true),
        Value::Null,
    ] {
        let mut request = valid.clone();
        request["protocol_version"] = version;
        invalid.push(request);
    }
    for field in ["consumer_id", "last_acked_sequence"] {
        let mut request = valid.clone();
        request.as_object_mut().unwrap().remove(field);
        invalid.push(request);
    }
    for consumer in [json!(""), json!("  "), json!(1), Value::Null] {
        let mut request = valid.clone();
        request["consumer_id"] = consumer;
        invalid.push(request);
    }
    for sequence in [
        json!("0"),
        json!(-1),
        json!(0.0),
        json!(false),
        Value::Null,
        json!(1),
    ] {
        let mut request = valid.clone();
        request["last_acked_sequence"] = sequence;
        invalid.push(request);
    }
    for request in invalid {
        let response = transport.handler("terminal:attach").unwrap()(request.clone())
            .await
            .unwrap();
        assert_eq!(response["success"], false, "{request}: {response}");
        assert!(response.get("protocol_version").is_none());
    }
    let response = attach(&transport, Some(2)).await;
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["protocol_version"], 2);
}

#[tokio::test]
async fn legacy_and_wrong_consumer_controls_cannot_bypass_v2() {
    let (handler, terminal) = fixture(VecDeque::new());
    let transport = RecordingTransport::default();
    let runner = wire_runner(handler, transport.clone());
    runner.register_handlers();
    assert_eq!(attach(&transport, Some(2)).await["success"], true);
    for consumer in [
        None,
        Some(json!("wrong")),
        Some(json!("")),
        Some(Value::Null),
        Some(json!(12)),
    ] {
        for event in [
            "terminal:input",
            "terminal:resize",
            "terminal:close",
            "terminal:ack",
        ] {
            let mut payload = json!({"session_id": "terminal-compat", "data": "bad", "rows": 3, "cols": 3, "sequence": 1});
            if let Some(consumer) = &consumer {
                payload["consumer_id"] = consumer.clone();
            }
            let response = transport.handler(event).unwrap()(payload).await.unwrap();
            assert_eq!(response["success"], false, "{event}: {response}");
        }
    }
    for version in [None, Some(1)] {
        assert_eq!(attach(&transport, version).await["success"], false);
    }
    let terminal = terminal.lock().unwrap();
    assert!(terminal.writes.is_empty() && terminal.resizes.is_empty());
    assert!(!terminal.closed && !terminal.terminated);
}

#[tokio::test]
async fn v1_pin_ignores_v2_fields_and_rejects_upgrade() {
    let (handler, _) = fixture(VecDeque::new());
    let transport = RecordingTransport::default();
    let runner = wire_runner(handler, transport.clone());
    runner.register_handlers();
    let response = transport.handler("terminal:attach").unwrap()(json!({
        "session_id": "terminal-compat", "consumer_id": "ignored", "last_acked_sequence": 999
    }))
    .await
    .unwrap();
    assert_eq!(response["protocol_version"], 1);
    assert_eq!(attach(&transport, Some(2)).await["success"], false);
    assert_eq!(attach(&transport, Some(1)).await["success"], true);
    let response = transport.handler("terminal:ack").unwrap()(json!({
        "session_id": "terminal-compat", "consumer_id": "ignored", "sequence": 1
    }))
    .await
    .unwrap();
    assert_eq!(response["success"], false);
}

#[tokio::test]
async fn old_backend_new_executor_streams_over_replay_limit_without_browser_ack() {
    for version in [None, Some(1)] {
        let expected = (0..256)
            .map(|index| vec![(index % 26) as u8 + b'a'; 8192])
            .collect::<Vec<_>>();
        let (handler, terminal) = fixture(expected.clone().into());
        let transport = RecordingTransport::default();
        let runner = wire_runner(handler, transport.clone());
        let task = tokio::spawn(runner.run_forever());
        wait_until(|| transport.handler("terminal:attach").is_some()).await;
        assert_eq!(attach(&transport, version).await["protocol_version"], 1);
        wait_until(|| {
            transport
                .calls()
                .iter()
                .filter(|call| call.event == "terminal:output")
                .map(|call| call.payload["data"].as_str().unwrap().len())
                .sum::<usize>()
                == 2 * 1024 * 1024
        })
        .await;

        // Repeated attach after released history must resume internally, not from zero.
        assert_eq!(attach(&transport, version).await["success"], true);
        terminal.lock().unwrap().exit_code = Some(0);
        assert_eq!(attach(&transport, version).await["success"], true);
        wait_until(|| {
            transport
                .calls()
                .iter()
                .any(|call| call.event == "terminal:exit")
        })
        .await;
        task.abort();
        let _ = task.await;
        let calls = transport.calls();
        let output = calls
            .iter()
            .filter(|call| call.event == "terminal:output")
            .flat_map(|call| call.payload["data"].as_str().unwrap().as_bytes().to_vec())
            .collect::<Vec<_>>();
        assert_eq!(output, expected.concat());
        for call in calls
            .iter()
            .filter(|call| call.event == "terminal:output" || call.event == "terminal:exit")
        {
            assert!(call.payload.get("sequence").is_none());
            assert!(call.payload.get("consumer_id").is_none());
            assert!(call.payload.get("protocol_version").is_none());
        }
        assert_eq!(
            calls
                .iter()
                .find(|call| call.event == "terminal:exit")
                .unwrap()
                .payload,
            json!({"session_id": "terminal-compat", "exit_code": 0})
        );
    }
}

#[test]
fn legacy_failure_and_reconnect_retain_bounded_output_at_internal_ack_position() {
    let (mut handler, terminal) = fixture(VecDeque::from([b"accepted".to_vec()]));
    assert!(
        handler
            .handle_legacy_terminal_attach("terminal-compat")
            .success
    );
    let first = handler.drain_terminal_events();
    assert_eq!(first.len(), 1);
    assert!(handler
        .begin_terminal_output_delivery("terminal-compat", None, 1)
        .unwrap());
    handler
        .complete_terminal_output_delivery("terminal-compat", 1)
        .unwrap();
    terminal.lock().unwrap().output = (0..256).map(|_| vec![b'x'; 8192]).collect();
    let mut retained = Vec::new();
    for _ in 0..10 {
        let events = handler.drain_terminal_events();
        for event in events {
            let TerminalEvent::Output {
                sequence,
                ref consumer_id,
                ..
            } = event
            else {
                panic!("unexpected exit")
            };
            assert!(consumer_id.is_none());
            assert!(handler
                .begin_terminal_output_delivery("terminal-compat", None, sequence)
                .unwrap());
            retained.push(event);
        }
    }
    let retained_bytes = retained
        .iter()
        .map(|event| match event {
            TerminalEvent::Output { data, .. } => data.len(),
            _ => 0,
        })
        .sum::<usize>();
    assert_eq!(retained_bytes, 384 * 1024);
    assert!(handler.drain_terminal_events().is_empty());
    assert!(!terminal.lock().unwrap().output.is_empty());
    assert!(handler.retry_terminal_output_delivery("terminal-compat", 2));
    handler.prepare_terminal_reconnect();
    assert!(
        handler
            .handle_legacy_terminal_attach("terminal-compat")
            .success
    );
    assert_eq!(handler.drain_terminal_events(), retained);
    assert!(
        !handler
            .handle_terminal_attach("terminal-compat", "consumer-1", 1)
            .success
    );
    assert_eq!(
        handler.drain_terminal_events(),
        retained,
        "rejected upgrade must preserve replay"
    );
}

#[test]
fn backend_ack_only_releases_v1_replay_including_reattach_during_delivery() {
    for version in [1, 2] {
        let (mut handler, terminal) = fixture(VecDeque::from([b"pending".to_vec()]));
        let attach = if version == 1 {
            handler.handle_legacy_terminal_attach("terminal-compat")
        } else {
            handler.handle_terminal_attach("terminal-compat", "consumer-1", 0)
        };
        assert!(attach.success);
        let events = handler.drain_terminal_events();
        let consumer = (version == 2).then_some("consumer-1");
        assert!(handler
            .begin_terminal_output_delivery("terminal-compat", consumer, 1)
            .unwrap());
        if version == 1 {
            assert!(
                handler
                    .handle_legacy_terminal_attach("terminal-compat")
                    .success
            );
        }
        handler
            .complete_terminal_output_delivery("terminal-compat", 1)
            .unwrap();
        if version == 1 {
            assert!(handler.drain_terminal_events().is_empty());
            terminal.lock().unwrap().output.push_back(b"next".to_vec());
            assert_eq!(handler.drain_terminal_events().len(), 1);
            assert!(handler
                .begin_terminal_output_delivery("terminal-compat", None, 2)
                .unwrap());
        } else {
            handler.prepare_terminal_reconnect();
            assert_eq!(handler.drain_terminal_events(), events);
            assert!(
                !handler
                    .handle_legacy_terminal_attach("terminal-compat")
                    .success
            );
            assert_eq!(handler.drain_terminal_events(), events);
            assert!(
                handler
                    .handle_terminal_ack("terminal-compat", "consumer-1", 1)
                    .success
            );
            assert!(handler.drain_terminal_events().is_empty());
        }
    }
}

#[test]
fn backpressured_legacy_session_does_not_starve_v2_session() {
    let (mut handler, _) = fixture((0..256).map(|_| vec![b'x'; 8192]).collect());
    let (mut quiet_handler, _) = fixture(VecDeque::from([b"quiet prompt".to_vec()]));
    let mut quiet = quiet_handler.sessions.remove("terminal-compat").unwrap();
    quiet.session_id = "quiet-v2".to_owned();
    handler.sessions.insert("quiet-v2".to_owned(), quiet);
    assert!(
        handler
            .handle_legacy_terminal_attach("terminal-compat")
            .success
    );
    for _ in 0..3 {
        for event in handler.drain_terminal_events() {
            let TerminalEvent::Output { sequence, .. } = event else {
                panic!("unexpected exit")
            };
            assert!(handler
                .begin_terminal_output_delivery("terminal-compat", None, sequence)
                .unwrap());
        }
    }
    assert!(handler.drain_terminal_events().is_empty());
    assert!(
        handler
            .handle_terminal_attach("quiet-v2", "consumer-1", 0)
            .success
    );
    assert_eq!(
        handler.drain_terminal_events(),
        vec![TerminalEvent::Output {
            session_id: "quiet-v2".to_owned(),
            consumer_id: Some("consumer-1".to_owned()),
            sequence: 1,
            data: "quiet prompt".to_owned()
        }]
    );
}

#[tokio::test]
async fn v2_backend_ack_preserves_replay_and_backpressure_until_browser_ack() {
    let (handler, terminal) = fixture((0..256).map(|_| vec![b'x'; 8192]).collect());
    let transport = RecordingTransport::default();
    let runner = wire_runner(handler, transport.clone());
    let task = tokio::spawn(runner.run_forever());
    wait_until(|| transport.handler("terminal:attach").is_some()).await;
    assert_eq!(attach(&transport, Some(2)).await["protocol_version"], 2);
    wait_until(|| *transport.terminal_completion_count.lock().unwrap() >= 3).await;
    // Backend-accepted output remains available for the browser to replay from zero.
    assert_eq!(attach(&transport, Some(2)).await["success"], true);
    wait_until(|| {
        transport
            .calls()
            .iter()
            .filter(|call| call.event == "terminal:output" && call.payload["sequence"] == 1)
            .count()
            >= 2
    })
    .await;
    assert!(transport
        .calls()
        .iter()
        .filter(|call| call.event == "terminal:output")
        .all(|call| call.payload["sequence"].as_u64().unwrap() <= 3));
    assert!(!terminal.lock().unwrap().output.is_empty());
    let response = transport.handler("terminal:ack").unwrap()(json!({
        "session_id": "terminal-compat", "consumer_id": "consumer-1", "sequence": 3
    }))
    .await
    .unwrap();
    assert_eq!(response["success"], true, "{response}");
    wait_until(|| {
        transport
            .calls()
            .iter()
            .any(|call| call.event == "terminal:output" && call.payload["sequence"] == 4)
    })
    .await;
    task.abort();
    let _ = task.await;
}

#[tokio::test]
async fn legacy_backend_rejection_and_transport_failure_retry_output_and_exit() {
    for failure in [
        Err("disconnected".to_owned()),
        Ok(json!({"success": false, "error": "not forwarded"})),
    ] {
        let (handler, terminal) = fixture(VecDeque::from([b"retained".to_vec()]));
        terminal.lock().unwrap().exit_code = Some(0);
        let transport = RecordingTransport::default();
        transport.terminal_responses.lock().unwrap().extend([
            failure.clone(),
            Ok(json!({"success": true})),
            failure,
            Ok(json!({"success": true})),
        ]);
        let runner = wire_runner(handler, transport.clone());
        let task = tokio::spawn(runner.run_forever());
        wait_until(|| transport.handler("terminal:attach").is_some()).await;
        assert_eq!(attach(&transport, None).await["success"], true);
        wait_until(|| *transport.terminal_completion_count.lock().unwrap() == 4).await;
        task.abort();
        let _ = task.await;
        let calls = transport
            .calls()
            .into_iter()
            .filter(|call| call.event.starts_with("terminal:"))
            .collect::<Vec<_>>();
        assert_eq!(calls.len(), 4);
        assert_eq!(calls[0].event, "terminal:output");
        assert_eq!(calls[1].payload, calls[0].payload);
        assert_eq!(calls[2].event, "terminal:exit");
        assert_eq!(calls[3].payload, calls[2].payload);
        assert_eq!(
            calls[0].payload,
            json!({"session_id": "terminal-compat", "data": "retained"})
        );
    }
}

#[tokio::test]
async fn terminal_delivery_is_sequential_per_session_and_concurrent_across_sessions() {
    let (mut handler, terminal) = fixture(VecDeque::from([b"first".to_vec()]));
    assert!(
        handler
            .handle_legacy_terminal_attach("terminal-compat")
            .success
    );
    assert_eq!(handler.drain_terminal_events().len(), 1);
    assert!(handler
        .begin_terminal_output_delivery("terminal-compat", None, 1)
        .unwrap());
    {
        let mut terminal = terminal.lock().unwrap();
        terminal.output.push_back(b"second".to_vec());
        terminal.exit_code = Some(0);
    }
    assert_eq!(handler.drain_terminal_events().len(), 1);
    // Reconnect will replay both unacknowledged outputs in one session batch.
    handler.prepare_terminal_reconnect();
    let independent = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from([b"independent".to_vec()]),
        exit_code: Some(0),
        ..RecordingTerminal::default()
    }));
    handler.sessions.insert(
        "terminal-independent".to_owned(),
        LocalSession::terminal(
            "terminal-independent",
            "test-token",
            1,
            handler.workspace_root.clone(),
            Box::new(SharedTerminal(independent)),
            u64::MAX,
        ),
    );
    assert!(
        handler
            .handle_legacy_terminal_attach("terminal-independent")
            .success
    );
    let transport = RecordingTransport::default();
    let gate = Arc::new(tokio::sync::Notify::new());
    *transport.terminal_call_gate.lock().unwrap() = Some(Arc::clone(&gate));
    let mut config = local_backend_config();
    config.heartbeat_interval = Duration::from_millis(10);
    let runner = LocalBackendRunner::with_task_runner(
        config,
        transport.clone(),
        RecordingTaskRunner::default(),
    )
    .with_session_handler(handler);
    let task = tokio::spawn(runner.run_forever());
    let terminal_calls = || {
        transport
            .calls()
            .into_iter()
            .filter(|call| call.event == "terminal:output" || call.event == "terminal:exit")
            .map(|call| (call.event, call.payload))
            .collect::<Vec<_>>()
    };

    wait_until(|| terminal_calls().len() >= 2).await;
    let heartbeats = || {
        transport
            .emits()
            .iter()
            .filter(|call| call.event == "device:heartbeat")
            .count()
    };
    let before = heartbeats();
    wait_until(|| heartbeats() >= before + 2).await;
    assert_eq!(*transport.terminal_completion_count.lock().unwrap(), 0);
    assert_eq!(
        terminal_calls(),
        vec![
            ("terminal:output".to_owned(), json!({"session_id": "terminal-compat", "data": "first"})),
            ("terminal:output".to_owned(), json!({"session_id": "terminal-independent", "data": "independent"})),
        ],
        "independent output must start while the first session waits, but its second output and exits must wait for ACK",
    );

    *transport.terminal_call_gate.lock().unwrap() = None;
    gate.notify_waiters();
    wait_until(|| *transport.terminal_completion_count.lock().unwrap() == 5).await;
    task.abort();
    let _ = task.await;
    for (session_id, output) in [
        ("terminal-compat", vec!["first", "second"]),
        ("terminal-independent", vec!["independent"]),
    ] {
        let mut expected = output
            .into_iter()
            .map(|data| {
                (
                    "terminal:output".to_owned(),
                    json!({"session_id": session_id, "data": data}),
                )
            })
            .collect::<Vec<_>>();
        expected.push((
            "terminal:exit".to_owned(),
            json!({"session_id": session_id, "exit_code": 0}),
        ));
        assert_eq!(
            terminal_calls()
                .into_iter()
                .filter(|(_, payload)| payload["session_id"] == session_id)
                .collect::<Vec<_>>(),
            expected,
        );
    }
}

#[tokio::test]
async fn slow_terminal_delivery_keeps_heartbeats_running_until_backend_ack() {
    for version in [None, Some(1), Some(2)] {
        let output = if version == Some(2) {
            b"slow delivery".to_vec()
        } else {
            b"held by backend".to_vec()
        };
        let (handler, _) = fixture(VecDeque::from([output]));
        let transport = RecordingTransport::default();
        let gate = Arc::new(tokio::sync::Notify::new());
        *transport.terminal_call_gate.lock().unwrap() = Some(Arc::clone(&gate));
        let mut config = local_backend_config();
        config.heartbeat_interval = Duration::from_millis(10);
        let runner = LocalBackendRunner::with_task_runner(
            config,
            transport.clone(),
            RecordingTaskRunner::default(),
        )
        .with_session_handler(handler);
        let task = tokio::spawn(runner.run_forever());
        wait_until(|| transport.handler("terminal:attach").is_some()).await;
        let response = attach(&transport, version).await;
        assert_eq!(response["success"], true, "{response}");
        assert_eq!(response["protocol_version"], version.unwrap_or(1));
        wait_until(|| {
            transport
                .calls()
                .iter()
                .any(|call| call.event == "terminal:output")
        })
        .await;
        let before = transport
            .emits()
            .iter()
            .filter(|call| call.event == "device:heartbeat")
            .count();
        wait_until(|| {
            transport
                .emits()
                .iter()
                .filter(|call| call.event == "device:heartbeat")
                .count()
                >= before + 3
        })
        .await;
        assert_eq!(*transport.terminal_completion_count.lock().unwrap(), 0);
        gate.notify_one();
        wait_until(|| *transport.terminal_completion_count.lock().unwrap() == 1).await;
        task.abort();
        let _ = task.await;
    }
}
