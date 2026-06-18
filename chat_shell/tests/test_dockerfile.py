# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
CHAT_SHELL_DOCKERFILE = REPO_ROOT / "docker" / "chat_shell" / "Dockerfile"


def test_chat_shell_image_precaches_tiktoken_encoding() -> None:
    dockerfile = CHAT_SHELL_DOCKERFILE.read_text(encoding="utf-8")

    assert 'ENV TIKTOKEN_CACHE_DIR="/app/.cache/tiktoken"' in dockerfile
    assert 'tiktoken.get_encoding("cl100k_base")' in dockerfile
