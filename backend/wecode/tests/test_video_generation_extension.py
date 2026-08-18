# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock

from app.services.execution.agents.video.extensions import (
    VideoResultOverride,
    VideoStatusOverride,
)
from wecode.service.video_generation_extension import (
    WeiboMediaAttachmentPlaybackResolver,
    WeiboMediaAttachmentStorageAdapter,
    WeiboVideoGenerationExtension,
)
from wecode.service.video_media_platform import PlaybackInfo, UploadedMedia


def test_builds_seedance_media_id_content_blocks() -> None:
    extension = WeiboVideoGenerationExtension()

    video = extension.build_provider_content(
        protocol="seedance",
        media_type="video",
        descriptor={"external_reference": {"id": "video-123"}},
        role="reference_video",
    )
    audio = extension.build_provider_content(
        protocol="seedance",
        media_type="audio",
        descriptor={"external_reference": {"id": "audio-456"}},
        role="reference_audio",
    )

    assert video == {
        "type": "video_media_id",
        "video_media_id": "video-123",
        "role": "reference_video",
    }
    assert audio == {
        "type": "audio_media_id",
        "audio_media_id": "audio-456",
        "role": "reference_audio",
    }


def test_wb_data_overrides_native_status_and_progress() -> None:
    extension = WeiboVideoGenerationExtension()

    parsed = extension.parse_status(
        {
            "status": "running",
            "progress": 5,
            "wb_data": {"status": "succeeded", "progress": 100},
        },
        VideoStatusOverride(
            progress=5,
            is_completed=False,
            is_failed=False,
        ),
    )

    assert parsed is not None
    assert parsed.progress == 100
    assert parsed.is_completed is True
    assert parsed.is_failed is False


def test_wb_data_overrides_result_url_and_preserves_media_metadata() -> None:
    extension = WeiboVideoGenerationExtension()

    parsed = extension.parse_result(
        {
            "wb_data": {
                "video_url": "https://media.example.com/video.mp4",
                "cover_url": "https://media.example.com/cover.jpg",
                "media_id": 5322767479013464,
                "pid": "pid-1",
                "fid": "fid-1",
            }
        },
        VideoResultOverride(video_url="https://provider.example.com/temporary.mp4"),
    )

    assert parsed is not None
    assert parsed.video_url == "https://media.example.com/video.mp4"
    assert parsed.metadata == {
        "weibo_hosted": True,
        "media_id": 5322767479013464,
        "pid": "pid-1",
        "fid": "fid-1",
        "cover_url": "https://media.example.com/cover.jpg",
    }


def test_non_weibo_result_uses_default_result_storage() -> None:
    extension = WeiboVideoGenerationExtension()
    result = MagicMock(metadata={})

    prepared = extension.prepare_result(
        result=result,
        user_id=1,
        task_id=2,
        subtask_id=3,
    )

    assert prepared is None


def test_weibo_result_does_not_fall_back_when_playback_is_disabled(
    monkeypatch,
) -> None:
    extension = WeiboVideoGenerationExtension()
    result = MagicMock(metadata={"weibo_hosted": True, "media_id": "media-1"})
    monkeypatch.setattr(
        "wecode.service.video_generation_extension.video_media_settings."
        "WEIBO_IMAGE_HOSTING_ENABLED",
        False,
    )

    try:
        extension.prepare_result(
            result=result,
            user_id=1,
            task_id=2,
            subtask_id=3,
        )
    except ValueError as exc:
        assert str(exc) == "WEIBO_IMAGE_HOSTING_ENABLED must be enabled"
    else:
        raise AssertionError("Expected missing playback configuration to fail")


def test_reference_upload_persists_weibo_storage_shape(monkeypatch) -> None:
    adapter = WeiboMediaAttachmentStorageAdapter()
    upload_kwargs = {}
    monkeypatch.setattr(
        "wecode.service.video_generation_extension.video_media_settings."
        "WEIBO_MEDIA_UPLOAD_DEFAULT_UID",
        "default-upload-uid",
    )

    def fake_upload_media(**kwargs):
        upload_kwargs.update(kwargs)
        return UploadedMedia(
            media_id="media-1",
            upload_id="upload-1",
        )

    monkeypatch.setattr(
        "wecode.service.video_generation_extension.upload_media",
        fake_upload_media,
    )

    stored = adapter.store(
        db=MagicMock(),
        user_id=1,
        filename="reference.mp4",
        mime_type="video/mp4",
        data=b"video",
    )

    assert stored.backend_type == "weibo_video_hosting"
    assert stored.storage_key == ""
    assert upload_kwargs["uid"] == "default-upload-uid"
    assert stored.type_data == {
        "weibo_video_upload": {
            "media_id": "media-1",
            "upload_id": "upload-1",
        }
    }


