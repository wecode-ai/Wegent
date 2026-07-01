// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::{Mutex, MutexGuard, OnceLock};

use wegent_executor::process_environment::{normalized_process_path, process_env};

fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

#[test]
fn normalized_process_path_adds_standard_developer_directories_once() {
    let path = normalized_process_path("/usr/bin:/opt/homebrew/bin:/bin");

    assert!(path.starts_with("/usr/bin:/opt/homebrew/bin:/bin"));
    assert_eq!(path.matches("/opt/homebrew/bin").count(), 1);
    assert!(path.contains("/opt/homebrew/sbin"));
    assert!(path.contains("/usr/local/bin"));
    assert!(path.contains("/usr/local/sbin"));
}

#[test]
fn process_env_merges_user_extra_paths_before_standard_developer_directories() {
    let _lock = env_lock();
    let _path = EnvGuard::set("PATH", "/usr/bin:/bin");
    let _extra = EnvGuard::set("WEGENT_EXTRA_PATHS", "/custom/bin:/opt/homebrew/bin");

    let env = process_env(&[]);
    let path = env.get("PATH").expect("PATH should be present");

    assert!(path.starts_with("/usr/bin:/bin:/custom/bin:/opt/homebrew/bin"));
    assert_eq!(path.matches("/custom/bin").count(), 1);
    assert_eq!(path.matches("/opt/homebrew/bin").count(), 1);
}

#[test]
fn process_env_normalizes_explicit_path_overrides() {
    let _lock = env_lock();
    let _path = EnvGuard::set("PATH", "/usr/bin:/bin");
    let _extra = EnvGuard::set("WEGENT_EXTRA_PATHS", "/extra/bin");

    let env = process_env(&[("PATH".to_owned(), "/request/bin:/usr/bin".to_owned())]);
    let path = env.get("PATH").expect("PATH should be present");

    assert!(path.starts_with("/request/bin:/usr/bin:/extra/bin"));
    assert!(path.contains("/opt/homebrew/bin"));
    assert!(path.contains("/usr/local/bin"));
}
