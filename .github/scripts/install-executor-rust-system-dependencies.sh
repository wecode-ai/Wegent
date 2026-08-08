#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/lib/apt-packages.sh"

packages=(pkg-config libssl-dev)
mapfile -t missing < <(find_missing_apt_packages "${packages[@]}")

if ((${#missing[@]} == 0)); then
  echo "Executor Rust system dependencies are already installed."
  exit 0
fi

echo "Installing missing executor Rust system dependencies: ${missing[*]}"
sudo apt-get update
sudo apt-get install -y --no-install-recommends "${missing[@]}"
