# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal remote device startup configuration."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class RemoteDeviceSettings(BaseSettings):
    """Settings owned by the internal remote device command provider."""

    REMOTE_DEVICE_DOCKER_IMAGE: str = "registry.api.weibo.com/ci/wegent-device:1.8.6"
    REMOTE_DEVICE_EXECUTOR_INSTALL_URL: str = (
        "https://github.com/wecode-ai/Wegent/releases/latest/download/"
        "local_executor_install.sh"
    )

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


remote_device_settings = RemoteDeviceSettings()
