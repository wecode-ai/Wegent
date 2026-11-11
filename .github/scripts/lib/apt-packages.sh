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

run_apt_with_diagnostics() {
  local apt_status=0
  "$@" || apt_status=$?
  if ((apt_status != 0)) && [[ "${CI:-}" == true ]]; then
    # Optional diagnostics must never replace the installer's original failure.
    {
      printf 'APT command failed with exit status %s; resolver diagnostics follow.\n' "$apt_status"
      awk '/^nameserver[[:space:]]/ { print }' /etc/resolv.conf
      local apt_host apt_family
      for apt_host in mirrors.edge.kernel.org archive.ubuntu.com security.ubuntu.com azure.archive.ubuntu.com deb.nodesource.com; do
        for apt_family in ahostsv4 ahostsv6; do
          printf 'APT resolver host=%s family=%s\n' "$apt_host" "$apt_family"
          timeout 2 getent "$apt_family" "$apt_host"
        done
      done
      if command -v curl >/dev/null; then
        local apt_url
        for apt_url in \
          http://mirrors.edge.kernel.org/ubuntu/ \
          https://mirrors.edge.kernel.org/ubuntu/ \
          https://archive.ubuntu.com/ubuntu/ \
          https://security.ubuntu.com/ubuntu/; do
          printf 'APT IPv4 transport probe=%s\n' "$apt_url"
          curl --ipv4 --head --silent --show-error --output /dev/null \
            --connect-timeout 2 --max-time 3 \
            --write-out 'http=%{http_code} remote=%{remote_ip} connect=%{time_connect} total=%{time_total}\n' \
            "$apt_url" || true
        done
      fi
    } >&2 || true
  fi
  return "$apt_status"
}
