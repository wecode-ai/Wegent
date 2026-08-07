#!/usr/bin/env bash

set -euo pipefail

profile="${1:-}"
include_redis="${2:-}"

case "$profile" in
  build)
    packages=(
      build-essential
      libayatana-appindicator3-dev
      libssl-dev
      libwebkit2gtk-4.1-dev
      librsvg2-dev
    )
    ;;
  runtime)
    packages=(
      libayatana-appindicator3-dev
      libssl-dev
      libwebkit2gtk-4.1-dev
      imagemagick
      librsvg2-dev
      xvfb
    )
    ;;
  full)
    packages=(
      build-essential
      libayatana-appindicator3-dev
      libssl-dev
      libwebkit2gtk-4.1-dev
      imagemagick
      librsvg2-dev
      xvfb
    )
    ;;
  *)
    printf 'Usage: %s <build|runtime|full> [redis]\n' "$0" >&2
    exit 2
    ;;
esac

if [[ "$include_redis" == "redis" ]]; then
  packages+=(redis-server)
elif [[ -n "$include_redis" ]]; then
  printf 'Unknown optional dependency group: %s\n' "$include_redis" >&2
  exit 2
fi

missing_packages=()
for package in "${packages[@]}"; do
  if ! dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null |
    grep -q '^ii '; then
    missing_packages+=("$package")
  fi
done

if ((${#missing_packages[@]} == 0)); then
  printf 'All Tauri system dependencies are already installed.\n'
  exit 0
fi

apt_archives="$HOME/.cache/wework-apt/archives"
mkdir -p "$apt_archives/partial"
sudo chown _apt:root "$apt_archives/partial"
sudo chmod 700 "$apt_archives/partial"

apt_options=(
  -o "Dir::Cache::archives=$apt_archives/"
  -o "Acquire::Retries=5"
  -o "Acquire::http::Timeout=30"
  -o "Acquire::https::Timeout=30"
  -o "Binary::apt-get::APT::Keep-Downloaded-Packages=true"
)

printf 'Installing missing Tauri system dependencies: %s\n' \
  "${missing_packages[*]}"
sudo apt-get "${apt_options[@]}" update
sudo apt-get "${apt_options[@]}" install -y --no-install-recommends \
  "${missing_packages[@]}"
sudo chown -R "$USER:$(id -gn)" "$apt_archives"
