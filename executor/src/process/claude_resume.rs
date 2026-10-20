// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::path::Path;

use super::{CommandOutcome, CommandSpec, FollowUpCommandRunner};
use crate::{
    agents::{
        claude_session_transcript, has_isolated_native_home, interactive_mcp::ClaudeFollowUpQuery,
    },
    logging::{log_executor_event, task_fields},
    protocol::ExecutionRequest,
    runner::EventSink,
};

pub(super) async fn run<S: EventSink>(
    request: &ExecutionRequest,
    spec: CommandSpec,
    timeout_seconds: u64,
    runner: &FollowUpCommandRunner<S>,
) -> (CommandSpec, CommandOutcome) {
    let outcome = runner.run(spec.clone(), timeout_seconds).await;
    if request.new_session
        || !has_isolated_native_home(request)
        || !is_missing_selected_session(&spec, &outcome)
    {
        return (spec, outcome);
    }
    let retry_spec = match file_resume_spec(request, spec.clone()) {
        Ok(spec) => spec,
        Err(error) => {
            let mut fields = task_fields(&request.task_id, &request.subtask_id);
            fields.push(("reason", error));
            log_executor_event("claude session file resume rejected", &fields);
            return (spec, outcome);
        }
    };
    let outcome = runner.run(retry_spec.clone(), timeout_seconds).await;
    (retry_spec, outcome)
}

fn is_missing_selected_session(spec: &CommandSpec, outcome: &CommandOutcome) -> bool {
    let CommandOutcome::Failure {
        stderr,
        stdout,
        exit_code: Some(1),
    } = outcome
    else {
        return false;
    };
    let Some(id) = spec
        .args
        .windows(2)
        .find(|args| args[0] == "--resume")
        .map(|args| args[1].as_str())
        .filter(|id| {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
        })
    else {
        return false;
    };
    is_missing_session_output(stderr, stdout, id)
}

fn is_missing_session_output(stderr: &str, stdout: &str, id: &str) -> bool {
    let expected = format!("No conversation found with session ID: {id}");
    if stdout.trim().is_empty() {
        return stderr.trim() == expected;
    }
    let mut matched = false;
    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return false;
        };
        if value["type"] == "system" {
            continue;
        }
        if value["type"] != "result"
            || value["subtype"] != "error_during_execution"
            || value["is_error"] != true
            || value["session_id"] != id
            || value["num_turns"] != 0
            || value["duration_api_ms"] != 0
            || !value["errors"].as_array().is_some_and(|errors| {
                !errors.is_empty() && errors.iter().all(|error| error.as_str() == Some(&expected))
            })
        {
            return false;
        }
        matched = true;
    }
    matched
}

fn file_resume_spec(
    request: &ExecutionRequest,
    mut spec: CommandSpec,
) -> Result<CommandSpec, String> {
    let index = spec
        .args
        .windows(2)
        .position(|args| args[0] == "--resume")
        .ok_or("Claude resume argument is missing")?;
    let id = &spec.args[index + 1];
    let home = spec
        .env
        .get("CLAUDE_CONFIG_DIR")
        .ok_or("Claude config directory is missing for session restore")?;
    let transcript = claude_session_transcript(Path::new(home), id)?;
    let mut fields = task_fields(&request.task_id, &request.subtask_id);
    fields.push(("session_id", id.clone()));
    fields.push(("transcript_path", transcript.display().to_string()));
    log_executor_event("claude session file resume started", &fields);
    // Older Claude versions resolve UUIDs only inside the current project.
    // A transcript path preserves the session's original storage after a move.
    spec.args[index + 1] = transcript
        .to_str()
        .ok_or("Claude session path is not valid UTF-8")?
        .to_owned();
    Ok(spec)
}

pub(super) fn follow_up_spec(
    base_spec: &CommandSpec,
    session_id: &str,
    query: ClaudeFollowUpQuery,
) -> CommandSpec {
    let mut spec = CommandSpec::new(base_spec.program.clone());
    spec.env = base_spec.env.clone();
    spec.cwd = base_spec.cwd.clone();
    let mut skip_next = false;
    for arg in &base_spec.args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "-p" || arg == "--print" {
            continue;
        }
        if arg == "--resume" || arg == "--input-format" {
            skip_next = true;
            continue;
        }
        spec.args.push(arg.clone());
    }
    spec.args.push("--resume".to_owned());
    spec.args
        .push(resume_argument(base_spec, session_id).to_owned());
    match query {
        ClaudeFollowUpQuery::Prompt(prompt) => {
            spec.args.push("-p".to_owned());
            spec.args.push(prompt);
        }
        ClaudeFollowUpQuery::ToolResult(value) => {
            spec.args.push("--input-format".to_owned());
            spec.args.push("stream-json".to_owned());
            spec.stdin = Some(format!("{value}\n"));
        }
    }
    spec
}

