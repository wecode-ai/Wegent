// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Instant, SystemTime},
};

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::command::CommandResult;

const MAX_TEXT_FILE_BYTES: usize = 256 * 1024;
const MAX_BINARY_CHUNK_BYTES: usize = 1024 * 1024;
const WORKSPACE_ROOTS_ENV: &str = "WEGENT_WORKSPACE_ROOTS";

pub fn is_workspace_file_command(command_key: &str) -> bool {
    matches!(
        command_key,
        "workspace_tree"
            | "workspace_read_text_file"
            | "workspace_read_file_chunk"
            | "workspace_write_text_file"
    )
}

pub async fn execute_workspace_file_command(
    command_key: &str,
    path: Option<String>,
    args: Vec<String>,
    env_values: HashMap<String, String>,
) -> CommandResult {
    execute_workspace_file_command_with_input(command_key, path, args, env_values, None).await
}

pub async fn execute_workspace_file_command_with_input(
    command_key: &str,
    path: Option<String>,
    args: Vec<String>,
    env_values: HashMap<String, String>,
    stdin: Option<String>,
) -> CommandResult {
    let started_at = Instant::now();
    let command_key = command_key.to_owned();
    match tokio::task::spawn_blocking(move || {
        execute_blocking(
            &command_key,
            path.as_deref(),
            &args,
            &env_values,
            stdin.as_deref(),
        )
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
    stdin: Option<&str>,
) -> Result<Value, String> {
    let root = resolve_workspace_directory(path)?;
    let allowed_roots = allowed_workspace_roots(env_values)?;
    require_allowed_root(&root, &allowed_roots)?;

    match command_key {
        "workspace_tree" => list_entries(&root),
        "workspace_read_text_file" => read_text_file(&root, &allowed_roots, args),
        "workspace_read_file_chunk" => read_file_chunk(&root, &allowed_roots, args),
        "workspace_write_text_file" => write_text_file(&root, &allowed_roots, args, stdin),
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
    let editable = !truncated && std::str::from_utf8(&bytes).is_ok();
    Ok(json!({
        "success": true,
        "path": target.to_string_lossy(),
        "name": target.file_name().and_then(|name| name.to_str()).unwrap_or_default(),
        "content": String::from_utf8_lossy(&bytes),
        "editable": editable,
        "revision": sha256_revision(&bytes),
        "truncated": truncated,
        "size": metadata.len(),
        "modified_at": modified_at(metadata.modified().ok()),
    }))
}

fn write_text_file(
    root: &Path,
    allowed_roots: &[PathBuf],
    args: &[String],
    stdin: Option<&str>,
) -> Result<Value, String> {
    if args.len() != 2 || args[0].trim().is_empty() || args[1].trim().is_empty() {
        return Err("File name and expected revision are required".to_owned());
    }
    let content = stdin.ok_or_else(|| "File content is required".to_owned())?;
    if content.len() > MAX_TEXT_FILE_BYTES {
        return Err("File content exceeds 256 KiB".to_owned());
    }
    let parent = fs::canonicalize(root)
        .map_err(|error| format!("Failed to resolve workspace directory: {error}"))?;
    require_allowed_root(&parent, allowed_roots)?;
    let target = parent.join(&args[0]);
    if target.parent() != Some(parent.as_path()) {
        return Err("File path is outside workspace".to_owned());
    }
    let existing_metadata = match fs::symlink_metadata(&target) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err("File does not exist".to_owned());
            }
            let current =
                fs::read(&target).map_err(|error| format!("Failed to read file: {error}"))?;
            std::str::from_utf8(&current).map_err(|_| "File is not valid UTF-8".to_owned())?;
            if sha256_revision(&current) != args[1] {
                return Err("Workspace file has changed on disk".to_owned());
            }
            Some(metadata)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && args[1] == "missing" => None,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("Workspace file has changed on disk".to_owned());
        }
        Err(error) => return Err(format!("Failed to read file metadata: {error}")),
    };
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to create temporary file: {error}"))?;
    temporary
        .write_all(content.as_bytes())
        .map_err(|error| format!("Failed to write file: {error}"))?;
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|error| format!("Failed to flush file: {error}"))?;
    if let Some(metadata) = existing_metadata {
        fs::set_permissions(temporary.path(), metadata.permissions())
            .map_err(|error| format!("Failed to preserve file permissions: {error}"))?;
    }
    temporary
        .persist(&target)
        .map_err(|error| format!("Failed to replace file: {}", error.error))?;
    let saved_metadata = fs::metadata(&target)
        .map_err(|error| format!("Failed to read saved file metadata: {error}"))?;
    Ok(json!({
        "success": true,
        "path": target.to_string_lossy(),
        "name": target.file_name().and_then(|name| name.to_str()).unwrap_or_default(),
        "content": content,
        "editable": true,
        "revision": sha256_revision(content.as_bytes()),
        "truncated": false,
        "size": saved_metadata.len(),
        "modified_at": modified_at(saved_metadata.modified().ok()),
    }))
}

