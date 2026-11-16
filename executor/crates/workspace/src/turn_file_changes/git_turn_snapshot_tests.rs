// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::Command,
};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::tempdir;

use super::{GitTurnRange, GitTurnSnapshot};

fn git(workspace: &Path, args: &[&str]) -> Vec<u8> {
    let mut command = Command::new("git");
    crate::native_git::clear_local_git_env(&mut command);
    let output = command
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Snapshot Test",
        ])
        .args(["-c", "user.email=snapshot-test@example.invalid", "-C"])
        .arg(workspace)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn init(workspace: &Path) {
    fs::create_dir_all(workspace).unwrap();
    git(workspace, &["init", "-q"]);
    git(workspace, &["config", "core.autocrlf", "false"]);
    git(
        workspace,
        &["config", "core.hooksPath", ".git/nonexistent-test-hooks"],
    );
}

fn commit(workspace: &Path) {
    git(workspace, &["add", "--all"]);
    git(workspace, &["commit", "--allow-empty", "-qm", "fixture"]);
}

fn snapshot(workspace: &Path) -> GitTurnSnapshot {
    GitTurnSnapshot::capture(workspace).unwrap().unwrap()
}

fn materialize(snapshot: GitTurnSnapshot, directory: &Path) -> Value {
    let range = snapshot.freeze().unwrap();
    let changes = range.materialize(directory).unwrap();
    range.release().unwrap();
    assert_descriptors(&changes);
    changes
}

fn artifact(changes: &Value, field: &str) -> PathBuf {
    PathBuf::from(changes[field]["path"].as_str().unwrap())
}

fn files(changes: &Value) -> Vec<Value> {
    BufReader::new(fs::File::open(artifact(changes, "files_artifact")).unwrap())
        .lines()
        .map(|line| serde_json::from_str(&line.unwrap()).unwrap())
        .collect()
}

fn paths(changes: &Value) -> Vec<String> {
    files(changes)
        .into_iter()
        .map(|file| file["path"].as_str().unwrap().to_owned())
        .collect()
}

fn patch(changes: &Value) -> String {
    fs::read_to_string(artifact(changes, "diff_artifact")).unwrap()
}

fn file_digest(path: &Path) -> (u64, String) {
    let mut reader = fs::File::open(path).unwrap();
    let mut hash = Sha256::new();
    let mut size = 0;
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        size += count as u64;
    }
    (size, format!("{:x}", hash.finalize()))
}

fn assert_descriptors(changes: &Value) {
    assert_eq!(changes["version"], 2);
    assert!(changes.get("diff").is_none());
    assert!(changes.get("files").is_none());
    for (field, format) in [("diff_artifact", "git-patch"), ("files_artifact", "jsonl")] {
        let descriptor = &changes[field];
        let path = artifact(changes, field);
        assert!(path.is_absolute());
        let (size, hash) = file_digest(&path);
        assert_eq!(descriptor["size_bytes"], size);
        assert_eq!(descriptor["sha256"], hash);
        assert_eq!(descriptor["format"], format);
    }
}

#[test]
fn git_turn_snapshot_covers_repository_from_subdirectory_and_preserves_dirty_baseline_and_index() {
    let fixture = tempdir().unwrap();
    let root = fixture.path().join("repo");
    init(&root);
    let nested = root.join("nested");
    fs::create_dir(&nested).unwrap();
    for name in ["root.txt", "dirty.txt", "staged.txt"] {
        fs::write(root.join(name), "committed\n").unwrap();
    }
    fs::write(nested.join("existing.txt"), "unchanged\n").unwrap();
    commit(&root);
    fs::write(root.join("dirty.txt"), "dirty before turn\n").unwrap();
    fs::write(root.join("staged.txt"), "staged before turn\n").unwrap();
    git(&root, &["add", "staged.txt"]);
    fs::write(root.join("untracked.txt"), "untracked before turn\n").unwrap();
    git(&root, &["update-index", "--assume-unchanged", "root.txt"]);
    let original_index = fs::read(root.join(".git/index")).unwrap();
    let before = snapshot(&nested);
    fs::write(root.join("root.txt"), "first root edit\n").unwrap();
    fs::write(root.join("dirty.txt"), "dirty after turn\n").unwrap();
    fs::write(nested.join("new.txt"), "new during turn\n").unwrap();

    let changes = materialize(before, &fixture.path().join("first"));

    assert_eq!(paths(&changes), ["dirty.txt", "nested/new.txt", "root.txt"]);
    let first_patch = patch(&changes);
    assert!(first_patch.contains("-dirty before turn\n+dirty after turn\n"));
    assert!(!first_patch.contains("staged before turn"));
    assert!(!first_patch.contains("untracked before turn"));
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), original_index);
    let unchanged = materialize(snapshot(&root), &fixture.path().join("unchanged"));
    assert!(paths(&unchanged).is_empty());
    assert_eq!(unchanged["file_count"], 0);
    assert_eq!(unchanged["diff_artifact"]["size_bytes"], 0);
    assert_eq!(unchanged["files_artifact"]["size_bytes"], 0);
    let before = snapshot(&root);
    fs::write(root.join("root.txt"), "second root edit\n").unwrap();
    let incremental = materialize(before, &fixture.path().join("incremental"));
    assert_eq!(paths(&incremental), ["root.txt"]);
    assert!(patch(&incremental).contains("-first root edit\n+second root edit\n"));
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), original_index);
}

