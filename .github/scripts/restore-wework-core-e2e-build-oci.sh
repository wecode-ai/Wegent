#!/usr/bin/env bash

set -euo pipefail

if (($# < 2)); then
  echo "usage: $0 <destination> <oci-reference>..." >&2
  exit 2
fi

destination="$1"
shift
artifact_name="$(basename "$destination")"
temporary_root="$(mktemp -d)"
trap 'rm -rf "$temporary_root"' EXIT

for reference in "$@"; do
  artifact_root="$temporary_root/artifact"
  rm -rf "$artifact_root"
  mkdir -p "$artifact_root"
  if ! oras manifest fetch "$reference" >/dev/null 2>&1; then
    continue
  fi

  oras pull --output "$artifact_root" "$reference"
  source="$artifact_root/$artifact_name"
  if [[ ! -s "$source" ]]; then
    echo "OCI Wework Core E2E build $reference is missing $artifact_name" >&2
    exit 2
  fi

  mkdir -p "$(dirname "$destination")"
  temporary_destination="${destination}.restore.$$"
  cp "$source" "$temporary_destination"
  mv -f "$temporary_destination" "$destination"
  echo "Restored Wework Core E2E build from $reference"
  exit 0
done

echo "No OCI Wework Core E2E build found"
exit 1
