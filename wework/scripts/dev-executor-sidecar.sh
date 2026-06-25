#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$WEWORK_DIR/.." && pwd)"
EXECUTOR_DIR="$PROJECT_DIR/executor"

export PYTHONPATH="$PROJECT_DIR${PYTHONPATH:+:$PYTHONPATH}"

cd "$EXECUTOR_DIR"

if [ "${WEGENT_EXECUTOR_DEV_RELOAD:-1}" = "0" ]; then
  if [ -x "$EXECUTOR_DIR/.venv/bin/python" ]; then
    exec "$EXECUTOR_DIR/.venv/bin/python" main.py "$@"
  fi
  exec uv run python main.py "$@"
fi

if [ -x "$EXECUTOR_DIR/.venv/bin/python" ]; then
  exec "$EXECUTOR_DIR/.venv/bin/python" scripts/dev_sidecar.py "$@"
fi

exec uv run python scripts/dev_sidecar.py "$@"
