// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn credentials(user: &str, token: &str) -> GitCredentials {
    GitCredentials {
        username: user.into(),
        token: token.into(),
    }
}

#[test]
fn different_accounts_and_rotations_reuse_only_the_secret_free_script() {
    let root = tempfile::tempdir().unwrap();
    let one = environment_at(
        root.path(),
        "github.com",
        &credentials("one", "synthetic-one"),
    )
    .unwrap();
    let two = environment_at(
        root.path(),
        "gitlab.example",
        &credentials("two", "synthetic-two"),
    )
    .unwrap();
    let rotated = environment_at(
        root.path(),
        "github.com",
        &credentials("one", "synthetic-new"),
    )
    .unwrap();
    assert_eq!(one["GIT_ASKPASS"], two["GIT_ASKPASS"]);
    assert_eq!(one["GIT_ASKPASS"], rotated["GIT_ASKPASS"]);
    assert_eq!(one["GH_TOKEN"], "synthetic-one");
    assert_eq!(two["GITLAB_TOKEN"], "synthetic-two");
    assert_eq!(rotated["GH_TOKEN"], "synthetic-new");
    assert_eq!(fs::read(&one["GIT_ASKPASS"]).unwrap(), SCRIPT);
    assert_eq!(
        fs::read_dir(root.path().join("runtime/git-auth"))
            .unwrap()
            .count(),
        1
    );
    let dev = tempfile::tempdir().unwrap();
    let isolated = environment_at(
        dev.path(),
        "github.com",
        &credentials("dev", "synthetic-dev"),
    )
    .unwrap();
    assert_ne!(one["GIT_ASKPASS"], isolated["GIT_ASKPASS"]);
}

#[test]
fn concurrent_publication_preserves_one_complete_script() {
    let root = tempfile::tempdir().unwrap();
    std::thread::scope(|scope| {
        let runs: Vec<_> = (0..4)
            .map(|_| scope.spawn(|| ensure_script(root.path()).unwrap()))
            .collect();
        for run in runs {
            assert_eq!(fs::read(run.join().unwrap()).unwrap(), SCRIPT);
        }
    });
    assert_eq!(
        fs::read_dir(root.path().join("runtime/git-auth"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn unexpected_existing_helper_is_not_overwritten() {
    let root = tempfile::tempdir().unwrap();
    let script = ensure_script(root.path()).unwrap();
    fs::write(&script, "unmanaged file").unwrap();
    assert!(ensure_script(root.path()).is_err());
    assert_eq!(fs::read_to_string(script).unwrap(), "unmanaged file");
}

#[cfg(unix)]
#[test]
fn symlink_helper_is_rejected_without_touching_its_target() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let script = ensure_script(root.path()).unwrap();
    fs::remove_file(&script).unwrap();
    fs::write(outside.path().join("untouched"), "user file").unwrap();
    std::os::unix::fs::symlink(outside.path().join("untouched"), &script).unwrap();
    assert!(ensure_script(root.path()).is_err());
    assert_eq!(
        fs::read_to_string(outside.path().join("untouched")).unwrap(),
        "user file"
    );
}

#[cfg(unix)]
#[test]
fn git_credential_fill_uses_each_process_environment_without_secret_files() {
    use std::process::{Command, Stdio};
    let root = tempfile::tempdir().unwrap();
    let first = environment_at(
        root.path(),
        "github.com",
        &credentials("one", "synthetic-$'one"),
    )
    .unwrap();
    let second = environment_at(
        root.path(),
        "gitlab.example",
        &credentials("two", "synthetic-two"),
    )
    .unwrap();
    std::thread::scope(|scope| {
        let runs: Vec<_> = [
            (first, "github.com", "one", "synthetic-$'one"),
            (second, "gitlab.example", "two", "synthetic-two"),
        ]
        .into_iter()
        .map(|(values, domain, user, token)| {
            let home = root.path();
            scope.spawn(move || {
                let mut child = Command::new("git")
                    .env_clear()
                    .env("PATH", std::env::var_os("PATH").unwrap())
                    .env("HOME", home)
                    .env("XDG_CONFIG_HOME", home)
                    .env("GIT_CONFIG_NOSYSTEM", "1")
                    .envs(values)
                    .args(["-c", "credential.helper=", "credential", "fill"])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap();
                writeln!(
                    child.stdin.take().unwrap(),
                    "protocol=https\nhost={domain}\n"
                )
                .unwrap();
                let output = child.wait_with_output().unwrap();
                assert!(output.status.success());
                let output = String::from_utf8(output.stdout).unwrap();
                assert!(output
                    .lines()
                    .any(|line| line == format!("username={user}")));
                assert!(output
                    .lines()
                    .any(|line| line == format!("password={token}")));
            })
        })
        .collect();
        for run in runs {
            run.join().unwrap();
        }
    });
    assert_eq!(
        fs::read_dir(root.path().join("runtime/git-auth"))
            .unwrap()
            .count(),
        1
    );
}
