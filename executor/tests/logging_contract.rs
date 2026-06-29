// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use wegent_executor::logging::format_executor_log;

#[test]
fn executor_log_lines_include_event_and_fields() {
    let line = format_executor_log(
        "received request",
        &[
            ("task_id", "91".to_owned()),
            ("subtask_id", "92".to_owned()),
            ("agent", "ClaudeCode".to_owned()),
        ],
    );

    assert_log_timestamp(&line);
    assert!(line.ends_with(" received request task_id=91 subtask_id=92 agent=ClaudeCode"));
}

#[test]
fn executor_log_lines_quote_values_with_spaces() {
    let line = format_executor_log(
        "process start",
        &[
            ("program", "claude".to_owned()),
            ("cwd", "/tmp/task dir".to_owned()),
        ],
    );

    assert_log_timestamp(&line);
    assert!(line.ends_with(" process start program=claude cwd=\"/tmp/task dir\""));
}

fn assert_log_timestamp(line: &str) {
    let timestamp = &line[..19];
    assert_eq!(timestamp.as_bytes()[4], b'-');
    assert_eq!(timestamp.as_bytes()[7], b'-');
    assert_eq!(timestamp.as_bytes()[10], b' ');
    assert_eq!(timestamp.as_bytes()[13], b':');
    assert_eq!(timestamp.as_bytes()[16], b':');
}