#[test]
fn git_turn_snapshot_includes_force_added_ignored_files_before_and_during_the_turn() {
    for staged_before in [false, true] {
        for committed_during in [false, true] {
            let fixture = tempdir().unwrap();
            let root = fixture.path().join("repo");
            init(&root);
            fs::write(root.join(".gitignore"), "*.rs\n").unwrap();
            commit(&root);
            let path = root.join("generated\ncode.rs");
            if staged_before {
                fs::write(&path, "before\n").unwrap();
                git(&root, &["add", "-f", "generated\ncode.rs"]);
            }
            let before = snapshot(&root);
            fs::write(&path, "after\n").unwrap();
            git(&root, &["add", "-f", "generated\ncode.rs"]);
            if committed_during {
                git(&root, &["commit", "-qm", "generated"]);
            }
            let index = fs::read(root.join(".git/index")).unwrap();

            let changes = materialize(before, &fixture.path().join("changes"));

            assert_eq!(paths(&changes), ["generated\ncode.rs"]);
            assert!(patch(&changes).contains("+after\n"));
            assert_eq!(patch(&changes).contains("-before\n"), staged_before);
            assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
        }
    }
}

#[test]
#[cfg(unix)]
fn private_snapshot_indexes_do_not_run_repository_index_hooks() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = tempdir().unwrap();
    let root = fixture.path().join("repo");
    init(&root);
    fs::write(root.join("source.txt"), "before\n").unwrap();
    commit(&root);
    git(&root, &["config", "core.hooksPath", ".git/hooks"]);
    let hook = root.join(".git/hooks/post-index-change");
    fs::create_dir_all(hook.parent().unwrap()).unwrap();
    fs::write(&hook, "#!/bin/sh\nprintf hit >> hook-ran\n").unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(root.join("source.txt"), "staged before\n").unwrap();
    git(&root, &["add", "source.txt"]);
    assert!(
        root.join("hook-ran").exists(),
        "the fixture hook must run for a real index update"
    );
    fs::remove_file(root.join("hook-ran")).unwrap();

    let before = snapshot(&root);
    fs::write(root.join("source.txt"), "after\n").unwrap();
    let changes = materialize(before, &fixture.path().join("changes"));

    assert!(
        !root.join("hook-ran").exists(),
        "internal snapshots must not trigger user index hooks"
    );
    assert_eq!(paths(&changes), ["source.txt"]);
    assert!(patch(&changes).contains("-staged before\n+after\n"));
}

#[test]
fn git_turn_snapshot_streams_a_complete_unicode_single_line_larger_than_eight_mib() {
    let fixture = tempdir().unwrap();
    let root = fixture.path().join("repo");
    init(&root);
    commit(&root);
    let before = snapshot(&root);
    let path = root.join("大 文件.txt");
    let mut writer = fs::File::create(&path).unwrap();
    let mut expected_hash = Sha256::new();
    let chunk = "数据".repeat(8192);
    for bytes in std::iter::once("起始-".as_bytes())
        .chain(std::iter::repeat(chunk.as_bytes()).take(192))
        .chain(std::iter::once("-完整末尾\n".as_bytes()))
    {
        writer.write_all(bytes).unwrap();
        expected_hash.update(bytes);
    }
    writer.sync_all().unwrap();
    drop(writer);
    let expected_hash = format!("{:x}", expected_hash.finalize());

    let changes = materialize(before, &fixture.path().join("large"));

    assert_eq!(paths(&changes), ["大 文件.txt"]);
    assert!(changes["diff_artifact"]["size_bytes"].as_u64().unwrap() > 9 * 1024 * 1024);
    assert_eq!(files(&changes)[0]["additions"], 1);
    assert_eq!(files(&changes)[0]["binary"], false);
    let patch_path = artifact(&changes, "diff_artifact");
    git(
        &root,
        &[
            "apply",
            "--reverse",
            "--binary",
            patch_path.to_str().unwrap(),
        ],
    );
    assert!(!path.exists());
    git(&root, &["apply", "--binary", patch_path.to_str().unwrap()]);
    assert_eq!(
        file_digest(&path).1,
        expected_hash,
        "Every original Unicode byte must survive"
    );
}

