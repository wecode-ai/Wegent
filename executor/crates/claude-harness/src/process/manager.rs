// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// The executor owns the authority and invokes it only for a native root result.
pub trait ManagerOperations: Send + Sync + std::fmt::Debug {
    fn schema(&self) -> Value;
    fn call<'a>(
        &'a self,
        name: &'a str,
        arguments: Value,
    ) -> Pin<Box<dyn Future<Output = Value> + Send + 'a>>;
}

pub(super) async fn run<S: EventSink>(
    request: &ExecutionRequest,
    spec: CommandSpec,
    seconds: u64,
    runner: &FollowUpCommandRunner<S>,
    manager: &dyn ManagerOperations,
    client_version: &str,
) -> ExecutionOutcome {
    timeout(
        Duration::from_secs(seconds),
        run_session(request, spec, seconds, runner, manager, client_version),
    )
    .await
    .unwrap_or_else(|_| ExecutionOutcome::Failed {
        message: "Claude manager turn timed out".into(),
    })
}

async fn run_session<S: EventSink>(
    request: &ExecutionRequest,
    spec: CommandSpec,
    seconds: u64,
    runner: &FollowUpCommandRunner<S>,
    manager: &dyn ManagerOperations,
    client_version: &str,
) -> ExecutionOutcome {
    let base = spec.arg("--json-schema").arg(manager.schema().to_string());
    let role_init = base
        .stdin_input()
        .and_then(|input| input.lines().next())
        .unwrap_or_default()
        .to_owned();
    let mut next = base.clone();
    loop {
        let (used, outcome) = claude_resume::run(request, next, seconds, runner).await;
        let stdout = match outcome {
            CommandOutcome::Success { stdout } => stdout,
            CommandOutcome::Failure { stderr, stdout, .. } => {
                return ExecutionOutcome::Failed {
                    message: failure_message(stderr.into_bytes(), stdout.into_bytes()),
                }
            }
        };
        let summary = collect_claude_stream_summary(&stdout);
        if let Some(session) = &summary.session_id {
            agent_session::save_session_id(request, session);
        }
        if summary.deferred_tool_use.is_some() {
            return handle_deferred_mcp_loop(
                used,
                request.clone(),
                summary,
                seconds,
                runner.clone(),
                client_version,
            )
            .await;
        }
        if !matches!(summary.outcome, ExecutionOutcome::Completed { .. }) {
            return summary.outcome;
        }
        let Some((session, action)) = root_action(&stdout) else {
            return ExecutionOutcome::Failed {
                message: "Missing structured Claude manager result".into(),
            };
        };
        let Some(name) = action["operation"].as_str() else {
            return ExecutionOutcome::Failed {
                message: "Missing Claude manager operation".into(),
            };
        };
        if name == "finish" {
            return ExecutionOutcome::Completed {
                content: action["message"].as_str().unwrap_or_default().into(),
            };
        }
        let result = manager.call(name, action["arguments"].clone()).await;
        let query = serde_json::json!({"type":"user","session_id":session,"parent_tool_use_id":null,
            "message":{"role":"user","content":format!("Host result for {name}. Continue from this result.\n{result}")}});
        next =
            claude_follow_up_resume_spec(&used, &session, ClaudeFollowUpQuery::ToolResult(query))
                .arg("-p");
        let input = format!("{role_init}\n{}", next.stdin_input().unwrap_or_default());
        next = next.stdin(input);
    }
}

fn root_action(stdout: &str) -> Option<(String, Value)> {
    let mut session = None;
    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !value["parent_tool_use_id"].is_null() || !value["origin"].is_null() {
            continue;
        }
        if session.is_none() && value["type"] == "system" && value["subtype"] == "init" {
            session = value["session_id"].as_str().map(str::to_owned);
        } else if value["type"] == "result"
            && value["subtype"] == "success"
            && value["is_error"] == false
            && session
                .as_deref()
                .is_some_and(|id| value["session_id"] == id)
            && value["structured_output"].is_object()
        {
            return Some((session?, value["structured_output"].clone()));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_the_foreground_root_session_can_submit_manager_operations() {
        let init = json!({"type":"system","subtype":"init","session_id":"root"});
        let result = json!({"type":"result","subtype":"success","is_error":false,
            "session_id":"root","structured_output":{"operation":"dispatch"}});
        for (key, value) in [
            ("origin", json!({"kind":"task-notification"})),
            ("parent_tool_use_id", json!("child")),
            ("session_id", json!("another")),
            ("is_error", json!(true)),
        ] {
            let mut denied = result.clone();
            denied[key] = value;
            assert!(root_action(&format!("{init}\n{denied}")).is_none());
        }
        assert_eq!(
            root_action(&format!("{init}\n{result}")),
            Some(("root".into(), json!({"operation":"dispatch"})))
        );
    }
}
