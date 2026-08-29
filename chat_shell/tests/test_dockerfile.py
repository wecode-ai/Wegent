# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CHAT_SHELL_DOCKERFILE = REPO_ROOT / "docker" / "chat_shell" / "Dockerfile"
CHAT_SHELL_PYPROJECT = REPO_ROOT / "chat_shell" / "pyproject.toml"


def test_chat_shell_image_precaches_tiktoken_encoding() -> None:
    dockerfile = CHAT_SHELL_DOCKERFILE.read_text(encoding="utf-8")

    assert 'ENV TIKTOKEN_CACHE_DIR="/app/.cache/tiktoken"' in dockerfile
    assert 'tiktoken.get_encoding("cl100k_base")' in dockerfile
    assert 'tiktoken.get_encoding("o200k_base")' in dockerfile


def test_chat_shell_requires_tiktoken_with_o200k_support() -> None:
    pyproject = CHAT_SHELL_PYPROJECT.read_text(encoding="utf-8")

    assert '"tiktoken>=0.7.0"' in pyproject
