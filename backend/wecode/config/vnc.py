# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal VNC proxy configuration."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class VncSettings(BaseSettings):
    """Origins permitted to open a proxied VNC WebSocket."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    VNC_ALLOWED_ORIGINS: list[str] = []


vnc_settings = VncSettings()
