#!/bin/sh
set -eu

echo "[desktop-e2e-window-manager] waiting for X display: display=${DISPLAY:-unset}" >&2
display_attempt=0
display_error=''
while ! display_error=$(xprop -root 2>&1); do
  display_attempt=$((display_attempt + 1))
  if [ "$display_attempt" -ge 100 ]; then
    echo "Xvfb display did not become reachable: display=${DISPLAY:-unset}" >&2
    printf '%s\n' "$display_error" >&2
    exit 1
  fi
  sleep 0.05
done

echo "[desktop-e2e-window-manager] starting: display=$DISPLAY" >&2
openbox >&2 &
openbox_pid=$!
trap 'kill "$openbox_pid" 2>/dev/null || true; wait "$openbox_pid" 2>/dev/null || true' EXIT

attempt=0
while [ "$attempt" -lt 100 ]; do
  if ! kill -0 "$openbox_pid" 2>/dev/null; then
    echo 'Openbox exited before registering with the isolated Xvfb display' >&2
    exit 1
  fi
  # A missing atom also echoes its name; only a nonzero window id proves readiness.
  if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null |
    grep -Eq 'window id # 0x0*[1-9a-fA-F][0-9a-fA-F]*([,[:space:]]|$)'; then
    echo "[desktop-e2e-window-manager] ready: display=$DISPLAY pid=$openbox_pid" >&2
    "$@"
    exit $?
  fi
  attempt=$((attempt + 1))
  sleep 0.05
done

echo 'Openbox did not register with the isolated Xvfb display' >&2
exit 1
