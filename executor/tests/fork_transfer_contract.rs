// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};
use wegent_executor::runtime_work::fork_transfer::{
    archive_upload_plan, candidate_hosts, direct_archive_urls, direct_transfer_bind_host,
    home_relative_session_paths, inherited_sessions_from_fork_runtime, parse_archive_metadata,
    safe_untracked_member_path, select_inherited_claude_session, select_inherited_codex_thread,
    transfer_proof, validate_import_fork_payload, validate_prepare_transfer_payload,
    ArchiveMetadata, ArchiveRestorePlan, CodexThreadState, PrepareArchiveTransferRequest,
    RuntimeForkArchive,
};

#[test]
fn direct_transfer_bind_host_defaults_to_all_interfaces() {
    assert_eq!(direct_transfer_bind_host(None), "0.0.0.0");
    assert_eq!(direct_transfer_bind_host(Some(" 127.0.0.1 ")), "127.0.0.1");
}

#[test]
fn candidate_hosts_use_backend_supplied_hosts_without_guessing() {
    let direct_hosts = vec![
        "10.0.0.11".to_owned(),
        "10.0.0.11".to_owned(),
        " 127.0.0.1 ".to_owned(),
    ];

    assert_eq!(
        candidate_hosts("0.0.0.0", Some(&direct_hosts), None, None),
        vec!["10.0.0.11".to_owned(), "127.0.0.1".to_owned()]
    );

    let empty: Vec<String> = Vec::new();
    assert!(candidate_hosts("0.0.0.0", Some(&empty), Some("10.0.0.99"), None).is_empty());
}

#[test]
fn direct_archive_urls_use_backend_hosts_without_token_and_include_peer_proof() {
    let direct_hosts = vec!["10.0.0.11".to_owned()];

    let urls = direct_archive_urls(
        "transfer-1",
        "0.0.0.0",
        34567,
        Some(&direct_hosts),
        None,
        None,
    );

    assert_eq!(
        urls,
        vec!["http://10.0.0.11:34567/runtime-task-transfers/transfer-1".to_owned()]
    );
    assert!(!urls[0].contains("token="));
    assert_eq!(
        transfer_proof("transfer-1", "secret-token"),
        "558e852f9c177c8353b9cfdfc1a1e364dd6971b122ed01807a2e71209bace6d3"
    );
}

#[test]
fn git_patch_archive_metadata_requires_base_commit_and_builds_restore_plan() {
    let metadata = parse_archive_metadata(&json!({
        "type": "git_patch",
        "baseCommit": "abc123",
        "sourceHead": "def456",
        "workspacePathspec": "."
    }))
    .expect("metadata should parse");

    match &metadata {
        ArchiveMetadata::GitPatch(git_patch) => {
            assert_eq!(git_patch.base_commit, "abc123");
            assert_eq!(git_patch.source_head.as_deref(), Some("def456"));
        }
        ArchiveMetadata::SessionOnly => panic!("expected git patch metadata"),
    }

    let plan = ArchiveRestorePlan::from_metadata(&metadata, 42).expect("plan should build");
    assert_eq!(plan.base_commit.as_deref(), Some("abc123"));
    assert!(plan.checkout_base_commit);
    assert!(plan.apply_patch);
    assert!(plan.extract_untracked_overlay);

    let error = parse_archive_metadata(&json!({"type": "git_patch"})).unwrap_err();
    assert_eq!(error.code(), "missing_base_commit");
}

#[test]
fn git_patch_restore_overlay_accepts_only_safe_untracked_members() {
    assert_eq!(
        safe_untracked_member_path("runtime-fork/untracked/notes.txt"),
        Some(PathBuf::from("notes.txt"))
    );
    assert_eq!(
        safe_untracked_member_path("runtime-fork/untracked/frontend/node_modules/pkg/index.js"),
        None
    );
    assert_eq!(
        safe_untracked_member_path("runtime-fork/untracked/../secrets.txt"),
        None
    );
    assert_eq!(safe_untracked_member_path("workspace/.git/config"), None);
}

#[test]
fn session_archive_paths_include_only_explicit_home_members() {
    let home = unique_dir("fork-transfer-home-paths");
    let session_path = home.join(".codex/sessions/2026/thread.jsonl");
    let duplicate_session_path = home.join(".codex/sessions/2026/thread.jsonl");
    let other_home = unique_dir("fork-transfer-other-home");
    let other_session_path = other_home.join(".codex/sessions/2026/other.jsonl");
    let excluded_path = home.join(".codex/sessions/2026/node_modules/pkg/index.js");

    let relative_paths = home_relative_session_paths(
        &home,
        &[
            session_path,
            duplicate_session_path,
            other_session_path,
            excluded_path,
        ],
    );

    assert_eq!(
        relative_paths,
        vec![".codex/sessions/2026/thread.jsonl".to_owned()]
    );
}