fn sha256_revision(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed_env(root: &Path) -> HashMap<String, String> {
        HashMap::from([(
            WORKSPACE_ROOTS_ENV.to_owned(),
            root.to_string_lossy().into_owned(),
        )])
    }

    #[test]
    fn write_text_file_saves_content_and_updates_revision() {
        let directory = tempfile::tempdir().expect("create workspace");
        let target = directory.path().join("README.md");
        fs::write(&target, "hello").expect("seed file");
        let expected_revision = sha256_revision(b"hello");

        let saved = execute_blocking(
            "workspace_write_text_file",
            directory.path().to_str(),
            &["README.md".to_owned(), expected_revision],
            &allowed_env(directory.path()),
            Some("updated"),
        )
        .expect("save file");

        assert_eq!(
            fs::read_to_string(&target).expect("read saved file"),
            "updated"
        );
        assert_eq!(saved["content"], "updated");
        assert_eq!(saved["editable"], true);
        assert_eq!(saved["revision"], sha256_revision(b"updated"));
    }

    #[test]
    fn write_text_file_creates_missing_file_with_missing_revision() {
        let directory = tempfile::tempdir().expect("create workspace");
        let target = directory.path().join("AGENTS.md");

        let saved = execute_blocking(
            "workspace_write_text_file",
            directory.path().to_str(),
            &["AGENTS.md".to_owned(), "missing".to_owned()],
            &allowed_env(directory.path()),
            Some("Project instructions"),
        )
        .expect("create file");

        assert_eq!(
            fs::read_to_string(&target).expect("read created file"),
            "Project instructions"
        );
        assert_eq!(saved["revision"], sha256_revision(b"Project instructions"));
    }

    #[test]
    fn write_text_file_rejects_stale_revision_without_overwriting() {
        let directory = tempfile::tempdir().expect("create workspace");
        let target = directory.path().join("README.md");
        fs::write(&target, "changed").expect("seed file");

        let error = execute_blocking(
            "workspace_write_text_file",
            directory.path().to_str(),
            &["README.md".to_owned(), "sha256:stale".to_owned()],
            &allowed_env(directory.path()),
            Some("updated"),
        )
        .expect_err("reject stale revision");

        assert_eq!(error, "Workspace file has changed on disk");
        assert_eq!(
            fs::read_to_string(target).expect("read original file"),
            "changed"
        );
    }

    #[test]
    fn write_text_file_rejects_content_over_limit() {
        let directory = tempfile::tempdir().expect("create workspace");
        let target = directory.path().join("README.md");
        fs::write(&target, "hello").expect("seed file");
        let content = "x".repeat(MAX_TEXT_FILE_BYTES + 1);

        let error = execute_blocking(
            "workspace_write_text_file",
            directory.path().to_str(),
            &["README.md".to_owned(), sha256_revision(b"hello")],
            &allowed_env(directory.path()),
            Some(&content),
        )
        .expect_err("reject oversized content");

        assert_eq!(error, "File content exceeds 256 KiB");
        assert_eq!(
            fs::read_to_string(target).expect("read original file"),
            "hello"
        );
    }
}
