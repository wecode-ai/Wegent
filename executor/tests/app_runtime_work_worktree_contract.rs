// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::json;
use tokio::sync::{Mutex, MutexGuard};
use wegent_executor::{local::app_ipc::RuntimeWorkHandler, runtime_work::RuntimeWorkRpcHandler};

async fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().await
}

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

fn verified_cloud_worktree_env() -> (EnvGuard, EnvGuard) {
    (
        EnvGuard::set("DEVICE_TYPE", "cloud"),
        EnvGuard::set("WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED", "true"),
    )
}

#[tokio::test]
async fn worktree_capabilities_rpc_uses_the_frozen_contract() {
    let _lock = env_lock().await;
    let executor_home = temp_path("runtime-worktree-capabilities-home");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let (_device_type, _persistent_storage) = verified_cloud_worktree_env();
    let handler = RuntimeWorkRpcHandler::new("device-1", "unused");

    let response = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.worktrees.capabilities",
            "payload": {}
        }))
        .await
        .expect("capabilities should succeed");

    assert_eq!(response["success"], true);
    assert_eq!(response["deviceId"], "device-1");
    assert_eq!(response["runtimeWorktrees"]["version"], 1);
    assert_eq!(response["runtimeWorktrees"]["managed"], true);
    assert_eq!(response["runtimeWorktrees"]["deferredPrepare"], true);
    assert_eq!(response["runtimeWorktrees"]["snapshots"], true);
    assert_eq!(response["runtimeWorktrees"]["restore"], true);
    assert_eq!(response["runtimeWorktrees"]["preflight"], true);
    assert_eq!(response["runtimeWorktrees"]["reconcile"], true);
    assert_eq!(
        response["runtimeWorktrees"]["persistentStorageVerified"],
        true
    );
    let _ = fs::remove_dir_all(executor_home);
}

#[tokio::test]
async fn cloud_worktree_rpc_fails_closed_without_verified_persistent_storage() {
    let _lock = env_lock().await;
    let executor_home = temp_path("runtime-worktree-unverified-storage-home");
    let source = temp_path("runtime-worktree-unverified-storage-source");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let _device_type = EnvGuard::set("DEVICE_TYPE", "cloud");
    let _persistent_storage = EnvGuard::set("WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED", "false");
    initialize_repository(&source);
    let handler = RuntimeWorkRpcHandler::new("device-1", "unused");

    let capabilities = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.worktrees.capabilities",
            "payload": {}
        }))
        .await
        .expect("capabilities should succeed");
    assert_eq!(
        capabilities["runtimeWorktrees"]["persistentStorageVerified"],
        false
    );

    let preflight = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.worktrees.preflight",
            "payload": {
                "sourcePath": source.display().to_string()
            }
        }))
        .await
        .expect("preflight should return a structured failure");
    assert_eq!(preflight["supported"], false);
    assert_eq!(
        preflight["errorCode"],
        "worktree_persistent_storage_unverified"
    );

    let error = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.worktrees.prepare",
            "payload": {
                "sourcePath": source.display().to_string(),
                "worktreeId": "task-1"
            }
        }))
        .await
        .expect_err("prepare must fail without verified persistent storage");
    assert_eq!(error.code, "worktree_persistent_storage_unverified");
    assert!(!executor_home.join("workspace/worktrees/task-1").exists());

    let _ = fs::remove_dir_all(source);
    let _ = fs::remove_dir_all(executor_home);
}

#[tokio::test]
async fn worktree_preflight_rpc_reports_git_identity_without_creating_a_worktree() {
    let _lock = env_lock().await;
    let executor_home = temp_path("runtime-worktree-preflight-home");
    let source = temp_path("runtime-worktree-preflight-source");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let (_device_type, _persistent_storage) = verified_cloud_worktree_env();
    initialize_repository(&source);
    let handler = RuntimeWorkRpcHandler::new("device-1", "unused");

    let response = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.worktrees.preflight",
            "payload": {
                "sourcePath": source.display().to_string(),
                "ref": "HEAD"
            }
        }))
        .await
        .expect("preflight should return a structured result");

    assert_eq!(response["success"], true);
    assert_eq!(response["deviceId"], "device-1");
    assert_eq!(response["supported"], true);
    assert_eq!(response["gitRepository"], true);
    assert_eq!(response["gitCommonDirValid"], true);
    assert_eq!(response["gitCommonDirWritable"], true);
    assert_eq!(response["refValid"], true);
    assert_eq!(response["writable"], true);
    assert_eq!(response["errorCode"], serde_json::Value::Null);
    assert!(response["repoRootFingerprint"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    assert!(
        !executor_home.join("workspace/worktrees").exists(),
        "preflight must not create the managed worktree root"
    );
    let _ = fs::remove_dir_all(source);
    let _ = fs::remove_dir_all(executor_home);
}

#[tokio::test]
async fn worktree_task_create_rejects_non_git_source_without_fallback() {
    let _lock = env_lock().await;
    let executor_home = temp_path("runtime-worktree-create-home");
    let source = temp_path("runtime-worktree-create-source");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let (_device_type, _persistent_storage) = verified_cloud_worktree_env();
    fs::create_dir_all(&source).unwrap();
    let handler = RuntimeWorkRpcHandler::new("device-1", "must-not-start");

    let error = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "task-1",
                "workspacePath": source.display().to_string(),
                "message": "run in an isolated worktree",
                "executionRequest": {
                    "task_id": 1001,
                    "subtask_id": 2001,
                    "prompt": "run in an isolated worktree",
                    "project_workspace_path": source.display().to_string(),
                    "workspace_source": "git_worktree",
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5.5",
                        "api_format": "responses",
                        "protocol": "openai-responses"
                    }
                }
            }
        }))
        .await
        .expect_err("non-Git Worktree creation must fail");

    assert_eq!(error.code, "worktree_source_not_git");
    assert!(
        !executor_home.join("workspace/worktrees/task-1").exists(),
        "failed Worktree planning must not fall back or create a target"
    );
    let _ = fs::remove_dir_all(source);
    let _ = fs::remove_dir_all(executor_home);
}

