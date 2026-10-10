// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};

use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use tar::{Archive, Builder, Header};
use wegent_executor::envd::archive::{
    create_runtime_archive, create_runtime_archive_with_roots, restore_runtime_archive,
    restore_runtime_archive_with_roots, ArchiveMode, ArchiveOptions,
};
use wegent_executor::envd::archive_sessions::SessionArchiveRoots;

#[cfg(unix)]
use std::os::unix::fs::symlink;

#[test]
fn sandbox_archive_restores_user_files_without_including_the_process_home() {
    let temp = tempfile::tempdir().unwrap();
    let runtime_home = temp.path().join("runtime-home");
    let sandbox_home = temp.path().join("sandbox-home");
    let workspace = temp.path().join("workspace/task");
    let roots = SessionArchiveRoots::for_home(&runtime_home);
    write_file(&runtime_home.join(".gvm/gos/compiler"), "image runtime");
    write_file(
        &sandbox_home.join("recovery-marker.txt"),
        "task-only-content",
    );
    write_file(
        &sandbox_home.join("result/presentation.pptx"),
        "task-output",
    );
    fs::create_dir_all(&workspace).unwrap();

    let archive = create_runtime_archive_with_roots(
        ArchiveOptions {
            mode: ArchiveMode::Sandbox,
            task_id: "task".to_owned(),
            workspace_path: workspace,
            home_path: sandbox_home,
            max_size_bytes: 1024 * 1024,
        },
        None,
        &roots,
    )
    .unwrap();
    let names = archive_names(&archive.bytes);
    assert!(names.contains(&"home/recovery-marker.txt".to_owned()));
    assert!(names.contains(&"home/result/presentation.pptx".to_owned()));
    assert!(!names.iter().any(|name| name.contains(".gvm")));

    let restored_home = temp.path().join("restored-sandbox-home");
    let result = restore_runtime_archive_with_roots(
        &archive.bytes,
        ArchiveMode::Sandbox,
        "task",
        &temp.path().join("restored-workspace"),
        &restored_home,
        &SessionArchiveRoots::for_home(&temp.path().join("restored-runtime-home")),
    )
    .unwrap();
    assert!(result.success);
    assert_eq!(
        fs::read_to_string(restored_home.join("recovery-marker.txt")).unwrap(),
        "task-only-content"
    );
    assert_eq!(
        fs::read_to_string(restored_home.join("result/presentation.pptx")).unwrap(),
        "task-output"
    );
    assert!(!restored_home.join(".gvm").exists());
}

