// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(crate) struct LaunchEnvironment {
    // Restore variables before deleting files and releasing the process-wide lock.
    _restore: Vec<EnvRestore>,
    _root: tempfile::TempDir,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl LaunchEnvironment {
    pub(crate) const BUNDLED_CATALOG: &str = r#"{"models":[{"slug":"gpt-test","visibility":"list","priority":0,"base_instructions":"Native fixture"}]}"#;

    #[cfg(unix)]
    pub(crate) fn with_bundled_catalog(script: &str) -> String {
        script.replacen(
            "#!/bin/sh\n",
            &format!(
                "#!/bin/sh\nif [ \"$1\" = debug ]; then\n  printf '%s\\n' '{}'\n  exit 0\nfi\n",
                Self::BUNDLED_CATALOG
            ),
            1,
        )
    }

    pub(crate) fn new() -> Self {
        let lock = crate::test_env::lock();
        let root = tempfile::tempdir().unwrap();
        let mut restore = Vec::new();
        for (key, directory) in [
            ("HOME", "home"),
            ("CODEX_HOME", "codex"),
            ("WEGENT_CODEX_HOME", "codex"),
            ("WEGENT_EXECUTOR_HOME", "executor"),
            ("WEGENT_WORKBENCH_HOME", "workbench"),
            ("WEGENT_CAPABILITIES_HOME", "capabilities"),
        ] {
            restore.push(EnvRestore::capture(key));
            let path = root.path().join(directory);
            fs::create_dir_all(&path).unwrap();
            env::set_var(key, path);
        }
        // Start the shared endpoint before capturing launch configuration expectations.
        // A dedicated thread also supports callers already inside a Tokio runtime.
        std::thread::spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(crate::task_runtime::mcp_http::ensure_space_mcp_http_endpoint())
                .unwrap();
        })
        .join()
        .unwrap();
        Self {
            _restore: restore,
            _root: root,
            _lock: lock,
        }
    }
}
