// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

#![cfg(unix)]

use std::{fs, path::Path, process::Command};

use serde_json::json;

use super::*;
use crate::hooks::{
    model::{HookPluginManifest, HooksConfig},
    registry::HookRegistryStore,
};

fn git(repo: &Path, args: &[&str]) {
    let mut command = Command::new("git");
    wegent_workspace::native_git::clear_local_git_env(&mut command);
    let output = command.arg("-C").arg(repo).args(args).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn init_repo(repo: &Path) {
    fs::create_dir_all(repo).unwrap();
    git(repo, &["init", "-q"]);
    git(repo, &["config", "user.name", "Tests"]);
    git(repo, &["config", "user.email", "tests@example.com"]);
    fs::write(repo.join("tracked.txt"), "original\n").unwrap();
    git(repo, &["add", "."]);
    git(
        repo,
        &["-c", "commit.gpgsign=false", "commit", "-qm", "baseline"],
    );
}

fn observer(root: &Path, workspace: &Path) -> (TurnDiffHook, PathBuf) {
    observer_with_gate(root, workspace, None)
}

fn observer_with_gate(
    root: &Path,
    workspace: &Path,
    gate: Option<&Path>,
) -> (TurnDiffHook, PathBuf) {
    let home = root.join("home");
    let registry = HookRegistryStore::new(home);
    let received = root.join("received.jsonl");
    let reporter = root.join("reporter.mjs");
    fs::write(
        &reporter,
        r#"
import { readFileSync, appendFileSync } from 'node:fs'
const input = JSON.parse(readFileSync(0, 'utf8'))
if (input.file_changes.status === 'active') {
  input.observed_diff = readFileSync(input.file_changes.diff_artifact.path, 'utf8')
  input.observed_files = readFileSync(input.file_changes.files_artifact.path, 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse)
}
appendFileSync(process.argv[2], JSON.stringify(input) + '\n')
"#,
    )
    .unwrap();
    let command = format!("node '{}' '{}'", reporter.display(), received.display());
    let command = match gate {
        Some(gate) => format!("cat '{}' > /dev/null; {command}", gate.display()),
        None => command,
    };
    registry
        .create(
            serde_json::from_value::<HookPluginManifest>(json!({
                "schemaVersion": 1, "id": "turn-diff", "name": "Turn Diff", "version": "1.0.0",
                "subscriptions": ["codex_rollout"],
            }))
            .unwrap(),
            serde_json::from_value::<HooksConfig>(json!({"TurnCompleted": [{
                "matcher": ".*", "hooks": [{"type": "command", "command": command, "timeout": 30}]
            }]}))
            .unwrap(),
        )
        .unwrap();
    let service = HookService::new(registry, root.join("codex"));
    assert!(service.has_turn_completed_hooks());
    (
        TurnDiffHook::new(
            service,
            HookUser {
                id: Some("7".into()),
                name: "alice".into(),
            },
            workspace.to_owned(),
            Some("test-model".into()),
            "workspace-write".into(),
        ),
        received,
    )
}

fn read_inputs(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn turn_diff_hook_collects_root_child_and_between_notification_writes_once() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    init_repo(&repo);
    fs::write(repo.join("tracked.txt"), "dirty before\n").unwrap();
    fs::write(repo.join("preexisting.txt"), "before\n").unwrap();
    let (hook, received) = observer(root.path(), &repo);
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        hook.prepare().await;
        fs::write(repo.join("root.txt"), "parent\n").unwrap();
        hook.started("root-session", "provisional-turn-id").await;
        hook.started("root-session", "turn-1").await;
        let output = Command::new("sh")
            .current_dir(&repo)
            .args(["-c", "printf 'child\\n' > child.txt"])
            .output()
            .unwrap();
        assert!(output.status.success());
        hook.observe(
            "root-session",
            &json!({"method":"turn/completed","params":{
                "threadId":"child-session","turn":{"id":"child-turn","status":"completed"}
            }}),
        )
        .await;
        assert!(
            !received.exists(),
            "Child completion must not complete the root hook"
        );
        for method in ["turn/started", "turn/completed"] {
            hook.observe(
                "root-session",
                &json!({"method":method,"params":{
                    "threadId":"root-session","turn":{
                        "id":"mirrored-child-turn","agentPath":"/root/child","status":"completed"
                    }
                }}),
            )
            .await;
        }
        assert!(
            !received.exists(),
            "Mirrored child events must not complete the root hook"
        );
        git(&repo, &["add", "root.txt", "child.txt"]);
        git(
            &repo,
            &["-c", "commit.gpgsign=false", "commit", "-qm", "during turn"],
        );
        hook.completed("completed").await;
        hook.completed("completed").await;

        fs::write(repo.join("between-turns.txt"), "between notifications\n").unwrap();
        hook.started("root-session", "turn-2").await;
        fs::write(repo.join("root.txt"), "followup\n").unwrap();
        hook.observe(
            "root-session",
            &json!({"method":"turn/completed","params":{
                "threadId":"root-session","turn":{"id":"turn-1","status":"completed"}
            }}),
        )
        .await;
        hook.completed("interrupted").await;
        hook.service.flush_turn_hooks().await.unwrap();
    });
    let inputs = read_inputs(&received);
    assert_eq!(inputs.len(), 2);
    assert_eq!(inputs[0]["hook_event_name"], "TurnCompleted");
    assert_eq!(inputs[0]["session_id"], "root-session");
    assert_eq!(inputs[0]["turn_id"], "turn-1");
    assert_eq!(inputs[0]["user"]["name"], "alice");
    assert_eq!(inputs[0]["file_changes"]["file_count"], 2);
    assert!(inputs[0]["file_changes"].get("diff").is_none());
    assert!(inputs[0]["file_changes"].get("files").is_none());
    let first = inputs[0]["observed_diff"].as_str().unwrap();
    assert!(first.contains("+parent"));
    assert!(first.contains("+child"));
    assert!(!first.contains("tracked.txt"));
    assert!(!first.contains("preexisting.txt"));
    assert_eq!(inputs[1]["turn_id"], "turn-2");
    assert_eq!(inputs[1]["status"], "interrupted");
    assert_eq!(inputs[1]["file_changes"]["file_count"], 2);
    let second = inputs[1]["observed_diff"].as_str().unwrap();
    assert!(second.contains("-parent\n+followup\n"));
    assert!(!second.contains("child.txt"));
    assert!(second.contains("+between notifications"));
    assert!(inputs[0]["sequence"].as_u64() < inputs[1]["sequence"].as_u64());
    assert_ne!(inputs[0]["event_id"], inputs[1]["event_id"]);
}

