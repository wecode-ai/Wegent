// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use flate2::read::GzDecoder;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use wegent_executor::services::turn_file_changes::{
    ClaudeToolFileChangeTracker, NativeTurnFileChangeTracker, TurnFileChangeTracker,
};

#[test]
fn tracker_excludes_changes_that_preexist_the_turn() {
    let root = unique_dir("turn-preexisting");
    let repo = init_repo(&root, true);
    write(repo.join("existing.txt"), "base\n");
    commit_all(&repo, "tracked");
    write(repo.join("existing.txt"), "user dirty\n");
    write(repo.join("untracked.txt"), "before\n");
    let mut tracker = TurnFileChangeTracker::new(repo.clone(), 10, 20, root.join("home"), None);

    assert!(tracker.start());
    write(repo.join("agent.txt"), "created by agent\n");
    let summary = tracker.finalize();

    assert_eq!(file_paths(&summary), vec!["agent.txt"]);
}

#[test]
fn tracker_counts_modified_created_deleted_renamed_no_head_and_binary_files() {
    let root = unique_dir("turn-counts");
    let repo = init_repo(&root, true);
    write(repo.join("modified.txt"), "old\n");
    write(repo.join("deleted.txt"), "gone\n");
    write(repo.join("old-name.txt"), "rename me\n");
    commit_all(&repo, "fixtures");
    let mut tracker =
        TurnFileChangeTracker::new(repo.clone(), 1, 2, root.join("home"), Some("device-1"));
    assert!(tracker.start());

    write(repo.join("modified.txt"), "new\nextra\n");
    write(repo.join("created.txt"), "created\n");
    fs::remove_file(repo.join("deleted.txt")).unwrap();
    fs::rename(repo.join("old-name.txt"), repo.join("new-name.txt")).unwrap();
    let changes = summary_changes(&tracker.finalize());
    let files = files_by_path(&changes);

    assert_eq!(changes["file_count"], 4);
    assert_eq!(changes["additions"], 3);
    assert_eq!(changes["deletions"], 2);
    assert_eq!(files["created.txt"]["change_type"], "created");
    assert_eq!(files["deleted.txt"]["change_type"], "deleted");
    assert_eq!(files["modified.txt"]["change_type"], "modified");
    assert_eq!(files["new-name.txt"]["change_type"], "renamed");
    assert_eq!(files["new-name.txt"]["old_path"], "old-name.txt");
    assert_eq!(changes["device_id"], "device-1");

    let repo = init_repo(&root.join("no-head"), false);
    let mut tracker = TurnFileChangeTracker::new(repo.clone(), 1, 2, root.join("home"), None);
    assert!(tracker.start());
    write(repo.join("first.txt"), "first\n");
    assert_eq!(file_paths(&tracker.finalize()), vec!["first.txt"]);

    let repo = init_repo(&root.join("binary"), true);
    let mut tracker = TurnFileChangeTracker::new(repo.clone(), 1, 2, root.join("home"), None);
    assert!(tracker.start());
    fs::write(repo.join("image.bin"), b"\x00\x01\x02\x03").unwrap();
    let file = summary_changes(&tracker.finalize())["files"][0].clone();
    assert_eq!(
        file,
        json!({
            "old_path": null,
            "path": "image.bin",
            "change_type": "created",
            "additions": 0,
            "deletions": 0,
            "binary": true,
        })
    );
}

