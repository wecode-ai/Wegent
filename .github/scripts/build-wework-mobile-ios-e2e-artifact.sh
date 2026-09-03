#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 <simulator-udid> <absolute-artifact-directory>" >&2
  exit 1
fi

device_id="$1"
artifact_dir="$2"
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

case "$artifact_dir" in
  /*) ;;
  *)
    echo "Artifact directory must be absolute: $artifact_dir" >&2
    exit 1
    ;;
esac

derived_data="${WEWORK_MOBILE_IOS_DERIVED_DATA:-$repository_root/wework-mobile/node_modules/.cache/ios-e2e-derived-data}"
cargo_target_dir="${CARGO_TARGET_DIR:-$repository_root/executor/target}"
if [[ "$cargo_target_dir" != /* ]]; then
  cargo_target_dir="$repository_root/$cargo_target_dir"
fi
mkdir -p "$artifact_dir" "$derived_data"

build_names=(executor codex ios)
build_pids=()

(
  cd "$repository_root"
  cargo build --locked --manifest-path executor/Cargo.toml --bin wegent-executor
  cp "$cargo_target_dir/debug/wegent-executor" "$artifact_dir/wegent-executor"
) &
build_pids+=("$!")

(
  cd "$repository_root"
  ARTIFACT_DIR="$artifact_dir" node --input-type=module <<'NODE'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDesktopCodexBinary } from './wework/e2e/desktop/modules/desktop-build-flows.mjs'

const codex = await resolveDesktopCodexBinary()
await copyFile(codex, join(process.env.ARTIFACT_DIR, 'codex'))
NODE
) &
build_pids+=("$!")

(
  cd "$repository_root"
  WEWORK_MOBILE_IOS_DERIVED_DATA="$derived_data" \
    .github/scripts/build-wework-mobile-ios-app.sh \
    "$device_id" \
    "$artifact_dir/Wegent.app"
) &
build_pids+=("$!")

failures=()
for index in "${!build_pids[@]}"; do
  if ! wait "${build_pids[$index]}"; then
    failures+=("${build_names[$index]}")
  fi
done

if ((${#failures[@]} > 0)); then
  printf 'Mobile iOS artifact build failed:' >&2
  printf ' %s' "${failures[@]}" >&2
  printf '\n' >&2
  exit 1
fi

rm -f "$artifact_dir/Wegent.app.zip"
ditto -c -k --sequesterRsrc --keepParent \
  "$artifact_dir/Wegent.app" \
  "$artifact_dir/Wegent.app.zip"
rm -rf "$artifact_dir/Wegent.app"
