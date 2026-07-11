// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    time::{Instant, SystemTime},
};

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use super::command::CommandResult;

const MAX_TEXT_FILE_BYTES: usize = 256 * 1024;
const MAX_BINARY_CHUNK_BYTES: usize = 1024 * 1024;
const WORKSPACE_ROOTS_ENV: &str = "WEGENT_WORKSPACE_ROOTS";

pub fn is_workspace_file_command(command_key: &str) -> bool {
    matches!(
        command_key,
        "workspace_tree" | "workspace_read_text_file" | "workspace_read_file_chunk"
    )
}

pub async fn execute_workspace_file_command(
    command_key: &str,
    path: Option<String>,
    args: Vec<String>,
    env_values: HashMap<String, String>,
) -> CommandResult {
    let started_at = Instant::now();
    let command_key = command_key.to_owned();
    match tokio::task::spawn_blocking(move || {
        execute_blocking(&command_key, path.as_deref(), &args, &env_values)
    })
    .await
    {
        Ok(Ok(stdout)) => CommandResult::ok(stdout),
        Ok(Err(error)) => error_result(error, started_at),
        Err(error) => error_result(
            format!("Workspace file operation failed: {error}"),
            started_at,
        ),
    }
}

fn execute_blocking(
    command_key: &str,
    path: Option<&str>,
    args: &[String],
    env_values: &HashMap<String, String>,
) -> Result<Value, String> {
    let root = resolve_workspace_directory(path)?;
    let allowed_roots = allowed_workspace_roots(env_values)?;
    require_allowed_root(&root, &allowed_roots)?;

    match command_key {
        "workspace_tree" => list_entries(&root),
        "workspace_read_text_file" => read_text_file(&root, &allowed_roots, args),
        "workspace_read_file_chunk" => read_file_chunk(&root, &allowed_roots, args),
        _ => Err(format!("Unsupported workspace file command: {command_key}")),
    }
}

fn resolve_workspace_directory(path: Option<&str>) -> Result<PathBuf, String> {
    let path = path.ok_or_else(|| "Workspace path is required".to_owned())?;
    let root =
        fs::canonicalize(path).map_err(|error| format!("Invalid workspace path: {error}"))?;
    if !root.is_dir() {
        return Err("Workspace path is not a directory".to_owned());
    }
    Ok(root)
}

fn allowed_workspace_roots(env_values: &HashMap<String, String>) -> Result<Vec<PathBuf>, String> {
    let raw_roots = env_values
        .get(WORKSPACE_ROOTS_ENV)
        .cloned()
        .or_else(|| env::var(WORKSPACE_ROOTS_ENV).ok());
    let Some(raw_roots) = raw_roots.filter(|value| !value.trim().is_empty()) else {
        return Ok(Vec::new());
    };

    raw_roots
        .split(if cfg!(windows) { ';' } else { ':' })
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            fs::canonicalize(value).map_err(|error| format!("Invalid workspace root: {error}"))
        })
        .collect()
}

fn require_allowed_root(path: &Path, allowed_roots: &[PathBuf]) -> Result<(), String> {
    if allowed_roots.is_empty() || allowed_roots.iter().any(|root| path.starts_with(root)) {
        return Ok(());
    }
    Err("Workspace path is outside allowed workspace roots".to_owned())
}

fn list_entries(root: &Path) -> Result<Value, String> {
    let mut entries = Vec::new();
    for child in fs::read_dir(root).map_err(|error| format!("Failed to list workspace: {error}"))? {
        let child = match child {
            Ok(child) => child,
            Err(_) => continue,
        };
        let metadata = match fs::symlink_metadata(child.path()) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let is_directory = metadata.file_type().is_dir();
        entries.push(json!({
            "name": child.file_name().to_string_lossy(),
            "path": child.path().to_string_lossy(),
            "is_directory": is_directory,
            "size": if is_directory { 0 } else { metadata.len() },
            "modified_at": modified_at(metadata.modified().ok()),
        }));
    }
    entries.sort_by(|left, right| {
        let left_directory = left["is_directory"].as_bool().unwrap_or(false);
        let right_directory = right["is_directory"].as_bool().unwrap_or(false);
        right_directory.cmp(&left_directory).then_with(|| {
            left["name"]
                .as_str()
                .unwrap_or_default()
                .to_lowercase()
                .cmp(&right["name"].as_str().unwrap_or_default().to_lowercase())
        })
    });
    Ok(json!({ "path": root.to_string_lossy(), "entries": entries }))
}

