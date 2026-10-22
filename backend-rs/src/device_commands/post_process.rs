// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Command result post-processors from
//! `app/services/device/command_post_processor.py`.

use serde_json::{Map, Value};

use super::{python_str, python_truthy};

/// `CommandPostProcessorError`: a configured post-processor is unknown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandPostProcessorError(pub String);

impl std::fmt::Display for CommandPostProcessorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for CommandPostProcessorError {}

/// `apply_command_post_processor`: apply the registered processor in place.
pub(crate) fn apply_command_post_processor(
    result: &mut Map<String, Value>,
    processor_name: Option<&str>,
) -> Result<(), CommandPostProcessorError> {
    let Some(processor_name) = processor_name.filter(|name| !name.is_empty()) else {
        return Ok(());
    };
    match processor_name {
        "file_list" => {
            file_list(result);
            Ok(())
        }
        "directory_list" => {
            directory_list(result);
            Ok(())
        }
        "json" => {
            json(result);
            Ok(())
        }
        other => Err(CommandPostProcessorError(format!(
            "Unknown local device command post processor: {other}"
        ))),
    }
}

/// `_file_list_processor`.
fn file_list(result: &mut Map<String, Value>) {
    if !result.get("success").is_some_and(python_truthy) {
        return;
    }
    let stdout = stdout_text(result);
    let entries: Vec<String> = python_splitlines(&stdout)
        .into_iter()
        .map(python_strip)
        .filter(|entry| !entry.is_empty())
        .filter(|entry| entry.as_str() != "." && entry.as_str() != "..")
        .collect();
    result.insert(
        "stdout".to_string(),
        Value::Array(entries.into_iter().map(Value::String).collect()),
    );
}

/// `_directory_list_processor`.
fn directory_list(result: &mut Map<String, Value>) {
    if !result.get("success").is_some_and(python_truthy) {
        return;
    }
    let stdout = stdout_text(result);
    let entries: Vec<String> = python_splitlines(&stdout)
        .into_iter()
        .map(python_strip)
        .filter(|entry| !entry.is_empty())
        .collect();
    let directories: Vec<Value> = entries
        .into_iter()
        .filter(|entry| entry.ends_with('/'))
        .map(|entry| entry.trim_end_matches('/').to_string())
        .filter(|entry| entry.as_str() != "." && entry.as_str() != "..")
        .map(Value::String)
        .collect();
    result.insert("stdout".to_string(), Value::Array(directories));
}

/// `_json_processor`.
fn json(result: &mut Map<String, Value>) {
    if result.get("stdout_truncated").is_some_and(python_truthy) {
        result.insert("success".to_string(), Value::Bool(false));
        result.insert(
            "error".to_string(),
            Value::String(
                "Command output exceeded max_output_bytes and was truncated; \
                 JSON is incomplete and cannot be parsed"
                    .to_string(),
            ),
        );
        return;
    }

    let stdout = result.get("stdout").cloned().unwrap_or(Value::Null);
    if matches!(stdout, Value::Object(_) | Value::Array(_)) {
        return;
    }
    let text = stdout_text(result);
    let parsed = match serde_json::from_str::<Value>(&text) {
        Ok(parsed) => parsed,
        Err(error) => {
            if !result.get("success").is_some_and(python_truthy) {
                return;
            }
            result.insert("success".to_string(), Value::Bool(false));
            result.insert(
                "error".to_string(),
                Value::String(format!("Failed to parse command JSON output: {error}")),
            );
            return;
        }
    };
    result.insert("stdout".to_string(), parsed.clone());
    if !result.get("success").is_some_and(python_truthy)
        && let Value::Object(object) = &parsed
        && let Some(Value::String(error)) = object.get("error")
        && !error.trim().is_empty()
        && !result.get("error").is_some_and(python_truthy)
    {
        result.insert("error".to_string(), Value::String(error.clone()));
    }
}

/// `str(result.get("stdout") or "")`.
fn stdout_text(result: &Map<String, Value>) -> String {
    match result.get("stdout") {
        Some(value) if python_truthy(value) => python_str(value),
        _ => String::new(),
    }
}

/// Python `str.splitlines()`: every Unicode line boundary, without a trailing
/// empty line for a final terminator.
fn python_splitlines(value: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut start = 0;
    let mut characters = value.char_indices().peekable();
    while let Some((index, character)) = characters.next() {
        let is_boundary = matches!(
            character,
            '\n' | '\r'
                | '\u{0b}'
                | '\u{0c}'
                | '\u{1c}'
                | '\u{1d}'
                | '\u{1e}'
                | '\u{85}'
                | '\u{2028}'
                | '\u{2029}'
        );
        if !is_boundary {
            continue;
        }
        lines.push(&value[start..index]);
        let mut end = index + character.len_utf8();
        if character == '\r'
            && let Some((next_index, '\n')) = characters.peek().copied()
        {
            characters.next();
            end = next_index + 1;
        }
        start = end;
    }
    if start < value.len() {
        lines.push(&value[start..]);
    }
    lines
}

/// Python `str.strip()` for the whitespace characters the executor emits.
fn python_strip(value: &str) -> String {
    value
        .trim_matches(|character: char| {
            character.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&character)
        })
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn result(stdout: &str, success: bool) -> Map<String, Value> {
        json!({
            "success": success,
            "stdout": stdout,
            "stderr": "",
            "duration": 0.1,
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn file_list_filters_dot_entries_and_returns_names() {
        let mut result = result("a.txt\n.\n..\n\nb.txt\n", true);
        apply_command_post_processor(&mut result, Some("file_list")).unwrap();
        assert_eq!(result["stdout"], json!(["a.txt", "b.txt"]));
    }

    #[test]
    fn directory_list_keeps_only_directories() {
        let mut result = result("a/\nb.txt\n./\n../\nsub/dir/\n", true);
        apply_command_post_processor(&mut result, Some("directory_list")).unwrap();
        assert_eq!(result["stdout"], json!(["a", "sub/dir"]));
    }

    #[test]
    fn failed_commands_keep_their_stdout() {
        let mut result = result("a\n", false);
        apply_command_post_processor(&mut result, Some("file_list")).unwrap();
        assert_eq!(result["stdout"], json!("a\n"));
    }

    #[test]
    fn json_processor_parses_successful_output() {
        let mut result = result(r#"{"entries": []}"#, true);
        apply_command_post_processor(&mut result, Some("json")).unwrap();
        assert_eq!(result["stdout"], json!({"entries": []}));
    }

    #[test]
    fn json_processor_leaves_a_failed_unparseable_result_unchanged() {
        let mut result = result("", false);
        let before = result.clone();
        apply_command_post_processor(&mut result, Some("json")).unwrap();
        assert_eq!(result, before);
    }

    #[test]
    fn unknown_processors_are_configuration_errors() {
        let mut result = result("", true);
        assert_eq!(
            apply_command_post_processor(&mut result, Some("missing")),
            Err(CommandPostProcessorError(
                "Unknown local device command post processor: missing".into()
            ))
        );
    }

    #[test]
    fn splitlines_matches_python_line_boundaries() {
        assert_eq!(
            python_splitlines("a\r\nb\rc\nd\u{2028}e"),
            ["a", "b", "c", "d", "e"]
        );
        assert_eq!(python_splitlines("a\n"), ["a"]);
        assert!(python_splitlines("").is_empty());
    }
}
