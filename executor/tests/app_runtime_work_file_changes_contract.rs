// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

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

#[tokio::test]
async fn runtime_transcript_preserves_assistant_file_changes_from_codex_items() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-file-changes-home", "dir")
            .display()
            .to_string(),
    );
    let fake_codex = write_fake_codex(&temp_path("runtime-file-changes-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let transcript = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "workspacePath": "/tmp/project",
                "localTaskId": "thread-1",
                "runtimeHandle": {"threadId": "thread-1"}
            }
        }))
        .await
        .expect("transcript should succeed");

    assert_eq!(transcript["success"], true);
    let assistant = &transcript["messages"][1];
    assert_eq!(assistant["role"], "assistant");
    assert_eq!(assistant["content"], "Edited files");
    assert_eq!(assistant["fileChanges"]["artifact_id"], "artifact-1");
    assert_eq!(assistant["fileChanges"]["file_count"], 1);
    assert_eq!(
        assistant["fileChanges"]["files"][0]["path"],
        "src/runtime_work.rs"
    );
}

#[tokio::test]
async fn runtime_transcript_normalizes_codex_file_change_items_without_backend_subtask_id() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-codex-file-change-home", "dir")
            .display()
            .to_string(),
    );
    let fake_codex =
        write_fake_file_change_codex(&temp_path("runtime-codex-file-change-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let transcript = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "workspacePath": "/tmp/project",
                "localTaskId": "thread-1",
                "runtimeHandle": {"threadId": "thread-1"}
            }
        }))
        .await
        .expect("transcript should succeed");

    assert_eq!(transcript["success"], true);
    let assistant = &transcript["messages"][1];
    assert_eq!(assistant["role"], "assistant");
    assert_eq!(assistant["content"], "Done");
    let subtask_id = assistant["subtaskId"]
        .as_i64()
        .expect("synthetic subtask id should be present");
    assert!(subtask_id < 0);
    assert_eq!(assistant["subtask_id"], assistant["subtaskId"]);
    assert_eq!(assistant["fileChanges"]["device_id"], "device-1");
    assert_eq!(assistant["fileChanges"]["workspace_path"], "/tmp/project");
    assert_eq!(
        assistant["fileChanges"]["artifact_id"],
        "codex-turn-file-change-call-1"
    );
    assert_eq!(assistant["blocks"].as_array().unwrap().len(), 2);
    assert_eq!(assistant["blocks"][0]["type"], "text");
    assert_eq!(assistant["blocks"][0]["content"], "Editing.");
    assert_eq!(assistant["blocks"][1]["type"], "file_changes");
    assert_eq!(
        assistant["blocks"][1]["file_changes"]["files"][0]["path"],
        "references/github-pr-flow.md"
    );
    assert_eq!(assistant["fileChanges"]["file_count"], 1);
    assert_eq!(assistant["fileChanges"]["additions"], 1);
    assert_eq!(assistant["fileChanges"]["deletions"], 1);
    assert_eq!(
        assistant["fileChanges"]["files"][0]["path"],
        "references/github-pr-flow.md"
    );
    assert!(assistant["fileChanges"]["diff"]
        .as_str()
        .unwrap()
        .starts_with("diff --git a/references/github-pr-flow.md b/references/github-pr-flow.md"));
}

