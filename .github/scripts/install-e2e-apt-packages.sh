#!/usr/bin/env bash
set -euo pipefail

test "${CI:-}" = true

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/lib/apt-packages.sh"
install_apt_packages "$@"
