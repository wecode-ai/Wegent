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

report_apt_network_diagnostics() {
  local hostname

  printf '%s\n' '[apt-network] Resolver configuration:' >&2
  cat /etc/resolv.conf >&2 || true
  for hostname in azure.archive.ubuntu.com archive.ubuntu.com security.ubuntu.com github.com packages.microsoft.com; do
    printf '[apt-network] IPv4 lookup: %s\n' "$hostname" >&2
    timeout 5 getent ahostsv4 "$hostname" >&2 || true
  done
}