#[tokio::test]
async fn runtime_transcript_normalizes_codex_rich_turn_items() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-rich-transcript-home", "dir")
            .display()
            .to_string(),
    );
    let fake_codex = write_fake_rich_codex(&temp_path("runtime-rich-transcript-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let transcript = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "workspacePath": "/tmp/project",
                "localTaskId": "thread-1",
                "runtimeHandle": {"threadId": "thread-1"}
            }
        }))
        .await
        .expect("transcript should succeed");

    assert_eq!(transcript["success"], true);
    let assistant = &transcript["messages"][1];
    assert_eq!(assistant["role"], "assistant");
    assert_eq!(assistant["content"], "Done");
    assert!(assistant["subtaskId"].as_i64().unwrap() < 0);
    assert_eq!(assistant["blocks"].as_array().unwrap().len(), 5);
    assert_eq!(assistant["blocks"][0]["type"], "thinking");
    assert_eq!(assistant["blocks"][1]["type"], "text");
    assert_eq!(assistant["blocks"][1]["content"], "I checked the files.");
    assert_eq!(assistant["blocks"][2]["tool_name"], "exec_command");
    assert_eq!(assistant["blocks"][2]["tool_output"], "ok");
    assert_eq!(assistant["blocks"][3]["type"], "file_changes");
    assert_eq!(
        assistant["blocks"][3]["file_changes"]["files"][0]["path"],
        "src/lib.rs"
    );
    assert_eq!(assistant["blocks"][3]["timestamp"], 1780000000000_i64);
    assert_eq!(assistant["fileChanges"]["device_id"], "device-1");
    assert_eq!(assistant["fileChanges"]["workspace_path"], "/tmp/project");
    assert_eq!(assistant["fileChanges"]["file_count"], 1);
    assert_eq!(assistant["fileChanges"]["additions"], 1);
    assert_eq!(assistant["fileChanges"]["deletions"], 1);
    assert_eq!(assistant["fileChanges"]["revertible"], false);
    assert_eq!(assistant["fileChanges"]["files"][0]["path"], "src/lib.rs");
    assert!(assistant["fileChanges"]["diff"]
        .as_str()
        .unwrap()
        .starts_with("diff --git a/src/lib.rs b/src/lib.rs"));
    assert_eq!(
        assistant["memoryCitations"][0]["entries"][0]["path"],
        "MEMORY.md"
    );
    assert_eq!(assistant["blocks"][4]["type"], "tool");
    assert_eq!(assistant["blocks"][4]["tool_name"], "context_compaction");
    assert_eq!(assistant["blocks"][4]["status"], "done");
    assert_eq!(assistant["blocks"][4]["timestamp"], 1780000007000_i64);
}

#[tokio::test]
async fn runtime_transcript_preserves_codex_web_search_actions() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-web-search-home", "dir")
            .display()
            .to_string(),
    );
    let fake_codex = write_fake_web_search_codex(&temp_path("runtime-web-search-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let transcript = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "workspacePath": "/tmp/project",
                "localTaskId": "thread-1",
                "runtimeHandle": {"threadId": "thread-1"}
            }
        }))
        .await
        .expect("transcript should succeed");

    assert_eq!(transcript["success"], true);
    let assistant = &transcript["messages"][1];
    assert_eq!(assistant["role"], "assistant");
    assert_eq!(assistant["content"], "Done");
    assert_eq!(assistant["blocks"].as_array().unwrap().len(), 3);
    assert_eq!(assistant["blocks"][0]["type"], "text");
    assert_eq!(assistant["blocks"][1]["type"], "tool");
    assert_eq!(assistant["blocks"][1]["tool_name"], "web_search");
    assert_eq!(assistant["blocks"][1]["tool_input"]["type"], "search");
    assert_eq!(
        assistant["blocks"][1]["tool_input"]["query"],
        "Beijing weather today June 17 2026 temperature rain"
    );
    assert_eq!(
        assistant["blocks"][1]["tool_input"]["queries"][1],
        "Beijing China current weather forecast today AccuWeather"
    );
    assert_eq!(assistant["blocks"][2]["tool_name"], "web_search");
    assert_eq!(assistant["blocks"][2]["tool_input"]["type"], "open_page");
    assert_eq!(
        assistant["blocks"][2]["tool_input"]["url"],
        "https://www.weather.com/weather/today/l/Beijing+China"
    );
}

#[tokio::test]
async fn runtime_transcript_keeps_interrupted_commentary_visible() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-interrupted-commentary-home", "dir")
            .display()
            .to_string(),
    );
    let fake_codex = write_fake_interrupted_commentary_codex(&temp_path(
        "runtime-interrupted-commentary-log",
        "jsonl",
    ));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let transcript = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "workspacePath": "/tmp/project",
                "localTaskId": "thread-1",
                "runtimeHandle": {"threadId": "thread-1"}
            }
        }))
        .await
        .expect("transcript should succeed");

    assert_eq!(transcript["success"], true);
    let interrupted = &transcript["messages"][1];
    assert_eq!(interrupted["role"], "assistant");
    assert_eq!(
        interrupted["content"],
        "I will inspect the repository.\n\nThe split is in the skill docs."
    );
    assert!(interrupted["blocks"].as_array().unwrap().is_empty());

    let completed = &transcript["messages"][3];
    assert_eq!(completed["role"], "assistant");
    assert_eq!(completed["content"], "Done");
    assert_eq!(completed["blocks"].as_array().unwrap().len(), 1);
    assert_eq!(completed["blocks"][0]["type"], "text");
    assert_eq!(completed["blocks"][0]["content"], "Editing files.");
}