#[test]
fn git_turn_snapshot_seals_the_range_before_later_workspace_writes() {
    let fixture = tempdir().unwrap();
    let root = fixture.path().join("repo");
    init(&root);
    fs::write(root.join("source.txt"), "baseline\n").unwrap();
    commit(&root);
    let before = snapshot(&root);
    fs::write(root.join("source.txt"), "sealed first turn\n").unwrap();
    fs::write(root.join("first-only.txt"), "first\n").unwrap();
    let range = before.freeze().unwrap();
    fs::write(root.join("source.txt"), "later second turn\n").unwrap();
    fs::write(root.join("second-only.txt"), "second\n").unwrap();

    let changes = range.materialize(&fixture.path().join("sealed")).unwrap();
    range.release().unwrap();

    assert_descriptors(&changes);
    assert_eq!(paths(&changes), ["first-only.txt", "source.txt"]);
    let patch = patch(&changes);
    assert!(patch.contains("-baseline\n+sealed first turn\n"));
    assert!(!patch.contains("later second turn"));
    assert!(!patch.contains("second-only.txt"));
    assert_eq!(
        fs::read_to_string(root.join("source.txt")).unwrap(),
        "later second turn\n"
    );
}

#[test]
fn git_turn_snapshot_seals_attributes_before_later_workspace_writes() {
    let fixture = tempdir().unwrap();
    let root = fixture.path().join("repo");
    init(&root);
    fs::write(root.join("tracked.txt"), "normal\n").unwrap();
    commit(&root);
    let before = snapshot(&root);
    fs::write(root.join("tracked.txt"), "sealed\n").unwrap();
    fs::write(root.join(".gitattributes"), "*.txt diff\n").unwrap();
    let range = before.freeze().unwrap();
    fs::write(root.join(".gitattributes"), "*.txt -diff\n").unwrap();

    let changes = range
        .materialize(&fixture.path().join("sealed-attributes"))
        .unwrap();
    range.release().unwrap();

    assert_descriptors(&changes);
    let records = files(&changes);
    let tracked = records
        .iter()
        .find(|record| record["path"] == "tracked.txt")
        .unwrap();
    let sealed_patch = patch(&changes);
    assert!(
        sealed_patch.contains("+sealed\n"),
        "Sealed text diff was changed by live attributes: {tracked}"
    );
    assert_eq!(tracked["binary"], false);
    assert_eq!(tracked["additions"], 1);
    assert_eq!(tracked["deletions"], 1);
}

#[test]
fn git_turn_snapshot_serialized_range_survives_pruning_and_releases_both_pins() {
    let fixture = tempdir().unwrap();
    let root = fixture.path().join("repo");
    init(&root);
    commit(&root);
    fs::write(root.join("uncommitted.txt"), "dirty baseline\n").unwrap();
    let before = snapshot(&root);
    fs::write(root.join("uncommitted.txt"), "sealed after\n").unwrap();
    let range = before.freeze().unwrap();
    let persisted = serde_json::to_vec(&range).unwrap();
    drop(range);
    fs::write(root.join("uncommitted.txt"), "new live bytes\n").unwrap();
    git(&root, &["gc", "--prune=now"]);
    let restored: GitTurnRange = serde_json::from_slice(&persisted).unwrap();

    let changes = restored
        .materialize(&fixture.path().join("restored"))
        .unwrap();

    assert_descriptors(&changes);
    assert_eq!(restored.workspace_path(), root.canonicalize().unwrap());
    assert!(patch(&changes).contains("-dirty baseline\n+sealed after\n"));
    let references = git(
        &root,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/wegent/turn-hooks/",
        ],
    );
    assert_eq!(String::from_utf8(references).unwrap().lines().count(), 2);
    restored.release().unwrap();
    assert!(git(&root, &["for-each-ref", "refs/wegent/turn-hooks/"]).is_empty());
    restored.release().unwrap();
}