#[test]
fn executor_archive_includes_only_task_native_sessions_and_workspace() {
    let root = temp_root("executor-archive");
    let task_id = "1385";
    let workspace = root.join("workspace").join(task_id);
    let home = root.join("home");
    write_file(
        &workspace.join(".claude/workspace-memory.md"),
        "workspace-context",
    );
    let session_file = home
        .join(".wegent-executor/sessions")
        .join(task_id)
        .join(".claude_session_id_987");
    write_file(&session_file, "session-id");
    write_file(
        &home.join(".claude/projects/project/session-id.jsonl"),
        "{\"sessionId\":\"session-id\"}\n",
    );
    write_file(
        &home.join(".codex/sessions/rollout-date-codex-thread-id.jsonl"),
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-thread-id\"}}\n",
    );
    let codex_thread_file = home
        .join(".wegent-executor/sessions")
        .join(task_id)
        .join(".codex_thread_id_654");
    write_file(&codex_thread_file, "codex-thread-id");
    write_file(
        &home.join(".wegent-executor/sessions/other-task/.claude_session_id_987"),
        "other-session",
    );
    write_file(
        &home.join(".wegent-executor/sessions/1385/request.json"),
        "sensitive-runtime-state",
    );
    write_file(&workspace.join(".git/HEAD"), "ref: refs/heads/main");
    write_file(&workspace.join("node_modules/skip.txt"), "skip");
    write_file(&home.join(".claude/home-memory.md"), "home-context");
    write_file(&home.join(".claude.json"), r#"{"theme":"dark"}"#);
    write_file(&home.join("notes.md"), "home-notes");
    write_file(&home.join(".ssh/id_rsa"), "secret");
    write_file(&home.join(".npmrc"), "secret");
    write_file(
        &home.join(".local/share/code-server/cert/tls.crt"),
        "runtime-cert",
    );

    let archive = create_runtime_archive(ArchiveOptions {
        mode: ArchiveMode::Executor,
        task_id: task_id.to_owned(),
        workspace_path: workspace.clone(),
        home_path: home.clone(),
        max_size_bytes: 10 * 1024 * 1024,
    })
    .unwrap();
    let names = archive_names(&archive.bytes);

    assert!(archive.session_file_included);
    assert!(archive.git_included);
    assert!(names.contains(&"workspace/.claude/workspace-memory.md".to_owned()));
    assert!(names.contains(&"executor-state/sessions/1385/.claude_session_id_987".to_owned()));
    assert!(names.contains(&"executor-state/sessions/1385/.codex_thread_id_654".to_owned()));
    assert!(names.contains(&"workspace/.git/HEAD".to_owned()));
    assert!(!names.contains(&"home/.claude/home-memory.md".to_owned()));
    assert!(names.contains(&"native-claude/projects/project/session-id.jsonl".to_owned()));
    assert!(!names.contains(&"home/.claude.json".to_owned()));
    assert!(!names.contains(&"workspace/node_modules/skip.txt".to_owned()));
    assert!(!names.contains(&"home/notes.md".to_owned()));
    assert!(!names.contains(&"home/.ssh/id_rsa".to_owned()));
    assert!(!names.contains(&"home/.npmrc".to_owned()));
    assert!(!names.contains(&"home/.local/share/code-server/cert/tls.crt".to_owned()));
    assert!(!names
        .contains(&"home/.wegent-executor/sessions/other-task/.claude_session_id_987".to_owned()));
    assert!(!names.contains(&"home/.wegent-executor/sessions/1385/request.json".to_owned()));

    fs::remove_dir_all(workspace.join(".claude")).unwrap();
    fs::remove_dir_all(workspace.join(".git")).unwrap();
    fs::remove_dir_all(home.join(".claude")).unwrap();
    fs::remove_file(home.join(".claude.json")).unwrap();
    fs::remove_dir_all(home.join(".wegent-executor")).unwrap();

    let restored = restore_runtime_archive(
        &archive.bytes,
        ArchiveMode::Executor,
        task_id,
        &workspace,
        &home,
    )
    .unwrap();

    assert!(restored.success);
    assert!(restored.session_restored);
    assert!(restored.git_restored);
    assert_eq!(
        fs::read_to_string(workspace.join(".claude/workspace-memory.md")).unwrap(),
        "workspace-context"
    );
    assert_eq!(
        fs::read_to_string(workspace.join(".git/HEAD")).unwrap(),
        "ref: refs/heads/main"
    );
    assert!(home
        .join(".claude/projects/project/session-id.jsonl")
        .is_file());
    assert!(!home.join(".claude.json").exists());
    assert_eq!(
        fs::read_to_string(
            home.join(".wegent/workbench/executor/sessions/1385/.claude_session_id_987")
        )
        .unwrap(),
        "session-id"
    );
    assert_eq!(
        fs::read_to_string(
            home.join(".wegent/workbench/executor/sessions/1385/.codex_thread_id_654")
        )
        .unwrap(),
        "codex-thread-id"
    );
    assert!(!home.join(".wegent-executor/sessions/other-task").exists());
    assert!(!home
        .join(".wegent-executor/sessions/1385/request.json")
        .exists());
}

#[test]
fn sandbox_archive_includes_workspace_and_home_but_excludes_runtime_directories() {
    let root = temp_root("sandbox-archive");
    let workspace = root.join("workspace").join("4680");
    let home = root.join("home");
    write_file(&workspace.join("project.txt"), "workspace-project");
    write_file(&workspace.join("node_modules/skip.txt"), "skip");
    write_file(&home.join("notes.md"), "home-notes");
    write_file(&home.join(".cache/large.bin"), "skip");

    let archive = create_runtime_archive(ArchiveOptions {
        mode: ArchiveMode::Sandbox,
        task_id: "4680".to_owned(),
        workspace_path: workspace.clone(),
        home_path: home.clone(),
        max_size_bytes: 10 * 1024 * 1024,
    })
    .unwrap();
    let names = archive_names(&archive.bytes);

    assert!(names.contains(&"workspace/project.txt".to_owned()));
    assert!(names.contains(&"home/notes.md".to_owned()));
    assert!(!names.contains(&"workspace/node_modules/skip.txt".to_owned()));
    assert!(!names.contains(&"home/.cache/large.bin".to_owned()));

    fs::remove_file(workspace.join("project.txt")).unwrap();
    fs::remove_file(home.join("notes.md")).unwrap();

    restore_runtime_archive(
        &archive.bytes,
        ArchiveMode::Sandbox,
        "4680",
        &workspace,
        &home,
    )
    .unwrap();

    assert_eq!(
        fs::read_to_string(workspace.join("project.txt")).unwrap(),
        "workspace-project"
    );
    assert_eq!(
        fs::read_to_string(home.join("notes.md")).unwrap(),
        "home-notes"
    );
}

#[test]
fn restore_supports_legacy_archive_without_workspace_prefix() {
    let root = temp_root("legacy-archive");
    let workspace = root.join("workspace").join("5728299");
    let home = root.join("home");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&home).unwrap();
    let archive = legacy_archive();

    let restored = restore_runtime_archive(
        &archive,
        ArchiveMode::Executor,
        "5728299",
        &workspace,
        &home,
    )
    .unwrap();

    assert!(restored.success);
    assert!(restored.session_restored);
    assert!(restored.git_restored);
    assert_eq!(
        fs::read_to_string(workspace.join("repo/README.md")).unwrap(),
        "legacy workspace content"
    );
    assert_eq!(
        fs::read_to_string(
            home.join(".wegent/workbench/executor/sessions/5728299/.claude_session_id")
        )
        .unwrap(),
        "legacy-session-id"
    );
    assert_eq!(
        fs::read_to_string(home.join(".claude/home-memory.md")).unwrap(),
        "legacy home memory"
    );
    assert_eq!(
        fs::read_to_string(home.join(".claude.json")).unwrap(),
        r#"{"legacy":true}"#
    );
}