def test_reference_storage_handles_chat_and_video_generation_media(monkeypatch) -> None:
    adapter = WeiboMediaAttachmentStorageAdapter()
    monkeypatch.setattr(
        "wecode.service.video_generation_extension.video_media_settings."
        "WEIBO_IMAGE_HOSTING_ENABLED",
        True,
    )
    monkeypatch.setattr(
        "wecode.service.video_generation_extension.video_media_settings."
        "WEIBO_FILEPLATFORM_URL",
        "https://file-platform.example.com",
    )

    assert adapter.supports("video/mp4", "video_reference") is True
    assert adapter.supports("audio/mpeg", "video_reference") is True
    assert adapter.supports("video/mp4", "default") is True
    assert adapter.supports("audio/mpeg", "default") is True
    assert adapter.supports("image/png", "default") is False


def test_resolves_uploaded_video_to_fresh_playback_url(monkeypatch) -> None:
    resolver = WeiboMediaAttachmentPlaybackResolver()
    monkeypatch.setattr(
        "wecode.service.video_generation_extension.video_media_settings."
        "WEIBO_MEDIA_UPLOAD_DEFAULT_UID",
        "1234567890",
    )
    monkeypatch.setattr(
        "wecode.service.video_generation_extension.fetch_playback",
        lambda media_ids, uid: {
            "media-1": PlaybackInfo(url="http://cdn.example.com/video.mp4")
        },
    )

    playback = resolver.resolve_playback(
        type_data={"weibo_video_upload": {"media_id": "media-1"}},
        user_id=1,
    )

    assert playback is not None
    assert playback.url == "https://cdn.example.com/video.mp4"
    assert playback.media_type == "video/mp4"


def test_resolves_uploaded_audio_to_fresh_playback_url(monkeypatch) -> None:
    resolver = WeiboMediaAttachmentPlaybackResolver()
    monkeypatch.setattr(
        "wecode.service.video_generation_extension.video_media_settings."
        "WEIBO_MEDIA_UPLOAD_DEFAULT_UID",
        "1234567890",
    )
    monkeypatch.setattr(
        "wecode.service.video_generation_extension.fetch_playback",
        lambda media_ids, uid: {
            "media-2": PlaybackInfo(url="https://cdn.example.com/audio.mp3")
        },
    )

    playback = resolver.resolve_playback(
        type_data={"weibo_audio_upload": {"media_id": "media-2"}},
        user_id=1,
    )

    assert playback is not None
    assert playback.url == "https://cdn.example.com/audio.mp3"
    assert playback.media_type == "audio/mpeg"


def test_refresh_result_replaces_expired_url(monkeypatch) -> None:
    extension = WeiboVideoGenerationExtension()
    monkeypatch.setattr(
        "wecode.service.video_generation_extension.video_media_settings."
        "WEIBO_MEDIA_UPLOAD_DEFAULT_UID",
        "1234567890",
    )
    signed_uids = []

    def fake_sign_urls(urls, uid):
        signed_uids.append(uid)
        return {
            "https://cdn.example.com/expired.mp4": ("http://cdn.example.com/fresh.mp4")
        }

    monkeypatch.setattr(
        "wecode.service.video_generation_extension.sign_urls",
        fake_sign_urls,
    )
    task = {
        "subtasks": [
            {
                "result": {
                    "blocks": [
                        {
                            "type": "video",
                            "media_id": "media-1",
                            "video_url": "https://cdn.example.com/expired.mp4",
                        }
                    ]
                }
            }
        ]
    }

    extension.refresh_result_urls(task=task, user_id=1)

    assert (
        task["subtasks"][0]["result"]["blocks"][0]["video_url"]
        == "https://cdn.example.com/fresh.mp4"
    )
    assert signed_uids == ["1234567890"]
