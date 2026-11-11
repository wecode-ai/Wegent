#!/usr/bin/env bash

set -euo pipefail

find_missing_apt_packages() {
  local package

  for package in "$@"; do
    if ! dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null |
      grep -q '^ii '; then
      printf '%s\n' "$package"
    fi
  done
}

install_missing_apt_packages() {
  local package
  local missing=()
  while IFS= read -r package; do
    missing+=("$package")
  done < <(find_missing_apt_packages "$@")
  if ((${#missing[@]} == 0)); then return 0; fi

  local privileged=()
  if ((EUID != 0)); then privileged=(sudo); fi
  "${privileged[@]}" apt-get -o APT::Update::Error-Mode=any update || return
  "${privileged[@]}" apt-get install --yes --no-install-recommends "${missing[@]}"
}
