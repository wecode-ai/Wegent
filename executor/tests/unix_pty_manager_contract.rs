// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#![cfg(unix)]

use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use tokio::sync::Notify;
use wegent_executor::local::pty::UnixPtyManager;

#[tokio::test]
async fn unix_pty_manager_notifies_when_output_is_ready() {
    let manager = UnixPtyManager::new();
    let mut process = manager
        .spawn(
            &["/bin/sh", "-lc", "sleep 0.05; printf ready; exit 0"],
            Some(&unique_dir("pty-notify")),
            &[],
            24,
            80,
        )
        .unwrap();
    let notifier = Arc::new(Notify::new());
    process.set_event_notifier(Arc::clone(&notifier));

    tokio::time::timeout(Duration::from_secs(1), notifier.notified())
        .await
        .expect("PTY output should notify the event loop");

    let output = read_until_contains(&mut process, "ready", Duration::from_secs(1));
    assert!(output.contains("ready"));
    assert_eq!(
        process.wait_timeout(Duration::from_secs(1)).unwrap(),
        Some(0)
    );
    process.close();
}

#[test]
fn unix_pty_manager_spawns_process_with_term_env_cwd_and_bounded_read() {
    let manager = UnixPtyManager::new();
    assert!(manager.is_available());
    let cwd = unique_dir("pty-spawn");
    let home = std::env::var("HOME").unwrap();

    let mut process = manager
        .spawn(
            &[
                "/bin/sh",
                "-lc",
                "printf 'ready:%s:%s:%s' \"$TERM\" \"$CUSTOM_ENV\" \"$PWD\"; exit 0",
            ],
            Some(&cwd),
            &[
                ("PATH", "/bin"),
                ("HOME", home.as_str()),
                ("CUSTOM_ENV", "contract"),
            ],
            30,
            100,
        )
        .unwrap();

    assert!(process.pid() > 0);
    process.resize(40, 120).unwrap();
    let output = read_until_contains(
        &mut process,
        "ready:xterm-256color:contract:",
        Duration::from_secs(2),
    );
    assert!(output.contains("ready:xterm-256color:contract:"));
    assert!(output.contains(cwd.to_str().unwrap()));
    assert_eq!(
        process.wait_timeout(Duration::from_secs(2)).unwrap(),
        Some(0)
    );
    process.close();
}

#[test]
fn unix_pty_manager_replaces_inherited_environment() {
    const CHILD_MARKER: &str = "WEGENT_TEST_PTY_ENV_CHILD";
    const PARENT_ONLY_ENV: &str = "WEGENT_TEST_PTY_PARENT_ONLY";

    if std::env::var(CHILD_MARKER).as_deref() == Ok("1") {
        let manager = UnixPtyManager::new();
        let mut process = manager
            .spawn(
                &["/usr/bin/env"],
                Some(&unique_dir("pty-environment")),
                &[("PATH", "/usr/bin:/bin"), ("CUSTOM_ENV", "contract")],
                24,
                80,
            )
            .unwrap();

        let output =
            read_until_contains(&mut process, "CUSTOM_ENV=contract", Duration::from_secs(2));
        assert!(output.contains("CUSTOM_ENV=contract"));
        assert!(!output.contains("BASH_FUNC_which%%"));
        assert!(!output.contains(PARENT_ONLY_ENV));
        assert_eq!(
            process.wait_timeout(Duration::from_secs(2)).unwrap(),
            Some(0)
        );
        process.close();
        return;
    }

    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "unix_pty_manager_replaces_inherited_environment",
            "--nocapture",
        ])
        .env(CHILD_MARKER, "1")
        .env(PARENT_ONLY_ENV, "must-not-leak")
        .env("BASH_FUNC_which%%", "() {")
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn unix_pty_manager_spawn_uses_single_session_creation_strategy() {
    let manager = UnixPtyManager::new();
    let mut process = manager
        .spawn(
            &["/bin/sh", "-lc", "exit 0"],
            Some(&unique_dir("pty-exit")),
            &[],
            24,
            80,
        )
        .unwrap();

    assert!(process.pid() > 0);
    assert_eq!(
        process.wait_timeout(Duration::from_secs(2)).unwrap(),
        Some(0)
    );
    process.close();
}

#[test]
fn unix_pty_manager_observes_shell_exit_while_background_process_holds_pty() {
    let manager = UnixPtyManager::new();
    let mut process = manager
        .spawn(
            &["/bin/sh", "-lc", "sleep 30 & exit 0"],
            Some(&unique_dir("pty-background-child")),
            &[],
            24,
            80,
        )
        .unwrap();

    assert_eq!(
        process.wait_timeout(Duration::from_secs(2)).unwrap(),
        Some(0)
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    while !process.output_closed() && Instant::now() < deadline {
        let _ = process.read_available(Duration::from_millis(50));
    }
    assert!(process.output_closed());
    process.close();
}

#[test]
fn unix_pty_manager_write_wrapper_sends_input_without_blocking_test() {
    let manager = UnixPtyManager::new();
    let mut process = manager
        .spawn(
            &[
                "/bin/sh",
                "-lc",
                "IFS= read line; printf 'echo:%s' \"$line\"",
            ],
            Some(&unique_dir("pty-write")),
            &[],
            24,
            80,
        )
        .unwrap();

    assert_eq!(process.write(b"pwd\r").unwrap(), 4);
    let output = read_until_contains(&mut process, "echo:pwd", Duration::from_secs(2));
    assert!(output.contains("echo:pwd"));
    assert_eq!(
        process.wait_timeout(Duration::from_secs(2)).unwrap(),
        Some(0)
    );
    process.close();
}

fn read_until_contains(
    process: &mut wegent_executor::local::pty::UnixPtyProcess,
    needle: &str,
    timeout: Duration,
) -> String {
    let deadline = Instant::now() + timeout;
    let mut output = String::new();
    while Instant::now() < deadline {
        if let Some(chunk) = process.read_available(Duration::from_millis(100)).unwrap() {
            output.push_str(&String::from_utf8_lossy(&chunk));
            if output.contains(needle) {
                return output;
            }
        }
    }
    output
}

fn unique_dir(prefix: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("{prefix}-{suffix}"));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}
