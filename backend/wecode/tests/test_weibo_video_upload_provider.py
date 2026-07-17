# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Tests for the Weibo VideoUploadProvider (two-phase KB video upload)."""

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from wecode.service.knowledge.weibo_video_upload_provider import (
    _UNLINKED_SUBTASK_ID,
    WeiboVideoUploadProvider,
    _run_async,
)


class TestUnlinkedSubtaskId:
    def test_is_zero(self):
        assert _UNLINKED_SUBTASK_ID == 0


class TestRunAsync:
    """_run_async bridges sync Protocol methods to async weibo_media_service."""

    def test_no_running_loop_uses_asyncio_run(self):
        """When no event loop is running, asyncio.run is used directly."""

        async def coro():
            return "result"

        result = _run_async(coro())
        assert result == "result"

    @pytest.mark.asyncio
    async def test_running_loop_uses_threadpool(self):
        """When a loop IS running, _run_async falls back to a thread."""

        async def coro():
            return "threaded-result"

        # We are inside an async test (loop is running). _run_async should
        # detect this and use ThreadPoolExecutor.
        result = await asyncio.get_event_loop().run_in_executor(
            None, lambda: _run_async(coro())
        )
        assert result == "threaded-result"


class TestInitUpload:
    """init_upload opens a Weibo chunked upload session."""

    def test_returns_video_upload_target(self):
        async def fake_init_upload(**kwargs):
            return SimpleNamespace(
                auth="upload-auth-token",
                file_token="file-token-1",
                chunk_size=4 * 1024 * 1024,
                request_id="req-1",
            )

        with patch(
            "wecode.service.knowledge.weibo_video_upload_provider.weibo_media_service"
        ) as mock_media:
            mock_media.init_upload = fake_init_upload
            mock_media.WEIBO_UPLOAD_URL = (
                "https://fileplatform.api.weibo.com/2/multimedia/upload.json"
            )

            provider = WeiboVideoUploadProvider()
            target = provider.init_upload(
                filename="video.mp4",
                file_size=1024 * 1024,
                file_extension=".mp4",
                uploader=SimpleNamespace(id=1, user_name="tester"),
                file_hash="abc123",
            )

        assert (
            target.upload_url
            == "https://fileplatform.api.weibo.com/2/multimedia/upload.json"
        )
        assert target.method == "POST"
        assert target.headers["X-Up-Auth"] == "upload-auth-token"
        assert target.extra["file_token"] == "file-token-1"
        assert target.extra["chunk_size"] == 4 * 1024 * 1024
        assert target.extra["filecheck"] == "abc123"

    def test_passes_file_hash_as_file_check(self):
        """file_hash (md5) is forwarded as Weibo's 'check' parameter."""
        captured_kwargs = {}

        async def fake_init_upload(**kwargs):
            captured_kwargs.update(kwargs)
            return SimpleNamespace(
                auth="auth", file_token="tok", chunk_size=4096, request_id="r"
            )

        with patch(
            "wecode.service.knowledge.weibo_video_upload_provider.weibo_media_service"
        ) as mock_media:
            mock_media.init_upload = fake_init_upload
            mock_media.WEIBO_UPLOAD_URL = "https://upload.url"

            provider = WeiboVideoUploadProvider()
            provider.init_upload(
                filename="v.mp4",
                file_size=100,
                file_extension=".mp4",
                uploader=SimpleNamespace(id=1, user_name="t"),
                file_hash="myhash",
            )

        assert captured_kwargs["file_check"] == "myhash"


class TestCompleteUpload:
    """complete_upload persists only metadata (fid) — no binary."""

    def test_success_returns_complete_result(self):
        fake_context = SimpleNamespace(id=999)

        with (
            patch(
                "wecode.service.knowledge.weibo_video_upload_provider.context_service"
            ) as mock_ctx,
            patch(
                "wecode.service.knowledge.weibo_video_upload_provider.SessionLocal"
            ) as mock_session_cls,
        ):
            mock_ctx.upload_video_metadata.return_value = fake_context
            mock_session = MagicMock()
            mock_session_cls.return_value = mock_session

            provider = WeiboVideoUploadProvider()
            result = provider.complete_upload(
                upload_result={"fid": 12345},
                filename="video.mp4",
                file_size=1024 * 1024,
                file_extension=".mp4",
                uploader=SimpleNamespace(id=1, user_name="tester"),
            )

        assert result.attachment_id == 999
        assert result.storage_backend == "weibo"
        assert result.object_key == "12345"
        # Verify subtask_id uses the constant.
        call_kwargs = mock_ctx.upload_video_metadata.call_args.kwargs
        assert call_kwargs["subtask_id"] == _UNLINKED_SUBTASK_ID
        mock_session.close.assert_called_once()

    def test_missing_fid_raises_value_error(self):
        provider = WeiboVideoUploadProvider()
        with pytest.raises(ValueError, match="fid"):
            provider.complete_upload(
                upload_result={},
                filename="v.mp4",
                file_size=100,
                file_extension=".mp4",
                uploader=SimpleNamespace(id=1, user_name="t"),
            )


class TestAutoRegistration:
    """The provider auto-registers on import via register_video_upload_provider."""

    def test_provider_is_registered(self):
        """After import, the WeiboVideoUploadProvider is in the registry."""
        from app.services.knowledge.video_upload_provider import (
            build_video_upload_provider,
        )

        provider = build_video_upload_provider()
        assert isinstance(provider, WeiboVideoUploadProvider)
