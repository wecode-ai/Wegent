// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{env, path::PathBuf};

use sha2::{Digest, Sha256};

const ATTACHMENT_RUNTIME_DIR: &str = "attachments/runtime";

pub(crate) fn device_runtime_attachment_dir(task_id: &str, turn_id: &str) -> PathBuf {
    device_runtime_attachment_dir_at(device_workspace_root(), task_id, turn_id)
}

pub(crate) fn device_runtime_attachment_task_dir(task_id: &str) -> PathBuf {
    device_runtime_attachment_root().join(safe_identity_segment(task_id))
}

pub(crate) fn device_runtime_attachment_dir_at(
    workspace_root: PathBuf,
    task_id: &str,
    turn_id: &str,
) -> PathBuf {
    workspace_root
        .join(ATTACHMENT_RUNTIME_DIR)
        .join(safe_identity_segment(task_id))
        .join(safe_identity_segment(turn_id))
}

fn device_runtime_attachment_root() -> PathBuf {
    device_workspace_root().join(ATTACHMENT_RUNTIME_DIR)
}

fn device_workspace_root() -> PathBuf {
    env::var_os("WEGENT_EXECUTOR_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".wegent-executor")))
        .unwrap_or_else(|| env::temp_dir().join("wegent-executor"))
        .join("workspace")
}

fn safe_identity_segment(value: &str) -> String {
    let value = value.trim();
    if !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return value.to_owned();
    }

    let digest = Sha256::digest(value.as_bytes());
    let encoded = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("id-{encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_attachment_paths_stay_under_the_private_runtime_root() {
        let root = PathBuf::from("/executor/workspace");

        assert_eq!(
            device_runtime_attachment_dir_at(root, "runtime-123", "turn-456"),
            PathBuf::from("/executor/workspace/attachments/runtime/runtime-123/turn-456")
        );
    }

    #[test]
    fn unsafe_identity_segments_are_replaced_with_stable_hashes() {
        let root = PathBuf::from("/executor/workspace");
        let first = device_runtime_attachment_dir_at(root.clone(), "../project", "../../turn");
        let second = device_runtime_attachment_dir_at(root.clone(), "../project", "../../turn");

        assert_eq!(first, second);
        assert!(first.starts_with(root.join(ATTACHMENT_RUNTIME_DIR)));
        assert!(!first.to_string_lossy().contains("../"));
    }
}
