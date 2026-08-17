# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Static contract tests for the Backend Docker image."""

from pathlib import Path

REPO_ROOT: Path = Path(__file__).resolve().parents[3]
BACKEND_DOCKERFILE: Path = REPO_ROOT / "docker" / "backend" / "Dockerfile"


def test_backend_image_does_not_require_optional_sites_plugin() -> None:
    """Backend images remain buildable when the optional Sites plugin is absent."""
    dockerfile = BACKEND_DOCKERFILE.read_text(encoding="utf-8")

    assert "COPY backend/init_data /app/init_data" in dockerfile
    assert "wegent-sites" not in dockerfile