#[test]
fn archive_rejects_missing_workspace_and_max_size_overflow() {
    let root = temp_root("archive-errors");
    let workspace = root.join("workspace").join("3579");
    let home = root.join("home");

    let missing = create_runtime_archive(ArchiveOptions {
        mode: ArchiveMode::Executor,
        task_id: "3579".to_owned(),
        workspace_path: workspace.clone(),
        home_path: home.clone(),
        max_size_bytes: 1024,
    })
    .unwrap_err();
    assert!(missing.to_string().contains("workspace not found"));

    write_file(&workspace.join("keep.txt"), "keep");
    let too_large = create_runtime_archive(ArchiveOptions {
        mode: ArchiveMode::Executor,
        task_id: "3579".to_owned(),
        workspace_path: workspace,
        home_path: home,
        max_size_bytes: 0,
    })
    .unwrap_err();
    assert!(too_large.to_string().contains("archive exceeds"));
}

#[test]
fn restore_skips_unsafe_home_members_from_old_archives() {
    let root = temp_root("unsafe-archive");
    let workspace = root.join("workspace").join("9764");
    let home = root.join("home");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&home).unwrap();
    let archive = archive_with_entries(&[
        ("workspace/keep.txt", "restored"),
        ("home/.local/share/code-server/cert/tls.crt", "runtime-cert"),
        ("home/.ssh/id_rsa", "secret"),
        ("home/.claude/home-memory.md", "claude-home"),
        (
            "home/.wegent-executor/sessions/9764/.claude_session_id_987",
            "invalid session id",
        ),
    ]);

    let restored =
        restore_runtime_archive(&archive, ArchiveMode::Executor, "9764", &workspace, &home)
            .unwrap();

    assert_eq!(
        fs::read_to_string(workspace.join("keep.txt")).unwrap(),
        "restored"
    );
    assert_eq!(
        fs::read_to_string(home.join(".claude/home-memory.md")).unwrap(),
        "claude-home"
    );
    assert!(!home.join(".local/share/code-server").exists());
    assert!(!home.join(".ssh").exists());
    assert!(!restored.session_restored);
    assert!(!home
        .join(".wegent-executor/sessions/9764/.claude_session_id_987")
        .exists());
}

