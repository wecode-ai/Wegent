// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use wegent_executor::{
    process::{CommandSpec, ProcessEngine},
    protocol::ExecutionRequest,
    runner::{AgentEngine, ExecutionOutcome},
};

const TEST_PROCESS_TIMEOUT_SECONDS: u64 = 3600;

#[tokio::test]
async fn process_engine_maps_success_stdout_to_completed_outcome() {
    let engine = ProcessEngine::new(
        CommandSpec::new("sh").arg("-c").arg("printf done"),
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
async fn process_engine_writes_configured_stdin_to_child() {
    let engine = ProcessEngine::new(
        CommandSpec::new("cat").stdin("from stdin"),
        TEST_PROCESS_TIMEOUT_SECONDS,
    );

    let outcome = engine.run(ExecutionRequest::default()).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "from stdin".to_owned()
        }
    );
}

#[tokio::test]
async fn process_engine_maps_nonzero_exit_to_failed_outcome() {
    let engine = ProcessEngine::new(
        CommandSpec::new("sh")
            .arg("-c")
            .arg("printf problem >&2; exit 7"),
        TEST_PROCESS_TIMEOUT_SECONDS,
    );

    let outcome = engine.run(ExecutionRequest::default()).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Failed {
            message: "problem".to_owned()
        }
    );
}

#[tokio::test]
async fn process_engine_times_out_hung_commands() {
    let engine = ProcessEngine::new(CommandSpec::new("sh").arg("-c").arg("sleep 5"), 1);

    let outcome = engine.run(ExecutionRequest::default()).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Failed {
            message: "command timed out after 1s".to_owned()
        }
    );
}
