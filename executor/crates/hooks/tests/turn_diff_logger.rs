// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use serde_json::{json, Value};
use tempfile::tempdir;
use wegent_executor_test_support as _;
use wegent_hooks::{
    host::HookService,
    model::{HookEventName, HookHealth, HookRunStatus, HookUser, TurnCompletedInput},
    registry::HookRegistryStore,
};
use wegent_workspace::turn_file_changes::{GitTurnRange, GitTurnSnapshot};

const ADDED_LINE: &str = "完整代码🙂0123456789\n";
const ADDED_LINES: u64 = 350_000;

fn example() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/hooks/turn-diff-logger")
}

fn init_git(workspace: &Path) {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(key);
        }
    }
    let output = command
        .args(["-c", "commit.gpgsign=false", "-C"])
        .arg(workspace)
        .args(["init", "--quiet", "--template="])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn payload(workspace: &Path, turn_id: &str) -> TurnCompletedInput {
    TurnCompletedInput {
        event_id: String::new(),
        sequence: 0,
        user: HookUser {
            id: Some("7".to_owned()),
            name: "本地用户🙂".to_owned(),
        },
        session_id: "session-1".to_owned(),
        turn_id: turn_id.to_owned(),
        cwd: workspace.to_path_buf(),
        hook_event_name: HookEventName::TurnCompleted,
        model: Some("codex".to_owned()),
        permission_mode: "workspace-write".to_owned(),
        status: "completed".to_owned(),
        file_changes: json!({"version": 2, "workspace_path": workspace,
            "status": "active", "file_count": 0, "additions": 0, "deletions": 0}),
    }
}

fn large_git_range(workspace: &Path) -> GitTurnRange {
    let source = workspace.join("代码.rs");
    fs::write(&source, "old\n").unwrap();
    let before = GitTurnSnapshot::capture(workspace).unwrap().unwrap();
    let mut output = BufWriter::new(fs::File::create(&source).unwrap());
    for _ in 0..ADDED_LINES {
        output.write_all(ADDED_LINE.as_bytes()).unwrap();
    }
    output.flush().unwrap();
    assert!(fs::metadata(source).unwrap().len() > 8 * 1024 * 1024);
    before.freeze().unwrap()
}

fn assert_large_archive(directory: &Path, changes: &Value) {
    assert_eq!(changes["version"], 2);
    assert_eq!(changes["file_count"], 1);
    assert_eq!(changes["additions"], ADDED_LINES);
    assert_eq!(changes["deletions"], 1);
    assert!(changes.get("diff").is_none());
    assert!(changes.get("files").is_none());
    let patch = directory.join("diff.patch");
    assert_eq!(
        fs::metadata(&patch).unwrap().len(),
        changes["diff_artifact"]["size_bytes"].as_u64().unwrap()
    );
    assert!(fs::metadata(&patch).unwrap().len() > 8 * 1024 * 1024);
    let expected = format!("+{}", ADDED_LINE.trim_end_matches('\n'));
    let mut additions = 0;
    let mut removed_old = false;
    for line in BufReader::new(fs::File::open(patch).unwrap()).lines() {
        let line = line.unwrap();
        if line == expected {
            additions += 1;
        }
        if line == "-old" {
            removed_old = true;
        }
    }
    assert_eq!(additions, ADDED_LINES);
    assert!(removed_old);
    let files = fs::read_to_string(directory.join("files.jsonl")).unwrap();
    let entries: Vec<Value> = files
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["path"], "代码.rs");
    assert_eq!(entries[0]["additions"], ADDED_LINES);
    assert_eq!(entries[0]["deletions"], 1);
}

async fn flush(service: &HookService) {
    tokio::time::timeout(Duration::from_secs(30), service.flush_turn_hooks())
        .await
        .expect("turn logger queue did not finish")
        .expect("turn logger queue failed");
}

