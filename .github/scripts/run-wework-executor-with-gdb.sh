#!/usr/bin/env bash

set -euo pipefail

executor_binary="${WEWORK_E2E_EXECUTOR_REAL_BIN:?The real Executor binary is required}"

# Schema queries and standalone MCP servers keep their normal stdout protocol.
if [[ -z "${WEGENT_APP_IPC_ENDPOINT:-}" ]]; then
  exec "$executor_binary" "$@"
fi

# A native crash must retain a stack trace instead of leaving only SIGSEGV in
# the supervisor log. Do not print arguments or locals, which can contain keys.
exec gdb --quiet --batch --return-child-result \
  -ex 'set pagination off' \
  -ex 'set print frame-arguments none' \
  -ex 'set startup-with-shell off' \
  -ex 'handle SIGPIPE nostop noprint pass' \
  -ex 'handle SIGTERM nostop noprint pass' \
  -ex run \
  -ex 'thread apply all bt' \
  --args "$executor_binary" "$@"
