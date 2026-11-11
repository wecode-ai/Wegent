#!/usr/bin/env bash

set -euo pipefail

rewrite_ci_ubuntu_archive() {
  sed -E 's#https?://(archive|security|azure\.archive)\.ubuntu\.com/ubuntu/?|mirror\+file:/etc/apt/apt-mirrors\.txt#http://mirrors.edge.kernel.org/ubuntu#g'
}

find_missing_apt_packages() {
  local package

  for package in "$@"; do
    if ! dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null |
      grep -q '^ii '; then
      printf '%s\n' "$package"
    fi
  done
}
