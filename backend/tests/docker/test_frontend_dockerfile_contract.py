# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Static contract tests for the frontend Docker image."""

import json
from pathlib import Path

REPO_ROOT: Path = Path(__file__).resolve().parents[3]
FRONTEND_DOCKERFILE: Path = REPO_ROOT / "docker" / "frontend" / "Dockerfile"
PACKAGE_JSON: Path = REPO_ROOT / "package.json"


def test_frontend_builder_includes_chat_core_workspace_dependencies() -> None:
    """Frontend builds import chat-core source and need its workspace dependencies."""
    dockerfile = FRONTEND_DOCKERFILE.read_text(encoding="utf-8")

    assert (
        "pnpm install --frozen-lockfile --filter wecode-ai-assistant..." in dockerfile
    )
    assert (
        "COPY --from=deps /app/packages/chat-core/node_modules "
        "./packages/chat-core/node_modules"
    ) in dockerfile


def test_frontend_builders_use_workspace_pnpm_version() -> None:
    """Frontend image builds should not download a second pnpm version."""
    dockerfile = FRONTEND_DOCKERFILE.read_text(encoding="utf-8")
    package_json = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    prepare_command = f"corepack prepare {package_json['packageManager']} --activate"

    assert dockerfile.count(prepare_command) == 2
