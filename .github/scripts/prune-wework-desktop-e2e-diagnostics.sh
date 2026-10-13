#!/usr/bin/env bash

set -euo pipefail

diagnostics_root="${1:-wework/test-results/desktop-e2e}"

if [[ ! -d "$diagnostics_root" ]]; then
  exit 0
fi

# Raw V8 profiles contain local paths and function names; only safe summaries are uploaded.
summary_status=0
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node "$repository_root/wework/scripts/summarize-core-startup-profiles.mjs" "$diagnostics_root" || summary_status=$?
find "$diagnostics_root" -type f -name '*.cpuprofile' -delete

find "$diagnostics_root" \
  -mindepth 2 \
  -maxdepth 2 \
  -type d \
  ! -name 'electron-user-data' \
  -prune \
  -exec rm -rf {} +

find "$diagnostics_root" \
  -type d \
  \( -name 'managed-components' -o -name 'managed-runtimes' \) \
  -prune \
  -exec rm -rf {} +

find "$diagnostics_root" \
  -type d \
  -name 'profiles' \
  \( \
    -path '*/dsh-core/profiles' -o \
    -path '*/Harness/profiles' -o \
    -path '*/harness-apps/instances/*/profiles' \
  \) \
  -prune \
  -exec rm -rf {} +

find "$diagnostics_root" -type d \( \
  -name 'Cache' -o \
  -name 'Code Cache' -o \
  -name 'DawnGraphiteCache' -o \
  -name 'DawnWebGPUCache' -o \
  -name 'GPUCache' -o \
  -name 'GrShaderCache' -o \
  -name 'ShaderCache' \
\) -prune -exec rm -rf {} +

find "$diagnostics_root" \
  -mindepth 2 \
  -maxdepth 2 \
  -type f \
  \( \
    -name '*.tar' -o \
    -name '*.tar.gz' -o \
    -name '*.tar.zst' -o \
    -name '*.tgz' -o \
    -name '*.zip' -o \
    -name 'wegent-executor' -o \
    -name 'wegent-executor.exe' \
  \) \
  -delete

exit "$summary_status"
