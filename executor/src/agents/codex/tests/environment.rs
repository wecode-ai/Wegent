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
    pub(crate) fn without_browser_bridge(&mut self) {
        for key in [
            "WEWORK_EMBEDDED_BROWSER_BRIDGE_URL",
            "WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN",
        ] {
            self._restore.push(EnvRestore::capture(key));
            env::remove_var(key);
        }
        let key = "WEWORK_EMBEDDED_BROWSER_BRIDGE_RUNTIME_FILE";
        self._restore.push(EnvRestore::capture(key));
        env::set_var(key, self._root.path().join("absent-browser-runtime.json"));
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

#[test]
fn managed_connection_gateway_credential_is_absent_from_the_real_codex_child_environment() {
    let _lock = crate::test_env::lock();
    let _restore = EnvRestore::capture("WEGENT_CONNECTION_SERVICE_TOKEN");
    env::set_var(
        "WEGENT_CONNECTION_SERVICE_TOKEN",
        "private-gateway-test-credential",
    );
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("app-server"),
        r#"
        if (process.env.WEGENT_CONNECTION_SERVICE_TOKEN !== undefined) process.exit(41)
        process.stdout.write('gateway-credential-isolated')
    "#,
    )
    .unwrap();
    let node = std::process::Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .unwrap();
    assert!(node.status.success());
    let binary = String::from_utf8(node.stdout).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut injected = CodexLaunchConfig::default();
    injected.env.insert(
        "WEGENT_CONNECTION_SERVICE_TOKEN".into(),
        "private-gateway-test-credential".into(),
    );
    for config in [CodexLaunchConfig::default(), injected] {
        let output = runtime.block_on(async {
            codex_app_server_command(binary.trim(), root.path(), &config)
                .output()
                .await
                .unwrap()
        });
        assert!(output.status.success());
        assert_eq!(output.stdout, b"gateway-credential-isolated");
        assert!(
            !String::from_utf8_lossy(&output.stdout).contains("private-gateway-test-credential")
        );
    }
}
