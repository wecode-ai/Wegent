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

is_apt_rate_limited() {
  local output=$1
  [[ "$output" =~ (HTTP[^[:space:]]*[[:space:]]*)?429[[:space:]]+Too[[:space:]]+Many[[:space:]]+Requests ]]
}

run_apt_update_with_retry() {
  local attempt
  local output=""
  local apt_status=0
  for attempt in 1 2 3; do
    apt_status=0
    output="$(run_apt_with_diagnostics "$@" 2>&1)" || apt_status=$?
    if ((apt_status == 0)); then
      [[ -z "$output" ]] || printf '%s\n' "$output"
      return 0
    fi
    if ! is_apt_rate_limited "$output"; then
      [[ -z "$output" ]] || printf '%s\n' "$output" >&2
      return "$apt_status"
    fi
    printf '%s\n' "$output" >&2
    if ((attempt == 3)); then
      return "$apt_status"
    fi
    # Package indexes can be rate-limited by an upstream mirror.
    echo "APT update failed; retrying in $((attempt * 5)) seconds." >&2
    if command -v sleep >/dev/null 2>&1; then
      sleep $((attempt * 5))
    else
      echo "sleep is unavailable; retrying without delay." >&2
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
  run_apt_update_with_retry "${privileged[@]}" apt-get -o APT::Update::Error-Mode=any update || return
  run_apt_with_diagnostics "${privileged[@]}" apt-get install --yes --no-install-recommends "${missing[@]}"
}
