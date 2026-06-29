#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${1:-.ci-artifacts}"
image_tag="${2:-wegent/e2e-claudecode-executor:latest}"
image_archive="$artifact_dir/e2e-claudecode-executor-image.tar.zst"
binary_archive="$artifact_dir/wegent-executor"

mkdir -p "$artifact_dir"

docker image inspect "$image_tag" >/dev/null
test -x executor/target/release/wegent-executor

docker save "$image_tag" | zstd -T0 -3 > "$image_archive"
cp executor/target/release/wegent-executor "$binary_archive"
chmod 0755 "$binary_archive"

test -s "$image_archive"
test -x "$binary_archive"
