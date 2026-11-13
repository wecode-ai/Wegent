#!/bin/sh
set -eu

# Each checkpoint owns a private D-Bus session and real Secret Service. Never use
# the developer's keyring or Electron's public fixed-key Linux fallback.
keyring_root=$(mktemp -d -t wework-e2e-keyring.XXXXXX)
keyring_pid=''
cleanup() {
  keyring_status=$?
  if [ -n "$keyring_pid" ]; then
    kill "$keyring_pid" 2>/dev/null || :
    wait "$keyring_pid" 2>/dev/null || :
  fi
  rm -rf "$keyring_root"
  exit "$keyring_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

export XDG_DATA_HOME="$keyring_root/data"
export XDG_CONFIG_HOME="$keyring_root/config"
export XDG_CACHE_HOME="$keyring_root/cache"
export XDG_RUNTIME_DIR="$keyring_root/runtime"
# Electron selects libsecret only for a declared compatible desktop session.
export XDG_CURRENT_DESKTOP=GNOME
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# The password protects synthetic checkpoint data only and is never persisted.
gnome-keyring-daemon --foreground --components=secrets --unlock <<'EOF' >&2 &
wework-isolated-e2e-keyring
EOF
keyring_pid=$!
gdbus wait --session --timeout 10 org.freedesktop.secrets
keyring_locked=$(gdbus call --session --dest org.freedesktop.secrets \
  --object-path /org/freedesktop/secrets/collection/login \
  --method org.freedesktop.DBus.Properties.Get org.freedesktop.Secret.Collection Locked)
if [ "$keyring_locked" != '(<false>,)' ]; then
  echo 'The isolated Secret Service did not unlock its login collection' >&2
  exit 1
fi
echo '[desktop-e2e-keyring] isolated Secret Service ready' >&2
"$@"
