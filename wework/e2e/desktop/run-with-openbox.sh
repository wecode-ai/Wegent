#!/bin/sh
set -eu

# `xvfb-run -a` can hand the command a display that is not accepting window
# manager connections yet, which makes openbox exit immediately. That is an
# infrastructure start race, not a checkpoint failure, so retry the start a
# bounded number of times before reporting it.
MAX_STARTS=10

start_window_manager() {
  openbox >&2 &
  openbox_pid=$!
  trap 'kill "$openbox_pid" 2>/dev/null || true; wait "$openbox_pid" 2>/dev/null || true' EXIT

  attempt=0
  while [ "$attempt" -lt 100 ]; do
    if ! kill -0 "$openbox_pid" 2>/dev/null; then
      echo 'Openbox exited before registering with the isolated Xvfb display' >&2
      return 1
    fi
    # A missing atom also echoes its name; only a nonzero window id proves readiness.
    if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null |
      grep -Eq 'window id # 0x0*[1-9a-fA-F][0-9a-fA-F]*([,[:space:]]|$)'; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.05
  done

  echo 'Openbox did not register with the isolated Xvfb display' >&2
  return 1
}

starts=0
while [ "$starts" -lt "$MAX_STARTS" ]; do
  starts=$((starts + 1))
  if start_window_manager; then
    echo "[desktop-e2e-window-manager] ready: display=$DISPLAY pid=$openbox_pid" >&2
    "$@"
    exit $?
  fi
  sleep 0.2
done

echo "The window manager never registered after $MAX_STARTS starts" >&2
exit 1
