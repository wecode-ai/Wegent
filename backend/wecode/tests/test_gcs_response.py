# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Tests for GCS gateway response parsing."""

from unittest.mock import patch

import httpx
import pytest

from wecode.service.gcs.gcs_models import (
    GcsGatewayError,
    GcsSessionInvalid,
)
from wecode.service.gcs.gcs_response import (
    common_params,
    parse_chunk_result,
    parse_gateway_response,
    parse_init_result,
    parse_query_result,
    parse_upload_result,
)


def _make_response(status_code: int, json_body=None, text: str = "") -> httpx.Response:
    """Build an httpx.Response for testing."""
    request = httpx.Request("POST", "http://i.aigc.weibo.com/files/upload")
    if json_body is not None:
        return httpx.Response(status_code, json=json_body, request=request)
    return httpx.Response(status_code, text=text, request=request)


class TestParseGatewayResponse:
    """parse_gateway_response maps HTTP status + business code to errors."""

    def test_5xx_raises_http_status_error(self):
        resp = _make_response(503, text="Service Unavailable")
        with pytest.raises(httpx.HTTPStatusError):
            parse_gateway_response(resp, "test_op", user_id=1)

    def test_401_raises_auth_failed(self):
        resp = _make_response(401, text="Unauthorized")
        with patch(
            "wecode.service.gcs.gcs_auth.invalidate_tauth_cache"
        ) as mock_invalidate:
            with pytest.raises(GcsGatewayError) as exc_info:
                parse_gateway_response(resp, "test_op", user_id=1)
        assert exc_info.value.error_code == "gcs_auth_failed"
        # The TAuth cache must be invalidated on 401 so the next request
        # re-fetches a fresh token instead of reusing the stale one.
        mock_invalidate.assert_called_once()

    def test_403_raises_auth_failed(self):
        resp = _make_response(403, text="Forbidden")
        with patch(
            "wecode.service.gcs.gcs_auth.invalidate_tauth_cache"
        ) as mock_invalidate:
            with pytest.raises(GcsGatewayError) as exc_info:
                parse_gateway_response(resp, "test_op", user_id=1)
        assert exc_info.value.error_code == "gcs_auth_failed"
        mock_invalidate.assert_called_once()

    def test_410_raises_session_invalid(self):
        resp = _make_response(410, text="Gone")
        with pytest.raises(GcsSessionInvalid):
            parse_gateway_response(resp, "test_op", user_id=1)

    def test_413_raises_file_too_large(self):
        resp = _make_response(413, text="Too Large")
        with pytest.raises(GcsGatewayError) as exc_info:
            parse_gateway_response(resp, "test_op", user_id=1)
        assert exc_info.value.error_code == "gcs_file_too_large"

    def test_429_raises_http_status_error(self):
        resp = _make_response(429, text="Rate Limited")
        with pytest.raises(httpx.HTTPStatusError):
            parse_gateway_response(resp, "test_op", user_id=1)

    def test_400_with_too_large_body_raises_file_too_large(self):
        resp = _make_response(400, text="File too large for upload")
        with pytest.raises(GcsGatewayError) as exc_info:
            parse_gateway_response(resp, "test_op", user_id=1)
        assert exc_info.value.error_code == "gcs_file_too_large"

    def test_400_with_chinese_too_large_raises_file_too_large(self):
        resp = _make_response(400, text="文件过大")
        with pytest.raises(GcsGatewayError) as exc_info:
            parse_gateway_response(resp, "test_op", user_id=1)
        assert exc_info.value.error_code == "gcs_file_too_large"

    def test_400_plain_raises_upstream_error(self):
        resp = _make_response(400, text="Bad Request")
        with pytest.raises(GcsGatewayError) as exc_info:
            parse_gateway_response(resp, "test_op", user_id=1)
        assert exc_info.value.error_code == "gcs_upstream_error"

    def test_200_with_non_200_business_code_raises_upstream_error(self):
        resp = _make_response(
            200, json_body={"code": 500, "msg": "internal error", "response_data": {}}
        )
        with pytest.raises(GcsGatewayError) as exc_info:
            parse_gateway_response(resp, "test_op", user_id=1)
        assert exc_info.value.error_code == "gcs_upstream_error"
        assert "internal error" in str(exc_info.value)

    def test_200_with_200_code_returns_response_data(self):
        resp = _make_response(
            200,
            json_body={
                "code": 200,
                "response_data": {"object_name": "obj/1.png", "gs_url": "gs://b/1.png"},
            },
        )
        data = parse_gateway_response(resp, "test_op", user_id=1)
        assert data == {"object_name": "obj/1.png", "gs_url": "gs://b/1.png"}

    def test_200_with_message_field_fallback(self):
        """Business error with 'message' field (not 'msg')."""
        resp = _make_response(
            200,
            json_body={"code": 400, "message": "fallback message", "response_data": {}},
        )
        with pytest.raises(GcsGatewayError) as exc_info:
            parse_gateway_response(resp, "test_op", user_id=1)
        assert "fallback message" in str(exc_info.value)


