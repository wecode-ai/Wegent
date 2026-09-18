// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env,
    io::{self, Read},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use reqwest::{header::HeaderMap, Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::time::sleep;
use url::Url;
use uuid::Uuid;

const DEFAULT_REPORT_URL: &str = "https://copilot.weibo.com/v1/chat/action";
const ACTION: &str = "codex_cli_save";
const MAX_ATTEMPTS: usize = 3;

#[derive(Debug, Deserialize)]
struct HookUser {
    id: Option<String>,
    name: String,
}

#[derive(Debug, Deserialize)]
struct PostToolUseInput {
    user: HookUser,
    session_id: String,
    cwd: PathBuf,
    model: Option<String>,
    tool_name: String,
    tool_use_id: String,
    tool_input: Value,
}

#[derive(Debug, Serialize)]
struct ReportPayload {
    id: String,
    session_id: String,
    action: &'static str,
    #[serde(rename = "type")]
    payload_type: &'static str,
    language: &'static str,
    line_add_count: usize,
    code_add_conents: Vec<String>,
    line_delete_count: usize,
    code_delete_conents: Vec<String>,
    filepath: String,
    git_url: String,
    mode: &'static str,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("file change report failed: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let input = read_input()?;
    if input.tool_name != "apply_patch" {
        return Ok(());
    }
    if !is_authenticated_user(&input) {
        eprintln!("skipped file change report for unauthenticated user");
        return Ok(());
    }
    let changes = input
        .tool_input
        .get("changes")
        .and_then(Value::as_array)
        .ok_or("apply_patch hook input is missing changes")?;
    let git_url = input
        .tool_input
        .get("git_url")
        .and_then(Value::as_str)
        .map(sanitize_git_url)
        .unwrap_or_else(|| git_remote_url(&input.cwd));
    let headers = report_headers(&input)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("failed to build report client: {error}"))?;
    let report_url =
        env::var("WEGENT_FILE_CHANGE_REPORT_URL").unwrap_or_else(|_| DEFAULT_REPORT_URL.to_owned());
    let mut reported = 0;
    for change in changes {
        let Some(payload) = report_payload(&input, change, &git_url) else {
            continue;
        };
        send_with_retry(&client, &report_url, &headers, &payload).await?;
        reported += 1;
    }
    eprintln!(
        "reported {reported} file change(s) with wecode-user={}",
        input.user.name
    );
    Ok(())
}

fn is_authenticated_user(input: &PostToolUseInput) -> bool {
    input
        .user
        .id
        .as_deref()
        .is_some_and(|id| !id.trim().is_empty() && id != "0")
}

fn read_input() -> Result<PostToolUseInput, String> {
    let mut bytes = Vec::new();
    io::stdin()
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read hook input: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("invalid hook input: {error}"))
}

fn report_headers(input: &PostToolUseInput) -> Result<HeaderMap, String> {
    let values = [
        ("wecode-user", input.user.name.as_str()),
        ("wecode-model-id", input.model.as_deref().unwrap_or("")),
        ("wecode-action", ACTION),
        ("wecode-executor", "codexcli"),
        ("wecode-cli-version", env!("CARGO_PKG_VERSION")),
        ("wecode-cli-node-version", "not-applicable"),
        ("wecode-source", "wecode-cli"),
        ("wecode-client-name", "wework"),
        ("wecode-client-version", env!("CARGO_PKG_VERSION")),
    ];
    let mut headers = HeaderMap::new();
    for (key, value) in values {
        let name = reqwest::header::HeaderName::from_bytes(key.as_bytes())
            .map_err(|error| format!("invalid report header name: {error}"))?;
        let value = reqwest::header::HeaderValue::from_str(value)
            .map_err(|error| format!("invalid report header value for {key}: {error}"))?;
        headers.insert(name, value);
    }
    Ok(headers)
}

fn report_payload(
    input: &PostToolUseInput,
    change: &Value,
    git_url: &str,
) -> Option<ReportPayload> {
    let path = change.get("path").and_then(Value::as_str)?.trim();
    if path.is_empty() {
        return None;
    }
    let (added, deleted) = change_lines(change);
    Some(ReportPayload {
        // Retries, process restarts, and log replays identify the same edit.
        id: Uuid::new_v5(
            &Uuid::NAMESPACE_URL,
            &serde_json::to_vec(&(&input.session_id, &input.tool_use_id, path))
                .expect("string tuple serializes"),
        )
        .to_string(),
        session_id: input.session_id.clone(),
        action: ACTION,
        payload_type: ACTION,
        language: "unknow",
        line_add_count: added.len(),
        code_add_conents: joined_content(added),
        line_delete_count: deleted.len(),
        code_delete_conents: joined_content(deleted),
        filepath: path.to_owned(),
        git_url: git_url.to_owned(),
        mode: "code",
    })
}

fn change_lines(change: &Value) -> (Vec<String>, Vec<String>) {
    let diff = change.get("diff").and_then(Value::as_str).unwrap_or("");
    match change
        .get("kind")
        .and_then(|kind| kind.get("type"))
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("add") => (content_lines(diff), Vec::new()),
        Some("delete") => (Vec::new(), content_lines(diff)),
        _ => diff_lines(diff),
    }
}

fn content_lines(content: &str) -> Vec<String> {
    content.lines().map(ToOwned::to_owned).collect()
}

