# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal configuration for Weibo-hosted video model media."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class VideoMediaSettings(BaseSettings):
    """Weibo multimedia upload and playback settings."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    WEIBO_IMAGE_HOSTING_ENABLED: bool = False
    WEIBO_FILEPLATFORM_URL: str = ""
    WEIBO_TAUTH2_APPKEY: str = ""
    WEIBO_MEDIA_UPLOAD_DEFAULT_UID: str = ""
    WEIBO_VIDEO_SHOW_BATCH_URL: str = (
        "http://i.media.api.weibo.com/2/video/show_batch.json"
    )
    WEIBO_MEDIA_SSIG_URL: str = (
        "http://i.mediaplay.api.weibo.com/2/multimedia/get_ssig_url_batch.json"
    )
    WEIBO_MEDIA_TIMEOUT_SECONDS: float = 120.0

    @property
    def storage_enabled(self) -> bool:
        """Return whether attachment routing to Weibo storage is enabled."""
        return bool(
            self.WEIBO_IMAGE_HOSTING_ENABLED and self.WEIBO_FILEPLATFORM_URL.strip()
        )

    def validate_storage_config(self) -> None:
        """Validate configuration required to upload reference media."""
        self.validate_playback_config()
        if not self.WEIBO_FILEPLATFORM_URL.strip():
            raise ValueError("WEIBO_FILEPLATFORM_URL is required for media uploads")

    def validate_playback_config(self) -> None:
        """Validate configuration required to resolve media playback URLs."""
        if not self.storage_enabled:
            if not self.WEIBO_IMAGE_HOSTING_ENABLED:
                raise ValueError("WEIBO_IMAGE_HOSTING_ENABLED must be enabled")
        if not self.WEIBO_TAUTH2_APPKEY.strip():
            raise ValueError("WEIBO_TAUTH2_APPKEY is required for media playback")
        self.get_upload_uid()

    def get_upload_uid(self) -> str:
        """Return the fixed internal account used for media uploads."""
        uid = self.WEIBO_MEDIA_UPLOAD_DEFAULT_UID.strip()
        if not uid:
            raise ValueError(
                "WEIBO_MEDIA_UPLOAD_DEFAULT_UID is required for media uploads"
            )
        return uid


video_media_settings = VideoMediaSettings()