#[cfg(unix)]
#[test]
fn archive_includes_symlink_entries_without_following_targets() {
    let root = temp_root("archive-symlinks");
    let workspace = root.join("workspace").join("2490");
    let home = root.join("home");
    let outside = root.join("outside");
    write_file(&workspace.join("keep.txt"), "keep");
    write_file(&outside.join("secret.txt"), "secret");
    symlink(
        outside.join("secret.txt"),
        workspace.join("secret-link.txt"),
    )
    .unwrap();
    symlink(&workspace, workspace.join("loop")).unwrap();

    let archive = create_runtime_archive(ArchiveOptions {
        mode: ArchiveMode::Sandbox,
        task_id: "2490".to_owned(),
        workspace_path: workspace,
        home_path: home,
        max_size_bytes: 10 * 1024 * 1024,
    })
    .unwrap();
    let names = archive_names(&archive.bytes);

    assert!(names.contains(&"workspace/keep.txt".to_owned()));
    assert!(names.contains(&"workspace/secret-link.txt".to_owned()));
    assert!(names.contains(&"workspace/loop".to_owned()));
    assert!(!names.iter().any(|name| name.starts_with("workspace/loop/")));
}

#[cfg(unix)]
#[test]
fn archive_survives_dangling_symlinks() {
    let root = temp_root("archive-dangling-symlink");
    let workspace = root.join("workspace").join("10170482707511");
    let home = root.join("home");
    write_file(&workspace.join("keep.txt"), "keep");
    fs::create_dir_all(workspace.join(".gitlab")).unwrap();
    symlink(
        workspace.join(".gitlab").join("missing-target.md"),
        workspace.join(".gitlab").join("CLAUDE.md"),
    )
    .unwrap();

    let archive = create_runtime_archive(ArchiveOptions {
        mode: ArchiveMode::Sandbox,
        task_id: "10170482707511".to_owned(),
        workspace_path: workspace,
        home_path: home,
        max_size_bytes: 10 * 1024 * 1024,
    })
    .unwrap();
    let names = archive_names(&archive.bytes);

    assert!(names.contains(&"workspace/keep.txt".to_owned()));
    assert!(names.contains(&"workspace/.gitlab/CLAUDE.md".to_owned()));
}

#[cfg(unix)]
#[test]
fn executor_archive_excludes_symlink_session_markers() {
    let root = temp_root("executor-session-symlink");
    let task_id = "1385";
    let workspace = root.join("workspace").join(task_id);
    let home = root.join("home");
    let marker = home.join(".wegent-executor/sessions/1385/.claude_session_id_987");
    let outside = root.join("outside-session");
    write_file(&workspace.join("keep.txt"), "keep");
    write_file(&outside, "session-id");
    fs::create_dir_all(marker.parent().unwrap()).unwrap();
    symlink(&outside, &marker).unwrap();

    let archive = create_runtime_archive(ArchiveOptions {
        mode: ArchiveMode::Executor,
        task_id: task_id.to_owned(),
        workspace_path: workspace,
        home_path: home,
        max_size_bytes: 10 * 1024 * 1024,
    })
    .unwrap();
    let names = archive_names(&archive.bytes);

    assert!(!archive.session_file_included);
    assert!(!names.contains(&"executor-state/sessions/1385/.claude_session_id_987".to_owned()));
}