#[tokio::test]
async fn runtime_transcript_merges_multiple_codex_file_change_items_in_one_turn() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-merged-file-changes-home", "dir")
            .display()
            .to_string(),
    );
    let fake_codex =
        write_fake_multi_patch_codex(&temp_path("runtime-merged-file-changes-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let transcript = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "workspacePath": "/tmp/project",
                "localTaskId": "thread-1",
                "runtimeHandle": {"threadId": "thread-1"}
            }
        }))
        .await
        .expect("transcript should succeed");

    assert_eq!(transcript["success"], true);
    let assistant = &transcript["messages"][1];
    assert_eq!(assistant["role"], "assistant");
    assert_eq!(assistant["content"], "Done");
    assert_eq!(assistant["fileChanges"]["file_count"], 4);
    assert_eq!(assistant["fileChanges"]["additions"], 69);
    assert_eq!(assistant["fileChanges"]["deletions"], 18);
    assert_eq!(assistant["fileChanges"]["files"][0]["path"], "SKILL.md");
    assert_eq!(
        assistant["fileChanges"]["files"][1]["path"],
        "references/acceptance-validation-contract.md"
    );
    assert_eq!(
        assistant["fileChanges"]["files"][2]["path"],
        "references/pr-review-notification.md"
    );
    assert_eq!(
        assistant["fileChanges"]["files"][3]["path"],
        "scripts/notify_pr_ready.sh"
    );
    assert!(assistant["fileChanges"]["diff"]
        .as_str()
        .unwrap()
        .contains("scripts/notify_pr_ready.sh"));
    let blocks = assistant["blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 4);
    assert!(blocks.iter().all(|block| block["type"] == "file_changes"));
    assert_eq!(
        blocks[3]["file_changes"]["files"][0]["path"],
        "scripts/notify_pr_ready.sh"
    );
}

#[tokio::test]
async fn runtime_transcript_accumulates_codex_file_changes_and_uses_move_target_path() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-accumulated-file-changes-home", "dir")
            .display()
            .to_string(),
    );
    let fake_codex = write_fake_accumulated_file_changes_codex(&temp_path(
        "runtime-accumulated-file-changes-log",
        "jsonl",
    ));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let transcript = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "workspacePath": "/tmp/project",
                "localTaskId": "thread-1",
                "runtimeHandle": {"threadId": "thread-1"}
            }
        }))
        .await
        .expect("transcript should succeed");

    assert_eq!(transcript["success"], true);
    let assistant = &transcript["messages"][1];
    assert_eq!(assistant["fileChanges"]["file_count"], 6);
    assert_eq!(assistant["fileChanges"]["additions"], 35);
    assert_eq!(assistant["fileChanges"]["deletions"], 39);
    assert_eq!(assistant["fileChanges"]["files"][0]["path"], "SKILL.md");
    assert_eq!(assistant["fileChanges"]["files"][0]["additions"], 3);
    assert_eq!(assistant["fileChanges"]["files"][0]["deletions"], 4);
    let files = assistant["fileChanges"]["files"].as_array().unwrap();
    let start_new = files
        .iter()
        .find(|file| file["path"] == "scripts/start_new.sh")
        .expect("renamed script should use the move target path");
    assert_eq!(start_new["old_path"], "scripts/start_old.sh");
    let new_reference = files
        .iter()
        .find(|file| file["path"] == "references/new.md")
        .expect("renamed reference should use the move target path");
    assert_eq!(new_reference["old_path"], "references/old.md");
    let deleted_script = files
        .iter()
        .find(|file| file["path"] == "scripts/delete.sh")
        .expect("deleted script should be present");
    assert_eq!(deleted_script["path"], "scripts/delete.sh");
    assert_eq!(deleted_script["deletions"], 3);
}

