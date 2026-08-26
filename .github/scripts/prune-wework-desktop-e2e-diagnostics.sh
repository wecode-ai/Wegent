#!/usr/bin/env bash

set -euo pipefail

diagnostics_root="${1:-wework/test-results/desktop-e2e}"

if [[ ! -d "$diagnostics_root" ]]; then
  exit 0
fi

find "$diagnostics_root" -type d \( \
  -name 'Cache' -o \
  -name 'Code Cache' -o \
  -name 'DawnGraphiteCache' -o \
  -name 'DawnWebGPUCache' -o \
  -name 'GPUCache' -o \
  -name 'GrShaderCache' -o \
  -name 'ShaderCache' \
\) -prune -exec rm -rf {} +
