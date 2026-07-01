// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde_json::{json, Value};
use tokio::sync::{Mutex, MutexGuard};
use wegent_executor::{
    agents::ImageValidatorEngine,
    protocol::ExecutionRequest,
    runner::{AgentEngine, ExecutionOutcome},
};

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

#[tokio::test]
async fn image_validator_runs_claudecode_dependency_checks() {
    let _lock = env_lock().await;
    let bin_dir = unique_dir("claudecode-bin");
    fs::create_dir_all(&bin_dir).unwrap();
    write_executable(&bin_dir, "node", "#!/bin/sh\necho v20.11.1\n");
    write_executable(&bin_dir, "claude", "#!/bin/sh\necho 2.1.142\n");
    write_executable(&bin_dir, "python3", "#!/bin/sh\necho Python 3.12.2\n");
    let path = format!(
        "{}:{}",
        bin_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let _path = EnvGuard::set("PATH", &path);
    let request = ExecutionRequest {
        task_type: Some("validation".to_owned()),
        validation_params: json!({
            "shell_type": "ClaudeCode",
            "shell_name": "Claude Code",
            "image": "example/custom:latest",
            "validation_id": "val-1"
        }),
        ..ExecutionRequest::default()
    };

    let outcome = ImageValidatorEngine.run(request).await;

    let ExecutionOutcome::Completed { content } = outcome else {
        panic!("expected completed validation outcome");
    };
    let result: Value = serde_json::from_str(&content).unwrap();
    assert_eq!(result["valid"], true);
    assert_eq!(result["shell_type"], "ClaudeCode");
    assert_eq!(result["shell_name"], "Claude Code");
    assert_eq!(result["image"], "example/custom:latest");
    assert_eq!(result["checks"][0]["name"], "node");
    assert_eq!(result["checks"][0]["version"], "20.11.1");
    assert_eq!(result["checks"][1]["name"], "claude-code");
    assert_eq!(result["checks"][2]["name"], "python");
}

#[tokio::test]
async fn image_validator_rejects_unknown_shell_type() {
    let request = ExecutionRequest {
        task_type: Some("validation".to_owned()),
        validation_params: json!({"shell_type": "Unknown"}),
        ..ExecutionRequest::default()
    };

    let outcome = ImageValidatorEngine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Failed {
            message: "Unknown shell type: Unknown".to_owned()
        }
    );
}

fn write_executable(dir: &Path, name: &str, content: &str) {
    let path = dir.join(name);
    fs::write(&path, content).unwrap();
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).unwrap();
    }
}

fn unique_dir(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "wegent-executor-image-validator-{label}-{}",
        std::process::id()
    ))
}
