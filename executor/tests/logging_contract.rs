// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use wegent_executor::logging::format_executor_log;

#[test]
fn executor_log_lines_include_event_and_fields() {
    assert_eq!(
        format_executor_log(
            "received request",
            &[
                ("task_id", "91".to_owned()),
                ("subtask_id", "92".to_owned()),
                ("agent", "ClaudeCode".to_owned()),
            ],
        ),
        "Wegent executor received request task_id=91 subtask_id=92 agent=ClaudeCode"
    );
}

#[test]
fn executor_log_lines_quote_values_with_spaces() {
    assert_eq!(
        format_executor_log(
            "process start",
            &[
                ("program", "claude".to_owned()),
                ("cwd", "/tmp/task dir".to_owned())
            ],
        ),
        "Wegent executor process start program=claude cwd=\"/tmp/task dir\""
    );
}
