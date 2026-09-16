// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::fs;

#[test]
fn internal_device_image_pipeline_keeps_policy_in_wecode() {
    let gitlab_pipeline = fs::read_to_string("../.gitlab-ci.yml").unwrap();
    assert!(gitlab_pipeline.contains("bash wecode/docker/device/build-and-publish.sh"));
    assert!(gitlab_pipeline.contains("bash wecode/docker/executor/build-and-export-image-tag.sh"));
    assert!(gitlab_pipeline.contains("dotenv: executor-image.env"));
    assert!(gitlab_pipeline.contains("job: wegent-executor"));
    assert!(gitlab_pipeline.contains("artifacts: true"));
    assert!(gitlab_pipeline.contains(
        "DEVICE_IMAGE_VERSION=\"${EXECUTOR_IMAGE_TAG:?missing wegent-executor image tag}\""
    ));
    assert!(gitlab_pipeline.contains("resource_group: wegent-device-image"));
    assert!(gitlab_pipeline.contains("docker/device/**/*"));
    assert!(gitlab_pipeline.contains("wecode/docker/device/**/*"));
    assert!(!gitlab_pipeline.contains("registry.api.weibo.com/ci/wegent-device"));
    assert!(!gitlab_pipeline.contains("pushregistry.api.weibo.com/ci/wegent-device"));

    let publish_script =
        fs::read_to_string("../wecode/docker/device/build-and-publish.sh").unwrap();
    assert!(publish_script.contains("--file wecode/docker/device/Dockerfile"));
    assert!(publish_script.contains("registry.api.weibo.com/ci/wegent-device"));
    assert!(publish_script.contains("pushregistry.api.weibo.com/ci/wegent-device"));
    assert!(publish_script.contains("from build.build_image import BuildImage"));
    assert!(publish_script.contains("build_image.push_registry_address"));
    assert!(publish_script.contains("--password-stdin"));
    assert!(publish_script.contains("registry.api.weibo.com/ci/moby/buildkit:buildx-stable-1"));
    assert!(publish_script.contains("--driver-opt \"image=$BUILDKIT_IMAGE\""));
    assert!(publish_script.contains("--driver-opt network=host"));
    assert!(publish_script.contains("--network host"));
    assert!(publish_script.contains("--allow network.host"));
    assert!(publish_script.contains("wegent-device-builder-${CI_JOB_ID}"));
    assert!(!publish_script
        .split_whitespace()
        .any(|argument| argument == "--use"));
    assert!(publish_script.contains("--builder \"$BUILDER_NAME\""));
    assert!(publish_script.contains("inspect \"$BUILDER_NAME\" --bootstrap"));
    assert!(publish_script.contains(
        "DEVICE_BASE_IMAGE=${DEVICE_BASE_IMAGE:-registry.api.weibo.com/weibo_rd_if/ubuntu:26.04}"
    ));
    assert!(publish_script.contains("https://rsproxy.cn/rustup-init.sh"));
    assert!(publish_script.contains("https://npmmirror.com/mirrors/node"));
    assert!(publish_script.contains("https://registry.npmmirror.com"));
    assert!(publish_script.contains(
        "CODE_SERVER_REPOSITORY_RAW=${CODE_SERVER_REPOSITORY_RAW:-https://raw.githubusercontent.com/coder/code-server}"
    ));
    assert!(publish_script.contains(
        "CODE_SERVER_HTTPS_PROXY=${CODE_SERVER_HTTPS_PROXY:-http://wproxy.intra.weibo.com:8889}"
    ));
    assert!(!publish_script.contains("WECODE_CLI_CC"));
    assert!(!publish_script.contains("wecode_cli_cc"));
    assert!(publish_script
        .contains("CARGO_HTTPS_PROXY=${CARGO_HTTPS_PROXY:-http://wproxy.intra.weibo.com:8889}"));
    assert!(publish_script.contains("--platform linux/amd64"));
    assert!(!publish_script.contains("for architecture in amd64 arm64"));
    assert!(!publish_script.contains("DEVICE_IMAGE_VERSION}-arm64"));
    assert!(publish_script.contains("Local image verification: architecture=%s"));
    assert!(publish_script.contains("Published image verification: architecture=%s"));
    assert!(publish_script.contains("Executor version check failed"));
    assert!(publish_script
        .contains("push_image=\"${DEVICE_IMAGE_PUSH_REPOSITORY}:${DEVICE_IMAGE_VERSION}\""));
    assert!(publish_script
        .contains("runtime_image=\"${DEVICE_IMAGE_REPOSITORY}:${DEVICE_IMAGE_VERSION}\""));
    assert!(publish_script.contains("--load"));
    assert!(publish_script.contains("git ls-remote origin"));
    assert!(publish_script.contains("push_output=\"$(docker push \"$push_image\" 2>&1)\""));
    assert!(publish_script.contains("pushed_digest"));
    assert!(publish_script.contains("for attempt in $(seq 1 120)"));
    assert!(publish_script.contains("timeout --signal=TERM --kill-after=5s 15s"));
    assert!(publish_script.contains("consecutive_current"));
    assert!(publish_script.contains("docker run --rm --platform linux/amd64"));
    assert!(!publish_script.contains("docker image rm \"$image\""));
    assert!(publish_script.contains("--entrypoint /app/executor"));
    assert!(publish_script.contains("org.opencontainers.image.version"));
    assert!(publish_script.contains("org.opencontainers.image.revision"));
    assert!(publish_script.contains("APP_VERSION=${EXECUTOR_VERSION}"));
    assert!(publish_script
        .contains("DEVICE_IMAGE_VERSION=\"${DEVICE_IMAGE_VERSION:-$EXECUTOR_VERSION}\""));
    assert!(publish_script.contains("test \"$actual_version\" = \"$EXECUTOR_VERSION\""));
    assert!(publish_script.contains("test \"$published_executor_version\" = \"$EXECUTOR_VERSION\""));
    assert!(publish_script.contains("${MASTER_BRANCH:-main}"));
    assert!(publish_script.contains("executor_version_push_image"));
    assert!(publish_script.contains("executor_version_runtime_image"));

    let device_dockerfile = fs::read_to_string("../wecode/docker/device/Dockerfile").unwrap();
    assert!(device_dockerfile
        .contains("ARG DEVICE_BASE_IMAGE=registry.api.weibo.com/weibo_rd_if/ubuntu:26.04"));
    assert!(device_dockerfile.contains("/etc/apt/sources.list.d/ubuntu.sources"));
    assert!(device_dockerfile.contains("ARG GH_VERSION=2.100.0"));
    assert!(device_dockerfile.contains("ARG GLAB_VERSION=1.116.0"));
    assert!(device_dockerfile.contains("gh_${GH_VERSION}_linux_${cli_arch}.tar.gz"));
    assert!(device_dockerfile.contains("glab_${GLAB_VERSION}_linux_${cli_arch}.tar.gz"));
    assert!(device_dockerfile.contains("gh --version && glab --version"));
    assert!(device_dockerfile.contains("COPY sdk/plugin-auth /build/sdk/plugin-auth"));
    assert!(device_dockerfile.contains("COPY sdk/plugin-creator /build/sdk/plugin-creator"));
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
    assert!(device_dockerfile.contains(
        "if [ \"$DEVICE_CODE_SERVER_ENABLED\" = \"true\" ] && [ \"$DEVICE_SESSION_GATEWAY_ENABLED\" = \"true\" ]; then"
    ));
}

