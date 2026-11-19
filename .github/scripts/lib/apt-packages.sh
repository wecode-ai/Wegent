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

run_apt_with_diagnostics() {
  local apt_status=0
  "$@" || apt_status=$?
  if ((apt_status != 0)) && [[ "${CI:-}" == true ]]; then
    # Optional diagnostics must never replace the installer's original failure.
    {
      printf 'APT command failed with exit status %s; resolver diagnostics follow.\n' "$apt_status"
      awk '/^nameserver[[:space:]]/ { print }' /etc/resolv.conf
      local apt_host apt_family
      for apt_host in archive.ubuntu.com security.ubuntu.com azure.archive.ubuntu.com deb.nodesource.com; do
        for apt_family in ahostsv4 ahostsv6; do
          printf 'APT resolver host=%s family=%s\n' "$apt_host" "$apt_family"
          timeout 2 getent "$apt_family" "$apt_host"
        done
      done
    } >&2 || true
  fi
  return "$apt_status"
}

update_apt_package_indexes() {
  local update_log apt_status=0
  update_log=$(run_apt_with_diagnostics "$@" apt-get -o APT::Update::Error-Mode=any update 2>&1) || apt_status=$?
  printf '%s\n' "$update_log" >&2
  if ((apt_status == 0)); then return 0; fi

  if grep -Eq '^E: Failed to fetch .* (File has unexpected size|Hash Sum mismatch)' <<< "$update_log"; then
    printf 'Refreshing APT metadata after an inconsistent mirror index.\n' >&2
    run_apt_with_diagnostics "$@" apt-get -o APT::Update::Error-Mode=any \
      -o Acquire::http::No-Cache=true -o Acquire::https::No-Cache=true update
  else
    return "$apt_status"
  fi
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
  update_apt_package_indexes "${privileged[@]}" || return
  run_apt_with_diagnostics "${privileged[@]}" apt-get install --yes --no-install-recommends "${missing[@]}"
}
