#!/usr/bin/env bash
set -euo pipefail

test "${CI:-}" = true
test -f /.dockerenv

# Use the reachable Ubuntu mirror while retaining the image's suites and
# signing keyring. Only disposable CI containers use this source configuration.
for source in /etc/apt/sources.list /etc/apt/sources.list.d/*.{list,sources}; do
  if [[ -f "$source" ]]; then
    sed -i -E 's#http://(archive|security)\.ubuntu\.com/ubuntu#https://security.ubuntu.com/ubuntu#g' "$source"
  fi
done
apt-get -o APT::Update::Error-Mode=any update
apt-get install --yes --no-install-recommends "$@"
