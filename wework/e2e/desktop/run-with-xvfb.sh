#!/bin/sh
set -eu

diagnostic_directory=$(mktemp -d "${TMPDIR:-/tmp}/wework-xvfb.XXXXXX")
diagnostic_file="$diagnostic_directory/xvfb.log"

cleanup() {
  status=$?
  trap - EXIT
  if [ -s "$diagnostic_file" ]; then
    cat "$diagnostic_file" >&2 || true
  fi
  rm -rf "$diagnostic_directory" || true
  exit "$status"
}
trap cleanup EXIT

xvfb-run -a --error-file="$diagnostic_file" \
  --server-args="-screen 0 1280x720x24" \
  sh "$(dirname "$0")/run-with-openbox.sh" "$@"
