#!/bin/sh
set -eu

# xvfb-run reopens its error path; Node's socket-backed stdio cannot be reopened.
xvfb_log=$(mktemp -t wework-e2e-xvfb.XXXXXX)
trap 'xvfb_status=$?; cat "$xvfb_log" >&2; rm -f "$xvfb_log"; exit "$xvfb_status"' EXIT

# Short-lived probes must not reset the display while Openbox connects.
# xvfb-run owns the isolated server until the checkpoint exits.
xvfb-run -a --error-file="$xvfb_log" \
  --server-args="-noreset -screen 0 1280x720x24" "$@"