#[test]
fn tracker_writes_gzip_patch_metadata_reverse_patch_and_preserves_real_index() {
    let root = unique_dir("turn-artifact");
    let repo = init_repo(&root, true);
    write(repo.join("existing.txt"), "committed\n");
    write(repo.join("staged.txt"), "base\n");
    commit_all(&repo, "tracked");
    write(repo.join("existing.txt"), "dirty before\n");
    write(repo.join("staged.txt"), "staged\n");
    run_git(&repo, ["add", "staged.txt"], None);
    let before_index = run_git(&repo, ["ls-files", "--stage"], None);
    let home = root.join("home");
    let mut tracker = TurnFileChangeTracker::new(repo.clone(), 12, 34, home.clone(), None);

    assert!(tracker.start());
    write(repo.join("hello.txt"), "hello\n");
    let changes = summary_changes(&tracker.finalize());

    assert_eq!(run_git(&repo, ["ls-files", "--stage"], None), before_index);
    let artifact_dir = home.join("artifacts/turn-file-changes/12/34");
    let patch = read_gzip(artifact_dir.join("changes.patch.gz"));
    let metadata: Value =
        serde_json::from_slice(&fs::read(artifact_dir.join("metadata.json")).unwrap()).unwrap();
    assert_eq!(changes["artifact_id"], "turn-file-changes/12/34");
    assert!(patch.starts_with(b"diff --git a/hello.txt b/hello.txt"));
    assert_eq!(metadata["checksum"], hex_sha256(&patch));

    run_git(&repo, ["apply", "--reverse", "--binary", "-"], Some(&patch));
    assert_eq!(
        fs::read_to_string(repo.join("existing.txt")).unwrap(),
        "dirty before\n"
    );
    assert!(!repo.join("hello.txt").exists());
}

#[test]
fn tracker_returns_empty_for_non_git_workspace_and_allows_concurrent_turns() {
    let root = unique_dir("turn-empty-concurrent");
    let plain = root.join("plain");
    fs::create_dir_all(&plain).unwrap();
    let mut tracker = TurnFileChangeTracker::new(plain, 1, 2, root.join("home"), None);
    assert!(!tracker.start());
    assert_eq!(tracker.finalize(), json!({}));

    let repo = init_repo(&root, true);
    let mut first = TurnFileChangeTracker::new(repo.clone(), 1, 2, root.join("home"), None);
    let mut second = TurnFileChangeTracker::new(repo.clone(), 1, 3, root.join("home"), None);
    assert!(first.start());
    assert!(second.start());

    write(repo.join("first.txt"), "first\n");
    assert_eq!(file_paths(&first.finalize()), vec!["first.txt"]);
    write(repo.join("second.txt"), "second\n");
    assert_eq!(
        file_paths(&second.finalize()),
        vec!["first.txt", "second.txt"]
    );
}

#[test]
fn native_tracker_persists_agent_provided_diff() {
    let root = unique_dir("turn-native");
    let repo = init_repo(&root, true);
    write(repo.join("native.txt"), "before\n");
    commit_all(&repo, "native fixture");
    write(repo.join("native.txt"), "native\n");
    let patch = run_git(&repo, ["diff", "--binary", "HEAD"], None);
    let home = root.join("home");
    let mut tracker =
        NativeTurnFileChangeTracker::new(repo.clone(), 7, 8, home.clone(), Some("device-1"));

    tracker.record_diff(&patch);
    let changes = summary_changes(&tracker.finalize());

    assert_eq!(changes["artifact_id"], "turn-file-changes/7/8");
    assert_eq!(changes["device_id"], "device-1");
    assert_eq!(changes["files"][0]["path"], "native.txt");
    assert_eq!(
        read_gzip(home.join("artifacts/turn-file-changes/7/8/changes.patch.gz")),
        patch
    );
}

#[test]
fn claude_tool_tracker_captures_git_tool_boundaries_and_hook_input_ids() {
    let root = unique_dir("turn-claude-git");
    let repo = init_repo(&root, true);
    write(repo.join("tool.txt"), "before\n");
    write(repo.join("hook.txt"), "before\n");
    commit_all(&repo, "tool fixture");
    let home = root.join("home");
    let mut tracker =
        ClaudeToolFileChangeTracker::new(repo.clone(), 3, 4, home.clone(), Some("device-1"));

    tracker.pre_tool_use(&json!({}), Some("tool-1"));
    write(repo.join("tool.txt"), "after\n");
    tracker.post_tool_use(&json!({}), Some("tool-1"));
    tracker.pre_tool_use(&json!({"tool_use_id": "tool-from-input"}), None);
    write(repo.join("hook.txt"), "after\n");
    tracker.post_tool_use(&json!({"tool_use_id": "tool-from-input"}), None);
    let changes = summary_changes(&tracker.finalize());

    assert_eq!(changes["file_count"], 2);
    assert_eq!(
        file_paths_from_changes(&changes),
        vec!["hook.txt", "tool.txt"]
    );
    let patch = read_gzip(home.join("artifacts/turn-file-changes/3/4/changes.patch.gz"));
    assert!(patch
        .windows(b"-before".len())
        .any(|window| window == b"-before"));
    assert!(patch
        .windows(b"+after".len())
        .any(|window| window == b"+after"));
}

