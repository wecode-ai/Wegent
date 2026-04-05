#!/bin/bash

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

set -e

PORT="${PORT:-8200}"
HOST="${HOST:-0.0.0.0}"

uv run --project knowledge_runtime uvicorn knowledge_runtime.main:app \
  --host "${HOST}" \
  --port "${PORT}" \
  --workers 1
