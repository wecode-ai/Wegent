# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal remote device startup configuration."""

from __future__ import annotations

import logging
import tomllib
from pathlib import Path
from typing import Self

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)

REMOTE_DEVICE_DOCKER_IMAGE_REPOSITORY = "registry.api.weibo.com/ci/wegent-device"
REMOTE_DEVICE_IMAGE_FALLBACK_VERSION = "1.8.6"


def _resolve_executor_version_from_cargo_toml() -> str | None:
    """Read version from executor/Cargo.toml if available."""
    current = Path(__file__).resolve()
    root = None
    for candidate in [current, *current.parents]:
        if candidate.name == "backend":
            root = candidate.parent
            break
    if root is None:
        logger.warning(
            "[RemoteDeviceConfig] Unable to locate backend directory from %s", __file__
        )
        return None

    cargo_toml = root / "executor" / "Cargo.toml"
    if not cargo_toml.exists():
        logger.warning("[RemoteDeviceConfig] Missing %s", cargo_toml)
        return None

    try:
        data = tomllib.loads(cargo_toml.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover - defensive compatibility
        logger.warning(
            "[RemoteDeviceConfig] Failed to parse Cargo.toml at %s: %s",
            cargo_toml,
            exc,
        )
        return None

    version = data.get("package", {}).get("version") if isinstance(data, dict) else None
    if isinstance(version, str) and version.strip():
        return version.strip()

    logger.warning("[RemoteDeviceConfig] No executable version found in %s", cargo_toml)
    return None


def _default_remote_device_image(version: str) -> str:
    """Build the default remote-device image reference."""
    if not version:
        logger.warning(
            "[RemoteDeviceConfig] Using fallback remote device version %s",
            REMOTE_DEVICE_IMAGE_FALLBACK_VERSION,
        )
        version = REMOTE_DEVICE_IMAGE_FALLBACK_VERSION

    return f"{REMOTE_DEVICE_DOCKER_IMAGE_REPOSITORY}:{version}"


class RemoteDeviceSettings(BaseSettings):
    """Settings owned by the internal remote device command provider."""

    REMOTE_DEVICE_DOCKER_IMAGE: str = ""
    REMOTE_DEVICE_DOCKER_IMAGE_VERSION: str = ""
    REMOTE_DEVICE_EXECUTOR_INSTALL_URL: str = (
        "https://github.com/wecode-ai/Wegent/releases/latest/download/"
        "local_executor_install.sh"
    )

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @model_validator(mode="after")
    def resolve_remote_device_image(self) -> Self:
        """Resolve the image after environment and dotenv fields are loaded."""
        if self.REMOTE_DEVICE_DOCKER_IMAGE.strip():
            self.REMOTE_DEVICE_DOCKER_IMAGE = self.REMOTE_DEVICE_DOCKER_IMAGE.strip()
            return self

        version = self.REMOTE_DEVICE_DOCKER_IMAGE_VERSION.strip()
        if not version:
            version = _resolve_executor_version_from_cargo_toml() or ""
        self.REMOTE_DEVICE_DOCKER_IMAGE = _default_remote_device_image(version)
        return self


remote_device_settings = RemoteDeviceSettings()