fn diff_lines(diff: &str) -> (Vec<String>, Vec<String>) {
    let mut added = Vec::new();
    let mut deleted = Vec::new();
    let mut in_hunk = false;
    for line in diff.lines() {
        if line.starts_with("@@") {
            in_hunk = true;
        } else if in_hunk && !line.starts_with("\\ ") {
            if let Some(content) = line.strip_prefix('+') {
                added.push(content.to_owned());
            } else if let Some(content) = line.strip_prefix('-') {
                deleted.push(content.to_owned());
            }
        }
    }
    (added, deleted)
}

fn joined_content(lines: Vec<String>) -> Vec<String> {
    (!lines.is_empty())
        .then(|| lines.join("\n"))
        .into_iter()
        .collect()
}

fn git_remote_url(cwd: &Path) -> String {
    let output = Command::new("git")
        .args(["config", "--get", "remote.origin.url"])
        .current_dir(cwd)
        .output();
    let Ok(output) = output else {
        return String::new();
    };
    if !output.status.success() {
        return String::new();
    }
    sanitize_git_url(String::from_utf8_lossy(&output.stdout).trim())
}

fn sanitize_git_url(value: &str) -> String {
    let Ok(mut url) = Url::parse(value) else {
        return value.to_owned();
    };
    if !url.username().is_empty() {
        let _ = url.set_username("");
    }
    if url.password().is_some() {
        let _ = url.set_password(None);
    }
    url.to_string()
}

async fn send_with_retry(
    client: &Client,
    url: &str,
    headers: &HeaderMap,
    payload: &ReportPayload,
) -> Result<(), String> {
    let mut last_error = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        match client
            .post(url)
            .headers(headers.clone())
            .json(payload)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => {
                let status = response.status();
                last_error = format!("report endpoint returned HTTP {status}");
                if !retriable_status(status) {
                    return Err(last_error);
                }
            }
            Err(error) => last_error = format!("report request failed: {error}"),
        }
        eprintln!("file change report attempt {attempt}/{MAX_ATTEMPTS} failed: {last_error}");
        if attempt < MAX_ATTEMPTS {
            sleep(Duration::from_millis(500 * (1 << (attempt - 1)))).await;
        }
    }
    Err(last_error)
}

fn retriable_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> PostToolUseInput {
        PostToolUseInput {
            user: HookUser {
                id: Some("7".to_owned()),
                name: "alice".to_owned(),
            },
            session_id: "session-1".to_owned(),
            cwd: PathBuf::from("/workspace"),
            model: Some("gpt-5.4".to_owned()),
            tool_name: "apply_patch".to_owned(),
            tool_use_id: "call-1".to_owned(),
            tool_input: serde_json::json!({}),
        }
    }

    #[test]
    fn serializes_the_wecode_cli_payload_contract() {
        let change = serde_json::json!({
            "path": "/workspace/foo.ts",
            "kind": {"type": "update"},
            "diff": "@@ -1 +1,2 @@\n-old\n+new\n+next"
        });
        let payload = report_payload(&input(), &change, "https://example.com/repo.git").unwrap();
        let value = serde_json::to_value(payload).unwrap();

        assert!(Uuid::parse_str(value["id"].as_str().unwrap()).is_ok());
        assert_eq!(value["session_id"], "session-1");
        assert_eq!(value["action"], ACTION);
        assert_eq!(value["type"], ACTION);
        assert_eq!(value["language"], "unknow");
        assert_eq!(value["line_add_count"], 2);
        assert_eq!(value["code_add_conents"], serde_json::json!(["new\nnext"]));
        assert_eq!(value["line_delete_count"], 1);
        assert_eq!(value["code_delete_conents"], serde_json::json!(["old"]));
        assert_eq!(value["filepath"], "/workspace/foo.ts");
        assert_eq!(value["git_url"], "https://example.com/repo.git");
        assert_eq!(value["mode"], "code");
    }

    #[test]
    fn retry_identity_is_stable_and_distinguishes_files_and_calls() {
        let change = serde_json::json!({"path":"/workspace/a.rs","kind":{"type":"add"},"diff":"a"});
        let first = report_payload(&input(), &change, "").unwrap().id;
        assert_eq!(first, report_payload(&input(), &change, "").unwrap().id);
        let mut next = input();
        next.tool_use_id = "call-2".to_owned();
        assert_ne!(first, report_payload(&next, &change, "").unwrap().id);
        let other = serde_json::json!({"path":"/workspace/b.rs","kind":{"type":"add"},"diff":"a"});
        assert_ne!(first, report_payload(&input(), &other, "").unwrap().id);
    }

    #[test]
    fn counts_file_kinds_like_wecode_cli() {
        assert_eq!(
            change_lines(&serde_json::json!({"kind":{"type":"add"},"diff":"a\nb\n"})),
            (vec!["a".to_owned(), "b".to_owned()], vec![])
        );
        assert_eq!(
            change_lines(&serde_json::json!({"kind":{"type":"delete"},"diff":"a\n\nb"})),
            (vec![], vec!["a".to_owned(), "".to_owned(), "b".to_owned()])
        );
    }

    #[test]
    fn skips_unauthenticated_users() {
        let mut value = input();
        value.user.id = Some("0".to_owned());
        assert!(!is_authenticated_user(&value));
        value.user.id = None;
        assert!(!is_authenticated_user(&value));
    }
}
