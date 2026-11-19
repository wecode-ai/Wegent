#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "Usage: $0 <executor-binary> <connection-runtime-archive> <version> <revision> <output-directory>" >&2
  exit 2
fi

executor_binary="$1"
runtime_archive="$2"
version="$3"
revision="$4"
output_directory="$5"
archive=wegent-executor-runtime-linux-amd64.tar.gz

staging="$(mktemp -d)"
trap 'rm -rf -- "$staging"' EXIT

tar -xzf "$runtime_archive" -C "$staging"
install -m 0755 "$executor_binary" "$staging/wegent-executor"

test -s "$staging/connection-runtime/connection-runtime.json"
"$staging/connection-runtime/node/node" --version
actual_version="$(env -u WEGENT_EXECUTOR_VERSION "$staging/wegent-executor" --version)"
if [ "$actual_version" != "$version" ]; then
  printf 'Executor version mismatch: expected %s, got %s\n' "$version" "$actual_version" >&2
  exit 1
fi

jq -n --arg version "$version" --arg revision "$revision" \
  '{version: $version, revision: $revision, platform: "linux/amd64"}' > "$staging/release.json"
mkdir -p "$output_directory"
tar -czf "$output_directory/$archive" -C "$staging" wegent-executor connection-runtime release.json
(cd "$output_directory" && sha256sum "$archive" > "$archive.sha256")