#[test]
fn session_only_codex_state_restore_rewrites_home_and_workspace() {
    let source_state = CodexThreadState::from_value(&json!({
        "threadId": "thread-1",
        "rolloutRelativePath": ".codex/sessions/2026/thread.jsonl",
        "thread": {
            "id": "thread-1",
            "cwd": "/source/workspace",
            "rollout_path": "/source-home/.codex/sessions/2026/thread.jsonl",
            "title": "hi"
        },
        "threadDynamicTools": [{
            "thread_id": "thread-1",
            "position": 0,
            "name": "tool",
            "description": "desc",
            "input_schema": "{}",
            "defer_loading": 0
        }]
    }))
    .expect("codex state should parse");

    let plan = source_state.restore_plan(Path::new("/target/workspace"), Path::new("/target-home"));

    assert_eq!(plan.thread["id"], "thread-1");
    assert_eq!(plan.thread["cwd"], "/target/workspace");
    assert_eq!(
        plan.thread["rollout_path"],
        "/target-home/.codex/sessions/2026/thread.jsonl"
    );
    assert_eq!(plan.thread_dynamic_tools[0]["thread_id"], "thread-1");
    assert_eq!(plan.thread_dynamic_tools[0]["name"], "tool");
}

#[test]
fn fork_runtime_extracts_deduped_inherited_sessions() {
    let fork_runtime = json!({
        "sessions": [
            {
                "agent": "CodeX",
                "sourceTaskId": 100,
                "botId": 654,
                "threadId": "codex-thread"
            },
            {
                "agent": "CodeX",
                "botId": 654,
                "threadId": "codex-thread"
            },
            {
                "agent": "ClaudeCode",
                "botId": "987",
                "sessionId": "claude-session"
            },
            "ignore-me",
            {"agent": "CodeX"}
        ]
    });

    let sessions = inherited_sessions_from_fork_runtime(&fork_runtime);

    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0].agent, "CodeX");
    assert_eq!(sessions[0].source_task_id, Some(100));
    assert_eq!(
        sessions[0].bot_id.as_ref().and_then(Value::as_i64),
        Some(654)
    );
    assert_eq!(sessions[0].thread_id.as_deref(), Some("codex-thread"));
    assert_eq!(sessions[1].agent, "ClaudeCode");
    assert_eq!(sessions[1].session_id.as_deref(), Some("claude-session"));
}

#[test]
fn inherited_session_selection_respects_agent_bot_existing_session_and_new_session() {
    let sessions = inherited_sessions_from_fork_runtime(&json!({
        "sessions": [
            {"agent": "ClaudeCode", "botId": 987, "sessionId": "source-claude-session"},
            {"agent": "CodeX", "botId": 654, "threadId": "source-codex-thread"},
            {"agent": "CodeX", "botId": 999, "threadId": "wrong-bot-thread"}
        ]
    }));

    let claude = select_inherited_claude_session(&sessions, Some(987), false, false)
        .expect("Claude session should be selected");
    let codex = select_inherited_codex_thread(&sessions, Some(654), false, false)
        .expect("Codex thread should be selected");

    assert_eq!(claude.session_id.as_deref(), Some("source-claude-session"));
    assert_eq!(codex.thread_id.as_deref(), Some("source-codex-thread"));
    assert!(select_inherited_claude_session(&sessions, Some(987), true, false).is_none());
    assert!(select_inherited_codex_thread(&sessions, Some(654), false, true).is_none());
    assert!(
        select_inherited_codex_thread(&sessions, Some(999), false, false)
            .expect("bot-specific thread should still be selectable")
            .thread_id
            .as_deref()
            == Some("wrong-bot-thread")
    );
}

