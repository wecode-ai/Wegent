#!/bin/bash
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

grep -Fq "COPY docs /app/docs" "$ROOT_DIR/docker/backend/Dockerfile"
grep -Fq "generate_wegent_help_knowledge_seed.py" "$ROOT_DIR/docker/backend/Dockerfile"
grep -Fq -- "--docs-root /app/docs" "$ROOT_DIR/docker/backend/Dockerfile"
grep -Fq -- "--output-dir /app/init_data/system_knowledge/wegent-help" "$ROOT_DIR/docker/backend/Dockerfile"

grep -Fq "COPY docs /app/docs" "$ROOT_DIR/docker/standalone/Dockerfile"
grep -Fq "generate_wegent_help_knowledge_seed.py" "$ROOT_DIR/docker/standalone/Dockerfile"
grep -Fq -- "--docs-root /app/docs" "$ROOT_DIR/docker/standalone/Dockerfile"
grep -Fq -- "--output-dir /app/init_data/system_knowledge/wegent-help" "$ROOT_DIR/docker/standalone/Dockerfile"

echo "Wegent help seed Dockerfile checks passed"
