# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from wecode.config.video_media_config import VideoMediaSettings


def test_playback_config_does_not_require_fileplatform_url() -> None:
    settings = VideoMediaSettings(
        _env_file=None,
        WEIBO_IMAGE_HOSTING_ENABLED=True,
        WEIBO_TAUTH2_APPKEY="app-key",
        WEIBO_MEDIA_UPLOAD_DEFAULT_UID="1234567890",
        WEIBO_FILEPLATFORM_URL="",
    )

    settings.validate_playback_config()

    with pytest.raises(
        ValueError,
        match="WEIBO_FILEPLATFORM_URL is required for media uploads",
    ):
        settings.validate_storage_config()
