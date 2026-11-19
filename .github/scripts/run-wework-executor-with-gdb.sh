#!/usr/bin/env bash

set -euo pipefail

executor_binary="${WEWORK_E2E_EXECUTOR_REAL_BIN:-${BASH_SOURCE[0]%.gdb}}"
if [[ "$executor_binary" == "${BASH_SOURCE[0]}" ]]; then
  printf 'The debugger wrapper must be beside its Executor with a .gdb suffix\n' >&2
  exit 2
fi
test -x "$executor_binary"

# Schema queries and standalone MCP servers keep their normal stdout protocol.
if [[ -z "${WEGENT_APP_IPC_ENDPOINT:-}" ]]; then
  exec "$executor_binary" "$@"
fi

# A native crash must retain a stack trace instead of leaving only SIGSEGV in
# the supervisor log. Do not print arguments or locals, which can contain keys.
# The debugger owns the pipes; identify each native producer without reading its arguments.
exec gdb --quiet --batch --return-child-result \
  -ex 'set pagination off' \
  -ex 'set print frame-arguments none' \
  -ex 'set startup-with-shell off' \
  -ex 'handle SIGPIPE nostop noprint pass' \
  -ex 'handle SIGTERM nostop noprint pass' \
  -ex 'python import json, os; _wework_executor_pids = set()' \
  -ex 'python gdb.events.new_thread.connect(lambda event: (_wework_executor_pids.add(event.inferior_thread.ptid[0]), gdb.write("[executor-gdb-inferior] " + json.dumps({"debuggerPid": os.getpid(), "executorPid": event.inferior_thread.ptid[0]}) + "\n")) if event.inferior_thread.ptid[0] > 0 and event.inferior_thread.ptid[0] not in _wework_executor_pids else None)' \
  -ex run \
  -ex 'thread apply all bt' \
  --args "$executor_binary" "$@"
