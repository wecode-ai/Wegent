# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Tests for the knowledge-base video download proxy endpoint."""

import asyncio
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from wecode.api import knowledge_video_download
from wecode.api.knowledge_video_download import (
    _build_content_disposition,
    _get_kb_video_attachment,
    _safe_video_mime,
)


class TestBuildContentDisposition:
    """_build_content_disposition builds RFC-compliant Content-Disposition headers."""

    def test_ascii_filename(self):
        result = _build_content_disposition("video.mp4")
        assert 'filename="video.mp4"' in result
        assert result.startswith("attachment;")

    def test_non_ascii_filename_uses_rfc5987(self):
        result = _build_content_disposition("视频文件.mp4")
        assert "filename*=UTF-8''" in result
        # The filename should be percent-encoded.
        assert "%E8%A7%86%E9%A2%91" in result

    def test_empty_filename_returns_attachment_only(self):
        result = _build_content_disposition("")
        assert result == "attachment"

    def test_filename_with_quotes_escaped(self):
        result = _build_content_disposition('file"name.mp4')
        assert '\\"' in result

    def test_filename_with_backslash_escaped(self):
        result = _build_content_disposition("file\\name.mp4")
        assert "\\\\" in result

    def test_filename_with_crlf_stripped(self):
        """Control characters (CRLF) are stripped to prevent header injection."""
        result = _build_content_disposition("video\r\nEvil: header.mp4")
        assert "\r" not in result
        assert "\n" not in result

    def test_filename_only_control_chars_returns_attachment(self):
        """A filename consisting solely of control chars falls back to 'attachment'."""
        result = _build_content_disposition("\r\n\r\n")
        assert result == "attachment"


class TestSafeVideoMime:
    """_safe_video_mime restricts MIME types to video/* (prevents HTML spoofing)."""

    def test_video_mime_passed_through(self):
        assert _safe_video_mime("video/mp4") == "video/mp4"
        assert _safe_video_mime("video/quicktime") == "video/quicktime"

    def test_uppercase_video_prefix_accepted(self):
        assert _safe_video_mime("VIDEO/MP4") == "VIDEO/MP4"

    def test_non_video_mime_replaced_with_default(self):
        assert _safe_video_mime("text/html") == "video/mp4"
        assert _safe_video_mime("application/octet-stream") == "video/mp4"

    def test_none_mime_replaced_with_default(self):
        assert _safe_video_mime(None) == "video/mp4"

    def test_empty_mime_replaced_with_default(self):
        assert _safe_video_mime("") == "video/mp4"


class TestGetKbVideoAttachment:
    """_get_kb_video_attachment enforces KB access + Weibo video checks."""

    def _make_db(self, kb_doc=None, context=None):
        """Build a fake DB that returns kb_doc for KnowledgeDocument query
        and context for SubtaskContext query."""
        kb_query = MagicMock()
        kb_query.filter.return_value = kb_query
        kb_query.first.return_value = kb_doc

        ctx_query = MagicMock()
        ctx_query.filter.return_value = ctx_query
        ctx_query.first.return_value = context

        db = MagicMock()
        # First call: KnowledgeDocument, second: SubtaskContext.
        db.query.side_effect = [kb_query, ctx_query]
        return db

    def test_attachment_not_found_returns_404(self):
        db = self._make_db(kb_doc=None)
        with pytest.raises(Exception) as exc_info:
            _get_kb_video_attachment(db, attachment_id=999, user_id=1)
        # FastAPI HTTPException has status_code attribute.
        assert getattr(exc_info.value, "status_code", None) == 404

    def test_non_weibo_video_returns_400(self):
        """Attachment exists but is not a Weibo-backed video → 400."""
        kb_doc = SimpleNamespace(kind_id=1)
        # context_service.is_video_context returns True but storage_backend != weibo
        context = SimpleNamespace(
            id=42,
            context_type="attachment",
            type_data={"storage_backend": "minio"},
        )
        db = self._make_db(kb_doc=kb_doc, context=context)

        with patch.object(knowledge_video_download, "KnowledgeService") as mock_ks:
            mock_ks.get_knowledge_base.return_value = (None, True)
            with patch.object(
                knowledge_video_download, "context_service"
            ) as mock_ctx_svc:
                mock_ctx_svc.is_video_context.return_value = True
                with pytest.raises(Exception) as exc_info:
                    _get_kb_video_attachment(db, attachment_id=42, user_id=1)
        assert getattr(exc_info.value, "status_code", None) == 400


class _FakeUpstream:
    """Minimal stand-in for an httpx streaming Response."""

    def __init__(self, status_code=200, headers=None, chunks=(b"data",)):
        self.status_code = status_code
        self.headers = headers or {}
        self._chunks = list(chunks)
        self.aclose = AsyncMock()

    async def aiter_raw(self):
        for chunk in self._chunks:
            yield chunk


