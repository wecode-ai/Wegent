#!/usr/bin/env bash

set -euo pipefail

readonly max_attempts="${PLAYWRIGHT_INSTALL_MAX_ATTEMPTS:-3}"
readonly timeout_seconds="${PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS:-600}"
readonly apt_conf_path="${APT_CONFIG_PATH:-/etc/apt/apt.conf.d/99wegent-playwright}"

write_apt_config() {
  if [[ -n "${APT_CONFIG:-}" ]]; then
    return
  fi

  printf '%s\n' \
    'Acquire::http::Timeout "15";' \
    'Acquire::https::Timeout "15";' \
    'Acquire::Retries "3";' \
    | sudo tee "$apt_conf_path" >/dev/null
}

cleanup_stale_apt_processes() {
  echo "Cleaning up stale apt/dpkg processes..."

  for pattern in '^/usr/bin/apt-get ' '^/usr/bin/apt ' '^/usr/bin/dpkg '; do
    sudo pkill -TERM -f "$pattern" || true
  done

  sleep 2

  for pattern in '^/usr/bin/apt-get ' '^/usr/bin/apt ' '^/usr/bin/dpkg '; do
    sudo pkill -KILL -f "$pattern" || true
  done

  sudo rm -f \
    /var/lib/apt/lists/lock \
    /var/cache/apt/archives/lock \
    /var/lib/dpkg/lock \
    /var/lib/dpkg/lock-frontend

  sudo dpkg --configure -a || true
}

for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  echo "Installing Playwright system dependencies (attempt $attempt/$max_attempts)"

  write_apt_config

  if timeout \
    --signal=TERM \
    --kill-after=15s \
    "${timeout_seconds}s" \
    pnpm exec playwright install-deps chromium; then
    exit 0
  fi

  cleanup_stale_apt_processes

  if [[ "$attempt" -eq "$max_attempts" ]]; then
    echo "Playwright system dependency installation failed after $max_attempts attempts" >&2
    exit 1
  fi

  sleep $((attempt * 5))
done
