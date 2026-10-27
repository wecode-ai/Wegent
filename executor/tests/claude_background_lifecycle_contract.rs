// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use wegent_executor::{runner::ExecutionOutcome, stream::collect_ndjson_outcome};

fn stdout(events: &[Value]) -> String {
    events.iter().map(|event| format!("{event}\n")).collect()
}

fn agent_started() -> Value {
    json!({"type":"system", "subtype":"task_started", "task_type":"local_agent",
        "task_id":"agent-1", "tool_use_id":"Agent_0", "is_backgrounded":true})
}

fn notification(status: &str) -> Value {
    json!({"type":"system", "subtype":"task_notification", "status":status,
        "task_id":"agent-1", "tool_use_id":"Agent_0"})
}

fn success() -> Value {
    json!({"type":"result", "subtype":"success", "is_error":false, "stop_reason":"end_turn"})
}

fn assert_failed(events: &[Value], expected: &str) {
    let outcome = collect_ndjson_outcome(&stdout(events));
    match outcome {
        ExecutionOutcome::Failed { message } => assert!(message.contains(expected), "{message}"),
        other => panic!("unfinished subagents must not complete the task: {other:?}"),
    }
}

#[test]
fn system_wind_down_is_failure_even_when_the_cli_returns_success() {
    // The runtime emits success before the interrupted tool's final cleanup
    // events. Its system-kill attribution is authoritative, not user-rejected.
    let mut result = success();
    result["subagent_stats"] = json!({"spawned":1, "completed":0, "failed":0,
        "killed":{"system":1, "parent":0, "user":0}});
    assert_failed(
        &[
            agent_started(),
            json!({"type":"system", "subtype":"task_updated", "task_id":"agent-1",
            "patch":{"status":"killed"}}),
            notification("stopped"),
            result,
            json!({"type":"system", "subtype":"task_notification", "task_id":"shell-1",
            "tool_use_id":"Bash_0", "status":"stopped"}),
        ],
        "runtime terminated 1 unfinished subagent",
    );
}

#[test]
fn final_statistics_detect_system_kills_without_lifecycle_events() {
    let mut result = success();
    result["subagent_stats"] = json!({"killed":{"system":2, "user":0}});
    assert_failed(&[result], "runtime terminated 2 unfinished subagent");
}

#[test]
fn final_statistics_detect_unfinished_subagents() {
    let mut result = success();
    result["subagent_stats"] = json!({"spawned":2, "completed":1, "failed":0});
    assert_failed(&[result], "1 unfinished subagent");
}

#[test]
fn a_running_subagent_prevents_completion_without_statistics() {
    assert_failed(
        &[agent_started(), success()],
        "unfinished or unsuccessful subagent",
    );
}

#[test]
fn stopped_or_failed_subagents_do_not_count_as_completed() {
    for status in ["stopped", "cancelled", "failed", "error"] {
        assert_failed(
            &[agent_started(), notification(status), success()],
            "unfinished or unsuccessful subagent",
        );
    }
}

#[test]
fn cleanup_after_the_success_result_still_prevents_completion() {
    assert_failed(
        &[
            agent_started(),
            success(),
            json!({"type":"system", "subtype":"task_updated", "task_id":"agent-1",
            "patch":{"status":"killed"}}),
        ],
        "unfinished or unsuccessful subagent",
    );
}

#[test]
fn task_updates_can_complete_agents_without_a_notification() {
    let output = stdout(&[
        agent_started(),
        json!({"type":"system", "subtype":"task_updated", "task_id":"agent-1",
            "patch":{"status":"completed"}}),
        json!({"type":"assistant", "message":{"content":[{"type":"text", "text":"done"}]}}),
        success(),
    ]);
    assert_eq!(
        collect_ndjson_outcome(&output),
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );
}

