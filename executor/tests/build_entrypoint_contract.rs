// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{fs, path::Path};

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
        "../.github/workflows/test-windows-executor.yml",
        "../.github/workflows/e2e-tests.yml",
        "../docker/standalone/start.sh",
        "../docker/standalone/Dockerfile",
        "../frontend/e2e/fixtures/claudecode-executor/Dockerfile",
        "../wework/scripts/dev-executor-sidecar.sh",
        "../wework/src-tauri/build.rs",
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
    assert!(local_sh.contains("target/release/wegent-executor"));

    let dev_sidecar = fs::read_to_string("../wework/scripts/dev-executor-sidecar.sh").unwrap();
    assert!(dev_sidecar.contains("WEGENT_EXECUTOR_DEV_RELOAD:-1"));
    assert!(dev_sidecar.contains("--features dev-reload"));
    assert!(dev_sidecar.contains("--bin wegent-executor-dev"));

    let device_dockerfile = fs::read_to_string("../docker/device/Dockerfile").unwrap();
    assert!(device_dockerfile.contains("pkg-config"));
    assert!(device_dockerfile.contains("libssl-dev"));
    assert!(device_dockerfile.contains("ARG APP_VERSION=dev"));
    assert!(
        device_dockerfile.contains("APP_VERSION=\"${APP_VERSION}\" cargo build --release --locked")
    );
    assert!(device_dockerfile.contains("ENV WEGENT_EXECUTOR_VERSION=${APP_VERSION}"));
    assert!(device_dockerfile.contains("cargo build --release --locked"));
    assert!(device_dockerfile.contains("target/release/wegent-executor"));

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
        if entry_path.components().any(|component| {
            matches!(
                component.as_os_str().to_str(),
                Some("target" | ".venv" | "venv" | ".venv-x86_64")
            )
        }) {
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
