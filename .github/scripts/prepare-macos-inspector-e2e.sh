#!/usr/bin/env bash
set -euo pipefail

brew install redis libmagic mysql &
brew_pid=$!
uv sync --project backend --frozen &
backend_pid=$!
result=0
if ! wait "$brew_pid"; then result=1; fi
if ! wait "$backend_pid"; then result=1; fi
if ((result != 0)); then exit "$result"; fi
redis-server --version
mysqld --version
uv run --project backend python -c \
  "import magic; assert magic.from_buffer(b'Wework E2E', mime=True) == 'text/plain'"
