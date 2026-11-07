use std::sync::{Mutex, MutexGuard, OnceLock};

use super::*;

fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    fn remove(key: &'static str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::remove_var(key);
        Self { key, previous }
    }

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

#[test]
fn claude_follow_up_resume_spec_removes_original_stream_json_input_args() {
    let base_spec = CommandSpec::new("claude")
        .arg("-p")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .stdin("original query\n");

    let spec = claude_follow_up_resume_spec(
        &base_spec,
        "session-1",
        ClaudeFollowUpQuery::Prompt("Retry to proceed".to_owned()),
    );

    assert_eq!(
        spec.args(),
        &[
            "--output-format",
            "stream-json",
            "--verbose",
            "--resume",
            "session-1",
            "-p",
            "Retry to proceed"
        ]
    );
    assert!(spec.stdin_input().is_none());
}

#[test]
fn stream_chunk_defaults_are_tuned_for_callback_backpressure() {
    let _lock = env_lock();
    let _chunk_chars = EnvGuard::remove("WEGENT_EXECUTOR_STREAM_CHUNK_CHARS");
    let _reasoning_chunk_chars = EnvGuard::remove("WEGENT_EXECUTOR_STREAM_REASONING_CHUNK_CHARS");

    assert_eq!(stream_text_chunk_chars(), 256);
    assert_eq!(stream_reasoning_chunk_chars(), 4_096);
}

#[test]
fn stream_chunk_env_overrides_defaults() {
    let _lock = env_lock();
    let _chunk_chars = EnvGuard::set("WEGENT_EXECUTOR_STREAM_CHUNK_CHARS", "128");
    let _reasoning_chunk_chars =
        EnvGuard::set("WEGENT_EXECUTOR_STREAM_REASONING_CHUNK_CHARS", "256");

    assert_eq!(stream_text_chunk_chars(), 128);
    assert_eq!(stream_reasoning_chunk_chars(), 256);
}

#[test]
fn debug_claude_stdout_appends_existing_task_log() {
    let _lock = env_lock();
    let _debug = EnvGuard::set(DEBUG_CLAUDE_STDOUT_ENV, "1");
    let task_id = std::process::id().to_string();
    let subtask_id = "987654321".to_owned();
    let spec = CommandSpec::new("claude");
    let path = debug_claude_stdout_path(Some(&task_id), Some(&subtask_id));
    let _ = fs::remove_file(&path);

    debug_claude_stdout_fields(
        &spec,
        &CommandOutcome::Success {
            stdout: "first".to_owned(),
        },
        Some(&task_id),
        Some(&subtask_id),
    );
    debug_claude_stdout_fields(
        &spec,
        &CommandOutcome::Success {
            stdout: "second".to_owned(),
        },
        Some(&task_id),
        Some(&subtask_id),
    );

    let content = fs::read_to_string(&path).unwrap();
    let lines: Vec<Value> = content
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["raw"], "first");
    assert!(has_timezone_offset(
        lines[0]["received_at"].as_str().unwrap()
    ));
    assert_eq!(lines[1]["raw"], "second");
    assert!(has_timezone_offset(
        lines[1]["received_at"].as_str().unwrap()
    ));
    let _ = fs::remove_file(path);
}

#[test]
fn debug_claude_stdout_line_adds_received_at_to_json_object() {
    let line = debug_claude_stdout_line_with_timestamp(
        r#"{"type":"assistant","message":{"content":[{"text":"done"}]}}"#,
        "2026-07-06T03:33:26.000Z".to_owned(),
    );

    let value: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(value["type"], "assistant");
    assert_eq!(value["message"]["content"][0]["text"], "done");
    assert_eq!(value["received_at"], "2026-07-06T03:33:26.000Z");
}

#[test]
fn debug_claude_stdout_line_wraps_non_json_line_with_received_at() {
    let line = debug_claude_stdout_line_with_timestamp(
        "plain output",
        "2026-07-06T03:33:26.000Z".to_owned(),
    );

    let value: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(value["raw"], "plain output");
    assert_eq!(value["received_at"], "2026-07-06T03:33:26.000Z");
}

fn has_timezone_offset(value: &str) -> bool {
    let Some(offset) = value.get(value.len().saturating_sub(6)..) else {
        return false;
    };
    let bytes = offset.as_bytes();
    matches!(bytes.first(), Some(b'+' | b'-'))
        && bytes.get(3) == Some(&b':')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 0 || index == 3 || byte.is_ascii_digit())
}

#[test]
fn debug_claude_stdout_is_disabled_by_default() {
    let _lock = env_lock();
    let _debug = EnvGuard::remove(DEBUG_CLAUDE_STDOUT_ENV);
    let spec = CommandSpec::new("claude");

    assert!(debug_claude_stdout_path_for_spec(&spec, Some("1"), Some("2")).is_none());
}

#[test]
fn debug_claude_stdout_accepts_resolved_claude_path() {
    let _lock = env_lock();
    let _debug = EnvGuard::set(DEBUG_CLAUDE_STDOUT_ENV, "1");
    let spec = CommandSpec::new("/usr/bin/claude");

    assert!(debug_claude_stdout_path_for_spec(&spec, Some("1"), Some("2")).is_some());
}

#[test]
fn command_outcome_fields_include_stderr_preview_on_failure() {
    let fields = command_outcome_fields(&CommandOutcome::Failure {
        stderr: "first line\nsecond line".to_owned(),
        stdout: String::new(),
        exit_code: Some(1),
    });

    assert!(fields.contains(&("stderr_preview", "first line\\nsecond line".to_owned())));
}

#[test]
fn failure_message_extracts_claude_terminal_error_from_stdout() {
    let stdout = concat!(
        r#"{"type":"system","subtype":"hook_started"}"#,
        "\n",
        r#"{"type":"result","subtype":"success","is_error":true,"result":"API Error: 502 Bad Gateway"}"#,
    );

    assert_eq!(
        failure_message(Vec::new(), stdout.as_bytes().to_vec()),
        "API Error: 502 Bad Gateway"
    );
}

#[test]
fn failure_message_keeps_stderr_without_terminal_result() {
    assert_eq!(
        failure_message(
            b"command timed out after 300s".to_vec(),
            br#"{"type":"assistant","message":{"content":[{"text":"partial"}]}}"#.to_vec(),
        ),
        "command timed out after 300s"
    );
}

#[test]
fn failure_message_prefers_terminal_result_over_stderr_warning() {
    let stdout = br#"{"type":"result","is_error":true,"result":"Invalid model ID"}"#.to_vec();

    assert_eq!(
        failure_message(b"startup hook warning".to_vec(), stdout),
        "Invalid model ID"
    );
}