#[cfg(unix)]
#[test]
fn executor_ci_build_exports_tomas_image_tag() {
    use std::{os::unix::fs::PermissionsExt, process::Command};

    let temp = tempfile::tempdir().unwrap();
    let fake_build_image = temp.path().join("build_image");
    fs::write(
        &fake_build_image,
        "#!/usr/bin/env bash\n\
         echo 'last_image:ci/wegent-executor:1.0.236'\n\
         echo 'image: ci/wegent-executor:1.0.237-feature-device-tag'\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&fake_build_image).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&fake_build_image, permissions).unwrap();

    let current_path = std::env::var("PATH").unwrap();
    let export_script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../wecode/docker/executor/build-and-export-image-tag.sh");
    let output = Command::new("bash")
        .arg(export_script)
        .env("PATH", format!("{}:{current_path}", temp.path().display()))
        .current_dir(temp.path())
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "tag export failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("executor-image.env")).unwrap(),
        "EXECUTOR_IMAGE_TAG=1.0.237-feature-device-tag\n"
    );
}

#[test]
fn internal_default_image_tag_falls_back_to_executor_version() {
    let cargo_manifest = fs::read_to_string("Cargo.toml").unwrap();
    let version = cargo_manifest
        .lines()
        .find_map(|line| line.strip_prefix("version = \"")?.strip_suffix('"'))
        .expect("executor package version");
    let internal_config =
        fs::read_to_string("../backend/wecode/config/remote_device_config.py").unwrap();

    assert!(internal_config.contains(&format!(
        "REMOTE_DEVICE_IMAGE_FALLBACK_VERSION = \"{version}\""
    )));
    assert!(internal_config.contains("_resolve_executor_version_from_cargo_toml()"));
    assert!(internal_config.contains("@model_validator(mode=\"after\")"));
}