fn archive_names(bytes: &[u8]) -> Vec<String> {
    let decoder = GzDecoder::new(Cursor::new(bytes));
    let mut archive = Archive::new(decoder);
    archive
        .entries()
        .unwrap()
        .map(|entry| entry.unwrap().path().unwrap().to_string_lossy().to_string())
        .collect()
}

fn legacy_archive() -> Vec<u8> {
    archive_with_entries(&[
        ("repo/README.md", "legacy workspace content"),
        (".claude_session_id", "legacy-session-id"),
        (
            "__home__/.claude/projects/project/legacy-session-id.jsonl",
            "{\"sessionId\":\"legacy-session-id\"}\n",
        ),
        (".git/HEAD", "ref: refs/heads/main"),
        ("__home__/.claude/home-memory.md", "legacy home memory"),
        ("__home__/.claude.json", r#"{"legacy":true}"#),
    ])
}

fn archive_with_entries(entries: &[(&str, &str)]) -> Vec<u8> {
    let encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut builder = Builder::new(encoder);
    for (path, content) in entries {
        let bytes = content.as_bytes();
        let mut header = Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, *path, Cursor::new(bytes))
            .unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

fn write_file(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn temp_root(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "wegent-executor-envd-{label}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    root
}

#[test]
fn task_sessions_roundtrip_across_home_layouts_for_both_engines_and_runtime_modes() {
    use wegent_executor::envd::{
        archive::{create_runtime_archive_with_roots, restore_runtime_archive_with_roots},
        archive_sessions::SessionArchiveRoots,
    };
    for mode in [ArchiveMode::Executor, ArchiveMode::Sandbox] {
        for claude in [true, false] {
            let source = tempfile::tempdir().unwrap();
            let target = tempfile::tempdir().unwrap();
            let home = source.path().join("home");
            fs::create_dir_all(&home).unwrap();
            let mut roots = SessionArchiveRoots::for_home(&home);
            roots.executor = home.join("mounted-executor");
            roots.workbench = home.join("mounted-workbench");
            let agent = roots.workbench.join("agents/test-user/default/agent");
            let marker = if claude {
                ".claude_session_id_1"
            } else {
                ".codex_thread_id_1"
            };
            let transcript = if claude {
                "projects/project/session-1.jsonl"
            } else {
                "sessions/2026/09/23/rollout-date-session-1.jsonl"
            };
            let record = if claude {
                "{\"sessionId\":\"session-1\"}\n"
            } else {
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"session-1\"}}\n"
            };
            write_file(
                &roots.executor.join("sessions/42").join(marker),
                "session-1",
            );
            write_file(&agent.join("agent.json"), "{}");
            write_file(&agent.join("runtime/tasks/42.json"), "{\"task_id\":\"42\"}");
            write_file(&agent.join(transcript), record);
            write_file(&agent.join("auth.json"), "not-for-backup");
            write_file(
                &agent.join("projects/project/other-session.jsonl"),
                "not-for-backup",
            );
            write_file(&source.path().join("workspace/README.md"), "task code");
            let options = ArchiveOptions {
                mode,
                task_id: "42".into(),
                workspace_path: source.path().join("workspace"),
                home_path: home,
                max_size_bytes: 1_000_000,
            };
            let archive = create_runtime_archive_with_roots(options.clone(), None, &roots).unwrap();
            assert!(archive.session_file_included);
            let names = archive_names(&archive.bytes);
            assert!(!names
                .iter()
                .any(|name| name.contains("auth.json") || name.contains("other-session")));
            let restored_roots = SessionArchiveRoots::for_home(target.path());
            let result = restore_runtime_archive_with_roots(
                &archive.bytes,
                mode,
                "42",
                &target.path().join("workspace"),
                target.path(),
                &restored_roots,
            )
            .unwrap();
            assert!(result.session_restored);
            assert_eq!(
                fs::read_to_string(restored_roots.executor.join("sessions/42").join(marker))
                    .unwrap(),
                "session-1"
            );
            assert_eq!(
                fs::read_to_string(
                    restored_roots
                        .workbench
                        .join("agents/test-user/default/agent")
                        .join(transcript)
                )
                .unwrap(),
                record
            );
            assert_eq!(
                fs::read_to_string(target.path().join("workspace/README.md")).unwrap(),
                "task code"
            );
            // A recorded ID without a valid native conversation must never produce a backup.
            fs::remove_file(agent.join(transcript)).unwrap();
            assert!(
                create_runtime_archive_with_roots(options.clone(), None, &roots)
                    .unwrap_err()
                    .to_string()
                    .contains("incomplete")
            );
            write_file(&agent.join(transcript), "{\"sessionId\":\"wrong\"}\n");
            assert!(create_runtime_archive_with_roots(options, None, &roots).is_err());
        }
    }
}

#[test]
fn restore_rejects_a_session_marker_without_its_native_conversation() {
    let root = tempfile::tempdir().unwrap();
    let archive = archive_with_entries(&[(
        "executor-state/sessions/42/.claude_session_id_1",
        "missing-session",
    )]);
    let error = restore_runtime_archive(
        &archive,
        ArchiveMode::Sandbox,
        "42",
        &root.path().join("workspace"),
        root.path(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("incomplete"));
}

#[test]
fn repository_restore_rejects_unsafe_bindings_and_existing_checkouts() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace/42");
    for key in ["../outside", "/outside", ".wegent/tasks", "42", "42/demo"] {
        let metadata = serde_json::json!({"key": key, "name": "demo"}).to_string();
        let archive = archive_with_entries(&[
            ("repository-binding.json", &metadata),
            ("workspace/demo/README.md", "must not write"),
        ]);
        assert!(
            restore_runtime_archive(
                &archive,
                ArchiveMode::Executor,
                "42",
                &workspace,
                &root.path().join("home")
            )
            .is_err(),
            "accepted {key}"
        );
    }
    let repository = root.path().join("workspace/demo-12345678");
    write_file(&repository.join("README.md"), "existing content");
    let archive = archive_with_entries(&[
        (
            "repository-binding.json",
            r#"{"key":"demo-12345678","name":"demo"}"#,
        ),
        ("workspace/demo/README.md", "replacement"),
    ]);
    assert!(restore_runtime_archive(
        &archive,
        ArchiveMode::Executor,
        "42",
        &workspace,
        &root.path().join("home")
    )
    .is_err());
    assert_eq!(
        fs::read_to_string(repository.join("README.md")).unwrap(),
        "existing content"
    );
}

#[cfg(unix)]
#[test]
fn repository_restore_rejects_symlink_parents() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join("workspace")).unwrap();
    symlink(outside.path(), root.path().join("workspace/projects")).unwrap();
    let archive = archive_with_entries(&[
        (
            "repository-binding.json",
            r#"{"key":"projects/demo-12345678","name":"demo"}"#,
        ),
        ("workspace/demo/README.md", "must not write"),
    ]);
    assert!(restore_runtime_archive(
        &archive,
        ArchiveMode::Executor,
        "42",
        &root.path().join("workspace/42"),
        &root.path().join("home")
    )
    .is_err());
    assert!(!outside.path().join("demo-12345678").exists());
}

#[cfg(unix)]
#[test]
fn restore_rejects_a_symlink_inside_an_agent_home() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let agent = root
        .path()
        .join(".wegent/workbench/agents/test/default/agent");
    fs::create_dir_all(&agent).unwrap();
    symlink(outside.path(), agent.join("projects")).unwrap();
    let archive = archive_with_entries(&[(
        "agent-homes/test/default/agent/projects/session.jsonl",
        "private",
    )]);
    assert!(restore_runtime_archive(
        &archive,
        ArchiveMode::Sandbox,
        "42",
        &root.path().join("workspace"),
        root.path()
    )
    .is_err());
    assert!(!outside.path().join("session.jsonl").exists());
}
