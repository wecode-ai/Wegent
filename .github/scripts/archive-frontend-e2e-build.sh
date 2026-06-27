#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${1:-.ci-artifacts}"
archive="$artifact_dir/frontend-next-build.tar.zst"

mkdir -p "$artifact_dir"

test -f frontend/.next/BUILD_ID
test -d frontend/public

tar --exclude='.next/cache' -I 'zstd -T0 -3' -cf "$archive" -C frontend .next public
test -s "$archive"
