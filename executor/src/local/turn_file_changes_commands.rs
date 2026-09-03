// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Native review/revert for turn-file-changes artifacts.
//!
//! These device commands previously ran an embedded python3 script. The
//! executor home layout and payload contract are preserved: artifacts live
//! under `<executor-home>/artifacts/turn-file-changes/<task>/<subtask>/` with
//! `metadata.json` and a gzipped patch, and the patch is verified against the
//! metadata checksum before it is returned or reverse-applied.

use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use flate2::read::GzDecoder;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    local::command::{build_env, CommandResult},
    local::native_git::run_git_capture,
};

const MAX_PATCH_BYTES: usize = 20 * 1024 * 1024;
const GIT_APPLY_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_EXECUTOR_HOME: &str = ".wegent-executor";

/// Run `turn_file_changes_review` / `turn_file_changes_revert` natively.
pub async fn turn_file_changes(
    mode: &str,
    artifact_id: &str,
    workspace: Option<&str>,
    env: &HashMap<String, String>,
    max_output_bytes: usize,
) -> CommandResult {
    let started_at = Instant::now();
    let effective_env = build_env(env);
    if !matches!(mode, "review" | "revert") {
        return fail_result("invalid mode", started_at);
    }
    let Some((task_id, subtask_id)) = parse_artifact_id(artifact_id) else {
        return fail_result("invalid artifact id", started_at);
    };

    let Some(artifact_root) = artifact_root(&effective_env) else {
        return fail_result("invalid artifact id", started_at);
    };
    let artifact_dir = artifact_root.join(artifact_id);
    if !artifact_dir.starts_with(&artifact_root) {
        return fail_result("invalid artifact id", started_at);
    }

    let metadata_path = artifact_dir.join("metadata.json");
    let patch_path = artifact_dir.join("changes.patch.gz");
    if !metadata_path.is_file() || !patch_path.is_file() {
        return json_success(
            json!({
                "success": false,
                "status": "artifact_missing",
                "error": "turn file changes artifact is missing",
            }),
            started_at,
        );
    }

    let metadata = match std::fs::read_to_string(&metadata_path) {
        Ok(content) => match serde_json::from_str::<Value>(&content) {
            Ok(Value::Object(map)) => map,
            _ => return fail_result("invalid artifact metadata", started_at),
        },
        Err(_) => return fail_result("invalid artifact metadata", started_at),
    };
    if metadata.get("task_id").and_then(Value::as_str) != Some(task_id)
        || metadata.get("subtask_id").and_then(Value::as_str) != Some(subtask_id)
    {
        return fail_result("artifact metadata id mismatch", started_at);
    }
    let Some(metadata_workspace) = metadata
        .get("workspace_path")
        .and_then(Value::as_str)
        .map(resolve_path)
    else {
        return fail_result("invalid artifact workspace", started_at);
    };
    let Some(workspace_path) = workspace.map(resolve_path) else {
        return fail_result("invalid artifact workspace", started_at);
    };
    if metadata_workspace != workspace_path {
        return fail_result("artifact workspace mismatch", started_at);
    }

    let patch = match read_patch(&patch_path) {
        Ok(patch) => patch,
        Err(message) => return fail_result(&message, started_at),
    };
    let checksum = metadata
        .get("checksum")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let digest = hex_sha256(&patch);
    if digest != checksum {
        return fail_result("artifact patch checksum mismatch", started_at);
    }

    if mode == "review" {
        let diff = String::from_utf8_lossy(&patch).into_owned();
        return json_success(json!({ "success": true, "diff": diff }), started_at);
    }

    revert_patch(
        &patch,
        &workspace_path,
        &effective_env,
        max_output_bytes,
        started_at,
    )
    .await
}

