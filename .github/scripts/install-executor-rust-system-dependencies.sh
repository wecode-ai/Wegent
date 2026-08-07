#!/usr/bin/env bash

set -euo pipefail

packages=(pkg-config libssl-dev)
missing=()

for package in "${packages[@]}"; do
  if ! dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null | grep -q '^ii '; then
    missing+=("$package")
  fi
done

if ((${#missing[@]} == 0)); then
  echo "Executor Rust system dependencies are already installed."
  exit 0
fi

echo "Installing missing executor Rust system dependencies: ${missing[*]}"
sudo apt-get update
sudo apt-get install -y --no-install-recommends "${missing[@]}"
