// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use wegent_executor::{
    process::{CommandSpec, StreamProcessEngine},
    protocol::ExecutionRequest,
    runner::{AgentEngine, ExecutionOutcome},
};

#[tokio::test]
async fn stream_process_engine_parses_ndjson_stdout() {
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh").arg("-c").arg(
            r#"printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}'"#,
        ),
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
async fn stream_process_engine_keeps_stderr_for_process_failures() {
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh")
            .arg("-c")
            .arg("printf process-failed >&2; exit 3"),
    );

    let outcome = engine.run(ExecutionRequest::default()).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Failed {
            message: "process-failed".to_owned()
        }
    );
}
