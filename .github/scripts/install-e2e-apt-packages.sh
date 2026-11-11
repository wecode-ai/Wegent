#!/usr/bin/env bash
set -euo pipefail

test "${CI:-}" = true

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/lib/apt-packages.sh"
privileged=()
if ((EUID != 0)); then privileged=(sudo); fi

# Preserve Ubuntu suites and signing keys on disposable CI hosts and containers.
for source in /etc/apt/sources.list /etc/apt/sources.list.d/*.{list,sources}; do
  if [[ -f "$source" ]]; then
    rewritten_source="$(rewrite_ci_ubuntu_archive < "$source")"
    printf '%s\n' "$rewritten_source" | "${privileged[@]}" tee "$source" >/dev/null
  fi
done
"${privileged[@]}" apt-get -o APT::Update::Error-Mode=any update
"${privileged[@]}" apt-get install --yes --no-install-recommends "$@"
