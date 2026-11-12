#!/usr/bin/env bash
set -euo pipefail

test "${CI:-}" = true

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/lib/apt-packages.sh"
privileged=()
if ((EUID != 0)); then privileged=(sudo); fi

apt_options=(
  -o Acquire::ForceIPv4=true
  -o Acquire::Retries=3
)
run_apt_with_diagnostics "${privileged[@]}" apt-get "${apt_options[@]}" -o APT::Update::Error-Mode=any update
run_apt_with_diagnostics "${privileged[@]}" apt-get "${apt_options[@]}" install --yes --no-install-recommends "$@"