fn write_fake_interrupted_commentary_codex(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-interrupted-commentary", "sh");
    let _ = fs::remove_file(log_path);
    let response = json!({
        "id": 2,
        "result": {
            "thread": {
                "id": "thread-1",
                "cwd": "/tmp/project",
                "name": "Interrupted commentary",
                "preview": "inspect",
                "path": "/tmp/codex/thread-1.jsonl",
                "createdAt": 1780000000_i64,
                "updatedAt": 1780000300_i64,
                "status": "idle",
                "turns": [
                    {
                        "id": "turn-interrupted",
                        "status": "interrupted",
                        "startedAt": 1780000000_i64,
                        "durationMs": 108000_i64,
                        "items": [
                            {
                                "id": "user-1",
                                "type": "userMessage",
                                "content": [{"type": "text", "text": "inspect"}],
                            },
                            {
                                "id": "agent-progress-1",
                                "type": "agentMessage",
                                "text": "I will inspect the repository.",
                                "phase": "commentary",
                            },
                            {
                                "id": "agent-progress-2",
                                "type": "agentMessage",
                                "text": "The split is in the skill docs.",
                                "phase": "commentary",
                            },
                        ],
                    },
                    {
                        "id": "turn-completed",
                        "status": "completed",
                        "startedAt": 1780000200_i64,
                        "durationMs": 3000_i64,
                        "items": [
                            {
                                "id": "user-2",
                                "type": "userMessage",
                                "content": [{"type": "text", "text": "edit"}],
                            },
                            {
                                "id": "agent-progress-3",
                                "type": "agentMessage",
                                "text": "Editing files.",
                                "phase": "commentary",
                            },
                            {
                                "id": "agent-final",
                                "type": "agentMessage",
                                "text": "Done",
                                "phase": "final_answer",
                            },
                        ],
                    },
                ],
            },
        },
    });
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":1,"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/read"'*)
      printf '%s\n' {}
      exit 0
      ;;
  esac
done
"#,
        log_path.display(),
        shell_single_quote(&response.to_string()),
    );
    fs::write(&path, content).unwrap();
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn write_fake_file_change_codex(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-file-change-item", "sh");
    let _ = fs::remove_file(log_path);
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":1,"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/read"'*)
      printf '%s\n' '{{"id":2,"result":{{"thread":{{"id":"thread-1","cwd":"/tmp/project","name":"File change transcript","preview":"edit","path":"/tmp/codex/thread-1.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[{{"id":"turn-file-change","createdAt":1780000000,"items":[{{"id":"user-1","type":"userMessage","content":[{{"type":"text","text":"edit"}}]}},{{"id":"agent-progress","type":"agentMessage","text":"Editing.","phase":"commentary"}},{{"id":"call-1","type":"fileChange","changes":[{{"path":"/tmp/project/references/github-pr-flow.md","kind":{{"type":"update","move_path":null}},"diff":"@@ -1 +1 @@\n-old\n+new\n"}}],"status":"completed"}},{{"id":"agent-1","type":"agentMessage","text":"Done","phase":"final_answer"}}]}}]}}}}}}'
      exit 0
      ;;
  esac
done
"#,
        log_path.display()
    );
    fs::write(&path, content).unwrap();
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn write_fake_codex(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-file-changes", "sh");
    let _ = fs::remove_file(log_path);
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":1,"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/read"'*)
      printf '%s\n' '{{"id":2,"result":{{"thread":{{"id":"thread-1","cwd":"/tmp/project","name":"Edit files","preview":"edit","path":"/tmp/codex/thread-1.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[{{"id":"turn-1","createdAt":1780000000,"items":[{{"id":"user-1","type":"userMessage","content":[{{"type":"text","text":"edit files"}}]}},{{"id":"agent-1","type":"agentMessage","text":"Edited files","phase":"final_answer","fileChanges":{{"version":1,"status":"active","artifact_id":"artifact-1","device_id":"device-1","workspace_path":"/tmp/project","file_count":1,"additions":6,"deletions":4,"files":[{{"path":"src/runtime_work.rs","change_type":"modified","additions":6,"deletions":4,"binary":false}}],"reverted_at":null}}}}]}}]}}}}}}'
      exit 0
      ;;
  esac
done
"#,
        log_path.display()
    );
    fs::write(&path, content).unwrap();
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn write_fake_multi_patch_codex(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-multi-patch-transcript", "sh");
    let _ = fs::remove_file(log_path);
    let response = json!({
        "id": 2,
        "result": {
            "thread": {
                "id": "thread-1",
                "cwd": "/tmp/project",
                "name": "Merged file changes",
                "preview": "edit",
                "path": "/tmp/codex/thread-1.jsonl",
                "createdAt": 1780000000_i64,
                "updatedAt": 1780000060_i64,
                "status": "idle",
                "turns": [{
                    "id": "turn-merged",
                    "createdAt": 1780000000_i64,
                    "items": [
                        {
                            "id": "user-1",
                            "type": "userMessage",
                            "content": [{"type": "text", "text": "edit files"}],
                        },
                        patch_apply_item(
                            "patch-1",
                            "SKILL.md",
                            counted_diff("SKILL.md", 5, 3),
                        ),
                        patch_apply_item(
                            "patch-2",
                            "references/acceptance-validation-contract.md",
                            counted_diff("references/acceptance-validation-contract.md", 16, 2),
                        ),
                        patch_apply_item(
                            "patch-3",
                            "references/pr-review-notification.md",
                            counted_diff("references/pr-review-notification.md", 12, 8),
                        ),
                        patch_apply_item(
                            "patch-4",
                            "scripts/notify_pr_ready.sh",
                            counted_diff("scripts/notify_pr_ready.sh", 36, 5),
                        ),
                        {
                            "id": "agent-1",
                            "type": "agentMessage",
                            "text": "Done",
                            "phase": "final_answer",
                        },
                    ],
                }],
            },
        },
    });
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":1,"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/read"'*)
      printf '%s\n' {}
      exit 0
      ;;
  esac
done
"#,
        log_path.display(),
        shell_single_quote(&response.to_string()),
    );
    fs::write(&path, content).unwrap();
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn write_fake_accumulated_file_changes_codex(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-accumulated-file-changes", "sh");
    let _ = fs::remove_file(log_path);
    let response = json!({
        "id": 2,
        "result": {
            "thread": {
                "id": "thread-1",
                "cwd": "/tmp/project",
                "name": "Accumulated file changes",
                "preview": "edit",
                "path": "/tmp/codex/thread-1.jsonl",
                "createdAt": 1780000000_i64,
                "updatedAt": 1780000060_i64,
                "status": "idle",
                "turns": [{
                    "id": "turn-accumulated",
                    "createdAt": 1780000000_i64,
                    "items": [
                        {
                            "id": "user-1",
                            "type": "userMessage",
                            "content": [{"type": "text", "text": "edit files"}],
                        },
                        {
                            "id": "change-1",
                            "type": "fileChange",
                            "status": "completed",
                            "changes": [
                                {
                                    "path": "/tmp/project/SKILL.md",
                                    "kind": {"type": "update", "move_path": null},
                                    "diff": counted_diff("SKILL.md", 2, 1),
                                },
                                {
                                    "path": "/tmp/project/scripts/start_old.sh",
                                    "kind": {"type": "update", "move_path": null},
                                    "diff": counted_diff("scripts/start_old.sh", 5, 4),
                                },
                                {
                                    "path": "/tmp/project/references/old.md",
                                    "kind": {"type": "update", "move_path": null},
                                    "diff": counted_diff("references/old.md", 22, 23),
                                },
                            ],
                        },
                        {
                            "id": "change-2",
                            "type": "fileChange",
                            "status": "completed",
                            "changes": [
                                {
                                    "path": "/tmp/project/SKILL.md",
                                    "kind": {"type": "update", "move_path": null},
                                    "diff": counted_diff("SKILL.md", 1, 3),
                                },
                                {
                                    "path": "/tmp/project/scripts/start_old.sh",
                                    "kind": {
                                        "type": "update",
                                        "move_path": "/tmp/project/scripts/start_new.sh",
                                    },
                                    "diff": counted_diff("scripts/start_new.sh", 1, 1),
                                },
                                {
                                    "path": "/tmp/project/references/old.md",
                                    "kind": {
                                        "type": "update",
                                        "move_path": "/tmp/project/references/new.md",
                                    },
                                    "diff": "",
                                },
                            ],
                        },
                        {
                            "id": "change-3",
                            "type": "fileChange",
                            "status": "completed",
                            "changes": [
                                {
                                    "path": "/tmp/project/references/new.md",
                                    "kind": {"type": "update", "move_path": null},
                                    "diff": counted_diff("references/new.md", 4, 4),
                                },
                                {
                                    "path": "/tmp/project/scripts/delete.sh",
                                    "kind": {"type": "delete"},
                                    "diff": "one\n\ntwo",
                                },
                            ],
                        },
                        {
                            "id": "agent-1",
                            "type": "agentMessage",
                            "text": "Done",
                            "phase": "final_answer",
                        },
                    ],
                }],
            },
        },
    });
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":1,"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/read"'*)
      printf '%s\n' {}
      exit 0
      ;;
  esac
done
"#,
        log_path.display(),
        shell_single_quote(&response.to_string()),
    );
    fs::write(&path, content).unwrap();
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn patch_apply_item(id: &str, path: &str, diff: String) -> serde_json::Value {
    json!({
        "id": id,
        "type": "patch_apply_end",
        "success": true,
        "changes": {
            path: {
                "type": "update",
                "unified_diff": diff,
                "move_path": null,
            },
        },
    })
}

