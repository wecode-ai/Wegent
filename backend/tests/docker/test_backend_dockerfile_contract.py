# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Static contract tests for the Backend Docker image."""

import re
import shutil
from pathlib import Path

REPO_ROOT: Path = Path(__file__).resolve().parents[3]
BACKEND_DOCKERFILE: Path = REPO_ROOT / "docker" / "backend" / "Dockerfile"


def test_backend_image_does_not_require_optional_sites_plugin() -> None:
    """Backend images remain buildable when the optional Sites plugin is absent."""
    dockerfile = BACKEND_DOCKERFILE.read_text(encoding="utf-8")

    assert "COPY backend-rs/init_data /app/init_data" in dockerfile
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


def test_rust_builder_contains_embedded_migration_assets(tmp_path: Path) -> None:
    """Resolve actual Rust include paths against the builder's copied inputs."""
    dockerfile = BACKEND_DOCKERFILE.read_text(encoding="utf-8")
    builder = dockerfile.split("FROM rust-builder-deps AS rust-builder\n", 1)[1]
    builder = builder.split("\nFROM ", 1)[0]
    image_root = tmp_path / "backend-rs"
    for source, destination in re.findall(r"^COPY (\S+) (\S+)$", builder, re.M):
        source_path = REPO_ROOT / source
        if source_path.is_dir():
            shutil.copytree(source_path, image_root / destination, dirs_exist_ok=True)
        else:
            target = image_root / destination
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_path, target)

    migration_sources = REPO_ROOT / "backend-rs/src/migrations"
    includes = [
        (source, asset)
        for source in migration_sources.rglob("*.rs")
        for asset in re.findall(
            r'include_str!\(\s*"([^"\n]+)"\s*\)', source.read_text()
        )
    ]
    assert includes, "The migration module must declare its embedded assets"
    for source, asset in includes:
        source_in_image = image_root / source.relative_to(REPO_ROOT / "backend-rs")
        embedded_asset = source_in_image.parent / asset
        assert (
            embedded_asset.is_file()
        ), f"Rust builder is missing {asset} for {source.name}"