#[test]
fn git_turn_checkpoints_replay_continuously_and_keep_independent_gc_pins() {
    let fixture = tempdir().unwrap();
    let root = fixture.path().join("repo");
    init(&root);
    fs::write(root.join("tracked.txt"), "baseline\n").unwrap();
    commit(&root);
    let replay = fixture.path().join("replay");
    git(
        fixture.path(),
        &[
            "clone",
            "-q",
            root.to_str().unwrap(),
            replay.to_str().unwrap(),
        ],
    );
    let mut baseline = snapshot(&root);
    fs::write(root.join("tracked.txt"), "first\n").unwrap();
    let (first, mut next) = baseline.checkpoint().unwrap();
    drop(baseline);
    let first_changes = first.materialize(&fixture.path().join("first")).unwrap();
    git(
        &replay,
        &[
            "apply",
            artifact(&first_changes, "diff_artifact").to_str().unwrap(),
        ],
    );
    first.release().unwrap();
    git(&root, &["gc", "--prune=now"]);
    // A write before the next start notification still belongs to the chain.
    fs::write(root.join("gap.txt"), "gap\n").unwrap();
    fs::write(root.join("tracked.txt"), "last\n").unwrap();
    let (second, ending) = next.checkpoint().unwrap();
    drop(next);
    let second_changes = second.materialize(&fixture.path().join("second")).unwrap();
    git(
        &replay,
        &[
            "apply",
            artifact(&second_changes, "diff_artifact").to_str().unwrap(),
        ],
    );
    for name in ["tracked.txt", "gap.txt"] {
        assert_eq!(
            fs::read(replay.join(name)).unwrap(),
            fs::read(root.join(name)).unwrap()
        );
    }
    second.release().unwrap();
    drop(ending);
    assert!(git(&root, &["for-each-ref", "refs/wegent/turn-hooks/"]).is_empty());
}

#[test]
fn git_turn_checkpoint_can_be_discarded_without_advancing_the_baseline() {
    let fixture = tempdir().unwrap();
    let root = fixture.path().join("repo");
    init(&root);
    commit(&root);
    let mut baseline = snapshot(&root);
    fs::write(root.join("first.txt"), "first\n").unwrap();
    let (discarded, next) = baseline.checkpoint().unwrap();
    discarded.release_if_unqueued().unwrap();
    drop(next);
    git(&root, &["gc", "--prune=now"]);
    fs::write(root.join("second.txt"), "second\n").unwrap();
    let (combined, ending) = baseline.checkpoint().unwrap();
    let changes = combined
        .materialize(&fixture.path().join("combined"))
        .unwrap();
    assert_eq!(paths(&changes), ["first.txt", "second.txt"]);
    combined.release().unwrap();
    drop(ending);
    drop(baseline);
    assert!(git(&root, &["for-each-ref", "refs/wegent/turn-hooks/"]).is_empty());
}

#[test]
fn git_turn_snapshot_batches_statistics_for_many_files_without_touching_the_real_index() {
    let fixture = tempdir().unwrap();
    let root = fixture.path().join("repo");
    init(&root);
    for index in 0..128 {
        fs::write(root.join(format!("existing-{index:03}.txt")), "before\n").unwrap();
    }
    commit(&root);
    let real_index = fs::read(root.join(".git/index")).unwrap();
    let before = snapshot(&root);
    for index in 0..128 {
        fs::write(
            root.join(format!("existing-{index:03}.txt")),
            "after\nsecond\n",
        )
        .unwrap();
        fs::write(root.join(format!("new-{index:03}.txt")), "new\n").unwrap();
    }

    let changes = materialize(before, &fixture.path().join("many-files"));

    assert_eq!(changes["file_count"], 256);
    assert_eq!(changes["additions"], 384);
    assert_eq!(changes["deletions"], 128);
    let records = files(&changes);
    assert_eq!(records.len(), 256);
    for record in records {
        let existing = record["path"].as_str().unwrap().starts_with("existing-");
        assert_eq!(record["additions"], if existing { 2 } else { 1 });
        assert_eq!(record["deletions"], if existing { 1 } else { 0 });
        assert_eq!(
            record["change_type"],
            if existing { "modified" } else { "added" }
        );
        assert_eq!(record["binary"], false);
    }
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), real_index);
}

