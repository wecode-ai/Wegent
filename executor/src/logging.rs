// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::io::Write;

pub fn log_executor_event(event: &str, fields: &[(&str, String)]) {
    println!("{}", format_executor_log(event, fields));
    let _ = std::io::stdout().flush();
}

pub fn task_fields(task_id: i64, subtask_id: i64) -> Vec<(&'static str, String)> {
    vec![
        ("task_id", task_id.to_string()),
        ("subtask_id", subtask_id.to_string()),
    ]
}

pub fn format_executor_log(event: &str, fields: &[(&str, String)]) -> String {
    let mut line = format!("Wegent executor {event}");
    for (key, value) in fields {
        line.push(' ');
        line.push_str(key);
        line.push('=');
        line.push_str(&format_field_value(value));
    }
    line
}

fn format_field_value(value: &str) -> String {
    if value
        .chars()
        .all(|character| !character.is_whitespace() && character != '"')
    {
        return value.to_owned();
    }

    format!("\"{}\"", value.replace('"', "\\\""))
}
