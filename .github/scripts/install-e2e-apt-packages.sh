#!/usr/bin/env bash
set -euo pipefail

test "${CI:-}" = true
test -f /.dockerenv

# Use a listed Ubuntu mirror outside ubuntu.com's DNS zone, retaining suites and
# signing keyring. Only disposable CI containers use this source configuration.
for source in /etc/apt/sources.list /etc/apt/sources.list.d/*.{list,sources}; do
  if [[ -f "$source" ]]; then
    sed -i -E 's#https?://(archive|security)\.ubuntu\.com/ubuntu#https://mirrors.kernel.org/ubuntu#g' "$source"
  fi
done
apt-get -o APT::Update::Error-Mode=any update
apt-get install --yes --no-install-recommends "$@"
