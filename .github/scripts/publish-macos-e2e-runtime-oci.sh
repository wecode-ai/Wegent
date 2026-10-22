#!/usr/bin/env bash

set -euo pipefail

if (($# < 2)); then
  echo "usage: $0 <source> <oci-reference>..." >&2
  exit 2
fi

source="$1"
shift

if [[ ! -x "$source" ]]; then
  echo "Runtime is not executable: $source" >&2
  exit 1
fi

source_directory="$(dirname "$source")"
source_name="$(basename "$source")"

for reference in "$@"; do
  if oras manifest fetch "$reference" >/dev/null 2>&1; then
    echo "OCI runtime artifact already exists: $reference"
    continue
  fi

  (
    cd "$source_directory"
    oras push \
      --artifact-type application/vnd.wegent.macos-e2e-runtime.v1 \
      "$reference" \
      "$source_name:application/octet-stream"
  )
done
