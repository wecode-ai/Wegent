# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Static contract tests for the Backend Docker image."""

import os
import subprocess
from pathlib import Path

import pytest
import yaml

REPO_ROOT: Path = Path(__file__).resolve().parents[3]
BACKEND_DOCKERFILE: Path = REPO_ROOT / "docker" / "backend" / "Dockerfile"


def test_backend_image_does_not_require_optional_sites_plugin() -> None:
    """Backend images remain buildable when the optional Sites plugin is absent."""
    dockerfile = BACKEND_DOCKERFILE.read_text(encoding="utf-8")

    assert "COPY backend/init_data /app/init_data" in dockerfile
    assert "wegent-sites" not in dockerfile


def test_backend_image_runs_prebuilt_hybrid_gateway_in_existing_layout() -> None:
    """Compose's existing backend image must start both implementations."""
    dockerfile = BACKEND_DOCKERFILE.read_text(encoding="utf-8")

    assert "AS rust-builder" in dockerfile
    assert "cargo build --release --locked --bin wegent-backend-rs" in dockerfile
    assert "dnf --enablerepo=crb install -y nasm" in dockerfile
    assert "COPY --from=rust-builder" in dockerfile
    assert "COPY backend /app" in dockerfile
    assert "WEGENT_PYTHON_BACKEND_DIR=/app" in dockerfile
    assert "WEGENT_PYTHON_RELOAD=false" in dockerfile
    assert "WEGENT_RS_BINARY_PATH=/usr/local/bin/wegent-backend-rs" in dockerfile
    assert "command -v uvicorn" in dockerfile
    assert "backend-rs/scripts/start-hybrid-backend.sh" in dockerfile
    assert "exec uvicorn app.main:app" not in dockerfile
    assert "EXPOSE ${PORT}" in dockerfile
    assert "EXPOSE 8004" not in dockerfile


def test_build_context_excludes_private_env_and_local_rust_outputs() -> None:
    """Local credentials and native build caches must stay out of images."""
    ignored = (REPO_ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()

    assert "**/.env" in ignored
    assert "**/target" in ignored


@pytest.mark.parametrize(
    ("platform", "container", "container_result", "success"),
    [
        (False, True, "failure", False),
        (False, True, "skipped", False),
        (False, True, "success", True),
        (True, True, "failure", False),
        (True, True, "success", True),
        (True, False, "skipped", True),
        (False, False, "skipped", True),
    ],
)
def test_ci_summary_checks_required_container_regressions(
    platform: bool, container: bool, container_result: str, success: bool
) -> None:
    """Container failures must remain blocking when browser E2E is not selected."""
    workflow = yaml.safe_load(
        (REPO_ROOT / ".github/workflows/e2e-tests.yml").read_text()
    )
    script = workflow["jobs"]["platform-e2e-summary"]["steps"][0]["run"]
    env = {
        **os.environ,
        "RUN_E2E": str(platform).lower(),
        "RUN_BACKEND_CONTAINER": str(container).lower(),
        "CHANGES_RESULT": "success",
        "FRONTEND_BUILD_RESULT": "success",
        "EXECUTOR_BUILD_RESULT": "success",
        "PLATFORM_E2E_RESULT": "success",
        "EXECUTOR_E2E_RESULT": "success",
        "BACKEND_CONTAINER_RESULT": container_result,
    }
    result = subprocess.run(
        ["bash", "-e", "-o", "pipefail", "-c", script],
        env=env,
        capture_output=True,
        text=True,
    )
    assert (result.returncode == 0) is success, result.stdout + result.stderr
