// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use wegent_executor::{
    process::{CommandSpec, ProcessEngine},
    protocol::ExecutionRequest,
    runner::{AgentEngine, ExecutionOutcome},
};

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

#[tokio::test]
async fn process_engine_maps_success_stdout_to_completed_outcome() {
    let engine = ProcessEngine::new(CommandSpec::new("sh").arg("-c").arg("printf done"));

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
    let engine = ProcessEngine::new(CommandSpec::new("cat").stdin("from stdin"));

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
    let _timeout = EnvGuard::set("WEGENT_EXECUTOR_PROCESS_TIMEOUT_SECONDS", "1");
    let engine = ProcessEngine::new(CommandSpec::new("sh").arg("-c").arg("sleep 5"));

    let outcome = engine.run(ExecutionRequest::default()).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Failed {
            message: "command timed out after 1s".to_owned()
        }
    );
}
