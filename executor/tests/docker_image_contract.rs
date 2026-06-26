// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{fs, path::Path};

#[test]
fn executor_dockerfile_builds_and_runs_rust_binary() {
    let dockerfile_path = Path::new("../docker/executor/Dockerfile");
    let dockerfile = fs::read_to_string(dockerfile_path).unwrap();

    assert!(dockerfile.contains("openssl-devel"));
    assert!(dockerfile.contains("pkgconf-pkg-config"));
    assert!(dockerfile.contains("ARG APP_VERSION=dev"));
    assert!(dockerfile.contains("APP_VERSION=\"${APP_VERSION}\" cargo build --release --locked"));
    assert!(dockerfile.contains("ENV WEGENT_EXECUTOR_VERSION=${APP_VERSION}"));
    assert!(dockerfile.contains("cargo build --release --locked"));
    assert!(dockerfile.contains("/app/executor/target/release/wegent-executor"));
    assert!(dockerfile.contains(
        "COPY --from=builder /app/executor/target/release/wegent-executor /app/executor"
    ));
    assert!(dockerfile.contains("CMD [\"/app/executor\"]"));
    assert!(!dockerfile.to_ascii_lowercase().contains("pyinstaller"));
    assert!(!dockerfile.contains("uvicorn main:app"));
}
