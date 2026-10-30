#!/bin/sh
set -eu

# xvfb-run reopens its error path; Node's socket-backed stdio cannot be reopened.
xvfb_log=$(mktemp -t wework-e2e-xvfb.XXXXXX)
cleanup() {
  xvfb_status=$?
  if [ -f "$xvfb_log" ]; then
    cat "$xvfb_log" >&2 || :
  fi
  rm -f "$xvfb_log" || :
  exit "$xvfb_status"
}
trap cleanup EXIT

# Parallel checkpoint workers reserve distinct numbers in their parent process.
if [ -n "${WEWORK_E2E_XVFB_SERVER_NUM:-}" ]; then
  set -- "--server-num=$WEWORK_E2E_XVFB_SERVER_NUM" "$@"
else
  set -- -a "$@"
fi

# Short-lived probes must not reset the display while Openbox connects.
# xvfb-run owns the isolated server until the checkpoint exits.
xvfb-run --error-file="$xvfb_log" \
  --server-args="-noreset -screen 0 1280x720x24" "$@"
