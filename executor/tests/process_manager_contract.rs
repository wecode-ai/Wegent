// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use wegent_executor::services::updater::{
    ProcessInfo, ProcessManager, ProcessOperations, RestartPlan,
};

#[test]
fn process_info_stores_pid_start_time_and_version() {
    let info = ProcessInfo::new(1234, 1234567890.0, "1.0.0");

    assert_eq!(info.pid, 1234);
    assert_eq!(info.start_time, 1234567890.0);
    assert_eq!(info.version, "1.0.0");
}

#[test]
fn write_read_and_remove_pid_file_lifecycle() {
    let manager = ProcessManager::for_pid_file(unique_dir("pid-lifecycle").join("executor.pid"));

    assert!(manager.write_pid_file("1.0.0"));
    let info = manager.read_pid_file().unwrap();
    assert_eq!(info.pid, std::process::id());
    assert_eq!(info.version, "1.0.0");
    assert!(info.start_time > 0.0);

    assert!(manager.remove_pid_file());
    assert!(manager.read_pid_file().is_none());
    assert!(manager.remove_pid_file());
}

#[test]
fn read_pid_file_removes_invalid_json() {
    let pid_file = unique_dir("pid-invalid").join("executor.pid");
    fs::write(&pid_file, "invalid json").unwrap();
    let manager = ProcessManager::for_pid_file(pid_file.clone());

    assert!(manager.read_pid_file().is_none());
    assert!(!pid_file.exists());
}

#[test]
fn was_running_ignores_current_process_and_removes_stale_pid_file() {
    let pid_file = unique_dir("pid-stale").join("executor.pid");
    let ops = Arc::new(FakeProcessOps::new(std::process::id(), vec![false]));
    let manager = ProcessManager::with_operations(pid_file.clone(), ops);

    assert!(manager.write_pid_file("1.0.0"));
    assert!(manager.was_running().is_none());

    fs::write(
        &pid_file,
        serde_json::to_string(&ProcessInfo::new(999_999, 1.0, "1.0.0")).unwrap(),
    )
    .unwrap();

    assert!(manager.was_running().is_none());
    assert!(!pid_file.exists());
}

#[test]
fn was_running_returns_live_external_process_info() {
    let pid_file = unique_dir("pid-live").join("executor.pid");
    let ops = Arc::new(FakeProcessOps::new(42, vec![true]));
    let manager = ProcessManager::with_operations(pid_file.clone(), ops);
    fs::write(
        &pid_file,
        serde_json::to_string(&ProcessInfo::new(777, 1.0, "1.0.0")).unwrap(),
    )
    .unwrap();

    let info = manager.was_running().unwrap();

    assert_eq!(info.pid, 777);
}

#[test]
fn is_running_checks_current_and_nonexistent_processes() {
    let manager = ProcessManager::default();

    assert!(manager.is_running(&ProcessInfo::new(std::process::id(), 1.0, "1.0.0")));
    assert!(!manager.is_running(&ProcessInfo::new(999_999, 1.0, "1.0.0")));
}

#[test]
fn terminate_process_rejects_current_process_and_treats_already_dead_as_success() {
    let ops = Arc::new(FakeProcessOps::new(std::process::id(), vec![false]));
    let manager = ProcessManager::with_operations(unique_dir("pid-term").join("executor.pid"), ops);

    assert!(!manager.terminate_process(std::process::id(), 0));
    assert!(manager.terminate_process(1234, 0));
}

#[test]
fn terminate_process_tries_graceful_then_forceful_when_process_stays_alive() {
    let ops = Arc::new(FakeProcessOps::always_alive(42));
    let manager =
        ProcessManager::with_operations(unique_dir("pid-force").join("executor.pid"), ops.clone());

    assert!(!manager.terminate_process(1234, 0));
    assert_eq!(ops.graceful_pids(), vec![1234]);
    assert_eq!(ops.forceful_pids(), vec![1234]);
}

#[test]
fn restart_plan_uses_nohup_binary_and_optional_verbose_log() {
    let quiet =
        RestartPlan::for_binary("/usr/local/bin/wegent-executor", Vec::<&str>::new(), false);
    assert_eq!(
        quiet.command,
        vec!["nohup", "/usr/local/bin/wegent-executor"]
    );
    assert!(quiet.log_file.is_none());

    let verbose =
        RestartPlan::for_binary("/usr/local/bin/wegent-executor", ["--config", "x"], true);
    assert_eq!(
        verbose.command,
        vec!["nohup", "/usr/local/bin/wegent-executor", "--config", "x"]
    );
    assert!(verbose
        .log_file
        .unwrap()
        .ends_with(".wegent-executor/logs/executor-restart.log"));
}

#[cfg(unix)]
#[test]
fn spawn_restart_runs_restart_plan_command() {
    let dir = unique_dir("restart-spawn");
    let marker = dir.join("started");
    let manager = ProcessManager::for_pid_file(dir.join("executor.pid"));
    let plan = RestartPlan {
        command: vec![
            "sh".to_owned(),
            "-c".to_owned(),
            format!("printf started > '{}'", marker.display()),
        ],
        log_file: None,
    };

    assert!(manager.spawn_restart(&plan));
    wait_until(|| {
        fs::read_to_string(&marker)
            .map(|content| content == "started")
            .unwrap_or(false)
    });
    assert_eq!(fs::read_to_string(marker).unwrap(), "started");
}

#[derive(Debug)]
struct FakeProcessOps {
    current_pid: u32,
    alive_sequence: Mutex<Vec<bool>>,
    fallback_alive: bool,
    graceful: Mutex<Vec<u32>>,
    forceful: Mutex<Vec<u32>>,
}

impl FakeProcessOps {
    fn new(current_pid: u32, alive_sequence: Vec<bool>) -> Self {
        Self {
            current_pid,
            alive_sequence: Mutex::new(alive_sequence),
            fallback_alive: false,
            graceful: Mutex::new(Vec::new()),
            forceful: Mutex::new(Vec::new()),
        }
    }

    fn always_alive(current_pid: u32) -> Self {
        Self {
            current_pid,
            alive_sequence: Mutex::new(Vec::new()),
            fallback_alive: true,
            graceful: Mutex::new(Vec::new()),
            forceful: Mutex::new(Vec::new()),
        }
    }

    fn graceful_pids(&self) -> Vec<u32> {
        self.graceful.lock().unwrap().clone()
    }

    fn forceful_pids(&self) -> Vec<u32> {
        self.forceful.lock().unwrap().clone()
    }
}

impl ProcessOperations for FakeProcessOps {
    fn current_pid(&self) -> u32 {
        self.current_pid
    }

    fn is_process_alive(&self, _pid: u32) -> bool {
        let mut sequence = self.alive_sequence.lock().unwrap();
        if sequence.is_empty() {
            self.fallback_alive
        } else {
            sequence.remove(0)
        }
    }

    fn terminate_gracefully(&self, pid: u32) -> bool {
        self.graceful.lock().unwrap().push(pid);
        true
    }

    fn terminate_forcefully(&self, pid: u32) -> bool {
        self.forceful.lock().unwrap().push(pid);
        true
    }
}

fn unique_dir(prefix: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("{prefix}-{suffix}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(unix)]
fn wait_until(condition: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while std::time::Instant::now() < deadline {
        if condition() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(condition());
}
