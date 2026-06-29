# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Static contract tests for executor container entrypoints."""

from pathlib import Path

REPO_ROOT: Path = Path(__file__).resolve().parents[3]
EXECUTOR_DOCKERFILE: Path = REPO_ROOT / "docker" / "executor" / "Dockerfile"
E2E_EXECUTOR_DOCKERFILE: Path = (
    REPO_ROOT / "frontend" / "e2e" / "fixtures" / "claudecode-executor" / "Dockerfile"
)


def test_executor_container_images_start_in_docker_mode() -> None:
    """Container executor images keep Docker runtime semantics and HTTP startup."""
    dockerfiles = [
        EXECUTOR_DOCKERFILE.read_text(encoding="utf-8"),
        E2E_EXECUTOR_DOCKERFILE.read_text(encoding="utf-8"),
    ]

    for dockerfile in dockerfiles:
        assert "ENV EXECUTOR_MODE=docker" in dockerfile
        assert "ENV EXECUTOR_STARTUP_MODE=http" in dockerfile
