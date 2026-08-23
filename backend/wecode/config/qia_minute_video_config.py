# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal configuration for the QIA one-minute video workflow."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class QiaMinuteVideoSettings(BaseSettings):
    """QIA workflow endpoint and authentication settings."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    QIA_MINUTE_VIDEO_CREATE_URL: str = ""
    QIA_API_TOKEN: str = ""
    QIA_REQUEST_TIMEOUT_SECONDS: float = 30


qia_minute_video_settings = QiaMinuteVideoSettings()
