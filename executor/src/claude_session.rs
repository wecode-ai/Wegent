// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{env, fs, path::PathBuf};

use serde_json::Value;

use crate::protocol::ExecutionRequest;

pub(crate) fn load_saved_session_id(request: &ExecutionRequest) -> Option<String> {
    let task_id = task_session_identifier(&request.task_id);
    if request.new_session || task_id.is_none() {
        if request.new_session {
            delete_saved_session_files(request);
        }
        return None;
    }

    read_session_file(request).or_else(|| seed_inherited_session(request))
}

pub(crate) fn save_session_id(request: &ExecutionRequest, session_id: &str) {
    let session_id = session_id.trim();
    if session_id.is_empty() || task_session_identifier(&request.task_id).is_none() {
        return;
    }

    for path in writable_session_file_candidates(request) {
        if write_session_file(&path, session_id).is_ok() {
            return;
        }
    }
}

pub(crate) fn preferred_task_dir(request: &ExecutionRequest) -> Option<PathBuf> {
    let task_id = task_session_identifier(&request.task_id)?;

    workspace_roots()
        .into_iter()
        .next()
        .map(|root| root.join(task_id))
}

fn read_session_file(request: &ExecutionRequest) -> Option<String> {
    for path in readable_session_file_candidates(request) {
        let Some(value) = read_trimmed_file(path) else {
            continue;
        };
        return Some(value);
    }
    None
}

fn seed_inherited_session(request: &ExecutionRequest) -> Option<String> {
    let session_id = inherited_session_id(request)?;
    save_session_id(request, &session_id);
    Some(session_id)
}

fn inherited_session_id(request: &ExecutionRequest) -> Option<String> {
    let current_bot_id = bot_id(&request.bot);
    request.inherited_sessions.iter().find_map(|session| {
        let agent = value_string(
            session
                .get("agent")
                .or_else(|| session.get("agentName"))
                .or_else(|| session.get("agent_name")),
        )?;
        if agent != "ClaudeCode" && agent != "Claude Code" {
            return None;
        }

        if let (Some(current_bot_id), Some(inherited_bot_id)) = (
            current_bot_id.as_deref(),
            session
                .get("botId")
                .or_else(|| session.get("bot_id"))
                .and_then(value_to_identifier),
        ) {
            if inherited_bot_id != current_bot_id {
                return None;
            }
        }

        value_string(
            session
                .get("sessionId")
                .or_else(|| session.get("session_id")),
        )
    })
}

fn delete_saved_session_files(request: &ExecutionRequest) {
    for path in removable_session_file_candidates(request) {
        let _ = fs::remove_file(path);
    }
}

fn write_session_file(path: &PathBuf, session_id: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, session_id)
}

fn read_trimmed_file(path: PathBuf) -> Option<String> {
    let value = fs::read_to_string(path).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn readable_session_file_candidates(request: &ExecutionRequest) -> Vec<PathBuf> {
    writable_session_file_candidates(request)
}

fn removable_session_file_candidates(request: &ExecutionRequest) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    candidates.extend(writable_session_file_candidates(request));
    candidates.extend(legacy_workspace_session_file_candidates(request));

    dedup_paths(candidates)
}

fn writable_session_file_candidates(request: &ExecutionRequest) -> Vec<PathBuf> {
    let Some(task_id) = task_session_identifier(&request.task_id) else {
        return Vec::new();
    };
    session_file_paths(executor_home_session_root().join(task_id), request)
}

fn legacy_workspace_session_file_candidates(request: &ExecutionRequest) -> Vec<PathBuf> {
    let Some(task_id) = task_session_identifier(&request.task_id) else {
        return Vec::new();
    };
    let mut candidates = Vec::new();

    for root in workspace_roots() {
        candidates.extend(session_file_paths(root.join(&task_id), request));
    }

    candidates
}

fn session_file_paths(task_dir: PathBuf, request: &ExecutionRequest) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(bot_id) = bot_id(&request.bot) {
        paths.push(task_dir.join(format!(".claude_session_id_{bot_id}")));
    }
    paths.push(task_dir.join(".claude_session_id"));
    paths
}

fn workspace_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Some(root) = env_path("WORKSPACE_ROOT") {
        roots.push(root);
    }
    if let Some(root) = env_path("WEGENT_WORKSPACE_ROOT") {
        roots.push(root);
    }
    let default_workspace = PathBuf::from("/workspace");
    if docker_mode_enabled() || default_workspace.exists() {
        roots.push(default_workspace);
    }
    if let Some(root) = env_path("LOCAL_WORKSPACE_ROOT") {
        roots.push(root);
    }
    roots.push(default_local_workspace_root());

    dedup_paths(roots)
}

fn default_local_workspace_root() -> PathBuf {
    env_path("WEGENT_EXECUTOR_HOME")
        .unwrap_or_else(|| {
            home_dir()
                .unwrap_or_else(|| env::temp_dir().join("wegent-executor"))
                .join(".wegent-executor")
        })
        .join("workspace")
}

fn executor_home_session_root() -> PathBuf {
    if let Ok(value) = env::var("WEGENT_EXECUTOR_HOME") {
        let value = value.trim();
        if !value.is_empty() {
            return PathBuf::from(value).join("sessions");
        }
    }

    home_dir()
        .unwrap_or_else(|| env::temp_dir().join("wegent-executor"))
        .join(".wegent-executor")
        .join("sessions")
}

fn env_path(key: &str) -> Option<PathBuf> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn docker_mode_enabled() -> bool {
    env::var("EXECUTOR_MODE")
        .ok()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("docker"))
}

fn dedup_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut deduped = Vec::new();
    for path in paths {
        if !deduped.contains(&path) {
            deduped.push(path);
        }
    }
    deduped
}

fn home_dir() -> Option<PathBuf> {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .ok()
        .map(|value| PathBuf::from(value.trim()))
        .filter(|value| !value.as_os_str().is_empty())
}

fn bot_id(bot: &Value) -> Option<String> {
    let bot = match bot {
        Value::Object(_) => bot,
        Value::Array(bots) => bots.first()?,
        _ => return None,
    };

    value_to_identifier(bot.get("id")?)
}

fn value_to_identifier(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => safe_session_identifier(value),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
    .filter(|value| !value.is_empty())
}

fn value_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => safe_session_identifier(value),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
    .filter(|value| !value.is_empty())
}

fn safe_session_identifier(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return None;
    }
    Some(value.to_owned())
}

fn task_session_identifier(value: &str) -> Option<String> {
    let value = safe_session_identifier(value)?;
    if value.parse::<i64>().ok().is_some_and(|id| id <= 0) {
        return None;
    }
    Some(value)
}