#[tokio::test]
async fn worktree_prepare_rpc_rejects_an_existing_plain_directory() {
    let _lock = env_lock().await;
    let executor_home = temp_path("runtime-worktree-existing-target-home");
    let source = temp_path("runtime-worktree-existing-target-source");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let (_device_type, _persistent_storage) = verified_cloud_worktree_env();
    initialize_repository(&source);
    let repository_name = source.file_name().unwrap();
    let target = executor_home
        .join("workspace/worktrees/task-1")
        .join(repository_name);
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("unknown.txt"), "do not delete\n").unwrap();
    let handler = RuntimeWorkRpcHandler::new("device-1", "must-not-start");

    let error = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.worktrees.prepare",
            "payload": {
                "sourcePath": source.display().to_string(),
                "worktreeId": "task-1"
            }
        }))
        .await
        .expect_err("an unknown target directory must be rejected");

    assert_eq!(error.code, "worktree_target_conflict");
    assert!(target.join("unknown.txt").exists());
    let _ = fs::remove_dir_all(source);
    let _ = fs::remove_dir_all(executor_home);
}

#[tokio::test]
async fn concurrent_worktree_prepare_uses_distinct_task_paths() {
    let _lock = env_lock().await;
    let executor_home = temp_path("runtime-worktree-concurrent-home");
    let source = temp_path("runtime-worktree-concurrent-source");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let (_device_type, _persistent_storage) = verified_cloud_worktree_env();
    initialize_repository(&source);
    let handler = RuntimeWorkRpcHandler::new("device-1", "unused");
    let source_path = source.display().to_string();

    let first = handler.handle_runtime_rpc(json!({
        "method": "runtime.worktrees.prepare",
        "payload": {
            "sourcePath": source_path,
            "worktreeId": "task-1"
        }
    }));
    let second = handler.handle_runtime_rpc(json!({
        "method": "runtime.worktrees.prepare",
        "payload": {
            "sourcePath": source.display().to_string(),
            "worktreeId": "task-2"
        }
    }));
    let (first, second) = tokio::join!(first, second);
    let first = first.expect("first concurrent preparation should succeed");
    let second = second.expect("second concurrent preparation should succeed");
    let first_path = PathBuf::from(first["path"].as_str().unwrap());
    let second_path = PathBuf::from(second["path"].as_str().unwrap());

    assert_ne!(first_path, second_path);
    assert!(first_path.exists());
    assert!(second_path.exists());
    assert!(first_path.starts_with(executor_home.join("workspace/worktrees/task-1")));
    assert!(second_path.starts_with(executor_home.join("workspace/worktrees/task-2")));

    for path in [&first_path, &second_path] {
        handler
            .handle_runtime_rpc(json!({
                "method": "runtime.worktrees.delete",
                "payload": {
                    "path": path.display().to_string(),
                    "preserveSnapshot": false
                }
            }))
            .await
            .expect("prepared worktree cleanup should succeed");
    }
    let _ = fs::remove_dir_all(source);
    let _ = fs::remove_dir_all(executor_home);
}

fn initialize_repository(path: &Path) {
    fs::create_dir_all(path).unwrap();
    run_git(path, &["init"]);
    run_git(path, &["config", "user.name", "Wegent Test"]);
    run_git(path, &["config", "user.email", "test@wegent.local"]);
    fs::write(path.join("tracked.txt"), "base\n").unwrap();
    run_git(path, &["add", "."]);
    run_git(path, &["commit", "-m", "base"]);
}

fn run_git(path: &Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git -C {} {} failed: {}",
        path.display(),
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn temp_path(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()))
}
