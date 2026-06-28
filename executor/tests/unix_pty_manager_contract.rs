// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#![cfg(unix)]

use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use wegent_executor::local::pty::UnixPtyManager;

#[test]
fn unix_pty_manager_spawns_process_with_term_env_cwd_and_bounded_read() {
    let manager = UnixPtyManager::new();
    assert!(manager.is_available());
    let cwd = unique_dir("pty-spawn");

    let mut process = manager
        .spawn(
            &[
                "/bin/sh",
                "-lc",
                "printf 'ready:%s:%s:%s' \"$TERM\" \"$CUSTOM_ENV\" \"$PWD\"; exit 0",
            ],
            Some(&cwd),
            &[("PATH", "/bin"), ("CUSTOM_ENV", "contract")],
            30,
            100,
        )
        .unwrap();

    assert!(process.pid() > 0);
    process.resize(40, 120).unwrap();
    let output = process
        .read_available(Duration::from_secs(2))
        .unwrap()
        .expect("expected PTY output before timeout");
    let output = String::from_utf8_lossy(&output);
    assert!(output.contains("ready:xterm-256color:contract:"));
    assert!(output.contains(cwd.to_str().unwrap()));
    assert_eq!(
        process.wait_timeout(Duration::from_secs(2)).unwrap(),
        Some(0)
    );
    process.close();
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