fn parse_artifact_id(artifact_id: &str) -> Option<(&str, &str)> {
    let rest = artifact_id.strip_prefix("turn-file-changes/")?;
    let (task_id, subtask_id) = rest.split_once('/')?;
    let valid = |segment: &str| {
        !segment.is_empty()
            && segment.chars().all(|character| {
                character.is_ascii_alphanumeric() || character == '_' || character == '-'
            })
    };
    if valid(task_id) && valid(subtask_id) {
        Some((task_id, subtask_id))
    } else {
        None
    }
}

fn artifact_root(env: &HashMap<String, String>) -> Option<PathBuf> {
    let home = env
        .get("WEGENT_EXECUTOR_HOME")
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| {
            dirs::home_dir()
                .map(|home| home.join(DEFAULT_EXECUTOR_HOME).display().to_string())
                .unwrap_or_else(|| DEFAULT_EXECUTOR_HOME.to_owned())
        });
    let root = PathBuf::from(home).join("artifacts");
    if root.file_name().is_some() {
        Some(root)
    } else {
        None
    }
}

fn resolve_path(path: &str) -> PathBuf {
    let path = Path::new(path);
    match path.canonicalize() {
        Ok(canonical) => canonical,
        Err(_) => {
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                std::env::current_dir()
                    .map(|cwd| cwd.join(path))
                    .unwrap_or_else(|_| path.to_path_buf())
            }
        }
    }
}

fn read_patch(patch_path: &Path) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(patch_path)
        .map_err(|error| format!("failed to read artifact patch: {error}"))?;
    let mut decoder = GzDecoder::new(file);
    let mut patch = Vec::new();
    decoder
        .read_to_end(&mut patch)
        .map_err(|error| format!("failed to read artifact patch: {error}"))?;
    if patch.len() > MAX_PATCH_BYTES {
        return Err("artifact patch exceeds size limit".to_owned());
    }
    Ok(patch)
}

fn hex_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

async fn revert_patch(
    patch: &[u8],
    workspace: &Path,
    env: &HashMap<String, String>,
    max_output_bytes: usize,
    started_at: Instant,
) -> CommandResult {
    let temp_path = temp_patch_path();
    let cleanup = || {
        let _ = std::fs::remove_file(&temp_path);
    };
    if let Err(error) = std::fs::write(&temp_path, patch) {
        cleanup();
        return fail_result(
            &format!("failed to write artifact patch: {error}"),
            started_at,
        );
    }
    let check_result = apply_patch(&temp_path, workspace, env, true, max_output_bytes).await;
    let apply_result = if check_result {
        apply_patch(&temp_path, workspace, env, false, max_output_bytes).await
    } else {
        false
    };
    cleanup();
    if !check_result || !apply_result {
        return json_success(
            json!({
                "success": false,
                "status": "conflicted",
                "error": "patch does not apply",
            }),
            started_at,
        );
    }
    json_success(json!({ "success": true, "status": "reverted" }), started_at)
}

async fn apply_patch(
    patch_path: &Path,
    workspace: &Path,
    env: &HashMap<String, String>,
    check_only: bool,
    max_output_bytes: usize,
) -> bool {
    let mut args = vec!["apply".to_owned()];
    if check_only {
        args.push("--reverse".to_owned());
        args.push("--check".to_owned());
    } else {
        args.push("--reverse".to_owned());
    }
    args.push("--binary".to_owned());
    args.push(patch_path.display().to_string());
    match run_git_capture(
        &args,
        Some(workspace),
        env,
        GIT_APPLY_TIMEOUT,
        max_output_bytes,
    )
    .await
    {
        Ok(capture) => capture.success,
        Err(_) => false,
    }
}

fn temp_patch_path() -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!(
        "wegent-validated-turn-{}-{sequence}-{nanos}.patch",
        std::process::id()
    ))
}

fn fail_result(message: &str, started_at: Instant) -> CommandResult {
    CommandResult {
        success: false,
        exit_code: Some(64),
        stdout: json!({ "success": false, "error": message }),
        stderr: String::new(),
        duration: started_at.elapsed().as_secs_f64(),
        timed_out: false,
        stdout_truncated: false,
        stderr_truncated: false,
        error: Some(message.to_owned()),
    }
}

