# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal configuration for video-model image staging."""

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class VideoImageStagingSettings(BaseSettings):
    """Aliyun OSS staging settings for video reference images."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    VIDEO_MODEL_IMAGE_STAGING_BACKEND: str = "direct"
    VIDEO_MODEL_IMAGE_OSS_ENDPOINT: str = ""
    VIDEO_MODEL_IMAGE_OSS_PUBLIC_ENDPOINT: str = ""
    VIDEO_MODEL_IMAGE_OSS_ACCESS_KEY_ID: str = ""
    VIDEO_MODEL_IMAGE_OSS_ACCESS_KEY_SECRET: str = ""
    VIDEO_MODEL_IMAGE_OSS_BUCKET: str = ""
    VIDEO_MODEL_IMAGE_OSS_URL_EXPIRES_SECONDS: int = 86400
    VIDEO_MODEL_IMAGE_OSS_CACHE_TTL_SECONDS: int = 82800
    VIDEO_MODEL_IMAGE_OSS_PREFIX: str = "video-image-staging"

    @field_validator("VIDEO_MODEL_IMAGE_STAGING_BACKEND")
    @classmethod
    def validate_backend(cls, value: str) -> str:
        backend = value.strip().lower()
        if backend not in {"direct", "oss"}:
            raise ValueError(
                "VIDEO_MODEL_IMAGE_STAGING_BACKEND must be 'direct' or 'oss'"
            )
        return backend

    @field_validator(
        "VIDEO_MODEL_IMAGE_OSS_URL_EXPIRES_SECONDS",
        "VIDEO_MODEL_IMAGE_OSS_CACHE_TTL_SECONDS",
    )
    @classmethod
    def validate_positive_ttl(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("OSS URL and cache TTL values must be positive")
        return value


video_image_staging_settings = VideoImageStagingSettings()
