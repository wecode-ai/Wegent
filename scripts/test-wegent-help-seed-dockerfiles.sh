#!/bin/bash
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

grep -q "generate_wegent_help_knowledge_seed.py" "$ROOT_DIR/docker/backend/Dockerfile"
grep -q "COPY docs /app/docs" "$ROOT_DIR/docker/backend/Dockerfile"
grep -q "generate_wegent_help_knowledge_seed.py" "$ROOT_DIR/docker/standalone/Dockerfile"
grep -q "COPY docs /app/docs" "$ROOT_DIR/docker/standalone/Dockerfile"

echo "Wegent help seed Dockerfile checks passed"
