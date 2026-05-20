#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Set PYTHONPATH to include project root (for shared/ module access)
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export PYTHONPATH="${PYTHONPATH}:${PROJECT_ROOT}"

if [ ! -d ".venv" ]; then
    uv venv
fi

uv sync

exec uv run celery -A knowledge_doc_converter.celery_app worker \
    --queues=knowledge_conversion \
    --concurrency=2 \
    --loglevel=info