fn read_text_file(
    root: &Path,
    allowed_roots: &[PathBuf],
    args: &[String],
) -> Result<Value, String> {
    if args.len() != 1 || args[0].trim().is_empty() {
        return Err("File name is required".to_owned());
    }
    let target = fs::canonicalize(root.join(&args[0]))
        .map_err(|error| format!("Failed to resolve workspace file: {error}"))?;
    if !target.starts_with(root) {
        return Err("File path is outside workspace".to_owned());
    }
    require_allowed_root(&target, allowed_roots)?;
    let metadata =
        fs::metadata(&target).map_err(|error| format!("Failed to read file metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("File does not exist".to_owned());
    }
    let file = fs::File::open(&target).map_err(|error| format!("Failed to open file: {error}"))?;
    let mut bytes = Vec::with_capacity(MAX_TEXT_FILE_BYTES + 1);
    use std::io::Read;
    file.take((MAX_TEXT_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read file: {error}"))?;
    let truncated = bytes.len() > MAX_TEXT_FILE_BYTES;
    bytes.truncate(MAX_TEXT_FILE_BYTES);
    Ok(json!({
        "success": true,
        "path": target.to_string_lossy(),
        "name": target.file_name().and_then(|name| name.to_str()).unwrap_or_default(),
        "content": String::from_utf8_lossy(&bytes),
        "truncated": truncated,
        "size": metadata.len(),
        "modified_at": modified_at(metadata.modified().ok()),
    }))
}

fn read_file_chunk(
    root: &Path,
    allowed_roots: &[PathBuf],
    args: &[String],
) -> Result<Value, String> {
    if args.len() != 2 || args[0].trim().is_empty() {
        return Err("File name and offset are required".to_owned());
    }
    let offset = args[1]
        .parse::<u64>()
        .map_err(|_| "File offset must be a non-negative integer".to_owned())?;
    let target = resolve_workspace_file(root, allowed_roots, &args[0])?;
    let metadata =
        fs::metadata(&target).map_err(|error| format!("Failed to read file metadata: {error}"))?;
    let mut file =
        fs::File::open(&target).map_err(|error| format!("Failed to open file: {error}"))?;
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Failed to seek file: {error}"))?;
    let mut bytes = vec![0; MAX_BINARY_CHUNK_BYTES];
    let bytes_read = file
        .read(&mut bytes)
        .map_err(|error| format!("Failed to read file: {error}"))?;
    bytes.truncate(bytes_read);
    Ok(json!({
        "path": target.to_string_lossy(),
        "name": target.file_name().and_then(|name| name.to_str()).unwrap_or_default(),
        "content_base64": base64_encode(&bytes),
        "offset": offset,
        "eof": offset.saturating_add(bytes_read as u64) >= metadata.len(),
        "size": metadata.len(),
        "modified_at": modified_at(metadata.modified().ok()),
    }))
}

fn resolve_workspace_file(
    root: &Path,
    allowed_roots: &[PathBuf],
    name: &str,
) -> Result<PathBuf, String> {
    let target = fs::canonicalize(root.join(name))
        .map_err(|error| format!("Failed to resolve workspace file: {error}"))?;
    if !target.starts_with(root) {
        return Err("File path is outside workspace".to_owned());
    }
    require_allowed_root(&target, allowed_roots)?;
    if !fs::metadata(&target)
        .map_err(|error| format!("Failed to read file metadata: {error}"))?
        .is_file()
    {
        return Err("File does not exist".to_owned());
    }
    Ok(target)
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[((first & 0b0000_0011) << 4 | (second >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[((second & 0b0000_1111) << 2 | (third >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(third & 0b0011_1111) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn modified_at(time: Option<SystemTime>) -> Option<String> {
    time.map(|time| DateTime::<Utc>::from(time).to_rfc3339())
}

fn error_result(error: String, started_at: Instant) -> CommandResult {
    CommandResult {
        success: false,
        exit_code: Some(1),
        stdout: Value::String(String::new()),
        stderr: String::new(),
        duration: started_at.elapsed().as_secs_f64(),
        timed_out: false,
        stdout_truncated: false,
        stderr_truncated: false,
        error: Some(error),
    }
}