#[test]
fn turn_diff_hook_skips_non_git_and_reports_empty_git_turns() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("plain");
    fs::create_dir(&workspace).unwrap();
    let (hook, received) = observer(root.path(), &workspace);
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        hook.prepare().await;
        hook.started("session", "plain-turn").await;
        fs::write(workspace.join("plain.txt"), "ignored\n").unwrap();
        hook.completed("completed").await;
        hook.service.flush_turn_hooks().await.unwrap();
        assert!(!received.exists());
        init_repo(&workspace);
        hook.prepare().await;
        hook.started("session", "empty-turn").await;
        hook.completed("completed").await;
        hook.service.flush_turn_hooks().await.unwrap();
    });
    let inputs = read_inputs(&received);
    assert_eq!(inputs.len(), 1);
    assert_eq!(inputs[0]["observed_diff"], "");
    assert_eq!(inputs[0]["file_changes"]["file_count"], 0);
}

#[test]
fn turn_diff_hook_never_binds_a_mirrored_child_turn_as_the_root() {
    let mut state = super::super::run_state::CodexRunState::default();
    state.set_root_thread_id("root-session");
    let message = json!({"method":"turn/started","params":{
        "threadId":"root-session","turn":{"id":"child-turn","agentPath":"/root/child"}
    }});
    assert_eq!(
        super::super::root_turn_notification_id(&message, &state),
        None
    );
}

#[test]
fn turn_diff_hook_returns_before_a_blocked_handler_and_freezes_its_input() {
    use std::io::Write;
    use std::time::Duration;

    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    init_repo(&repo);
    let gate = root.path().join("handler-gate");
    assert!(Command::new("mkfifo")
        .arg(&gate)
        .status()
        .unwrap()
        .success());
    let (hook, received) = observer_with_gate(root.path(), &repo, Some(&gate));
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        hook.prepare().await;
        hook.started("session", "first").await;
        fs::write(repo.join("tracked.txt"), "first turn\n").unwrap();
        tokio::time::timeout(Duration::from_secs(10), hook.completed("completed"))
            .await
            .expect("turn completion must not wait for the blocked handler");
        assert!(!received.exists(), "the FIFO still blocks the handler");
        hook.started("session", "next").await;
        fs::write(repo.join("tracked.txt"), "next turn\n").unwrap();
        tokio::task::spawn_blocking(move || {
            fs::OpenOptions::new()
                .write(true)
                .open(gate)
                .unwrap()
                .write_all(b"release\n")
                .unwrap();
        })
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(10), hook.service.flush_turn_hooks())
            .await
            .unwrap()
            .unwrap();
    });
    let inputs = read_inputs(&received);
    assert_eq!(inputs.len(), 1);
    let diff = inputs[0]["observed_diff"].as_str().unwrap();
    assert!(diff.contains("+first turn"));
    assert!(!diff.contains("next turn"));
}

