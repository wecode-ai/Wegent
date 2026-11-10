// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::{Mutex, MutexGuard};

static ENV_LOCK: Mutex<()> = Mutex::new(());

// The desktop app exports host-specific environment variables (for example
// WEGENT_BUNDLED_HOOKS_DIR pointing inside the installed app bundle) into
// every process it spawns, including `cargo test`. Tests that rely on a
// hermetic environment must not observe them, so scrub the variables that
// leak host machine state before any test runs. Constructors execute
// single-threaded ahead of main, which makes the mutation safe. Keep this
// list narrow: variables like WEGENT_EXTRA_PATHS configure the runner and
// must survive.
const HOST_STATE_VARS: &[&str] = &[
    "WEGENT_BUNDLED_HOOKS_DIR",
    "WEGENT_BUNDLED_PLUGIN_MARKETPLACE_DIR",
    "WEGENT_MANAGED_HOOKS_DIR",
    "WEGENT_EXECUTOR_HOME",
    "WEGENT_NATIVE_CODEX_HOME",
    "WEWORK_PYTHON_RUNTIME_URL",
    "WEWORK_PYTHON_RUNTIME_TOKEN",
];

#[used]
#[cfg_attr(target_os = "macos", link_section = "__DATA,__mod_init_func")]
#[cfg_attr(windows, link_section = ".CRT$XCU")]
#[cfg_attr(all(unix, not(target_os = "macos")), link_section = ".init_array")]
static SCRUB_WEGENT_ENV: extern "C" fn() = {
    extern "C" fn scrub() {
        for key in HOST_STATE_VARS {
            // SAFETY: constructors run single-threaded before main.
            unsafe { std::env::remove_var(key) };
        }
    }
    scrub
};

pub fn lock() -> MutexGuard<'static, ()> {
    // Recover from poisoning so a single panicking test does not cascade
    // into unrelated PoisonError failures across the shared test binary.
    ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Create a deterministic ZIP archive for package protocol fixtures.
pub fn zip_entries(entries: &[(&str, &str)]) -> Vec<u8> {
    use std::io::Write;
    let cursor = std::io::Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    let options = zip::write::FileOptions::default();
    for (path, content) in entries {
        writer.start_file(*path, options).unwrap();
        writer.write_all(content.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

/// Minimal native model metadata shared by Codex CLI fixtures.
pub const CODEX_BUNDLED_CATALOG: &str = r#"{"models":[{"slug":"gpt-test","visibility":"list","priority":0,"base_instructions":"Native fixture"}]}"#;

/// Add the bundled model export command without changing app-server traffic.
pub fn with_codex_bundled_catalog(script: &str) -> String {
    script.replacen(
        "#!/bin/sh\n",
        &format!(
            "#!/bin/sh\nif [ \"$1\" = debug ]; then\n  printf '%s\\n' '{}'\n  exit 0\nfi\n",
            CODEX_BUNDLED_CATALOG
        ),
        1,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_environment_is_scrubbed_before_tests_start() {
        const CHILD: &str = "WEGENT_TEST_HOST_SCRUB_CHILD";
        if std::env::var_os(CHILD).is_some() {
            for key in HOST_STATE_VARS {
                assert!(
                    std::env::var_os(key).is_none(),
                    "Inherited host state: {key}"
                );
            }
            assert_eq!(std::env::var("WEGENT_EXTRA_PATHS").unwrap(), "test-path");
            return;
        }
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "tests::host_environment_is_scrubbed_before_tests_start",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("WEGENT_EXTRA_PATHS", "test-path");
        for key in HOST_STATE_VARS {
            command.env(key, "synthetic-host-state");
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    }
}