#[test]
fn git_turn_snapshot_preserves_rename_delete_and_binary_changes() {
    let fixture = tempdir().unwrap();
    let root = fixture.path().join("repo");
    init(&root);
    fs::write(root.join("old.txt"), "unique renamed content\n").unwrap();
    fs::write(root.join("deleted.txt"), "removed content\n").unwrap();
    fs::write(root.join("binary.dat"), [0, 1, 2, 3]).unwrap();
    commit(&root);
    let before = snapshot(&root);
    fs::rename(root.join("old.txt"), root.join("renamed.txt")).unwrap();
    fs::remove_file(root.join("deleted.txt")).unwrap();
    fs::write(root.join("binary.dat"), [0, 4, 5, 6]).unwrap();

    let changes = materialize(before, &fixture.path().join("types"));

    assert_eq!(
        paths(&changes),
        ["binary.dat", "deleted.txt", "renamed.txt"]
    );
    let records = files(&changes);
    assert_eq!(records[0]["binary"], true);
    assert_eq!(records[1]["change_type"], "deleted");
    assert_eq!(records[2]["change_type"], "renamed");
    assert_eq!(records[2]["old_path"], "old.txt");
    let patch = patch(&changes);
    assert!(patch.contains("GIT binary patch"));
    assert!(patch.contains("rename from old.txt\nrename to renamed.txt"));
    assert!(patch.contains("-removed content\n"));
}

#[test]
fn git_turn_snapshot_supports_unborn_repositories_and_linked_worktrees() {
    let fixture = tempdir().unwrap();
    let root = fixture.path().join("repo");
    init(&root);
    fs::write(root.join("before.txt"), "already present\n").unwrap();
    let before = snapshot(&root);
    fs::write(root.join("during.txt"), "created during turn\n").unwrap();

    let unborn = materialize(before, &fixture.path().join("unborn"));

    assert_eq!(paths(&unborn), ["during.txt"]);
    assert!(
        !root.join(".git/index").exists(),
        "The real index must not be created"
    );
    commit(&root);
    let worktree = fixture.path().join("worktree");
    git(
        &root,
        &[
            "worktree",
            "add",
            "--detach",
            worktree.to_str().unwrap(),
            "HEAD",
        ],
    );
    assert!(worktree.join(".git").is_file());
    let before = snapshot(&worktree);
    fs::write(worktree.join("during.txt"), "worktree edit\n").unwrap();

    let linked = materialize(before, &fixture.path().join("linked"));

    assert_eq!(paths(&linked), ["during.txt"]);
    assert!(patch(&linked).contains("+worktree edit\n"));
    assert_eq!(
        fs::read_to_string(root.join("during.txt")).unwrap(),
        "created during turn\n"
    );
    assert!(git(&root, &["for-each-ref", "refs/wegent/turn-hooks/"]).is_empty());
}

#[test]
fn git_turn_snapshot_skips_non_repositories_and_recovers_after_capture_failures() {
    let fixture = tempdir().unwrap();
    assert!(GitTurnSnapshot::capture(fixture.path()).unwrap().is_none());
    let root = fixture.path().join("repo");
    init(&root);
    commit(&root);
    let before = snapshot(&root);
    git(
        &root,
        &[
            "config",
            "filter.snapshot-test.clean",
            "wegent-intentionally-missing-filter",
        ],
    );
    git(&root, &["config", "filter.snapshot-test.required", "true"]);
    fs::write(root.join(".gitattributes"), "*.bad filter=snapshot-test\n").unwrap();
    fs::write(root.join("broken.bad"), "cannot be filtered\n").unwrap();

    let initial_error = GitTurnSnapshot::capture(&root).unwrap_err();
    let final_error = before.freeze().unwrap_err();

    assert!(!initial_error.trim().is_empty());
    assert!(!final_error.trim().is_empty());
    assert!(git(&root, &["for-each-ref", "refs/wegent/turn-hooks/"]).is_empty());
    fs::remove_file(root.join("broken.bad")).unwrap();
    let before = snapshot(&root);
    fs::write(root.join("recovered.txt"), "recovered next turn\n").unwrap();
    let recovered = materialize(before, &fixture.path().join("recovered"));
    assert_eq!(paths(&recovered), ["recovered.txt"]);
}
