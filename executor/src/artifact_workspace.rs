// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Immutable artifact roots captured from native execution, never from declaration input.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use crate::protocol::ExecutionRequest;

#[derive(Debug, Deserialize, PartialEq, Serialize)]
struct Binding {
    task_id: String,
    subtask_id: String,
    workspace_root: PathBuf,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct ArtifactQuery {
    pub binding_id: String,
    pub task_id: String,
    pub subtask_id: String,
    pub root_path: Option<String>,
    pub path: Option<String>,
    pub offset: Option<u64>,
}

fn linked_token(request: &ExecutionRequest) -> Option<&str> {
    let token = request.auth_token.as_deref()?.trim();
    // Signature validation belongs to Backend. This only recognizes linked Task
    // executions; a token or its claims never authorize a filesystem read here.
    let payload = URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?).ok()?;
    let claims: Value = serde_json::from_slice(&payload).ok()?;
    (claims["type"] == "task_token"
        && claims["task_id"]
            .as_i64()
            .is_some_and(|id| id > 0 && id.to_string() == request.task_id)
        && claims["subtask_id"]
            .as_i64()
            .is_some_and(|id| id > 0 && id.to_string() == request.subtask_id))
    .then_some(token)
}

pub(crate) fn bind(request: &ExecutionRequest, cwd: Option<&Path>) -> Result<(), String> {
    if request.extra.get("enable_tools") == Some(&json!(false)) {
        return Ok(());
    }
    let Some(token) = linked_token(request) else {
        return Ok(());
    };
    let cwd = cwd.ok_or("Linked Task execution requires an explicit workspace")?;
    bind_at(&crate::config::paths::executor_home(), request, token, cwd)
}

fn binding_path(home: &Path, id: &str) -> Result<PathBuf, String> {
    if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid artifact workspace binding".into());
    }
    let directory = home.join("artifact-workspaces");
    if let Ok(metadata) = fs::symlink_metadata(&directory) {
        if !metadata.is_dir() {
            return Err("Artifact workspace bindings must not be symlinks".into());
        }
    }
    Ok(directory.join(format!("{id}.json")))
}

pub(crate) fn bind_at(
    home: &Path,
    request: &ExecutionRequest,
    token: &str,
    cwd: &Path,
) -> Result<(), String> {
    let binding = Binding {
        task_id: request.task_id.clone(),
        subtask_id: request.subtask_id.clone(),
        workspace_root: cwd
            .canonicalize()
            .map_err(|error| format!("Resolve execution workspace: {error}"))?,
    };
    if !binding.workspace_root.is_dir() {
        return Err("Execution workspace is not a directory".into());
    }
    let id = format!("{:x}", Sha256::digest(token.as_bytes()));
    let path = binding_path(home, &id)?;
    let parent = path.parent().unwrap();
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    staged
        .write_all(&serde_json::to_vec(&binding).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    match staged.persist_noclobber(&path) {
        Ok(_) => Ok(()),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            if load(home, &id)? == binding {
                Ok(())
            } else {
                Err("Artifact execution workspace cannot change".into())
            }
        }
        Err(error) => Err(error.to_string()),
    }
}

fn load(home: &Path, id: &str) -> Result<Binding, String> {
    let path = binding_path(home, id)?;
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "Artifact execution workspace is unavailable")?;
    if !metadata.is_file() || metadata.len() > 16 * 1024 {
        return Err("Invalid artifact workspace binding file".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|_| "Invalid artifact workspace binding data".into())
}

pub(crate) fn resolve(query: &ArtifactQuery) -> Result<PathBuf, String> {
    resolve_at(&crate::config::paths::executor_home(), query)
}

fn resolve_at(home: &Path, query: &ArtifactQuery) -> Result<PathBuf, String> {
    let binding = load(home, &query.binding_id)?;
    if binding.task_id != query.task_id || binding.subtask_id != query.subtask_id {
        return Err("Artifact workspace does not belong to this Task execution".into());
    }
    let root = binding
        .workspace_root
        .canonicalize()
        .map_err(|_| "Artifact execution workspace is unavailable")?;
    if root != binding.workspace_root || !root.is_dir() {
        return Err("Artifact execution workspace has changed".into());
    }
    if query
        .root_path
        .as_deref()
        .is_some_and(|expected| Path::new(expected) != root)
    {
        return Err("Artifact workspace does not match its execution binding".into());
    }
    Ok(root)
}

pub(crate) async fn command(payload: Value) -> crate::local::command::CommandResult {
    let home = crate::config::paths::executor_home();
    match tokio::task::spawn_blocking(move || command_at(&home, &payload)).await {
        Ok(result) => result,
        Err(error) => crate::local::command::CommandResult::error(error.to_string(), 0.0, false),
    }
}

fn command_at(home: &Path, payload: &Value) -> crate::local::command::CommandResult {
    let result = payload
        .get("args")
        .and_then(Value::as_array)
        .and_then(|args| args.first())
        .and_then(Value::as_str)
        .ok_or_else(|| "Artifact query is required".to_owned())
        .and_then(|value| {
            serde_json::from_str::<ArtifactQuery>(value)
                .map_err(|_| "Invalid artifact query".to_owned())
        })
        .and_then(|query| execute_at(home, &query));
    match result {
        Ok(value) => crate::local::command::CommandResult::ok(value),
        Err(error) => crate::local::command::CommandResult::error(error, 0.0, false),
    }
}

fn execute_at(home: &Path, query: &ArtifactQuery) -> Result<Value, String> {
    let root = resolve_at(home, query)?;
    match query.path.as_deref() {
        None => Ok(json!({"workspace_root": root})),
        Some(path) => {
            if query.root_path.is_none() {
                return Err("Artifact download requires its captured workspace root".into());
            }
            crate::local::workspace_files::read_file_chunk(
                &root,
                &[
                    path.to_owned(),
                    query.offset.unwrap_or_default().to_string(),
                ],
            )
        }
    }
}

#[cfg(test)]
mod tests;
