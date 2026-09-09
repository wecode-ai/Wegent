// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{fs, path::Path, process::Command};

#[test]
fn docker_dependency_layer_can_parse_manifest_without_example_sources() {
    let directory = tempfile::tempdir().unwrap();
    fs::copy("Cargo.toml", directory.path().join("Cargo.toml")).unwrap();
    fs::copy("Cargo.lock", directory.path().join("Cargo.lock")).unwrap();
    fs::create_dir_all(directory.path().join("src/bin")).unwrap();
    fs::write(
        directory.path().join("src/lib.rs"),
        "pub fn placeholder() {}\n",
    )
    .unwrap();
    fs::write(
        directory.path().join("src/bin/wegent-executor.rs"),
        "fn main() {}\n",
    )
    .unwrap();

    let output = Command::new(env!("CARGO"))
        .args([
            "metadata",
            "--no-deps",
            "--format-version",
            "1",
            "--offline",
        ])
        .current_dir(directory.path())
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "Docker dependency-layer manifest failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!directory.path().join("examples").exists());
    let metadata: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let example = metadata["packages"][0]["targets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["name"] == "terminal_load")
        .expect("terminal_load must remain declared without example sources");
    assert_eq!(example["test"], true);
}

#[test]
fn executor_tree_contains_no_python_runtime_files() {
    let forbidden_files = collect_forbidden_python_runtime_files(Path::new("."));

    assert!(
        forbidden_files.is_empty(),
        "executor still contains Python runtime files: {forbidden_files:?}"
    );
}

#[test]
fn executor_build_entrypoints_use_rust_binary_build() {
    let files = [
        "../docker/device/Dockerfile",
        "../.github/workflows/snapshot-image.yml",
        "../.github/workflows/publish-image.yml",
        "../.github/workflows/e2e-tests.yml",
        "../docker/standalone/start.sh",
        "../docker/standalone/Dockerfile",
        "../frontend/e2e/fixtures/claudecode-executor/Dockerfile",
        "../wework/scripts/dev-executor-sidecar.sh",
        "local.sh",
        "build.sh",
    ];

    for file in files {
        let content = fs::read_to_string(Path::new(file)).unwrap();
        assert!(
            !content.contains("scripts/build_local.py"),
            "{file} still invokes the Python PyInstaller build script"
        );
        assert!(
            !content.to_ascii_lowercase().contains("pyinstaller"),
            "{file} still invokes PyInstaller"
        );
        assert!(
            !content.contains("executor.spec"),
            "{file} still references the Python executor spec"
        );
        assert!(
            !content.contains("uv run python main.py"),
            "{file} still invokes the Python executor entrypoint"
        );
        assert!(
            !content.contains("scripts/dev_sidecar.py"),
            "{file} still invokes the Python WeWork executor sidecar"
        );
        assert!(
            !content.contains("executor/pyproject.toml"),
            "{file} still references Python executor package metadata"
        );
    }

    let local_sh = fs::read_to_string("local.sh").unwrap();
    assert!(local_sh.contains("cargo build --release --locked"));
    assert!(local_sh.contains("configure_wegent_cargo_target_dir \"$PROJECT_DIR\" \"executor\""));
    assert!(local_sh.contains("cargo_target_binary_path \"$ROOT_DIR\" release wegent-executor"));

    let dev_sidecar = fs::read_to_string("../wework/scripts/dev-executor-sidecar.sh").unwrap();
    assert!(dev_sidecar.contains("WEGENT_EXECUTOR_DEV_RELOAD:-1"));
    assert!(dev_sidecar.contains("dev-executor-reload.mjs"));
    assert!(dev_sidecar.contains("cargo build"));
    assert!(dev_sidecar.contains("configure_wegent_cargo_target_dir \"$PROJECT_DIR\" \"executor\""));
    assert!(dev_sidecar.contains("$cache_root/executor-dev"));
    assert!(!dev_sidecar.contains("executor_source_cache_key"));
    assert!(dev_sidecar.contains("WEGENT_EXECUTOR_SOURCE_DIR"));
    assert!(!dev_sidecar.contains("exec cargo run"));

    let dev_reload = fs::read_to_string("../wework/scripts/dev-executor-reload.mjs").unwrap();
    assert!(dev_reload.contains("'cargo'"));
    assert!(dev_reload.contains("'--bin', 'wegent-executor'"));
    assert!(dev_reload.contains("watch(sourceDir, { recursive: true }"));
    assert!(!dev_reload.contains("wegent-executor-dev"));

    let device_dockerfile = fs::read_to_string("../docker/device/Dockerfile").unwrap();
    assert!(device_dockerfile.contains("ARG DEVICE_BASE_IMAGE=ubuntu:26.04"));
    assert!(device_dockerfile.contains("/etc/apt/sources.list.d/ubuntu.sources"));
    assert!(device_dockerfile.contains("pkg-config"));
    assert!(device_dockerfile.contains("libssl-dev"));
    assert!(device_dockerfile.contains("ARG APP_VERSION=dev"));
    assert!(
        device_dockerfile.contains("APP_VERSION=\"${APP_VERSION}\" cargo build --release --locked")
    );
    assert!(device_dockerfile.contains("ENV WEGENT_EXECUTOR_VERSION=${APP_VERSION}"));
    assert!(device_dockerfile.contains("cargo build --release --locked"));
    assert!(device_dockerfile.contains("target/release/wegent-executor"));
    assert!(device_dockerfile.contains("ARG NODE_DIST_MIRROR=https://nodejs.org/dist"));
    assert!(device_dockerfile.contains("ARG CODE_SERVER_VERSION=4.121.0"));
    assert!(device_dockerfile.contains(
        "ARG CODE_SERVER_REPOSITORY_RAW=https://raw.githubusercontent.com/coder/code-server"
    ));
    assert!(device_dockerfile.contains("ARG CODE_SERVER_HTTPS_PROXY="));
    assert!(!device_dockerfile.contains("WECODE_CLI_CC"));
    assert!(!device_dockerfile.contains("wecode-cli-cc"));
    assert!(device_dockerfile.contains("export HTTPS_PROXY=\"$CODE_SERVER_HTTPS_PROXY\""));
    assert!(device_dockerfile.contains("ARG CARGO_HTTPS_PROXY="));
    assert!(device_dockerfile.contains("export HTTPS_PROXY=\"$CARGO_HTTPS_PROXY\""));
    assert!(device_dockerfile.contains("/v${CODE_SERVER_VERSION}/install.sh"));
    assert!(device_dockerfile.contains("--method=standalone"));
    assert!(device_dockerfile.contains("--prefix=/usr/local"));
    assert!(device_dockerfile.contains("--version=\"${CODE_SERVER_VERSION}\""));
    assert!(device_dockerfile.contains(
        "/usr/local/lib/code-server-${CODE_SERVER_VERSION}/lib/vscode/node_modules/vsda"
    ));
    assert!(device_dockerfile.contains("code-server --version | tail -n 1 | awk '{print $1}'"));
    assert!(device_dockerfile
        .contains("test \"$installed_code_server_version\" = \"$CODE_SERVER_VERSION\""));
    assert!(device_dockerfile
        .contains("install -m 0755 /app/executor \"$WEGENT_EXECUTOR_HOME/bin/wegent-executor\""));
    assert!(device_dockerfile
        .contains("ENV LOCAL_WORKSPACE_ROOT=/home/wegent/.wecode/wegent-executor/workspace"));
    assert!(device_dockerfile.contains("ENV WEGENT_WORKSPACE_ROOTS=/home/wegent"));
    assert!(device_dockerfile.contains("ENV DEVICE_CODE_SERVER_ENABLED=true"));
    assert!(device_dockerfile.contains("ENV DEVICE_TERMINAL_ENABLED=true"));
    assert!(device_dockerfile.contains(
        "DEVICE_CODE_SERVER_ENABLED=\"$(normalize_enabled_flag DEVICE_CODE_SERVER_ENABLED)\""
    ));
    assert!(device_dockerfile
        .contains("DEVICE_TERMINAL_ENABLED=\"$(normalize_enabled_flag DEVICE_TERMINAL_ENABLED)\""));
    assert!(device_dockerfile.contains(
        "export DEVICE_SESSION_GATEWAY_ENABLED DEVICE_CODE_SERVER_ENABLED DEVICE_TERMINAL_ENABLED"
    ));
    assert!(!device_dockerfile.contains(
        "export DEVICE_CODE_SERVER_ENABLED=\"$(normalize_enabled_flag DEVICE_CODE_SERVER_ENABLED)\""
    ));
    assert!(device_dockerfile.contains(
        "if [ \"$DEVICE_CODE_SERVER_ENABLED\" = \"true\" ] && [ \"$DEVICE_SESSION_GATEWAY_ENABLED\" = \"true\" ]; then"
    ));
    for persistent_path in [
        "$WEGENT_EXECUTOR_HOME/bin",
        "$WEGENT_EXECUTOR_HOME/runtime-work",
        "$WEGENT_EXECUTOR_HOME/capabilities",
        "$WEGENT_EXECUTOR_HOME/sessions",
        "$LOCAL_WORKSPACE_ROOT/projects",
        "$LOCAL_WORKSPACE_ROOT/chats",
        "$LOCAL_WORKSPACE_ROOT/worktrees",
        "$DEVICE_LOG_DIR",
    ] {
        assert!(device_dockerfile.contains(persistent_path));
    }
    assert!(device_dockerfile
        .contains("EXPECTED_EXECUTOR_HOME=\"/home/wegent/.wecode/wegent-executor\""));
    assert!(!device_dockerfile.contains("WEGENT_EXECUTOR_HOME_EXPECTED_PATH"));
    assert!(device_dockerfile
        .contains("WEGENT_EXECUTOR_HOME=\"$(realpath -m -- \"$WEGENT_EXECUTOR_HOME\")\""));
    assert!(device_dockerfile
        .contains("LOCAL_WORKSPACE_ROOT=\"$(realpath -m -- \"$LOCAL_WORKSPACE_ROOT\")\""));
    assert!(device_dockerfile.contains("WEGENT_EXECUTOR_HOME_ID"));
    assert!(device_dockerfile.contains(".executor-home-id"));
    assert!(device_dockerfile.contains("flock -n 9"));
    assert!(device_dockerfile.contains(".write-probe.$$"));
    assert!(device_dockerfile.contains("auth: none"));
    assert!(device_dockerfile.contains("--auth none"));
    assert!(!device_dockerfile.contains("--auth password"));
    assert!(!device_dockerfile.contains("--install-extension"));
    assert!(device_dockerfile.contains("$WEGENT_EXECUTOR_HOME/logs"));
    assert!(!device_dockerfile.contains("code-server@${CODE_SERVER_VERSION}"));
    assert!(!device_dockerfile.contains("deb.nodesource.com"));
    assert!(!device_dockerfile.contains(
        "ARG CODE_SERVER_DIST_MIRROR=https://github.com/coder/code-server/releases/download"
    ));

    let github_pipeline = fs::read_to_string("../.github/workflows/publish-image.yml").unwrap();
    assert_eq!(
        github_pipeline
            .matches("file: docker/device/Dockerfile")
            .count(),
        2
    );
    assert!(!github_pipeline.contains("file: wecode/docker/device/Dockerfile"));

    let e2e_workflow = fs::read_to_string("../.github/workflows/e2e-tests.yml").unwrap();
    assert!(!e2e_workflow.contains("python -m executor.main"));
    assert!(!e2e_workflow.contains("Install executor dependencies"));
    assert!(!e2e_workflow.contains("source executor/.venv/bin/activate"));
    assert!(e2e_workflow.contains(
        "docker cp \"$container_id:/app/executor\" executor/target/release/wegent-executor"
    ));
    assert!(e2e_workflow.contains("test -x executor/target/release/wegent-executor"));
    assert!(!e2e_workflow.contains("cd executor\n            cargo build --release --locked"));

    let e2e_fixture =
        fs::read_to_string("../frontend/e2e/fixtures/claudecode-executor/Dockerfile").unwrap();
    assert!(e2e_fixture.contains("cargo build --release --locked"));
    assert!(e2e_fixture.contains("target/release/wegent-executor"));

    let standalone_start = fs::read_to_string("../docker/standalone/start.sh").unwrap();
    assert!(!standalone_start.contains("python -m executor.main"));
    assert!(standalone_start.contains("/app/wegent-executor"));

    let standalone_dockerfile = fs::read_to_string("../docker/standalone/Dockerfile").unwrap();
    assert!(standalone_dockerfile.contains("AS executor-builder"));
    assert!(standalone_dockerfile.contains("ARG APP_VERSION=dev"));
    assert!(standalone_dockerfile
        .contains("APP_VERSION=\"${APP_VERSION}\" cargo build --release --locked"));
    assert!(standalone_dockerfile.contains("ENV WEGENT_EXECUTOR_VERSION=${APP_VERSION}"));
    assert!(standalone_dockerfile.contains("cargo build --release --locked"));
    assert!(standalone_dockerfile.contains("/app/wegent-executor"));
    assert!(!standalone_dockerfile.contains("cd /app/executor && uv pip install"));
}

#[test]
fn windows_executor_sources_keep_unix_only_symbols_cfg_gated() {
    let app_ipc = fs::read_to_string("src/local/app_ipc.rs").unwrap();
    assert!(
        !app_ipc.contains("    net::UnixListener,"),
        "UnixListener must not be imported through always-compiled tokio::net on Windows"
    );
    assert!(
        !app_ipc.contains("stream: tokio::net::UnixStream"),
        "UnixStream method signatures must be cfg-gated for Windows builds"
    );

    let process_manager = fs::read_to_string("src/services/updater/process_manager.rs").unwrap();
    assert!(
        process_manager.contains("#[cfg(unix)]\n    fn terminate_forcefully"),
        "forceful Unix signal termination must be cfg-gated"
    );
    assert!(
        process_manager.contains("#[cfg(not(unix))]\n    fn terminate_forcefully"),
        "Windows builds need a non-Unix forceful termination branch"
    );
}

fn collect_forbidden_python_runtime_files(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    collect_forbidden_python_runtime_files_inner(root, &mut files);
    files.sort();
    files
}

fn collect_forbidden_python_runtime_files_inner(path: &Path, files: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };

    for entry in entries.flatten() {
        let entry_path = entry.path();
        if entry_path.components().any(is_generated_runtime_component) {
            continue;
        }

        if entry_path.is_dir() {
            collect_forbidden_python_runtime_files_inner(&entry_path, files);
            continue;
        }

        let Some(file_name) = entry_path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let is_forbidden = file_name.ends_with(".py")
            || file_name.ends_with(".pyi")
            || matches!(
                file_name,
                "pyproject.toml" | "uv.lock" | "requirements.txt" | "executor.spec"
            );
        if is_forbidden {
            files.push(entry_path.display().to_string());
        }
    }
}

fn is_generated_runtime_component(component: std::path::Component<'_>) -> bool {
    matches!(
        component.as_os_str().to_str(),
        Some("target" | ".venv" | "venv" | ".venv-x86_64" | "__pycache__")
    )
}