#[test]
fn claude_tool_tracker_captures_file_patch_without_git() {
    let root = unique_dir("turn-claude-plain");
    let workspace = root.join("plain-workspace");
    fs::create_dir_all(&workspace).unwrap();
    let home = root.join("home");
    let mut tracker =
        ClaudeToolFileChangeTracker::new(workspace.clone(), 9, 10, home.clone(), Some("device-1"));

    tracker.record_tool_use_start(
        "Write",
        "tool-plain",
        &json!({"file_path": "notes/result.txt", "content": "created\n"}),
    );
    write(workspace.join("notes/result.txt"), "created\n");
    tracker.record_tool_result("tool-plain", false);
    let changes = summary_changes(&tracker.finalize());

    assert_eq!(changes["file_count"], 1);
    assert_eq!(changes["files"][0]["path"], "notes/result.txt");
    assert_eq!(changes["files"][0]["change_type"], "created");
    let patch = read_gzip(home.join("artifacts/turn-file-changes/9/10/changes.patch.gz"));
    assert!(patch.starts_with(b"diff --git a/notes/result.txt b/notes/result.txt"));
    assert!(patch
        .windows(b"+created".len())
        .any(|window| window == b"+created"));
}

fn init_repo(root: &Path, with_head: bool) -> PathBuf {
    let repo = root.join("repo");
    fs::create_dir_all(&repo).unwrap();
    run_git(&repo, ["init", "-q"], None);
    run_git(&repo, ["config", "user.email", "tests@example.com"], None);
    run_git(&repo, ["config", "user.name", "Tests"], None);
    if with_head {
        write(repo.join(".gitkeep"), "");
        commit_all(&repo, "initial");
    }
    repo
}

fn commit_all(repo: &Path, message: &str) {
    run_git(repo, ["add", "--all"], None);
    run_git(repo, ["commit", "-qm", message], None);
}

fn run_git<const N: usize>(repo: &Path, args: [&str; N], input: Option<&[u8]>) -> Vec<u8> {
    let mut command = Command::new("git");
    command.arg("-C").arg(repo).args(args);
    if input.is_some() {
        command.stdin(std::process::Stdio::piped());
    }
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    let mut child = command.spawn().unwrap();
    if let Some(input) = input {
        use std::io::Write;
        child.stdin.as_mut().unwrap().write_all(input).unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "git failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn write(path: PathBuf, content: impl AsRef<[u8]>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn summary_changes(summary: &Value) -> Value {
    summary["file_changes"].clone()
}

fn file_paths(summary: &Value) -> Vec<String> {
    file_paths_from_changes(&summary_changes(summary))
}

fn file_paths_from_changes(changes: &Value) -> Vec<String> {
    changes["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["path"].as_str().unwrap().to_owned())
        .collect()
}

fn files_by_path(changes: &Value) -> std::collections::BTreeMap<String, Value> {
    changes["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| (item["path"].as_str().unwrap().to_owned(), item.clone()))
        .collect()
}

fn read_gzip(path: PathBuf) -> Vec<u8> {
    let mut decoder = GzDecoder::new(fs::File::open(path).unwrap());
    let mut bytes = Vec::new();
    decoder.read_to_end(&mut bytes).unwrap();
    bytes
}

fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn unique_dir(prefix: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = stable_test_tmp_root().join(format!("{prefix}-{}-{suffix}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}

fn stable_test_tmp_root() -> PathBuf {
    std::env::var_os("WEGENT_TEST_TMPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(default_stable_test_tmp_root)
}

#[cfg(not(windows))]
fn default_stable_test_tmp_root() -> PathBuf {
    PathBuf::from("/tmp").join("wegent-executor-tests")
}

#[cfg(windows)]
fn default_stable_test_tmp_root() -> PathBuf {
    std::env::temp_dir().join("wegent-executor-tests")
}
