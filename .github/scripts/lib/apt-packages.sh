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

install_apt_packages() {
  local privileged=()
  if ((EUID != 0)); then privileged=(sudo); fi
  local apt_options=()
  if [[ -n "${WEGENT_CI_APT_SOURCE_LIST:-}" ]]; then
    if [[ ! -f "$WEGENT_CI_APT_SOURCE_LIST" || ! -r "$WEGENT_CI_APT_SOURCE_LIST" ]]; then
      printf 'The configured CI distribution source list is not readable: %s\n' "$WEGENT_CI_APT_SOURCE_LIST" >&2
      return 1
    fi
    # Limit this transaction without changing the runner's repositories or trust.
    apt_options=(-o "Dir::Etc::sourcelist=$WEGENT_CI_APT_SOURCE_LIST" -o Dir::Etc::sourceparts=-)
  fi
  run_apt_with_diagnostics "${privileged[@]}" apt-get "${apt_options[@]}" -o APT::Update::Error-Mode=any update || return
  run_apt_with_diagnostics "${privileged[@]}" apt-get "${apt_options[@]}" install --yes --no-install-recommends "$@"
}

install_missing_apt_packages() {
  local package
  local missing=()
  while IFS= read -r package; do
    missing+=("$package")
  done < <(find_missing_apt_packages "$@")
  if ((${#missing[@]} == 0)); then return 0; fi

  install_apt_packages "${missing[@]}"
}
