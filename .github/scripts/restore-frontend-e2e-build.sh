#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${1:-.ci-artifacts}"
archive="$artifact_dir/frontend-next-build.tar.zst"

test -s "$archive"

rm -rf frontend/.next
tar -I zstd -xf "$archive" -C frontend

test -f frontend/.next/BUILD_ID
