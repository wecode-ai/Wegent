// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn tracker(repo: &Path, home: &Path, task: i64, turn: i64) -> TurnFileChangeTracker {
    TurnFileChangeTracker::new(repo.to_owned(), task, turn, home.to_owned(), None)
        .with_task_baseline()
}

fn run_in_isolated_git_process(name: &str) -> bool {
    let name = format!("task_baseline::{name}");
    const CASE_ENV: &str = "WEGENT_TASK_BASELINE_TEST_CASE";
    if std::env::var(CASE_ENV).as_deref() == Ok(name.as_str()) {
        return false;
    }
    let configuration = tempfile::tempdir().unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let status = command
        .args(["--exact", &name, "--test-threads=1"])
        .env(CASE_ENV, &name)
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("XDG_CONFIG_HOME", configuration.path())
        .status()
        .unwrap();
    assert!(status.success(), "isolated Git case failed: {name}");
    true
}

#[test]
fn cumulative_snapshot_adds_across_turns_and_clears_after_restore() {
    if run_in_isolated_git_process("cumulative_snapshot_adds_across_turns_and_clears_after_restore")
    {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let repo = init_repo(root.path(), true);
    let home = root.path().join("home");
    write(repo.join("preexisting.txt"), "user dirty\n");
    let initial_index = run_git(&repo, ["ls-files", "--stage"], None);
    let mut first = tracker(&repo, &home, 40, 401);
    assert!(first.start());
    write(repo.join("a.txt"), "a\n");
    let first_fields = first.finalize();
    assert_eq!(
        file_paths_from_changes(&first_fields["task_file_changes"]),
        ["a.txt"]
    );

    let mut second = tracker(&repo, &home, 40, 402);
    assert!(second.start());
    run_git(&repo, ["checkout", "-b", "agent/second"], None);
    write(repo.join("b.txt"), "b\n");
    let second_fields = second.finalize();
    assert_eq!(file_paths(&second_fields), ["b.txt"]);
    assert_eq!(
        file_paths_from_changes(&second_fields["task_file_changes"]),
        ["a.txt", "b.txt"]
    );
    assert!(second_fields["task_file_changes"]["artifact_id"].is_null());
    assert_eq!(run_git(&repo, ["ls-files", "--stage"], None), initial_index);
    assert!(!home.join("artifacts/task-file-changes").exists());

    let mut restored = tracker(&repo, &home, 40, 403);
    assert!(restored.start());
    fs::remove_file(repo.join("a.txt")).unwrap();
    fs::remove_file(repo.join("b.txt")).unwrap();
    let restored_fields = restored.finalize();
    assert_eq!(file_paths(&restored_fields), ["a.txt", "b.txt"]);
    assert_eq!(restored_fields["task_file_changes"]["status"], "active");
    assert_eq!(restored_fields["task_file_changes"]["files"], json!([]));
    assert_eq!(restored_fields["task_file_changes"]["diff"], "");
}

#[test]
#[cfg(unix)]
fn cumulative_snapshot_preserves_numstat_for_quoted_paths_and_renames() {
    if run_in_isolated_git_process(
        "cumulative_snapshot_preserves_numstat_for_quoted_paths_and_renames",
    ) {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let repo = init_repo(root.path(), true);
    let home = root.path().join("home");
    let modified = "dir b/name\"with\ttab\nand-newline.txt";
    let previous = "old dir/source.txt";
    let renamed = "dir b/renamed\tfile.txt";
    write(repo.join(modified), "before\n");
    write(repo.join(previous), "retained content\n".repeat(20));
    commit_all(&repo, "path baseline");
    let mut capture = tracker(&repo, &home, 44, 441);
    assert!(capture.start());

    write(repo.join(modified), "after\nextra\n");
    fs::rename(repo.join(previous), repo.join(renamed)).unwrap();
    write(
        repo.join(renamed),
        format!("{}added\n", "retained content\n".repeat(20)),
    );
    let fields = capture.finalize();

    for key in ["file_changes", "task_file_changes"] {
        let files = files_by_path(&fields[key]);
        assert_eq!(files[modified]["path"], modified);
        assert_eq!(files[modified]["additions"], 2);
        assert_eq!(files[modified]["deletions"], 1);
        assert_eq!(files[renamed]["old_path"], previous);
        assert_eq!(files[renamed]["change_type"], "renamed");
        assert_eq!(files[renamed]["additions"], 1);
        assert_eq!(files[renamed]["deletions"], 0);
    }
}

#[test]
fn captured_patches_use_standard_paths_and_no_color_despite_git_config() {
    if run_in_isolated_git_process(
        "captured_patches_use_standard_paths_and_no_color_despite_git_config",
    ) {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let path = "backend-rs/nested folder/file.txt";
    for (case, no_prefix, mnemonic, source_prefix, destination_prefix) in [
        ("no-prefix", "true", "true", "", ""),
        ("mnemonic-prefix", "false", "true", "c/", "w/"),
        ("custom-prefix", "false", "false", "old/", "new/"),
    ] {
        let case_root = root.path().join(case);
        let repo = init_repo(&case_root, true);
        let home = case_root.join("home");
        write(repo.join(path), "before\n");
        commit_all(&repo, "format baseline");
        for (key, value) in [
            ("diff.noprefix", no_prefix),
            ("diff.mnemonicPrefix", mnemonic),
            ("diff.srcPrefix", "old/"),
            ("diff.dstPrefix", "new/"),
            ("color.ui", "always"),
            ("color.diff", "always"),
        ] {
            run_git(&repo, ["config", key, value], None);
        }
        let mut capture = tracker(&repo, &home, 45, 451);
        assert!(capture.start());
        write(repo.join(path), "after\n");
        let configured_patch = run_git(&repo, ["diff", "HEAD"], None);
        assert!(configured_patch.contains(&0x1b));
        let configured_paths =
            String::from_utf8(run_git(&repo, ["diff", "--no-color", "HEAD"], None)).unwrap();
        assert!(configured_paths.starts_with(&format!(
            "diff --git {source_prefix}{path} {destination_prefix}{path}\n"
        )));

        let fields = capture.finalize();

        for changes in [&fields["file_changes"], &fields["task_file_changes"]] {
            assert_eq!(file_paths_from_changes(changes), [path]);
            let patch = changes["diff"].as_str().unwrap();
            assert!(patch.starts_with(&format!("diff --git a/{path} b/{path}\n")));
            assert!(patch.contains(&format!("--- a/{path}\t\n+++ b/{path}\t\n")));
            assert!(patch.contains("-before\n+after\n"));
            assert!(!patch.contains('\u{1b}'));
        }
        let full_patch =
            read_gzip(home.join("artifacts/turn-file-changes/45/451/changes.patch.gz"));
        assert_eq!(
            full_patch,
            fields["file_changes"]["diff"].as_str().unwrap().as_bytes()
        );
    }
}

#[test]
fn captured_patches_ignore_external_diff_and_textconv() {
    if run_in_isolated_git_process("captured_patches_ignore_external_diff_and_textconv") {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    for (case, key, command) in [
        ("external", "diff.external", "echo"),
        ("textconv", "diff.capture.textconv", "echo TEXTCONV_ACTIVE"),
    ] {
        assert_capture_ignores_diff_command(&root.path().join(case), key, command);
    }
}

fn assert_capture_ignores_diff_command(root: &Path, key: &str, command: &str) {
    let repo = init_repo(root, true);
    let home = root.join("home");
    let path = "backend-rs/nested folder/file.txt";
    write(repo.join(path), "before\n");
    if key != "diff.external" {
        write(repo.join(".gitattributes"), "*.txt diff=capture\n");
    }
    commit_all(&repo, "diff command baseline");
    let before = String::from_utf8(run_git(&repo, ["rev-parse", "HEAD^{tree}"], None)).unwrap();
    run_git(&repo, ["config", key, command], None);
    let mut capture = tracker(&repo, &home, 46, 461);
    assert!(capture.start());
    write(repo.join(path), "after\n");
    commit_all(&repo, "diff command change");
    let after = String::from_utf8(run_git(&repo, ["rev-parse", "HEAD^{tree}"], None)).unwrap();

    // Prove each configured command replaces the real tree diff contents.
    let configured_patch = String::from_utf8(run_git(
        &repo,
        [
            "diff",
            "--binary",
            "--find-renames",
            before.trim(),
            after.trim(),
        ],
        None,
    ))
    .unwrap();
    assert!(configured_patch.contains(path));
    assert!(!configured_patch.contains("-before\n+after\n"));
    if key == "diff.external" {
        assert!(!configured_patch.starts_with("diff --git "));
    } else {
        assert!(configured_patch.contains("TEXTCONV_ACTIVE"));
    }

    let fields = capture.finalize();

    for key in ["file_changes", "task_file_changes"] {
        let changes = &fields[key];
        assert_eq!(changes["status"], "active");
        assert_eq!(file_paths_from_changes(changes), [path]);
        assert_eq!(changes["additions"], 1);
        assert_eq!(changes["deletions"], 1);
        let patch = changes["diff"].as_str().unwrap();
        assert!(patch.starts_with(&format!("diff --git a/{path} b/{path}\n")));
        assert!(patch.contains("-before\n+after\n"));
    }
    let patch = read_gzip(home.join("artifacts/turn-file-changes/46/461/changes.patch.gz"));
    assert_eq!(
        patch,
        fields["file_changes"]["diff"].as_str().unwrap().as_bytes()
    );
    run_git(&repo, ["apply", "--reverse", "--binary", "-"], Some(&patch));
    assert_eq!(fs::read_to_string(repo.join(path)).unwrap(), "before\n");
}

#[test]
fn cumulative_baseline_survives_git_gc_and_a_new_process() {
    if run_in_isolated_git_process("cumulative_baseline_survives_git_gc_and_a_new_process") {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let repo = init_repo(root.path(), true);
    let home = root.path().join("home");
    write(repo.join("preexisting.txt"), "user dirty\n");
    let mut first = tracker(&repo, &home, 41, 411);
    assert!(first.start());
    write(repo.join("a.txt"), "a\n");
    assert_eq!(file_paths(&first.finalize()), ["a.txt"]);
    drop(first);
    run_git(&repo, ["gc", "--prune=now"], None);

    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "task_baseline::baseline_child_process",
            "--test-threads=1",
        ])
        .env("WEGENT_BASELINE_CONTRACT_ROOT", root.path())
        .status()
        .unwrap();
    assert!(status.success());
    let fields: Value =
        serde_json::from_slice(&fs::read(root.path().join("child-result.json")).unwrap()).unwrap();
    assert_eq!(file_paths(&fields), ["b.txt"]);
    assert_eq!(
        file_paths_from_changes(&fields["task_file_changes"]),
        ["a.txt", "b.txt"]
    );
    assert!(!fields["task_file_changes"]["diff"]
        .as_str()
        .unwrap()
        .contains("preexisting.txt"));
}

#[test]
fn baseline_child_process() {
    let Some(root) = std::env::var_os("WEGENT_BASELINE_CONTRACT_ROOT").map(PathBuf::from) else {
        return;
    };
    let repo = root.join("repo");
    let mut next = tracker(&repo, &root.join("home"), 41, 412);
    assert!(next.start());
    write(repo.join("b.txt"), "b\n");
    fs::write(
        root.join("child-result.json"),
        serde_json::to_vec(&next.finalize()).unwrap(),
    )
    .unwrap();
}

#[test]
fn cumulative_baselines_are_isolated_and_corruption_is_not_reinitialized() {
    if run_in_isolated_git_process(
        "cumulative_baselines_are_isolated_and_corruption_is_not_reinitialized",
    ) {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let repo = init_repo(root.path(), true);
    let home = root.path().join("home");
    let mut first = tracker(&repo, &home, 42, 421);
    assert!(first.start());
    write(repo.join("a.txt"), "a\n");
    first.finalize();

    let mut other_task = tracker(&repo, &home, 43, 431);
    assert!(other_task.start());
    let fields = other_task.finalize();
    assert_eq!(fields["task_file_changes"]["files"], json!([]));

    let reference = String::from_utf8(run_git(
        &repo,
        [
            "for-each-ref",
            "--format=%(refname)",
            "refs/wegent/task-file-changes/42",
        ],
        None,
    ))
    .unwrap();
    let reference = reference.trim();
    let blob = String::from_utf8(run_git(
        &repo,
        ["hash-object", "-w", "--stdin"],
        Some(b"invalid baseline"),
    ))
    .unwrap();
    run_git(&repo, ["update-ref", reference, blob.trim()], None);
    let mut corrupt = tracker(&repo, &home, 42, 422);
    assert!(corrupt.start());
    write(repo.join("b.txt"), "b\n");
    let fields = corrupt.finalize();
    assert_eq!(fields["file_changes"]["status"], "active");
    assert_eq!(fields["task_file_changes"]["status"], "error");
    assert_eq!(fields["task_file_changes"]["files"], json!([]));
    assert_eq!(fields["task_file_changes"]["diff"], "");
    assert_eq!(
        run_git(&repo, ["rev-parse", reference], None),
        blob.as_bytes()
    );

    let other_repo = init_repo(&root.path().join("other"), true);
    let mut isolated = tracker(&other_repo, &home, 42, 423);
    assert!(isolated.start());
    assert_eq!(isolated.finalize()["task_file_changes"]["status"], "active");
}