fn resume_argument<'a>(base_spec: &'a CommandSpec, session_id: &'a str) -> &'a str {
    base_spec
        .args
        .windows(2)
        .find(|args| args[0] == "--resume")
        .map(|args| args[1].as_str())
        .filter(|argument| {
            let path = Path::new(argument);
            path.is_absolute()
                && path.extension().is_some_and(|value| value == "jsonl")
                && path.file_stem().is_some_and(|value| value == session_id)
        })
        .unwrap_or(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn missing_result() -> serde_json::Value {
        serde_json::json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "session_id": "session-1",
            "num_turns": 0,
            "duration_api_ms": 0,
            "errors": ["No conversation found with session ID: session-1"]
        })
    }

    #[test]
    fn file_recovery_requires_the_exact_missing_session_before_execution() {
        let expected = "No conversation found with session ID: session-1";
        let result = missing_result();
        assert!(is_missing_session_output(expected, "", "session-1"));
        assert!(is_missing_session_output(
            "",
            &result.to_string(),
            "session-1"
        ));
        assert!(!is_missing_session_output(expected, "", "session-10"));
        for (key, value) in [
            ("session_id", serde_json::json!("session-2")),
            ("subtype", serde_json::json!("error_during_api_request")),
            ("num_turns", serde_json::json!(1)),
            ("duration_api_ms", serde_json::json!(1)),
            ("is_error", serde_json::json!(false)),
            (
                "errors",
                serde_json::json!([expected, "authentication failed"]),
            ),
        ] {
            let mut changed = result.clone();
            changed[key] = value;
            assert!(
                !is_missing_session_output(expected, &changed.to_string(), "session-1"),
                "{key}"
            );
        }
        let mixed = format!("{{\"type\":\"assistant\"}}\n{result}\n");
        assert!(!is_missing_session_output(expected, &mixed, "session-1"));
    }

    #[test]
    fn file_recovery_requires_a_failed_id_attempt_instead_of_a_path_or_timeout() {
        let spec = CommandSpec::new("claude").arg("--resume").arg("session-1");
        let failure = |exit_code| CommandOutcome::Failure {
            stdout: missing_result().to_string(),
            stderr: String::new(),
            exit_code,
        };
        assert!(is_missing_selected_session(&spec, &failure(Some(1))));
        assert!(!is_missing_selected_session(&spec, &failure(None)));
        assert!(!is_missing_selected_session(&spec, &failure(Some(2))));
        let root = tempfile::tempdir().unwrap();
        let path = CommandSpec::new("claude")
            .arg("--resume")
            .arg(root.path().join("session-1.jsonl").to_str().unwrap());
        assert!(!is_missing_selected_session(&path, &failure(Some(1))));
    }

    #[test]
    fn follow_up_preserves_transcript_path_for_prompt_and_tool_result() {
        let root = tempfile::tempdir().unwrap();
        let transcript = root.path().join("old project/session-1.jsonl");
        let cwd = root.path().join("new workspace");
        let base = CommandSpec::new("claude")
            .arg("-p")
            .arg("--resume")
            .arg(transcript.to_str().unwrap())
            .arg("--input-format")
            .arg("stream-json")
            .cwd(&cwd);

        for query in [
            ClaudeFollowUpQuery::Prompt("continue".to_owned()),
            ClaudeFollowUpQuery::ToolResult(serde_json::json!({"type":"user"})),
        ] {
            let next = follow_up_spec(&base, "session-1", query);
            assert!(next
                .args()
                .windows(2)
                .any(|args| args[0] == "--resume" && Path::new(&args[1]) == transcript));
            assert_eq!(next.current_dir(), Some(&cwd));
        }
    }

    #[test]
    fn follow_up_does_not_reuse_another_sessions_transcript() {
        let root = tempfile::tempdir().unwrap();
        let transcript = root.path().join("old project/session-1.jsonl");
        let base = CommandSpec::new("claude")
            .arg("--resume")
            .arg(transcript.to_str().unwrap());

        let next = follow_up_spec(
            &base,
            "session-2",
            ClaudeFollowUpQuery::Prompt("continue".to_owned()),
        );

        assert!(next
            .args()
            .windows(2)
            .any(|args| args == ["--resume", "session-2"]));
    }
}
