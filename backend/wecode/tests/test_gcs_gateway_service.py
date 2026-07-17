# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Tests for GcsGatewayService — the GCS gateway client.

Uses httpx_mock to intercept gateway HTTP calls and monkeypatch to bypass
TAuth2 authentication.
"""

import asyncio
import io
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from wecode.service.gcs.gcs_models import (
    GcsGatewayError,
    GcsSessionInvalid,
)


@pytest.fixture(autouse=True)
def _mock_auth(monkeypatch):
    """Bypass TAuth2 for all tests in this module."""
    monkeypatch.setattr(
        "wecode.service.gcs.gcs_gateway_service.get_auth_headers",
        lambda: {"Authorization": "TAuth2 fake"},
    )

    # Mock retry sleep as a no-op async coroutine to avoid real delays.
    async def _noop_sleep(*args, **kwargs):
        return None

    monkeypatch.setattr(
        "wecode.service.gcs.gcs_retry.asyncio.sleep",
        _noop_sleep,
    )


GATEWAY_URL = "http://i.aigc.weibo.com/files/upload"
RESUMABLE_URL = "http://i.aigc.weibo.com/files/resumable_upload"


class TestUploadSimple:
    async def test_success_returns_upload_result(self, httpx_mock):
        httpx_mock.add_response(
            method="POST",
            json={
                "code": 200,
                "response_data": {
                    "object_name": "obj/1.png",
                    "gs_url": "gs://bucket/obj/1.png",
                    "request_id": "req-1",
                    "file_size": 1024,
                    "content_type": "image/png",
                },
            },
        )
        from wecode.service.gcs.gcs_gateway_service import GcsGatewayService

        result = await GcsGatewayService().upload_simple(
            user_id=1,
            filename="test.png",
            content_type="image/png",
            file_stream=io.BytesIO(b"fake image bytes"),
        )
        assert result.object_name == "obj/1.png"
        assert result.gs_url == "gs://bucket/obj/1.png"
        assert result.file_size == 1024

    async def test_413_raises_file_too_large(self, httpx_mock):
        httpx_mock.add_response(method="POST", status_code=413, text="Too Large")
        from wecode.service.gcs.gcs_gateway_service import GcsGatewayService

        with pytest.raises(GcsGatewayError) as exc_info:
            await GcsGatewayService().upload_simple(
                user_id=1,
                filename="big.mp4",
                content_type="video/mp4",
                file_stream=io.BytesIO(b"x" * 200),
            )
        assert exc_info.value.error_code == "gcs_file_too_large"

    async def test_5xx_retries_then_gateway_timeout(self, httpx_mock):
        # All attempts return 503; retry_with_backoff will exhaust and classify.
        # is_reusable=True so the same 503 response is served on every retry.
        httpx_mock.add_response(
            method="POST", status_code=503, text="Server Error", is_reusable=True
        )
        from wecode.service.gcs.gcs_gateway_service import GcsGatewayService

        with pytest.raises(GcsGatewayError) as exc_info:
            await GcsGatewayService().upload_simple(
                user_id=1,
                filename="test.png",
                content_type="image/png",
                file_stream=io.BytesIO(b"fake"),
            )
        assert exc_info.value.error_code == "gcs_gateway_timeout"


class TestResumableInit:
    async def test_success_returns_init_result(self, httpx_mock):
        httpx_mock.add_response(
            method="POST",
            json={
                "code": 200,
                "response_data": {
                    "api_ext": {
                        "session_uri": "https://upload/session-1",
                        "object_name": "obj/1.mp4",
                        "bucket": "pj1-bucket",
                        "total_size": 278921216,
                        "chunk_size": 8388608,
                        "content_type": "video/mp4",
                    }
                },
            },
        )
        from wecode.service.gcs.gcs_gateway_service import GcsGatewayService

        result = await GcsGatewayService().resumable_init(
            user_id=1,
            filename="big.mp4",
            content_type="video/mp4",
            total_size=278921216,
        )
        assert result.session_uri == "https://upload/session-1"
        assert result.object_name == "obj/1.mp4"
        assert result.chunk_size == 8388608

    async def test_oversized_rejects_without_calling_gateway(self, httpx_mock):
        """Files > 2GB are rejected at init before any HTTP call."""
        from shared.utils.multimodal_limits import REMOTE_MEDIA_MAX_FILE_SIZE
        from wecode.service.gcs.gcs_gateway_service import GcsGatewayService

        with pytest.raises(GcsGatewayError) as exc_info:
            await GcsGatewayService().resumable_init(
                user_id=1,
                filename="huge.mp4",
                content_type="video/mp4",
                total_size=REMOTE_MEDIA_MAX_FILE_SIZE + 1,
            )
        assert exc_info.value.error_code == "gcs_file_too_large"
        assert len(httpx_mock.get_requests()) == 0


class TestResumablePutChunk:
    async def test_status_continue(self, httpx_mock):
        httpx_mock.add_response(
            method="POST",
            json={
                "code": 200,
                "response_data": {
                    "api_ext": {"status": "continue", "next_offset": 8388608}
                },
            },
        )
        from wecode.service.gcs.gcs_gateway_service import GcsGatewayService

        result = await GcsGatewayService().resumable_put_chunk(
            user_id=1,
            session_uri="https://upload/session-1",
            object_name="obj/1.mp4",
            offset=0,
            total_size=278921216,
            chunk=b"x" * 8388608,
        )
        assert result.status == "continue"
        assert result.next_offset == 8388608

    async def test_status_done(self, httpx_mock):
        httpx_mock.add_response(
            method="POST",
            json={
                "code": 200,
                "response_data": {
                    "api_ext": {"status": "done", "gs_url": "gs://bucket/obj/1.mp4"}
                },
            },
        )
        from wecode.service.gcs.gcs_gateway_service import GcsGatewayService

        result = await GcsGatewayService().resumable_put_chunk(
            user_id=1,
            session_uri="https://upload/session-1",
            object_name="obj/1.mp4",
            offset=278883328,
            total_size=278921216,
            chunk=b"x" * 37888,
        )
        assert result.status == "done"
        assert result.gs_url == "gs://bucket/obj/1.mp4"


class TestResumableQuery:
    async def test_success_returns_query_result(self, httpx_mock):
        httpx_mock.add_response(
            method="POST",
            json={
                "code": 200,
                "response_data": {
                    "api_ext": {
                        "status": "in_progress",
                        "received_byte": 8388607,
                        "next_offset": 8388608,
                    }
                },
            },
        )
        from wecode.service.gcs.gcs_gateway_service import GcsGatewayService

        result = await GcsGatewayService().resumable_query(
            user_id=1,
            session_uri="https://upload/session-1",
            total_size=278921216,
        )
        assert result.status == "in_progress"
        assert result.received_byte == 8388607

    async def test_410_returns_empty(self, httpx_mock):
        httpx_mock.add_response(method="POST", status_code=410, text="Gone")
        from wecode.service.gcs.gcs_gateway_service import GcsGatewayService

        result = await GcsGatewayService().resumable_query(
            user_id=1,
            session_uri="https://upload/expired",
            total_size=278921216,
        )
        assert result.status == "empty"
        assert result.gs_url is None


class TestResumableCancel:
    async def test_success(self, httpx_mock):
        httpx_mock.add_response(
            method="POST",
            json={"code": 200, "response_data": {"api_ext": {"status": "cancelled"}}},
        )
        from wecode.service.gcs.gcs_gateway_service import GcsGatewayService

        await GcsGatewayService().resumable_cancel(
            user_id=1, session_uri="https://upload/session-1"
        )

    async def test_410_silent_success(self, httpx_mock):
        httpx_mock.add_response(method="POST", status_code=410, text="Gone")
        from wecode.service.gcs.gcs_gateway_service import GcsGatewayService

        await GcsGatewayService().resumable_cancel(
            user_id=1, session_uri="https://upload/expired"
        )

    async def test_other_exception_does_not_raise(self, httpx_mock):
        httpx_mock.add_response(method="POST", status_code=500, text="Server Error")
        from wecode.service.gcs.gcs_gateway_service import GcsGatewayService

        await GcsGatewayService().resumable_cancel(
            user_id=1, session_uri="https://upload/session-1"
        )