class TestStreamingDispatch:
    """Covers the streaming proxy path: semaphore ordering, timeout, headers.

    These exercise the async endpoint directly (bypassing FastAPI deps) with a
    fake httpx client + upstream, so the concurrency / header-forwarding
    invariants are locked down (they were previously untested).
    """

    def _fake_context(self, filename="clip.mp4", mime="video/mp4"):
        return SimpleNamespace(
            type_data={"fid": 123},
            original_filename=filename,
            mime_type=mime,
        )

    def _make_request(self, range_header=None):
        request = MagicMock()
        request.headers.get.return_value = range_header
        return request

    def _patch_stream(self, upstream=None, send_raises=None):
        """Patch DB lookup, URL resolution, and httpx.AsyncClient.

        Returns (patcher_stack, async_client_factory) so a test can enter the
        stack and inspect the factory call args.
        """
        factory = MagicMock()
        inst = MagicMock()
        inst.build_request.return_value = MagicMock()
        if send_raises is not None:
            inst.send = AsyncMock(side_effect=send_raises)
        else:
            inst.send = AsyncMock(return_value=upstream)
        inst.aclose = AsyncMock()
        factory.return_value = inst

        stack = ExitStack()
        stack.enter_context(
            patch.object(
                knowledge_video_download,
                "_get_kb_video_attachment",
                return_value=self._fake_context(),
            )
        )
        stack.enter_context(
            patch.object(
                knowledge_video_download.weibo_media_service,
                "get_download_url",
                return_value="http://cdn.example/video.mp4",
            )
        )
        stack.enter_context(
            patch.object(knowledge_video_download.httpx, "AsyncClient", factory)
        )
        return stack, factory

    async def test_semaphore_acquired_before_upstream_opened(self):
        """Bug 1: with the slot exhausted, the upstream client is never built.

        ``await semaphore.acquire()`` precedes ``httpx.AsyncClient(...)``, so a
        contending request blocks on the slot instead of opening a connection
        that the cap was meant to forbid.
        """
        exhausted = asyncio.Semaphore(1)
        await exhausted.acquire()  # capacity now 0

        upstream = _FakeUpstream()
        stack, factory = self._patch_stream(upstream=upstream)
        with (
            stack,
            patch.object(
                knowledge_video_download,
                "_get_download_semaphore",
                return_value=exhausted,
            ),
        ):
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(
                    knowledge_video_download.download_knowledge_video(
                        attachment_id=42,
                        request=self._make_request(),
                        current_user=SimpleNamespace(id=1),
                        db=None,
                    ),
                    timeout=0.2,
                )
        # Blocked on the slot before reaching httpx.AsyncClient.
        assert factory.call_count == 0

    async def test_upstream_read_timeout_is_bounded(self):
        """Bug 3: read timeout is finite (not None) so a stalled CDN releases
        the slot instead of hanging forever."""
        upstream = _FakeUpstream()
        stack, factory = self._patch_stream(upstream=upstream)
        with stack:
            await knowledge_video_download.download_knowledge_video(
                attachment_id=42,
                request=self._make_request(),
                current_user=SimpleNamespace(id=1),
                db=None,
            )
        timeout = factory.call_args.kwargs["timeout"]
        assert timeout.read is not None
        assert timeout.read == knowledge_video_download._UPSTREAM_READ_TIMEOUT

    async def test_content_encoding_forwarded(self):
        """Bug 2: content-encoding is forwarded so aiter_raw()'s still-encoded
        bytes are decompressed by the browser (omitting it corrupts the file)."""
        upstream = _FakeUpstream(
            headers={
                "content-length": "123",
                "content-encoding": "gzip",
                "content-range": "bytes 0-122/500",
            }
        )
        stack, _ = self._patch_stream(upstream=upstream)
        with stack:
            resp = await knowledge_video_download.download_knowledge_video(
                attachment_id=42,
                request=self._make_request(),
                current_user=SimpleNamespace(id=1),
                db=None,
            )
        assert resp.headers.get("content-encoding") == "gzip"
        assert resp.headers.get("content-length") == "123"
        assert resp.headers.get("content-range") == "bytes 0-122/500"
        assert (
            resp.headers.get("content-disposition") == 'attachment; filename="clip.mp4"'
        )

    async def test_slot_released_after_normal_stream(self):
        """The finally in _stream() releases the slot on completion."""
        sem = asyncio.Semaphore(1)
        upstream = _FakeUpstream(chunks=(b"ab", b"cd"))
        stack, _ = self._patch_stream(upstream=upstream)
        with (
            stack,
            patch.object(
                knowledge_video_download, "_get_download_semaphore", return_value=sem
            ),
        ):
            resp = await knowledge_video_download.download_knowledge_video(
                attachment_id=42,
                request=self._make_request(),
                current_user=SimpleNamespace(id=1),
                db=None,
            )
            assert sem._value == 0  # held during streaming
            async for _ in resp.body_iterator:
                pass
        assert sem._value == 1  # released in finally
        upstream.aclose.assert_awaited_once()

    async def test_slot_released_on_upstream_error_status(self):
        """Bug 1 error path: a >=400 upstream releases the slot."""
        sem = asyncio.Semaphore(1)
        upstream = _FakeUpstream(status_code=500)
        stack, _ = self._patch_stream(upstream=upstream)
        with (
            stack,
            patch.object(
                knowledge_video_download, "_get_download_semaphore", return_value=sem
            ),
        ):
            with pytest.raises(Exception) as exc_info:
                await knowledge_video_download.download_knowledge_video(
                    attachment_id=42,
                    request=self._make_request(),
                    current_user=SimpleNamespace(id=1),
                    db=None,
                )
        assert getattr(exc_info.value, "status_code", None) == 502
        assert sem._value == 1

    async def test_slot_released_on_connect_error(self):
        """Bug 1 error path: a connection failure releases the slot."""
        sem = asyncio.Semaphore(1)
        stack, _ = self._patch_stream(send_raises=httpx.ConnectError("boom"))
        with (
            stack,
            patch.object(
                knowledge_video_download, "_get_download_semaphore", return_value=sem
            ),
        ):
            with pytest.raises(Exception) as exc_info:
                await knowledge_video_download.download_knowledge_video(
                    attachment_id=42,
                    request=self._make_request(),
                    current_user=SimpleNamespace(id=1),
                    db=None,
                )
        assert getattr(exc_info.value, "status_code", None) == 502
        assert sem._value == 1