fn counted_diff(path: &str, additions: usize, deletions: usize) -> String {
    let mut lines = vec![
        format!("diff --git a/{path} b/{path}"),
        "@@ -1 +1 @@".to_owned(),
    ];
    for index in 1..=deletions {
        lines.push(format!("-old {index}"));
    }
    for index in 1..=additions {
        lines.push(format!("+new {index}"));
    }
    lines.join("\n")
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn write_fake_rich_codex(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-rich-transcript", "sh");
    let _ = fs::remove_file(log_path);
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":1,"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/read"'*)
      printf '%s\n' '{{"id":2,"result":{{"thread":{{"id":"thread-1","cwd":"/tmp/project","name":"Rich transcript","preview":"rich","path":"/tmp/codex/thread-1.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[{{"id":"turn-rich","startedAt":1780000000,"durationMs":7000,"items":[{{"id":"user-1","type":"userMessage","content":[{{"type":"text","text":"inspect"}}]}},{{"id":"reason-1","type":"reasoning","summary":["thinking"]}},{{"id":"agent-progress","type":"agentMessage","text":"I checked the files.","phase":"analysis"}},{{"type":"function_call","name":"exec_command","arguments":"{{\"cmd\":\"rg -n test\"}}","call_id":"call-1"}},{{"type":"function_call_output","call_id":"call-1","output":"ok"}},{{"id":"patch-1","type":"patch_apply_end","success":true,"changes":{{"/tmp/project/src/lib.rs":{{"type":"update","unified_diff":"@@ -1 +1 @@\n-old\n+new\n","move_path":null}}}}}},{{"type":"event_msg","payload":{{"id":"ctx-1","type":"context_compacted"}}}},{{"id":"agent-1","type":"agentMessage","text":"Done","phase":"final_answer","memoryCitation":{{"entries":[{{"path":"MEMORY.md","lineStart":1,"lineEnd":2,"note":"note"}}],"threadIds":["thread-a"]}}}}]}}]}}}}}}'
      exit 0
      ;;
  esac
done
"#,
        log_path.display()
    );
    fs::write(&path, content).unwrap();
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn write_fake_web_search_codex(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-web-search-transcript", "sh");
    let _ = fs::remove_file(log_path);
    let response = json!({
        "id": 2,
        "result": {
            "thread": {
                "id": "thread-1",
                "cwd": "/tmp/project",
                "name": "Web search transcript",
                "preview": "search",
                "path": "/tmp/codex/thread-1.jsonl",
                "createdAt": 1780000000_i64,
                "updatedAt": 1780000060_i64,
                "status": "idle",
                "turns": [{
                    "id": "turn-web-search",
                    "createdAt": 1780000000_i64,
                    "items": [
                        {
                            "id": "user-1",
                            "type": "userMessage",
                            "content": [{"type": "text", "text": "weather"}],
                        },
                        {
                            "id": "agent-progress",
                            "type": "agentMessage",
                            "text": "I will search the web.",
                            "phase": "analysis",
                        },
                        {
                            "id": "web-search-1",
                            "type": "web_search_call",
                            "status": "completed",
                            "action": {
                                "type": "search",
                                "query": "Beijing weather today June 17 2026 temperature rain",
                                "queries": [
                                    "Beijing weather today June 17 2026 temperature rain",
                                    "Beijing China current weather forecast today AccuWeather",
                                ],
                            },
                        },
                        {
                            "id": "web-open-1",
                            "type": "web_search_call",
                            "status": "completed",
                            "action": {
                                "type": "open_page",
                                "url": "https://www.weather.com/weather/today/l/Beijing+China",
                            },
                        },
                        {
                            "id": "agent-1",
                            "type": "agentMessage",
                            "text": "Done",
                            "phase": "final_answer",
                        },
                    ],
                }],
            },
        },
    });
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":1,"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/read"'*)
      printf '%s\n' {}
      exit 0
      ;;
  esac
done
"#,
        log_path.display(),
        shell_single_quote(&response.to_string()),
    );
    fs::write(&path, content).unwrap();
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn temp_path(prefix: &str, extension: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!(
        "{prefix}-{}-{nanos}.{extension}",
        std::process::id(),
    ))
}
