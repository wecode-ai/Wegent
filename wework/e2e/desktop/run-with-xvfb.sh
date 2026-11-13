#!/bin/sh
set -eu

xvfb_screen=${WEWORK_E2E_XVFB_SCREEN:-1280x720x24}
if ! printf '%s\n' "$xvfb_screen" | LC_ALL=C grep -Eq '^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}x(16|24|32)$'; then
  printf '%s\n' 'WEWORK_E2E_XVFB_SCREEN must be WIDTHxHEIGHTxDEPTH (depth 16, 24 or 32)' >&2
  exit 2
fi
xvfb_server_num=${WEWORK_E2E_XVFB_SERVER_NUM:-}
if [ -n "$xvfb_server_num" ] && ! printf '%s\n' "$xvfb_server_num" | LC_ALL=C grep -Eq '^[0-9]+$'; then
  printf '%s\n' 'WEWORK_E2E_XVFB_SERVER_NUM must be a display number' >&2
  exit 2
fi

xvfb_root=$(mktemp -d -t wework-e2e-xvfb.XXXXXX)
xvfb_log="$xvfb_root/Xvfb.log"
xvfb_pid=''
cleanup() {
  xvfb_status=$?
  if [ -n "$xvfb_pid" ]; then
    kill "$xvfb_pid" 2>/dev/null || :
    wait "$xvfb_pid" 2>/dev/null || :
  fi
  if [ -f "$xvfb_log" ]; then cat "$xvfb_log" >&2 || :; fi
  rm -rf "$xvfb_root" || :
  exit "$xvfb_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

export XAUTHORITY="$xvfb_root/Xauthority"
(umask 077; touch "$XAUTHORITY")
xvfb_cookie=$(mcookie)
# Xvfb loads the cookie before selecting a display; clients need the selected number.
xauth -f "$XAUTHORITY" add :0 . "$xvfb_cookie" >>"$xvfb_log" 2>&1
start_display() {
  exec Xvfb "$@" -displayfd 3 -noreset -nolisten tcp -screen 0 "$xvfb_screen" \
    -auth "$XAUTHORITY" 3>"$xvfb_root/display" >>"$xvfb_log" 2>&1
}
if [ -n "$xvfb_server_num" ]; then
  start_display ":$xvfb_server_num" &
else
  start_display &
fi
xvfb_pid=$!

# A written display number cannot be lost when readiness precedes the parent's wait.
xvfb_attempt=0
while [ ! -s "$xvfb_root/display" ]; do
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    xvfb_status=0
    wait "$xvfb_pid" || xvfb_status=$?
    printf '%s\n' 'Xvfb exited before publishing its display' >&2
    if [ "$xvfb_status" -eq 0 ]; then xvfb_status=1; fi
    exit "$xvfb_status"
  fi
  if [ "$xvfb_attempt" -ge 100 ]; then
    printf '%s\n' 'Xvfb did not publish its display within 5 seconds' >&2
    exit 1
  fi
  xvfb_attempt=$((xvfb_attempt + 1))
  sleep 0.05
done
xvfb_display=$(cat "$xvfb_root/display")
if ! printf '%s\n' "$xvfb_display" | LC_ALL=C grep -Eq '^[0-9]+$'; then
  printf '%s\n' 'Xvfb published an invalid display number' >&2
  exit 1
fi
xauth -f "$XAUTHORITY" add ":$xvfb_display" . "$xvfb_cookie" >>"$xvfb_log" 2>&1
export DISPLAY=":$xvfb_display"
"$@"
