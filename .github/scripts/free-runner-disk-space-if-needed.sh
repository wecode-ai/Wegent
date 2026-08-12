#!/usr/bin/env bash

set -euo pipefail

threshold_gib="${1:-50}"
if ! [[ "$threshold_gib" =~ ^[0-9]+$ ]] || ((threshold_gib <= 0)); then
  echo "Disk cleanup threshold must be a positive integer in GiB." >&2
  exit 2
fi

available_kib="$(df --output=avail -k / | tail -1 | tr -d '[:space:]')"
threshold_kib=$((threshold_gib * 1024 * 1024))

echo "Runner disk space before optional cleanup:"
df -h /

if ((available_kib >= threshold_kib)); then
  echo "Skipping cleanup: at least ${threshold_gib} GiB is already available."
  exit 0
fi

echo "Available disk is below ${threshold_gib} GiB; removing unused hosted-runner SDKs."
sudo rm -rf \
  /usr/share/dotnet \
  /usr/local/lib/android \
  /opt/ghc \
  /opt/hostedtoolcache/CodeQL

echo "Runner disk space after cleanup:"
df -h /
