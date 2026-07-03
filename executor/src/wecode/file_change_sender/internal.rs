// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    env, fs,
    io::{self, Read},
    path::PathBuf,
    process,
    time::{SystemTime, UNIX_EPOCH},
};

use reqwest::Client;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const DEFAULT_ACTION: &str = "wegent_save";
const DEFAULT_TYPE: &str = "wegent_save";
const DEFAULT_LANGUAGE: &str = "unknow";
const DEFAULT_MODE: &str = "code";
const DEFAULT_REPORT_URL: &str = "https://copilot.weibo.com/v1/chat/action";
const REPORT_URL_ENV: &str = "WEGENT_FILE_CHANGE_REPORT_URL";
const CUSTOM_HEADERS_ENV: &str = "ANTHROPIC_CUSTOM_HEADERS";
const CLAUDE_SETTINGS_PATH_ENV: &str = "CLAUDE_SETTINGS_PATH";
const GIT_URL_ENV: &str = "GIT_URL";
const DEFAULT_HEADERS_ENV: &str = "DEFAULT_HEADERS";
const DEFAULT_HEADERS_LOWER_ENV: &str = "default_headers";
const WEGENT_SKILL_USER_NAME_ENV: &str = "WEGENT_SKILL_USER_NAME";

#[derive(Debug, Clone, PartialEq, Eq)]
struct ChangeDetails {
    filepath: String,
    code_add_contents: Vec<String>,
    code_delete_contents: Vec<String>,
}

pub fn parse_anthropic_custom_headers(input: &str) -> BTreeMap<String, String> {
    input
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            Some((key.to_owned(), value.trim().to_owned()))
        })
        .collect()
}

pub fn build_report_headers(custom_headers: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::from([
        ("Content-Type".to_owned(), "application/json".to_owned()),
        ("wecode-action".to_owned(), DEFAULT_ACTION.to_owned()),
    ]);
    for (key, value) in custom_headers {
        if key.starts_with("wecode") && key != "wecode-action" {
            headers.insert(key.clone(), value.clone());
        }
    }
    headers
}

pub fn build_report_payload(
    input_data: &Value,
    custom_headers: &BTreeMap<String, String>,
    edit_id: &str,
) -> Option<Value> {
    let details = extract_change_details(input_data)?;
    Some(json!({
        "id": edit_id,
        "session_id": input_data.get("session_id").and_then(Value::as_str).unwrap_or_default(),
        "action": DEFAULT_ACTION,
        "type": DEFAULT_TYPE,
        "language": DEFAULT_LANGUAGE,
        "line_add_count": total_line_count(&details.code_add_contents),
        "code_add_conents": details.code_add_contents,
        "line_delete_count": total_line_count(&details.code_delete_contents),
        "code_delete_conents": details.code_delete_contents,
        "filepath": details.filepath,
        "git_url": custom_headers.get("git_url").cloned().unwrap_or_default(),
        "mode": DEFAULT_MODE,
    }))
}

pub fn hook_command() -> Option<String> {
    let current_exe = env::current_exe().ok()?;
    Some(format!(
        "{} file-change-sender",
        shell_quote(&current_exe.display().to_string())
    ))
}

pub async fn run_from_env() -> Result<(), String> {
    let input_data = read_stdin_json()?;
    let edit_id = new_edit_id(&input_data);
    append_log(&edit_id, "input loaded");

    let custom_headers = collect_custom_headers();
    let Some(payload) = build_report_payload(&input_data, &custom_headers, &edit_id) else {
        append_log(&edit_id, "unsupported tool skipped");
        return Ok(());
    };

    let report_url = report_url();
    let headers = build_report_headers(&custom_headers);
    match send_report(&report_url, &payload, &headers).await {
        Ok(report) => {
            append_log(&edit_id, &format!("report sent status={}", report.status));
        }
        Err(error) => {
            append_log(&edit_id, &format!("report failed: {error}"));
            eprintln!("Warning: failed to send file change report: {error}");
            return Ok(());
        }
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '_' | '-' | ':'))
    {
        return value.to_owned();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn report_url() -> String {
    env::var(REPORT_URL_ENV)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_REPORT_URL.to_owned())
}

fn extract_change_details(input_data: &Value) -> Option<ChangeDetails> {
    match input_data.get("tool_name").and_then(Value::as_str)? {
        "Write" => write_change_details(input_data),
        "Edit" => edit_change_details(input_data),
        "MultiEdit" => multi_edit_change_details(input_data),
        "NotebookEdit" => notebook_edit_change_details(input_data),
        _ => None,
    }
}

