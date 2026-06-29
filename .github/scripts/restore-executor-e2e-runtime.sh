#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${1:-.ci-artifacts}"
image_tag="${2:-wegent/e2e-claudecode-executor:latest}"
image_archive="$artifact_dir/e2e-claudecode-executor-image.tar.zst"
binary_archive="$artifact_dir/wegent-executor"

test -s "$image_archive"
test -s "$binary_archive"

zstd -dc "$image_archive" | docker load
docker image inspect "$image_tag" >/dev/null

mkdir -p executor/target/release
cp "$binary_archive" executor/target/release/wegent-executor
chmod 0755 executor/target/release/wegent-executor

test -x executor/target/release/wegent-executor