class TestParseUploadResult:
    def test_full_fields(self):
        data = {
            "object_name": "obj/1.png",
            "gs_url": "gs://b/1.png",
            "request_id": "req-1",
            "file_size": 1024,
            "content_type": "image/png",
        }
        result = parse_upload_result(data)
        assert result.object_name == "obj/1.png"
        assert result.gs_url == "gs://b/1.png"
        assert result.request_id == "req-1"
        assert result.file_size == 1024
        assert result.content_type == "image/png"

    def test_missing_fields_use_defaults(self):
        result = parse_upload_result({})
        assert result.object_name == ""
        assert result.gs_url == ""
        assert result.request_id is None
        assert result.file_size == 0
        assert result.content_type == ""


class TestParseInitResult:
    def test_full_fields(self):
        data = {
            "api_ext": {
                "session_uri": "https://upload/uri",
                "object_name": "obj/1.mp4",
                "bucket": "pj1-bucket",
                "total_size": 278921216,
                "chunk_size": 8388608,
                "content_type": "video/mp4",
            }
        }
        result = parse_init_result(data)
        assert result.session_uri == "https://upload/uri"
        assert result.object_name == "obj/1.mp4"
        assert result.bucket == "pj1-bucket"
        assert result.total_size == 278921216
        assert result.chunk_size == 8388608
        assert result.content_type == "video/mp4"

    def test_flat_data_without_api_ext(self):
        """When api_ext key is absent, fields are read from the top-level dict."""
        data = {"session_uri": "uri", "object_name": "obj"}
        result = parse_init_result(data)
        assert result.session_uri == "uri"
        assert result.object_name == "obj"

    def test_default_chunk_size(self):
        result = parse_init_result({})
        assert result.chunk_size == 8 * 1024 * 1024


class TestParseChunkResult:
    def test_status_continue(self):
        data = {"api_ext": {"status": "continue", "next_offset": 8388608}}
        result = parse_chunk_result(data)
        assert result.status == "continue"
        assert result.next_offset == 8388608

    def test_status_done(self):
        data = {"api_ext": {"status": "done", "gs_url": "gs://b/1.mp4"}}
        result = parse_chunk_result(data)
        assert result.status == "done"
        assert result.gs_url == "gs://b/1.mp4"

    def test_invalid_status_falls_back_to_continue(self):
        data = {"api_ext": {"status": "weird"}}
        result = parse_chunk_result(data)
        assert result.status == "continue"

    def test_missing_status_defaults_to_continue(self):
        result = parse_chunk_result({})
        assert result.status == "continue"


class TestParseQueryResult:
    def test_status_done(self):
        data = {"api_ext": {"status": "done", "gs_url": "gs://b/1.mp4"}}
        result = parse_query_result(data)
        assert result.status == "done"
        assert result.gs_url == "gs://b/1.mp4"

    def test_status_in_progress(self):
        data = {"api_ext": {"status": "in_progress", "received_byte": 8388607}}
        result = parse_query_result(data)
        assert result.status == "in_progress"
        assert result.received_byte == 8388607

    def test_invalid_status_falls_back_to_in_progress(self):
        result = parse_query_result({"api_ext": {"status": "unknown"}})
        assert result.status == "in_progress"

    def test_missing_status_defaults_to_in_progress(self):
        result = parse_query_result({})
        assert result.status == "in_progress"


class TestCommonParams:
    def test_returns_five_params(self):
        params = common_params()
        assert params["appkey"] == "2720640420"
        assert params["type"] == "google-cloud"
        assert params["model_id"] == "gcs-standard"
        assert params["message"] == "wegent-gemini-video"
        assert params["use_ext_first"] == "1"
