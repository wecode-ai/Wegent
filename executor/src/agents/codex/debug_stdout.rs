// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{fs, io::Write, path::PathBuf};

use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::ChildStdout,
};

use crate::{logging::log_executor_event, process::debug_stdout};

use super::diagnostics::{debug_stdout_value, redact_diagnostic_text};

pub(super) struct CodexStdout {
    reader: BufReader<ChildStdout>,
    debug_file: Option<fs::File>,
}

impl CodexStdout {
    pub(super) fn new(stdout: ChildStdout, task: Option<(&str, &str)>) -> Self {
        let debug_file = debug_stdout::enabled()
            .then(|| open_debug_file(debug_path(task)))
            .flatten();
        Self {
            reader: BufReader::new(stdout),
            debug_file,
        }
    }

    pub(super) async fn read_line(&mut self, line: &mut String) -> std::io::Result<usize> {
        let bytes = self.reader.read_line(line).await?;
        if bytes > 0 {
            if let Some(file) = self.debug_file.as_mut() {
                if let Err(error) = writeln!(file, "{}", debug_line(line)) {
                    log_executor_event(
                        "codex debug stdout write failed",
                        &[("error", error.to_string())],
                    );
                    self.debug_file = None;
                }
            }
        }
        Ok(bytes)
    }
}

fn debug_path(task: Option<(&str, &str)>) -> PathBuf {
    let suffix = match task {
        Some((task_id, subtask_id)) => format!("{task_id}-{subtask_id}"),
        None => std::process::id().to_string(),
    };
    let suffix: String = suffix
        .chars()
        .map(|c| if matches!(c, '/' | '\\') { '_' } else { c })
        .collect();
    std::env::temp_dir().join(format!("wegent-codex-stdout-{suffix}.jsonl"))
}

fn open_debug_file(path: PathBuf) -> Option<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = options.open(&path);
    let mut fields = vec![("debug_stdout_path", path.display().to_string())];
    if let Err(error) = &result {
        fields.push(("error", error.to_string()));
        log_executor_event("codex debug stdout open failed", &fields);
    } else {
        log_executor_event("codex debug stdout enabled", &fields);
    }
    result.ok()
}

fn debug_line(line: &str) -> String {
    let sanitized = match serde_json::from_str::<Value>(line) {
        Ok(value) => debug_stdout_value(&value).to_string(),
        Err(_) => redact_diagnostic_text(line),
    };
    debug_stdout::line(&sanitized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stdout_keeps_full_summary_and_usage_but_redacts_credentials() {
        let summary = "分析".repeat(3000);
        let message = json!({
            "method": "item/reasoning/summaryTextDelta",
            "params": {"delta": summary, "apiKey": "secret-value"},
            "usage": {"reasoning_tokens": 42},
            "result": {"fileContent": "auth-file-content", "accessToken": "token-value"}
        });
        let recorded: Value = serde_json::from_str(&debug_line(&message.to_string())).unwrap();
        assert_eq!(recorded["params"]["delta"], summary);
        assert_eq!(recorded["usage"]["reasoning_tokens"], 42);
        assert_eq!(recorded["params"]["apiKey"], "[redacted]");
        assert_eq!(recorded["result"]["fileContent"], "[redacted]");
        assert_eq!(recorded["result"]["accessToken"], "[redacted]");
        assert!(
            chrono::DateTime::parse_from_rfc3339(recorded["received_at"].as_str().unwrap()).is_ok()
        );
    }

    #[test]
    fn stdout_keeps_malformed_output_for_diagnostics() {
        let recorded: Value = serde_json::from_str(&debug_line("invalid JSON\n")).unwrap();
        assert_eq!(recorded["raw"], "invalid JSON\n");
    }

    #[test]
    fn stdout_redacts_credentials_in_malformed_output() {
        let recorded: Value = serde_json::from_str(&debug_line(
            "invalid JSON Authorization: Bearer fake-value\n",
        ))
        .unwrap();
        assert_eq!(
            recorded["raw"],
            "invalid JSON Authorization: Bearer [redacted]\n"
        );
    }

    #[test]
    fn stdout_path_stays_in_the_temporary_directory() {
        let path = debug_path(Some(("../510", "nested/774")));
        assert_eq!(path.parent(), Some(std::env::temp_dir().as_path()));
        assert_eq!(
            path.file_name().unwrap(),
            "wegent-codex-stdout-.._510-nested_774.jsonl"
        );
    }
}