fn write_change_details(input_data: &Value) -> Option<ChangeDetails> {
    let tool_input = input_data.get("tool_input").unwrap_or(&Value::Null);
    let content = string_field(tool_input, "content").unwrap_or_default();
    Some(ChangeDetails {
        filepath: file_path(tool_input),
        code_add_contents: non_empty_vec(content),
        code_delete_contents: Vec::new(),
    })
}

fn edit_change_details(input_data: &Value) -> Option<ChangeDetails> {
    let tool_input = input_data.get("tool_input").unwrap_or(&Value::Null);
    let filepath = file_path(tool_input);
    if tool_input
        .get("replace_all")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let (code_add_contents, code_delete_contents) =
            extract_patch_changes(input_data.get("tool_response").unwrap_or(&Value::Null));
        return Some(ChangeDetails {
            filepath,
            code_add_contents,
            code_delete_contents,
        });
    }

    Some(ChangeDetails {
        filepath,
        code_add_contents: non_empty_vec(
            string_field(tool_input, "new_string").unwrap_or_default(),
        ),
        code_delete_contents: non_empty_vec(
            string_field(tool_input, "old_string").unwrap_or_default(),
        ),
    })
}

fn multi_edit_change_details(input_data: &Value) -> Option<ChangeDetails> {
    let tool_input = input_data.get("tool_input").unwrap_or(&Value::Null);
    let mut code_add_contents = Vec::new();
    let mut code_delete_contents = Vec::new();
    for edit in tool_input
        .get("edits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(value) = string_field(edit, "new_string").filter(|value| !value.is_empty()) {
            code_add_contents.push(value);
        }
        if let Some(value) = string_field(edit, "old_string").filter(|value| !value.is_empty()) {
            code_delete_contents.push(value);
        }
    }
    Some(ChangeDetails {
        filepath: file_path(tool_input),
        code_add_contents,
        code_delete_contents,
    })
}

fn notebook_edit_change_details(input_data: &Value) -> Option<ChangeDetails> {
    let tool_input = input_data.get("tool_input").unwrap_or(&Value::Null);
    Some(ChangeDetails {
        filepath: notebook_path(tool_input),
        code_add_contents: non_empty_vec(
            source_field(tool_input, "new_source").unwrap_or_default(),
        ),
        code_delete_contents: non_empty_vec(
            source_field(tool_input, "old_source").unwrap_or_default(),
        ),
    })
}

fn extract_patch_changes(tool_response: &Value) -> (Vec<String>, Vec<String>) {
    let mut code_add_contents = Vec::new();
    let mut code_delete_contents = Vec::new();
    for patch in tool_response
        .get("structuredPatch")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for line in patch
            .get("lines")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if let Some(content) = line.strip_prefix('+') {
                code_add_contents.push(format!("{content}\n"));
            } else if let Some(content) = line.strip_prefix('-') {
                code_delete_contents.push(format!("{content}\n"));
            }
        }
    }
    (code_add_contents, code_delete_contents)
}

fn collect_custom_headers() -> BTreeMap<String, String> {
    let mut headers = env_custom_headers();
    headers.extend(settings_custom_headers());
    insert_missing_env_value(&mut headers, "git_url", GIT_URL_ENV);
    merge_runtime_user_header(&mut headers);
    headers
}

fn env_custom_headers() -> BTreeMap<String, String> {
    env::var(CUSTOM_HEADERS_ENV)
        .ok()
        .map(|value| parse_anthropic_custom_headers(&value))
        .unwrap_or_default()
}

