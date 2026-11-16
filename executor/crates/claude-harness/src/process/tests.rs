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