#[test]
fn turn_diff_hook_discards_unstarted_snapshots_safely_inside_async_context() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    init_repo(&repo);
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        for complete in [false, true] {
            let case = root.path().join(format!("case-{complete}"));
            fs::create_dir(&case).unwrap();
            let (hook, received) = observer(&case, &repo);
            hook.prepare().await;
            if complete {
                hook.completed("failed").await;
            }
            drop(hook);
            let refs = Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args([
                    "for-each-ref",
                    "--format=%(refname)",
                    "refs/wegent/turn-hooks/",
                ])
                .output()
                .unwrap();
            assert!(refs.status.success());
            assert!(
                refs.stdout.is_empty(),
                "abandoned snapshots must release their refs"
            );
            assert!(
                !received.exists(),
                "a turn without an ID must not be delivered"
            );
        }
    });
}

#[test]
fn turn_diff_hook_reports_capture_failure_and_recovers_on_the_next_turn() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    init_repo(&repo);
    let (hook, received) = observer(root.path(), &repo);
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        hook.prepare().await;
        hook.started("session", "failed-capture").await;
        git(
            &repo,
            &[
                "config",
                "filter.turn-test.clean",
                "wegent-missing-test-filter",
            ],
        );
        git(&repo, &["config", "filter.turn-test.required", "true"]);
        fs::write(repo.join(".gitattributes"), "*.bad filter=turn-test\n").unwrap();
        fs::write(repo.join("broken.bad"), "cannot be captured\n").unwrap();
        hook.completed("completed").await;
        hook.service.flush_turn_hooks().await.unwrap();
        fs::remove_file(repo.join("broken.bad")).unwrap();
        hook.started("session", "recovered-capture").await;
        fs::write(repo.join("recovered.txt"), "captured\n").unwrap();
        hook.completed("completed").await;
        hook.service.flush_turn_hooks().await.unwrap();
    });
    let inputs = read_inputs(&received);
    assert_eq!(inputs.len(), 2);
    assert_eq!(inputs[0]["file_changes"]["status"], "error");
    assert_eq!(inputs[1]["file_changes"]["status"], "active");
    assert_eq!(inputs[1]["file_changes"]["file_count"], 2);
    let diff = inputs[1]["observed_diff"].as_str().unwrap();
    assert!(diff.contains("+*.bad filter=turn-test"));
    assert!(diff.contains("+captured"));
}

#[test]
fn turn_diff_hook_allows_coalescing_and_resets_only_for_a_new_execution() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    init_repo(&repo);
    let (hook, received) = observer(root.path(), &repo);
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        hook.prepare().await;
        hook.started("session", "first").await;
        fs::write(repo.join("tracked.txt"), "first\n").unwrap();
        // The producer can write again before its completion is consumed.
        fs::write(repo.join("early-next.txt"), "next turn\n").unwrap();
        hook.completed("completed").await;
        hook.started("session", "second").await;
        hook.completed("completed").await;
        fs::write(repo.join("external.txt"), "before new request\n").unwrap();
        hook.prepare().await;
        hook.started("session", "new-request").await;
        fs::write(repo.join("tracked.txt"), "new request\n").unwrap();
        hook.completed("completed").await;
        hook.service.flush_turn_hooks().await.unwrap();
    });
    let inputs = read_inputs(&received);
    assert_eq!(inputs.len(), 3);
    assert_eq!(inputs[0]["file_changes"]["file_count"], 2);
    assert!(inputs[0]["observed_diff"]
        .as_str()
        .unwrap()
        .contains("+next turn"));
    assert_eq!(inputs[1]["observed_diff"], "");
    let diff = inputs[2]["observed_diff"].as_str().unwrap();
    assert!(diff.contains("-first\n+new request\n"));
    assert!(!diff.contains("external.txt"));
    assert!(!diff.contains("early-next.txt"));
}

#[test]
fn turn_diff_hook_retains_baseline_when_durable_enqueue_fails() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    init_repo(&repo);
    let (hook, received) = observer(root.path(), &repo);
    let registry = HookRegistryStore::new(root.path().join("home"));
    let database = registry
        .plugins_dir()
        .parent()
        .unwrap()
        .join("turn-completed.sqlite");
    fs::create_dir(&database).unwrap();
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        hook.prepare().await;
        hook.started("session", "failed-enqueue").await;
        fs::write(repo.join("tracked.txt"), "must survive\n").unwrap();
        hook.completed("completed").await;
        assert!(!received.exists());
        fs::remove_dir(&database).unwrap();
        fs::write(repo.join("gap.txt"), "gap\n").unwrap();
        hook.started("session", "recovered").await;
        fs::write(repo.join("last.txt"), "last\n").unwrap();
        hook.completed("completed").await;
        hook.service.flush_turn_hooks().await.unwrap();
    });
    let inputs = read_inputs(&received);
    assert_eq!(inputs.len(), 1);
    assert_eq!(inputs[0]["turn_id"], "recovered");
    assert_eq!(inputs[0]["file_changes"]["file_count"], 3);
    let diff = inputs[0]["observed_diff"].as_str().unwrap();
    for expected in ["-original\n+must survive\n", "+gap", "+last"] {
        assert!(diff.contains(expected), "missing {expected}");
    }
}
