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
    create_runtime_archive, restore_runtime_archive, ArchiveMode, ArchiveOptions,
};

#[cfg(unix)]
use std::os::unix::fs::symlink;

#[test]
fn executor_archive_includes_workspace_and_sanitized_claude_home() {
    let root = temp_root("executor-archive");
    let workspace = root.join("workspace").join("1385");
    let home = root.join("home");
    write_file(
        &workspace.join(".claude/workspace-memory.md"),
        "workspace-context",
    );
    write_file(&workspace.join(".claude_session_id"), "session-id");
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
        workspace_path: workspace.clone(),
        home_path: home.clone(),
        max_size_bytes: 10 * 1024 * 1024,
    })
    .unwrap();
    let names = archive_names(&archive.bytes);

    assert!(archive.session_file_included);
    assert!(archive.git_included);
    assert!(names.contains(&"workspace/.claude/workspace-memory.md".to_owned()));
    assert!(names.contains(&"workspace/.claude_session_id".to_owned()));
    assert!(names.contains(&"workspace/.git/HEAD".to_owned()));
    assert!(names.contains(&"home/.claude/home-memory.md".to_owned()));
    assert!(names.contains(&"home/.claude.json".to_owned()));
    assert!(!names.contains(&"workspace/node_modules/skip.txt".to_owned()));
    assert!(!names.contains(&"home/notes.md".to_owned()));
    assert!(!names.contains(&"home/.ssh/id_rsa".to_owned()));
    assert!(!names.contains(&"home/.npmrc".to_owned()));
    assert!(!names.contains(&"home/.local/share/code-server/cert/tls.crt".to_owned()));

    fs::remove_dir_all(workspace.join(".claude")).unwrap();
    fs::remove_file(workspace.join(".claude_session_id")).unwrap();
    fs::remove_dir_all(workspace.join(".git")).unwrap();
    fs::remove_dir_all(home.join(".claude")).unwrap();
    fs::remove_file(home.join(".claude.json")).unwrap();

    let restored =
        restore_runtime_archive(&archive.bytes, ArchiveMode::Executor, &workspace, &home).unwrap();

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
    assert_eq!(
        fs::read_to_string(home.join(".claude/home-memory.md")).unwrap(),
        "home-context"
    );
    assert_eq!(
        fs::read_to_string(home.join(".claude.json")).unwrap(),
        r#"{"theme":"dark"}"#
    );
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

    restore_runtime_archive(&archive.bytes, ArchiveMode::Sandbox, &workspace, &home).unwrap();

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

    let restored =
        restore_runtime_archive(&archive, ArchiveMode::Executor, &workspace, &home).unwrap();

    assert!(restored.success);
    assert!(restored.session_restored);
    assert!(restored.git_restored);
    assert_eq!(
        fs::read_to_string(workspace.join("repo/README.md")).unwrap(),
        "legacy workspace content"
    );
    assert_eq!(
        fs::read_to_string(workspace.join(".claude_session_id")).unwrap(),
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
        workspace_path: workspace.clone(),
        home_path: home.clone(),
        max_size_bytes: 1024,
    })
    .unwrap_err();
    assert!(missing.to_string().contains("workspace not found"));

    write_file(&workspace.join("keep.txt"), "keep");
    let too_large = create_runtime_archive(ArchiveOptions {
        mode: ArchiveMode::Executor,
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
    ]);

    restore_runtime_archive(&archive, ArchiveMode::Executor, &workspace, &home).unwrap();

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
        workspace_path: workspace,
        home_path: home,
        max_size_bytes: 10 * 1024 * 1024,
    })
    .unwrap();
    let names = archive_names(&archive.bytes);

    assert!(names.contains(&"workspace/keep.txt".to_owned()));
    assert!(names.contains(&"workspace/.gitlab/CLAUDE.md".to_owned()));
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
