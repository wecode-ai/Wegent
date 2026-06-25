// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{fs, path::Path};

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
    }

    let local_sh = fs::read_to_string("local.sh").unwrap();
    assert!(local_sh.contains("cargo build --release --locked"));
    assert!(local_sh.contains("target/release/wegent-executor"));

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
    assert!(e2e_workflow.contains("cargo build --release --locked"));

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
}
