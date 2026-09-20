// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use chrono::{Local, SecondsFormat};
use serde_json::{Map, Value};

pub(crate) const ENV: &str = "WEGENT_DEBUG_CLAUDE_STDOUT";

pub(crate) fn enabled() -> bool {
    std::env::var(ENV)
        .map(|value| {
            let value = value.trim().to_ascii_lowercase();
            !matches!(value.as_str(), "0" | "false" | "no" | "off")
        })
        .unwrap_or(false)
}

pub(crate) fn line(line: &str) -> String {
    line_with_timestamp(
        line,
        Local::now().to_rfc3339_opts(SecondsFormat::Millis, false),
    )
}

pub(crate) fn line_with_timestamp(line: &str, received_at: String) -> String {
    match serde_json::from_str::<Value>(line.trim()) {
        Ok(Value::Object(mut object)) => {
            object.insert("received_at".to_owned(), Value::String(received_at));
            Value::Object(object).to_string()
        }
        Ok(value) => {
            let mut object = Map::new();
            object.insert("received_at".to_owned(), Value::String(received_at));
            object.insert("value".to_owned(), value);
            Value::Object(object).to_string()
        }
        Err(_) => {
            let mut object = Map::new();
            object.insert("received_at".to_owned(), Value::String(received_at));
            object.insert("raw".to_owned(), Value::String(line.to_owned()));
            Value::Object(object).to_string()
        }
    }
}