#[test]
fn imported_runtime_handle_appends_executor_session_to_execution_request_once() {
    let fork_package = json!({
        "sourceRuntime": "claude",
        "runtimeHandle": {
            "executionRequest": {
                "new_session": true,
                "inherited_sessions": [{"agent": "CodeX", "threadId": "existing"}]
            }
        },
        "executorSession": {
            "agent": "ClaudeCode",
            "botId": 987,
            "sessionId": "source-claude-session"
        },
        "recentMessages": [
            {"role": "user", "content": "hello"},
            "ignore-me"
        ]
    });

    let handle =
        wegent_executor::runtime_work::fork_transfer::build_imported_runtime_handle(&fork_package)
            .expect("runtime handle should build");

    assert_eq!(
        handle["executorSession"]["sessionId"],
        "source-claude-session"
    );
    assert_eq!(handle["executionRequest"]["new_session"], false);
    assert_eq!(
        handle["executionRequest"]["inherited_sessions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(handle["messages"].as_array().unwrap().len(), 1);

    let second =
        wegent_executor::runtime_work::fork_transfer::build_imported_runtime_handle(&json!({
            "runtimeHandle": handle,
            "executorSession": {
                "agent": "ClaudeCode",
                "botId": 987,
                "sessionId": "source-claude-session"
            }
        }))
        .expect("runtime handle should remain idempotent");
    assert_eq!(
        second["executionRequest"]["inherited_sessions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn payload_validation_and_transfer_retry_archive_merge_match_rpc_contracts() {
    let prepare = validate_prepare_transfer_payload(&json!({
        "transferId": "transfer-1",
        "uploadUrl": "https://storage/upload",
        "workspaceTransfer": "git_workspace",
        "directHosts": [" 10.0.0.11 ", 42, "", "10.0.0.12"]
    }))
    .expect("prepare payload should validate");
    assert_eq!(prepare.transfer_id, "transfer-1");
    assert_eq!(
        prepare.upload_url.as_deref(),
        Some("https://storage/upload")
    );
    assert_eq!(prepare.workspace_transfer.as_deref(), Some("git_workspace"));
    assert_eq!(
        prepare.direct_hosts,
        Some(vec!["10.0.0.11".to_owned(), "10.0.0.12".to_owned()])
    );

    let import = validate_import_fork_payload(&json!({
        "source": {
            "deviceId": "source-device",
            "workspacePath": "/source/Wegent",
            "taskId": "codex-1"
        },
        "workspacePath": "/target/Wegent",
        "forkPackage": {
            "sourceRuntime": "codex",
            "archive": {"directUrls": ["http://source/archive"]}
        }
    }))
    .expect("import payload should validate");
    assert_eq!(import.source.local_task_id, "codex-1");
    assert_eq!(import.workspace_path, "/target/Wegent");

    let archive = RuntimeForkArchive::from_value(&json!({
        "mode": "git_workspace",
        "directUrls": ["http://source/archive"]
    }))
    .expect("archive should parse");
    assert!(archive.requires_restore());
    let retried = archive
        .with_local_transfer_id("receiver-transfer-1")
        .expect("local transfer should merge");
    assert_eq!(
        retried.local_transfer_id.as_deref(),
        Some("receiver-transfer-1")
    );
    assert_eq!(
        retried.direct_urls,
        vec!["http://source/archive".to_owned()]
    );
    assert_eq!(
        retried
            .with_local_transfer_id("receiver-transfer-1")
            .expect("same transfer id is idempotent")
            .local_transfer_id
            .as_deref(),
        Some("receiver-transfer-1")
    );
    assert_eq!(
        retried
            .with_local_transfer_id("receiver-transfer-2")
            .unwrap_err()
            .code(),
        "conflicting_transfer"
    );
}

#[tokio::test]
async fn prepare_archive_transfer_runs_archive_creation_off_event_loop() {
    let archive_path = unique_dir("fork-transfer-archive").join("archive.tar.gz");
    let seen_threads = Arc::new(Mutex::new(Vec::new()));
    let main_thread = thread::current().id();
    let seen_threads_for_closure = Arc::clone(&seen_threads);
    let archive_path_for_closure = archive_path.clone();

    let prepared = wegent_executor::runtime_work::fork_transfer::prepare_archive_transfer_with(
        PrepareArchiveTransferRequest {
            workspace_path: "/workspace".to_owned(),
            transfer_id: "transfer-1".to_owned(),
            session_paths: vec!["/home/.codex/session.jsonl".to_owned()],
            direct_hosts: Some(vec!["127.0.0.1".to_owned()]),
            include_workspace: true,
            codex_thread_id: Some("thread-1".to_owned()),
        },
        move |_request| {
            seen_threads_for_closure
                .lock()
                .unwrap()
                .push(thread::current().id());
            thread::sleep(std::time::Duration::from_millis(25));
            fs::create_dir_all(archive_path_for_closure.parent().unwrap()).unwrap();
            fs::write(&archive_path_for_closure, b"archive").unwrap();
            Ok(archive_path_for_closure)
        },
        |_transfer_id, _archive_path, token, _direct_hosts| {
            assert_eq!(token, "direct-token");
            vec!["http://127.0.0.1/archive".to_owned()]
        },
        "direct-token".to_owned(),
    )
    .await
    .expect("transfer should prepare");

    assert_eq!(prepared.archive_path, archive_path);
    assert_eq!(
        prepared.direct_urls,
        vec!["http://127.0.0.1/archive".to_owned()]
    );
    assert_eq!(prepared.direct_token, "direct-token");
    assert_eq!(prepared.size_bytes, 7);
    assert_ne!(seen_threads.lock().unwrap()[0], main_thread);
}

#[test]
fn archive_upload_plan_streams_chunks_with_content_length() {
    let plan = archive_upload_plan(1_048_579, None);

    assert_eq!(plan.headers["Content-Type"], "application/gzip");
    assert_eq!(plan.headers["Content-Length"], "1048579");
    assert_eq!(plan.chunk_sizes, vec![1_048_576, 3]);
}

fn unique_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("{label}-{nanos}"))
}
