#!/bin/sh
set -eu

attempt=0
display_ready=false
while [ "$attempt" -lt 100 ]; do
  attempt=$((attempt + 1))
  if xprop -root >/dev/null 2>&1; then
    display_ready=true
    break
  fi
  sleep 0.05
done

if [ "$display_ready" != true ]; then
  echo 'The isolated Xvfb display did not accept an X root query' >&2
  exit 1
fi

openbox >&2 &
openbox_pid=$!
trap 'kill "$openbox_pid" 2>/dev/null || true; wait "$openbox_pid" 2>/dev/null || true' EXIT

while [ "$attempt" -lt 100 ]; do
  if ! kill -0 "$openbox_pid" 2>/dev/null; then
    echo 'Openbox exited before registering with the isolated Xvfb display' >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  # A missing atom also echoes its name; only a nonzero window id proves readiness.
  if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null |
    grep -Eq 'window id # 0x0*[1-9a-fA-F][0-9a-fA-F]*([,[:space:]]|$)'; then
    echo "[desktop-e2e-window-manager] ready: display=$DISPLAY pid=$openbox_pid" >&2
    "$@"
    exit $?
  fi
  sleep 0.05
done

echo 'Openbox did not register with the isolated Xvfb display' >&2
exit 1
