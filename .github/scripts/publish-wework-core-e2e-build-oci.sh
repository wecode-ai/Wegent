#!/usr/bin/env bash

set -euo pipefail

if (($# < 2)); then
  echo "usage: $0 <archive> <oci-reference>..." >&2
  exit 2
fi

archive="$1"
shift

if [[ ! -s "$archive" ]]; then
  echo "Wework Core E2E archive is missing or empty: $archive" >&2
  exit 1
fi

archive_directory="$(dirname "$archive")"
archive_name="$(basename "$archive")"

for reference in "$@"; do
  if oras manifest fetch "$reference" >/dev/null 2>&1; then
    echo "OCI Wework Core E2E build already exists: $reference"
    continue
  fi

  (
    cd "$archive_directory"
    oras push \
      --artifact-type application/vnd.wegent.wework-core-e2e-build.v1 \
      "$reference" \
      "$archive_name:application/zstd"
  )
done
