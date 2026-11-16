// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::HashMap, path::Path, process::Command, time::Duration};

use serde_json::{json, Value};
use wegent_executor::local::{
    app_ipc::AppIpcServer,
    command::build_env,
    native_git::{clear_local_git_env, run_git_capture},
};

fn git(cwd: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    clear_local_git_env(&mut command);
    let output = command.args(args).current_dir(cwd).output().unwrap();
    assert!(output.status.success(), "{args:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn repository() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "--bare", "origin.git"]);
    git(root.path(), &["init", "work"]);
    let repo = root.path().join("work");
    git(&repo, &["checkout", "-b", "feature/topic"]);
    git(&repo, &["config", "user.name", "Git portability test"]);
    git(&repo, &["config", "user.email", "git-test@example.invalid"]);
    std::fs::write(repo.join("README.md"), "Git portability\n").unwrap();
    git(&repo, &["add", "README.md"]);
    git(&repo, &["commit", "-m", "test: initial commit"]);
    git(
        &repo,
        &[
            "remote",
            "add",
            "origin",
            root.path().join("origin.git").to_str().unwrap(),
        ],
    );
    root
}

async fn push(repo: &Path) -> Value {
    let env = HashMap::from([
        ("PATH".to_owned(), std::env::var("PATH").unwrap()),
        ("WEWORK_RUNTIME_BIN".to_owned(), String::new()),
        ("WEGENT_EXTRA_PATHS".to_owned(), String::new()),
    ]);
    let version = run_git_capture(
        &["--version".to_owned()],
        Some(repo),
        &build_env(&env),
        Duration::from_secs(10),
        4096,
    )
    .await
    .unwrap();
    assert!(version.success);
    let version = String::from_utf8(version.stdout).unwrap().trim().to_owned();
    assert_eq!(version, git(repo, &["--version"]));
    eprintln!("Native push Git: {version}");
    let response = AppIpcServer::new()
        .handle_line(
            &json!({
                "type": "request",
                "id": "portable-push",
                "method": "device.execute_command",
                "params": {"command_key": "git_push", "path": repo, "env": env}
            })
            .to_string(),
        )
        .await
        .unwrap();
    assert_eq!(response["ok"], true, "{response}");
    response["result"].clone()
}

#[tokio::test]
async fn native_push_publishes_branch_and_sets_upstream() {
    let root = repository();
    let repo = root.path().join("work");
    let result = push(&repo).await;
    assert_eq!(result["success"], true, "{result}");
    assert_eq!(
        git(&repo, &["rev-parse", "--abbrev-ref", "@{u}"]),
        "origin/feature/topic"
    );
    assert_eq!(
        git(
            &root.path().join("origin.git"),
            &["rev-parse", "refs/heads/feature/topic"]
        ),
        git(&repo, &["rev-parse", "HEAD"])
    );
}

#[tokio::test]
async fn native_push_rejects_detached_head_without_publishing() {
    let root = repository();
    let repo = root.path().join("work");
    git(&repo, &["checkout", "--detach"]);
    let result = push(&repo).await;
    assert_eq!(result["success"], false);
    assert_eq!(result["exit_code"], 64);
    assert_eq!(result["stderr"], "Cannot push detached HEAD");
    assert_eq!(
        git(
            &root.path().join("origin.git"),
            &["for-each-ref", "refs/heads/"]
        ),
        ""
    );
}

#[tokio::test]
async fn native_push_preserves_remote_failure() {
    let root = repository();
    let repo = root.path().join("work");
    git(&repo, &["remote", "remove", "origin"]);
    let result = push(&repo).await;
    assert_eq!(result["success"], false);
    assert!(
        result["stderr"].as_str().unwrap().contains("origin"),
        "{result}"
    );
    assert_ne!(result["stderr"], "Cannot push detached HEAD");
}
