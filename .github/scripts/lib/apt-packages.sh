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

install_missing_apt_packages() {
  local package
  local missing=()
  while IFS= read -r package; do
    missing+=("$package")
  done < <(find_missing_apt_packages "$@")
  if ((${#missing[@]} == 0)); then return 0; fi

  local privileged=()
  if ((EUID != 0)); then privileged=(sudo); fi
  local update_attempt update_status delay
  for update_attempt in 1 2 3 4; do
    update_status=0
    run_apt_with_diagnostics "${privileged[@]}" apt-get -o APT::Update::Error-Mode=any update ||
      update_status=$?
    if ((update_status == 0)); then break; fi
    # Repository mirror rate limits surface as apt exit 100; other failures are
    # configuration errors and should still fail immediately.
    if ((update_status != 100 || update_attempt == 4)); then return "$update_status"; fi
    delay=$((update_attempt * 10))
    printf 'APT update failed (attempt %s/4); retrying in %ss.\n' "$update_attempt" "$delay" >&2
    if command -v sleep >/dev/null 2>&1; then sleep "$delay"; fi
  done
  run_apt_with_diagnostics "${privileged[@]}" apt-get install --yes --no-install-recommends "${missing[@]}"
}
