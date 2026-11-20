// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

struct Holder(Child);

impl Drop for Holder {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn command(paths: &[PathBuf]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_wegent-executor"));
    command.args([
        "--workbench-lock",
        &serde_json::to_string(paths).unwrap(),
        "--version",
    ]);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn hold(paths: &[PathBuf]) -> Holder {
    let mut holder = Holder(command(paths).spawn().unwrap());
    let mut line = String::new();
    BufReader::new(holder.0.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&line).unwrap(),
        serde_json::json!({"protocol_version": 1, "locked": true})
    );
    holder
}

#[test]
fn locks_exclude_other_processes_and_release_on_kill_without_deleting_files() {
    let root = tempfile::tempdir().unwrap();
    let paths = vec![
        root.path().join("source.lock"),
        root.path().join("target.lock"),
    ];
    let mut first = hold(&paths);
    let rejected = command(&[paths[0].clone(), root.path().join("other-state.lock")])
        .output()
        .unwrap();
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("lock unavailable"));
    let independent = hold(&[root.path().join("unrelated.lock")]);
    drop(independent);
    first.0.kill().unwrap();
    first.0.wait().unwrap();
    assert!(paths.iter().all(|path| path.is_file()));
    let mut recovered = hold(&paths);
    drop(recovered.0.stdin.take());
    assert!(recovered.0.wait().unwrap().success());
    assert!(paths.iter().all(|path| path.is_file()));
}

#[test]
fn partial_acquisition_failure_releases_earlier_locks() {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("a.lock");
    let occupied = root.path().join("z.lock");
    let _holder = hold(std::slice::from_ref(&occupied));
    assert!(!command(&[first.clone(), occupied])
        .output()
        .unwrap()
        .status
        .success());
    let _recovered = hold(&[first]);
}

#[test]
fn waiting_launch_acquires_the_same_locks_after_the_previous_holder_releases() {
    let root = tempfile::tempdir().unwrap();
    let paths = vec![root.path().join("desktop.lock")];
    let first = hold(&paths);
    let mut waiting_command = command(&paths);
    waiting_command.arg("--workbench-lock-wait");
    let mut waiting = Holder(waiting_command.spawn().unwrap());
    let stdout = waiting.0.stdout.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut line = String::new();
        BufReader::new(stdout).read_line(&mut line).unwrap();
        sender.send(line).unwrap();
    });
    assert!(matches!(
        receiver.recv_timeout(Duration::from_millis(100)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    drop(first);
    let line = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&line).unwrap(),
        serde_json::json!({"protocol_version": 1, "locked": true})
    );
    reader.join().unwrap();
    drop(waiting.0.stdin.take());
    assert!(waiting.0.wait().unwrap().success());
    assert!(paths[0].is_file());
}

#[test]
fn rejects_relative_lock_paths() {
    let output = command(&[PathBuf::from("relative.lock")]).output().unwrap();
    assert!(!output.status.success());
}

#[cfg(unix)]
#[test]
fn rejects_symlink_lock_files() {
    let root = tempfile::tempdir().unwrap();
    let original = root.path().join("original");
    std::fs::write(&original, "unchanged").unwrap();
    let alias = root.path().join("alias.lock");
    std::os::unix::fs::symlink(&original, &alias).unwrap();
    assert!(!command(&[alias]).output().unwrap().status.success());
    assert_eq!(std::fs::read_to_string(original).unwrap(), "unchanged");
}