#[test]
fn example_logger_node_tests_are_part_of_the_cargo_suite() {
    let output = Command::new("node")
        .arg("--test")
        .arg(example().join("logger.test.mjs"))
        .output()
        .expect("Node.js 18+ must be available for the turn-diff-logger example tests");
    assert!(
        output.status.success(),
        "Node logger tests failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn installed_example_archives_full_git_artifacts_and_error_events_from_the_durable_queue() {
    let fixture = tempdir().unwrap();
    let executor_home = fixture.path().join("executor home with spaces");
    let workspace = fixture.path().join("workspace with spaces");
    let log_directory = fixture.path().join("日志 output with spaces");
    fs::create_dir_all(&workspace).unwrap();
    init_git(&workspace);
    let nested_cwd = workspace.join("src");
    fs::create_dir(&nested_cwd).unwrap();
    let registry = HookRegistryStore::new(executor_home.clone());
    let plugin = registry.install(&example()).unwrap();
    assert_eq!(plugin.manifest.id, "turn-diff-logger");
    assert_eq!(plugin.health, HookHealth::Ready);
    assert_eq!(plugin.handlers.len(), 1);
    assert_eq!(plugin.handlers[0].event_name, HookEventName::TurnCompleted);
    assert!(plugin.handlers[0].config.asynchronous);
    assert_eq!(plugin.handlers[0].config.command, "./bin/log-turn.mjs");
    assert_eq!(
        plugin.handlers[0].config.command_windows.as_deref(),
        Some("./bin/log-turn.cmd")
    );
    fs::write(
        plugin.install_path.join("config.json"),
        serde_json::to_vec(&json!({"logDirectory": log_directory})).unwrap(),
    )
    .unwrap();
    let service = HookService::new(registry, executor_home.join("codex"));
    let capture_workspace = workspace.clone();
    let range = tokio::task::spawn_blocking(move || large_git_range(&capture_workspace))
        .await
        .unwrap();
    let mut logged_paths = Vec::new();
    let mut previous_sequence = 0;
    for turn_id in ["turn-1", "turn-2"] {
        let mut input = payload(&workspace, turn_id);
        if turn_id == "turn-2" {
            input.cwd = nested_cwd.clone();
            input.status = "failed".to_owned();
            input.file_changes = json!({"version": 2, "status": "error",
                "file_count": 0, "additions": 0, "deletions": 0, "error": "Git capture failed"});
        }
        let receipt = service
            .enqueue_turn_completed(
                input.clone(),
                if turn_id == "turn-1" {
                    Some(range.clone())
                } else {
                    None
                },
            )
            .await
            .unwrap();
        assert_eq!(receipt.queued_handlers, 1);
        assert!(receipt.sequence > previous_sequence);
        previous_sequence = receipt.sequence;
        input.event_id = receipt.event_id.clone();
        input.sequence = receipt.sequence;
        flush(&service).await;
        let plugins = service.list();
        let plugin = plugins
            .iter()
            .find(|plugin| plugin.manifest.id == "turn-diff-logger")
            .unwrap();
        let run = &plugin.recent_runs[0];
        assert_eq!(run.status, HookRunStatus::Succeeded, "{run:?}");
        assert!(!run.stdout_truncated);
        assert!(run.stderr_preview.is_empty(), "{run:?}");
        let result: Value = serde_json::from_str(&run.stdout_preview).unwrap();
        assert_eq!(result["logged"], true);
        assert_eq!(result["deduplicated"], false);
        let path = PathBuf::from(result["log_path"].as_str().unwrap());
        assert!(path.starts_with(log_directory.canonicalize().unwrap()));
        assert!(!path.starts_with(workspace.canonicalize().unwrap()));
        let stored: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored["schema_version"], 2);
        assert_eq!(stored["record_id"], result["record_id"]);
        chrono::DateTime::parse_from_rfc3339(stored["timestamp"].as_str().unwrap()).unwrap();
        if turn_id == "turn-1" {
            let changes = &stored["payload"]["file_changes"];
            assert_large_archive(path.parent().unwrap(), changes);
            for field in ["diff_artifact", "files_artifact"] {
                assert!(
                    !Path::new(changes[field]["path"].as_str().unwrap()).exists(),
                    "host artifacts must be released after logger succeeds"
                );
            }
            input.file_changes = changes.clone();
        } else {
            assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        }
        assert_eq!(stored["payload"], serde_json::to_value(&input).unwrap());
        let duplicate = service.enqueue_turn_completed(input, None).await.unwrap();
        assert_eq!(duplicate, receipt);
        flush(&service).await;
        let duplicate_plugin = service
            .list()
            .into_iter()
            .find(|plugin| plugin.manifest.id == "turn-diff-logger")
            .unwrap();
        assert_eq!(
            serde_json::to_value(&duplicate_plugin.recent_runs[0]).unwrap(),
            serde_json::to_value(run).unwrap(),
            "duplicate enqueue must not execute the handler again"
        );
        logged_paths.push(path);
    }
    assert_ne!(logged_paths[0], logged_paths[1]);
    assert_eq!(
        fs::read_dir(log_directory.join("records")).unwrap().count(),
        2
    );
    // The registry retains the latest run for each handler, rather than a history.
    assert_eq!(
        service
            .list()
            .into_iter()
            .find(|plugin| plugin.manifest.id == "turn-diff-logger")
            .unwrap()
            .recent_runs
            .len(),
        1
    );
    assert!(fs::read_dir(&nested_cwd).unwrap().next().is_none());
    let entries: Vec<_> = fs::read_dir(&workspace)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(entries.len(), 3, "logger must not create workspace files");
}
