#!/usr/bin/env bash

set -euo pipefail

if (($# < 3)); then
  echo "usage: $0 <destination> <artifact-name> <oci-reference>..." >&2
  exit 2
fi

destination="$1"
artifact_name="$2"
shift 2

if [[ -x "$destination" ]]; then
  exit 0
fi

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
  if [[ ! -f "$source" ]]; then
    echo "OCI runtime artifact $reference is missing $artifact_name" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$destination")"
  temporary_destination="${destination}.restore.$$"
  cp "$source" "$temporary_destination"
  chmod 0755 "$temporary_destination"
  mv -f "$temporary_destination" "$destination"
  echo "Restored $artifact_name from $reference"
  exit 0
done

echo "No OCI runtime artifact found for $artifact_name"
