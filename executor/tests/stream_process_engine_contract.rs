// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{future::Future, pin::Pin, time::Duration};

use wegent_executor::{
    emitter::{EventEnvelope, ResponsesEventBuilder},
    process::{CommandSpec, StreamProcessEngine},
    protocol::ExecutionRequest,
    runner::{AgentEngine, EventSink, ExecutionOutcome},
};

const TEST_PROCESS_TIMEOUT_SECONDS: u64 = 3600;

#[derive(Clone)]
struct SlowSink {
    delay: Duration,
}

impl EventSink for SlowSink {
    type SendFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

    fn send(&self, _event: EventEnvelope) -> Self::SendFuture {
        let delay = self.delay;
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            Ok(())
        })
    }
}

#[tokio::test]
async fn stream_process_engine_parses_ndjson_stdout() {
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh").arg("-c").arg(
            r#"printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'"#,
        ),
        TEST_PROCESS_TIMEOUT_SECONDS,
    );

    let outcome = engine.run(ExecutionRequest::default()).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );
}

#[tokio::test]
async fn stream_process_engine_completes_with_slow_stream_callbacks() {
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh").arg("-c").arg(
            r#"printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'"#,
        ),
        TEST_PROCESS_TIMEOUT_SECONDS,
    );

    let outcome = tokio::time::timeout(
        Duration::from_secs(1),
        engine.run_with_events(
            ExecutionRequest::default(),
            SlowSink {
                delay: Duration::from_millis(50),
            },
            ResponsesEventBuilder::new("task", "subtask", "model"),
        ),
    )
    .await
    .expect("stream callbacks should flush without hanging");

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );
}

#[tokio::test]
async fn stream_process_engine_flushes_stream_callbacks_before_outcome() {
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh").arg("-c").arg(
            r#"printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'"#,
        ),
        TEST_PROCESS_TIMEOUT_SECONDS,
    );

    let started = std::time::Instant::now();
    let outcome = engine
        .run_with_events(
            ExecutionRequest::default(),
            SlowSink {
                delay: Duration::from_millis(50),
            },
            ResponsesEventBuilder::new("task", "subtask", "model"),
        )
        .await;

    assert!(
        started.elapsed() >= Duration::from_millis(50),
        "outcome returned before streaming callbacks flushed"
    );
    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );
}

#[tokio::test]
async fn stream_process_engine_fails_when_claude_stdout_ends_without_result() {
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh").arg("-c").arg(
            r#"printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}'; printf '%s' '{"type":"user","message":{"content":[{"type":"tool_result","content":"broken"}'"#,
        ),
        TEST_PROCESS_TIMEOUT_SECONDS,
    );

    let outcome = engine.run(ExecutionRequest::default()).await;

    assert!(matches!(outcome, ExecutionOutcome::Failed { .. }));
    if let ExecutionOutcome::Failed { message } = outcome {
        assert!(message.contains("Claude stdout ended before result message"));
    }
}

#[tokio::test]
async fn stream_process_engine_keeps_stderr_for_process_failures() {
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh")
            .arg("-c")
            .arg("printf process-failed >&2; exit 3"),
        TEST_PROCESS_TIMEOUT_SECONDS,
    );

    let outcome = engine.run(ExecutionRequest::default()).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Failed {
            message: "process-failed".to_owned()
        }
    );
}
