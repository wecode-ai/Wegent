#!/usr/bin/env bash
set -euo pipefail

package="$1"
shift
artifacts="${RUNNER_TEMP:?}/backend-rs-test-artifacts.jsonl"
target="${package//-/_}"

artifact="$(jq -rs --arg target "$target" '
  [.[] | select(.reason == "compiler-artifact" and .profile.test
    and .target.name == $target and (.target.kind | index("lib"))
    and .executable != null)]
  | if length == 1 then .[0] | [.manifest_path, .executable] | @tsv
    else error("expected one workspace test binary for " + $target) end
' "$artifacts")"
IFS=$'\t' read -r manifest binary <<< "$artifact"
export CARGO_MANIFEST_DIR="${manifest%/*}"
export CARGO_MANIFEST_PATH="$manifest"
rust_libdir="$(rustc --print target-libdir)"
export LD_LIBRARY_PATH="${binary%/*}:$rust_libdir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
cd "$CARGO_MANIFEST_DIR"

# libtest succeeds with an empty filter result. Treat that as a broken CI selection.
listed="$("$binary" --ignored --list "$@")"
if [[ "$listed" != *': test'* ]]; then
  printf 'No ignored tests matched in %s: %s\n' "$package" "$*" >&2
  exit 1
fi
exec "$binary" --ignored "$@"
