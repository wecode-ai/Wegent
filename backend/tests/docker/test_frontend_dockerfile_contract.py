# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Static contract tests for the frontend Docker image."""

from pathlib import Path

REPO_ROOT: Path = Path(__file__).resolve().parents[3]
FRONTEND_DOCKERFILE: Path = REPO_ROOT / "docker" / "frontend" / "Dockerfile"


def test_frontend_builder_includes_chat_core_workspace_dependencies() -> None:
    """Frontend builds import chat-core source and need its workspace dependencies."""
    dockerfile = FRONTEND_DOCKERFILE.read_text(encoding="utf-8")

    assert "pnpm install --frozen-lockfile --filter wecode-ai-assistant..." in dockerfile
    assert (
        "COPY --from=deps /app/packages/chat-core/node_modules "
        "./packages/chat-core/node_modules"
    ) in dockerfile
