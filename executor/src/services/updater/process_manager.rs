// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

const DEFAULT_GRACEFUL_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub start_time: f64,
    pub version: String,
}

impl ProcessInfo {
    pub fn new(pid: u32, start_time: f64, version: &str) -> Self {
        Self {
            pid,
            start_time,
            version: version.to_owned(),
        }
    }
}

pub trait ProcessOperations: std::fmt::Debug + Send + Sync {
    fn current_pid(&self) -> u32;
    fn is_process_alive(&self, pid: u32) -> bool;
    fn terminate_gracefully(&self, pid: u32) -> bool;
    fn terminate_forcefully(&self, pid: u32) -> bool;
}

#[derive(Debug, Clone)]
pub struct ProcessManager {
    pid_file: PathBuf,
    operations: Arc<dyn ProcessOperations>,
}

impl Default for ProcessManager {
    fn default() -> Self {
        Self::for_pid_file(home_dir().join(".wegent-executor").join("executor.pid"))
    }
}

impl ProcessManager {
    pub fn for_pid_file(pid_file: PathBuf) -> Self {
        Self::with_operations(pid_file, Arc::new(DefaultProcessOperations))
    }

    pub fn with_operations(pid_file: PathBuf, operations: Arc<dyn ProcessOperations>) -> Self {
        Self {
            pid_file,
            operations,
        }
    }

    pub fn write_pid_file(&self, version: &str) -> bool {
        let Some(parent) = self.pid_file.parent() else {
            return false;
        };
        if fs::create_dir_all(parent).is_err() {
            return false;
        }

        let info = ProcessInfo::new(
            self.operations.current_pid(),
            unix_timestamp_seconds(),
            version,
        );
        let Ok(json) = serde_json::to_string(&info) else {
            return false;
        };
        if fs::write(&self.pid_file, json).is_err() {
            return false;
        }
        set_owner_only_permissions(&self.pid_file).is_ok()
    }

    pub fn remove_pid_file(&self) -> bool {
        match fs::remove_file(&self.pid_file) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(_) => false,
        }
    }

    pub fn read_pid_file(&self) -> Option<ProcessInfo> {
        let contents = fs::read_to_string(&self.pid_file).ok()?;
        match serde_json::from_str::<ProcessInfo>(&contents) {
            Ok(info) => Some(info),
            Err(_) => {
                let _ = fs::remove_file(&self.pid_file);
                None
            }
        }
    }

    pub fn is_running(&self, info: &ProcessInfo) -> bool {
        self.operations.is_process_alive(info.pid)
    }

    pub fn was_running(&self) -> Option<ProcessInfo> {
        let info = self.read_pid_file()?;
        if info.pid == self.operations.current_pid() {
            return None;
        }
        if self.is_running(&info) {
            return Some(info);
        }

        let _ = self.remove_pid_file();
        None
    }

    pub fn terminate_process(&self, pid: u32, timeout_millis: u64) -> bool {
        if pid == self.operations.current_pid() {
            return false;
        }
        if !self.operations.is_process_alive(pid) {
            return true;
        }

        if !self.operations.terminate_gracefully(pid) && !self.operations.is_process_alive(pid) {
            return true;
        }

        let timeout = if timeout_millis == 0 {
            Duration::ZERO
        } else {
            Duration::from_millis(timeout_millis)
        };
        if self.wait_until_dead(pid, timeout) {
            return true;
        }

        if !self.operations.terminate_forcefully(pid) {
            return false;
        }
        self.wait_until_dead(pid, Duration::from_millis(100))
    }

    fn wait_until_dead(&self, pid: u32, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if !self.operations.is_process_alive(pid) {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        !self.operations.is_process_alive(pid)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestartPlan {
    pub command: Vec<String>,
    pub log_file: Option<PathBuf>,
}

impl RestartPlan {
    pub fn for_binary<I, S>(binary_path: &str, args: I, verbose: bool) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut command = vec!["nohup".to_owned(), binary_path.to_owned()];
        command.extend(args.into_iter().map(|arg| arg.as_ref().to_owned()));

        Self {
            command,
            log_file: verbose.then(|| {
                home_dir()
                    .join(".wegent-executor")
                    .join("logs")
                    .join("executor-restart.log")
            }),
        }
    }
}

#[derive(Debug)]
struct DefaultProcessOperations;

impl ProcessOperations for DefaultProcessOperations {
    fn current_pid(&self) -> u32 {
        std::process::id()
    }

    fn is_process_alive(&self, pid: u32) -> bool {
        is_process_alive(pid)
    }

    fn terminate_gracefully(&self, pid: u32) -> bool {
        send_signal(pid, libc::SIGTERM)
    }

    fn terminate_forcefully(&self, pid: u32) -> bool {
        send_signal(pid, libc::SIGKILL)
    }
}

#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    // Signal 0 performs permission/existence checking without delivering a signal.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(not(unix))]
fn is_process_alive(_pid: u32) -> bool {
    false
}

#[cfg(unix)]
fn send_signal(pid: u32, signal: libc::c_int) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, signal) == 0 }
}

#[cfg(not(unix))]
fn send_signal(_pid: u32, _signal: libc::c_int) -> bool {
    false
}

#[cfg(unix)]
fn set_owner_only_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o600);
    fs::set_permissions(path, permissions)
}

#[cfg(not(unix))]
fn set_owner_only_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn unix_timestamp_seconds() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or_default()
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

#[allow(dead_code)]
fn _default_graceful_timeout() -> Duration {
    DEFAULT_GRACEFUL_TIMEOUT
}
