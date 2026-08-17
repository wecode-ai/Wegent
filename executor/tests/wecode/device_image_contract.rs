// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::fs;

#[test]
fn internal_device_image_pipeline_keeps_policy_in_wecode() {
    let gitlab_pipeline = fs::read_to_string("../.gitlab-ci.yml").unwrap();
    assert!(gitlab_pipeline.contains("bash wecode/docker/device/build-and-publish.sh"));
    assert!(gitlab_pipeline.contains("resource_group: wegent-device-image"));
    assert!(gitlab_pipeline.contains("docker/device/**/*"));
    assert!(gitlab_pipeline.contains("wecode/docker/device/**/*"));
    assert!(!gitlab_pipeline.contains("registry.api.weibo.com/ci/wegent-device"));
    assert!(!gitlab_pipeline.contains("pushregistry.api.weibo.com/ci/wegent-device"));

    let publish_script =
        fs::read_to_string("../wecode/docker/device/build-and-publish.sh").unwrap();
    assert!(publish_script.contains("--file docker/device/Dockerfile"));
    assert!(publish_script.contains("registry.api.weibo.com/ci/wegent-device"));
    assert!(publish_script.contains("pushregistry.api.weibo.com/ci/wegent-device"));
    assert!(publish_script.contains("from build.build_image import BuildImage"));
    assert!(publish_script.contains("build_image.push_registry_address"));
    assert!(publish_script.contains("--password-stdin"));
    assert!(publish_script.contains("registry.api.weibo.com/ci/moby/buildkit:buildx-stable-1"));
    assert!(publish_script.contains("--driver-opt \"image=$BUILDKIT_IMAGE\""));
    assert!(publish_script.contains("wegent-device-builder-${CI_JOB_ID}"));
    assert!(!publish_script
        .split_whitespace()
        .any(|argument| argument == "--use"));
    assert!(publish_script.contains("--builder \"$BUILDER_NAME\""));
    assert!(publish_script.contains("inspect \"$BUILDER_NAME\" --bootstrap"));
    assert!(publish_script.contains("registry.api.weibo.com/weibo_rd_if/ubuntu:22.04.5"));
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
}

#[test]
fn internal_default_image_tag_matches_executor_version() {
    let cargo_manifest = fs::read_to_string("Cargo.toml").unwrap();
    let version = cargo_manifest
        .lines()
        .find_map(|line| line.strip_prefix("version = \"")?.strip_suffix('"'))
        .expect("executor package version");
    let internal_config =
        fs::read_to_string("../backend/wecode/config/remote_device_config.py").unwrap();

    assert!(internal_config.contains(&format!("wegent-device:{version}")));
}
