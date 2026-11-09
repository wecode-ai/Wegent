// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::TIMEOUT;
use std::time::Duration;

pub(super) async fn wait_for_process_exit(pid: i32) {
    tokio::time::timeout(TIMEOUT, async {
        // Signal zero only checks process existence.
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("suspended Codex process {pid} was not reaped"));
}

#[cfg(not(target_os = "linux"))]
pub(super) async fn wait_for_tool_child_exit(pid: i32) {
    wait_for_process_exit(pid).await;
}

#[cfg(target_os = "linux")]
pub(super) async fn wait_for_tool_child_exit(pid: i32) {
    let status = tokio::time::timeout(TIMEOUT, async {
        loop {
            let mut status = 0;
            match unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) } {
                0 => tokio::time::sleep(Duration::from_millis(10)).await,
                waited if waited == pid => break status,
                _ => panic!(
                    "waitpid for adopted tool child {pid}: {}",
                    std::io::Error::last_os_error()
                ),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("tool child {pid} did not terminate after cancellation"));
    assert!(libc::WIFSIGNALED(status));
    assert!(matches!(
        libc::WTERMSIG(status),
        libc::SIGTERM | libc::SIGKILL
    ));
    assert_eq!(
        unsafe { libc::kill(pid, 0) },
        -1,
        "tool child {pid} was not reaped"
    );
}

// A Linux runner's PID 1 need not reap orphans. Adopt the test's tool child
// after app-server exits so the assertion does not depend on the host's init.
#[cfg(target_os = "linux")]
pub(super) struct ChildSubreaper(libc::c_int);

#[cfg(target_os = "linux")]
impl ChildSubreaper {
    pub(super) fn install() -> Self {
        let mut previous = 0;
        let result = unsafe {
            libc::prctl(
                libc::PR_GET_CHILD_SUBREAPER,
                &mut previous as *mut libc::c_int,
                0_usize,
                0_usize,
                0_usize,
            )
        };
        assert_eq!(
            result,
            0,
            "get child subreaper: {}",
            std::io::Error::last_os_error()
        );
        let result = unsafe {
            libc::prctl(
                libc::PR_SET_CHILD_SUBREAPER,
                1_usize,
                0_usize,
                0_usize,
                0_usize,
            )
        };
        assert_eq!(
            result,
            0,
            "set child subreaper: {}",
            std::io::Error::last_os_error()
        );
        Self(previous)
    }
}

#[cfg(target_os = "linux")]
impl Drop for ChildSubreaper {
    fn drop(&mut self) {
        unsafe {
            libc::prctl(
                libc::PR_SET_CHILD_SUBREAPER,
                self.0 as libc::c_ulong,
                0_usize,
                0_usize,
                0_usize,
            );
        }
    }
}

pub(super) struct ProcessCleanup(pub(super) Vec<i32>);

impl Drop for ProcessCleanup {
    fn drop(&mut self) {
        // Clean up test-owned processes even if an assertion fails.
        for pid in &self.0 {
            unsafe {
                libc::kill(*pid, libc::SIGKILL);
            }
        }
    }
}
