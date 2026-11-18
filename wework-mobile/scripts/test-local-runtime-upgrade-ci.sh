#!/usr/bin/env bash
set -euo pipefail

mobile="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
module="$mobile/modules/wework-local-runtime"
output="${1:?Pass a new output directory outside the repository}"
mkdir "$output"
output="$(cd "$output" && pwd)"
if [[ "$(uname -s)-$(uname -m)" != Darwin-arm64 || "$(zig version)" != 0.15.2 ]]; then
  echo "The migration probe requires Apple ARM64 and Zig 0.15.2" >&2
  exit 1
fi

lock="$module/native/ish-source-lock.json"
rootfs="$output/alpine.tar.gz"
rootfs_sha="$(jq -er '.probeRootfs.sha256' "$lock")"
curl --fail --location --silent --show-error --connect-timeout 20 --max-time 300 \
  -o "$rootfs" "$(jq -er '.probeRootfs.url' "$lock")"
uv run --no-project --python 3.12 "$module/scripts/prepare-ish-source.py" --output "$output/source"

for version in previous current; do
  zig cc -target aarch64-linux-musl -static -O2 "-DPROBE_VERSION=\"$version\"" \
    "$module/tests/RuntimeUpgradeProbe.c" -o "$output/$version-executor"
  uv run --no-project --python 3.12 "$mobile/scripts/build-local-runtime-ios.py" \
    --host --source "$output/source" --rootfs "$rootfs" --rootfs-sha256 "$rootfs_sha" \
    --executor "$output/$version-executor" --output "$output/build"
  mv "$output/build/vendor/resources" "$output/$version-resources"
done

echo "Testing Swift/C migration with two static ARM64 executor protocol probes"
uv run --no-project --python 3.12 "$mobile/scripts/test-local-runtime-upgrade.py" \
  --previous-resources "$output/previous-resources" --resources "$output/current-resources" \
  --structured-stamp --native-source "$output/source" --native-build "$output/build/build-ish-host" \
  --vendor "$output/build/vendor" --output "$output/test"