#[test]
fn an_interim_result_does_not_override_later_completed_work() {
    let mut interim = success();
    interim["subagent_stats"] = json!({"spawned":1, "completed":0});
    let mut final_result = success();
    final_result["subagent_stats"] = json!({"spawned":1, "completed":1, "failed":0,
        "killed":{"system":0, "parent":0, "user":0}});
    let output = stdout(&[
        agent_started(),
        interim,
        notification("completed"),
        json!({"type":"assistant", "message":{"content":[{"type":"text", "text":"verified"}]}}),
        final_result,
    ]);
    assert_eq!(
        collect_ndjson_outcome(&output),
        ExecutionOutcome::Completed {
            content: "verified".to_owned()
        }
    );
}

#[test]
fn explicit_user_cancellation_keeps_its_cancelled_outcome() {
    let output = stdout(&[
        agent_started(),
        notification("stopped"),
        json!({"type":"result", "subtype":"error_during_execution", "is_error":true,
            "result":"Request interrupted"}),
    ]);
    assert_eq!(
        collect_ndjson_outcome(&output),
        ExecutionOutcome::Cancelled {
            message: "Request interrupted".to_owned()
        }
    );
}

#[test]
fn standalone_background_shell_cleanup_is_not_a_subagent_failure() {
    let output = stdout(&[
        json!({"type":"system", "subtype":"task_started", "task_type":"local_bash",
            "task_id":"shell-1", "tool_use_id":"Bash_0"}),
        json!({"type":"system", "subtype":"task_updated", "task_id":"shell-1",
            "patch":{"status":"killed"}}),
        success(),
    ]);
    assert_eq!(
        collect_ndjson_outcome(&output),
        ExecutionOutcome::Completed {
            content: String::new()
        }
    );
}

#[cfg(unix)]
mod process {
    use std::future::{ready, Ready};

    use tokio::sync::mpsc;
    use wegent_executor::{
        emitter::EventEnvelope,
        process::{CommandSpec, StreamProcessEngine},
        protocol::{ExecutionRequest, TaskStatus},
        runner::{AgentEngine, BackgroundTaskRunner, EventSink},
        server::TaskRunner,
    };

    use super::*;

    #[derive(Clone)]
    struct Sink(mpsc::UnboundedSender<EventEnvelope>);

    impl EventSink for Sink {
        type SendFuture = Ready<Result<(), String>>;

        fn send(&self, event: EventEnvelope) -> Self::SendFuture {
            ready(self.0.send(event).map_err(|error| error.to_string()))
        }
    }

    fn interrupted_engine() -> StreamProcessEngine {
        let transcript = stdout(&[agent_started(), notification("stopped"), success()]);
        StreamProcessEngine::new(
            CommandSpec::new("sh")
                .arg("-c")
                .arg(format!("cat <<'NDJSON'\n{transcript}NDJSON\n")),
            60,
        )
    }

    #[tokio::test]
    async fn zero_exit_code_does_not_hide_an_interrupted_subagent() {
        let outcome = interrupted_engine().run(ExecutionRequest::default()).await;
        assert!(
            matches!(outcome, ExecutionOutcome::Failed { .. }),
            "{outcome:?}"
        );
    }

    #[tokio::test]
    async fn background_runner_emits_error_instead_of_completed() {
        let (sender, mut events) = mpsc::unbounded_channel();
        let runner = BackgroundTaskRunner::new(interrupted_engine(), Sink(sender));
        let request = ExecutionRequest {
            task_id: "task-1".to_owned(),
            subtask_id: "subtask-1".to_owned(),
            ..ExecutionRequest::default()
        };

        assert_eq!(runner.submit(request).await.status, TaskStatus::Running);
        let terminal = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Some(event) = events.recv().await {
                if matches!(
                    event.event_type.as_str(),
                    "error" | "response.completed" | "response.incomplete"
                ) {
                    return event;
                }
            }
            panic!("runner exited without a terminal callback")
        })
        .await
        .expect("terminal callback must arrive");

        assert_eq!(terminal.event_type, "error");
        assert!(terminal.data["message"]
            .as_str()
            .unwrap()
            .contains("unfinished or unsuccessful subagent"));
    }
}
