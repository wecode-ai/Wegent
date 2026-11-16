#!/usr/bin/env bash
set -euo pipefail

test "${CI:-}" = true

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/lib/apt-packages.sh"
privileged=()
if ((EUID != 0)); then privileged=(sudo); fi

run_apt_with_diagnostics "${privileged[@]}" apt-get -o APT::Update::Error-Mode=any update
run_apt_with_diagnostics "${privileged[@]}" apt-get install --yes --no-install-recommends "$@"