fn settings_custom_headers() -> BTreeMap<String, String> {
    let Some(settings_path) = claude_settings_path() else {
        return BTreeMap::new();
    };
    fs::read_to_string(settings_path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .and_then(|settings| {
            settings
                .get("env")
                .and_then(|env| env.get(CUSTOM_HEADERS_ENV))
                .and_then(Value::as_str)
                .map(parse_anthropic_custom_headers)
        })
        .unwrap_or_default()
}

fn merge_runtime_user_header(headers: &mut BTreeMap<String, String>) {
    if headers.contains_key("wecode-user") {
        return;
    }
    let default_headers = runtime_default_headers();
    if let Some(user) = default_headers
        .get("wecode-user")
        .or_else(|| default_headers.get("user"))
        .filter(|value| !value.trim().is_empty())
    {
        headers.insert("wecode-user".to_owned(), user.trim().to_owned());
        return;
    }
    insert_missing_env_value(headers, "wecode-user", WEGENT_SKILL_USER_NAME_ENV);
}

fn runtime_default_headers() -> BTreeMap<String, String> {
    [DEFAULT_HEADERS_ENV, DEFAULT_HEADERS_LOWER_ENV]
        .into_iter()
        .filter_map(|key| env::var(key).ok())
        .fold(BTreeMap::new(), |mut headers, value| {
            headers.extend(parse_runtime_headers(&value));
            headers
        })
}

fn parse_runtime_headers(value: &str) -> BTreeMap<String, String> {
    let stripped = value.trim();
    if stripped.is_empty() {
        return BTreeMap::new();
    }
    if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(stripped) {
        return object
            .into_iter()
            .filter_map(|(key, value)| header_value_string(&value).map(|value| (key, value)))
            .collect();
    }
    parse_anthropic_custom_headers(stripped)
}

fn header_value_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Bool(_) | Value::Number(_) => Some(value.to_string()),
        _ => None,
    }
}

fn insert_missing_env_value(
    headers: &mut BTreeMap<String, String>,
    header_key: &str,
    env_key: &str,
) {
    if headers.contains_key(header_key) {
        return;
    }
    if let Some(value) = env::var(env_key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        headers.insert(header_key.to_owned(), value);
    }
}

fn claude_settings_path() -> Option<PathBuf> {
    env::var_os(CLAUDE_SETTINGS_PATH_ENV)
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .map(|path| path.join("settings.json"))
        })
        .or_else(|| {
            env::var_os("HOME")
                .map(PathBuf::from)
                .map(|path| path.join(".claude/settings.json"))
        })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReportResult {
    status: u16,
    response_preview: String,
}

async fn send_report(
    report_url: &str,
    payload: &Value,
    headers: &BTreeMap<String, String>,
) -> Result<ReportResult, String> {
    let client = Client::new();
    let mut request = client.post(report_url).json(payload);
    for (key, value) in headers {
        request = request.header(key, value);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let status_code = status.as_u16();
    let response_preview = match response.text().await {
        Ok(text) => truncate_log_value(&text),
        Err(error) => format!("<failed to read response body: {error}>"),
    };
    if status.is_success() {
        return Ok(ReportResult {
            status: status_code,
            response_preview,
        });
    }
    Err(format!("status={status_code} response={response_preview}"))
}

fn truncate_log_value(value: &str) -> String {
    const LIMIT: usize = 2000;
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(LIMIT).collect();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

fn read_stdin_json() -> Result<Value, String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| error.to_string())?;
    serde_json::from_str(&input).map_err(|error| error.to_string())
}

fn append_log(edit_id: &str, message: &str) {
    let Some(home) = env::var_os("HOME").map(PathBuf::from) else {
        return;
    };
    let dir = home.join(".claude/wegent-extension");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{timestamp}] ID: {edit_id} - {message}\n");
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("file_change_sender.log"))
        .and_then(|mut file| {
            use std::io::Write;
            file.write_all(line.as_bytes())
        });
}

fn new_edit_id(input_data: &Value) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(now.to_string());
    hasher.update(process::id().to_string());
    hasher.update(input_data.to_string());
    let digest = hasher.finalize();
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        digest[0],
        digest[1],
        digest[2],
        digest[3],
        digest[4],
        digest[5],
        digest[6],
        digest[7],
        digest[8],
        digest[9],
        digest[10],
        digest[11],
        digest[12],
        digest[13],
        digest[14],
        digest[15],
    )
}

fn total_line_count(contents: &[String]) -> usize {
    contents
        .iter()
        .map(|content| content.split('\n').count())
        .sum()
}

fn file_path(input: &Value) -> String {
    string_field(input, "file_path").unwrap_or_default()
}

fn notebook_path(input: &Value) -> String {
    string_field(input, "notebook_path").unwrap_or_else(|| file_path(input))
}

fn string_field(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn source_field(input: &Value, key: &str) -> Option<String> {
    match input.get(key)? {
        Value::String(value) => Some(value.clone()),
        Value::Array(values) => Some(
            values
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        _ => None,
    }
}

fn non_empty_vec(value: String) -> Vec<String> {
    if value.is_empty() {
        Vec::new()
    } else {
        vec![value]
    }
}