fn json_success(payload: Value, started_at: Instant) -> CommandResult {
    CommandResult {
        success: true,
        exit_code: Some(0),
        stdout: payload,
        stderr: String::new(),
        duration: started_at.elapsed().as_secs_f64(),
        timed_out: false,
        stdout_truncated: false,
        stderr_truncated: false,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_env() -> HashMap<String, String> {
        HashMap::new()
    }

    fn write_artifact(
        executor_home: &Path,
        artifact_id: &str,
        workspace: &Path,
        task_id: &str,
        subtask_id: &str,
        patch: &[u8],
        checksum: Option<&str>,
    ) {
        let dir = executor_home.join("artifacts").join(artifact_id);
        std::fs::create_dir_all(&dir).expect("artifact dir should be created");
        let metadata = json!({
            "task_id": task_id,
            "subtask_id": subtask_id,
            "workspace_path": workspace.canonicalize().unwrap_or_else(|_| workspace.to_path_buf()).display().to_string(),
            "checksum": checksum.map(str::to_owned).unwrap_or_else(|| hex_sha256(patch)),
        });
        std::fs::write(
            dir.join("metadata.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .expect("metadata should be written");
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut encoder = encoder;
        use std::io::Write;
        encoder.write_all(patch).expect("patch should compress");
        let compressed = encoder.finish().expect("patch should compress");
        std::fs::write(dir.join("changes.patch.gz"), compressed).expect("patch should be written");
    }

    #[tokio::test]
    async fn review_reports_missing_artifact() {
        let home = tempfile::tempdir().expect("temporary directory should be created");
        let workspace = tempfile::tempdir().expect("temporary directory should be created");
        let result = turn_file_changes(
            "review",
            "turn-file-changes/task-1/sub-2",
            Some(workspace.path().display().to_string().as_str()),
            &empty_env_with_home(home.path()),
            1 << 20,
        )
        .await;
        assert!(result.success);
        assert_eq!(result.stdout["status"], "artifact_missing");
    }

    #[tokio::test]
    async fn review_returns_verified_diff() {
        let home = tempfile::tempdir().expect("temporary directory should be created");
        let workspace = tempfile::tempdir().expect("temporary directory should be created");
        let artifact_id = "turn-file-changes/task-1/sub-2";
        let patch = b"diff --git a/a.txt b/a.txt\nindex 0000000..1111111\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+hello\n";
        write_artifact(
            home.path(),
            artifact_id,
            workspace.path(),
            "task-1",
            "sub-2",
            patch,
            None,
        );
        let result = turn_file_changes(
            "review",
            artifact_id,
            Some(workspace.path().display().to_string().as_str()),
            &empty_env_with_home(home.path()),
            1 << 20,
        )
        .await;
        assert!(result.success);
        assert_eq!(result.stdout["success"], true);
        assert_eq!(
            result.stdout["diff"],
            Value::String(String::from_utf8_lossy(patch).into_owned())
        );
    }

    #[tokio::test]
    async fn review_rejects_checksum_mismatch() {
        let home = tempfile::tempdir().expect("temporary directory should be created");
        let workspace = tempfile::tempdir().expect("temporary directory should be created");
        let artifact_id = "turn-file-changes/task-1/sub-2";
        write_artifact(
            home.path(),
            artifact_id,
            workspace.path(),
            "task-1",
            "sub-2",
            b"not the patch",
            Some("deadbeef"),
        );
        let result = turn_file_changes(
            "review",
            artifact_id,
            Some(workspace.path().display().to_string().as_str()),
            &empty_env_with_home(home.path()),
            1 << 20,
        )
        .await;
        assert!(!result.success);
        assert_eq!(result.stdout["error"], "artifact patch checksum mismatch");
    }

    fn empty_env_with_home(home: &Path) -> HashMap<String, String> {
        let mut env = empty_env();
        env.insert(
            "WEGENT_EXECUTOR_HOME".to_owned(),
            home.display().to_string(),
        );
        env
    }
}
