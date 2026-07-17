# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Tests for GCS gateway retry logic."""

import asyncio
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from wecode.service.gcs.gcs_models import GcsGatewayError, GcsSessionInvalid
from wecode.service.gcs.gcs_retry import (
    classify_exhausted_error,
    retry_with_backoff,
    should_retry,
)


def _make_http_status_error(status_code: int) -> httpx.HTTPStatusError:
    """Build an httpx.HTTPStatusError for testing."""
    request = httpx.Request("POST", "http://i.aigc.weibo.com/files/upload")
    response = httpx.Response(status_code, request=request)
    return httpx.HTTPStatusError(
        f"HTTP {status_code}", request=request, response=response
    )


class TestShouldRetry:
    """should_retry decides retry + backoff delay by exception type."""

    def test_5xx_returns_true_with_delay(self):
        exc = _make_http_status_error(503)
        do_retry, delay = should_retry(
            exc, is_read_timeout=False, attempt=1, effective_max=3
        )
        assert do_retry is True
        assert delay > 0

    def test_429_returns_true_with_delay(self):
        exc = _make_http_status_error(429)
        do_retry, delay = should_retry(
            exc, is_read_timeout=False, attempt=1, effective_max=3
        )
        assert do_retry is True
        assert delay > 0

    def test_4xx_non_429_returns_false(self):
        exc = _make_http_status_error(400)
        do_retry, _ = should_retry(
            exc, is_read_timeout=False, attempt=1, effective_max=3
        )
        assert do_retry is False

    def test_connect_error_returns_true(self):
        exc = httpx.ConnectError("connection refused")
        do_retry, delay = should_retry(
            exc, is_read_timeout=False, attempt=1, effective_max=3
        )
        assert do_retry is True
        assert delay > 0

    def test_connect_timeout_returns_true(self):
        exc = httpx.ConnectTimeout("timeout")
        do_retry, delay = should_retry(
            exc, is_read_timeout=False, attempt=1, effective_max=3
        )
        assert do_retry is True
        assert delay > 0

    def test_read_timeout_not_exhausted_returns_true(self):
        exc = httpx.ReadTimeout("read timeout")
        do_retry, delay = should_retry(
            exc, is_read_timeout=True, attempt=1, effective_max=2
        )
        assert do_retry is True
        assert delay > 0

    def test_read_timeout_exhausted_returns_false(self):
        exc = httpx.ReadTimeout("read timeout")
        do_retry, _ = should_retry(
            exc, is_read_timeout=True, attempt=2, effective_max=2
        )
        assert do_retry is False

    def test_gcs_gateway_error_returns_false(self):
        exc = GcsGatewayError("gcs_file_too_large", "too large")
        do_retry, _ = should_retry(
            exc, is_read_timeout=False, attempt=1, effective_max=3
        )
        assert do_retry is False

    def test_gcs_session_invalid_returns_false(self):
        exc = GcsSessionInvalid()
        do_retry, _ = should_retry(
            exc, is_read_timeout=False, attempt=1, effective_max=3
        )
        assert do_retry is False


class TestClassifyExhaustedError:
    """classify_exhausted_error maps the last exception to a GcsGatewayError."""

    def test_gcs_gateway_error_passthrough(self):
        original = GcsGatewayError("gcs_file_too_large", "too large")
        result = classify_exhausted_error(original)
        assert result is original

    def test_http_5xx_to_gateway_timeout(self):
        exc = _make_http_status_error(503)
        result = classify_exhausted_error(exc)
        assert result.error_code == "gcs_gateway_timeout"

    def test_http_429_to_quota_exceeded(self):
        exc = _make_http_status_error(429)
        result = classify_exhausted_error(exc)
        assert result.error_code == "gcs_quota_exceeded"

    def test_connect_error_to_network_error(self):
        exc = httpx.ConnectError("refused")
        result = classify_exhausted_error(exc)
        assert result.error_code == "gcs_network_error"

    def test_read_timeout_to_gateway_timeout(self):
        exc = httpx.ReadTimeout("timed out")
        result = classify_exhausted_error(exc)
        assert result.error_code == "gcs_gateway_timeout"

    def test_none_to_upstream_error(self):
        result = classify_exhausted_error(None)
        assert result.error_code == "gcs_upstream_error"

    def test_unknown_exception_to_upstream_error(self):
        result = classify_exhausted_error(ValueError("unknown"))
        assert result.error_code == "gcs_upstream_error"


class TestRetryWithBackoff:
    """retry_with_backoff orchestrates retry decisions."""

    @pytest.mark.asyncio
    async def test_success_on_first_attempt(self):
        fn = AsyncMock(return_value="ok")
        result = await retry_with_backoff(fn, op="test", user_id=1)
        assert result == "ok"
        fn.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_retries_on_transient_then_succeeds(self):
        fn = AsyncMock(
            side_effect=[
                _make_http_status_error(503),
                "ok",
            ]
        )
        with patch(
            "wecode.service.gcs.gcs_retry.asyncio.sleep", new_callable=AsyncMock
        ):
            result = await retry_with_backoff(fn, op="test", user_id=1, max_retries=3)
        assert result == "ok"
        assert fn.await_count == 2

    @pytest.mark.asyncio
    async def test_retries_exhausted_raises_classified_error(self):
        fn = AsyncMock(side_effect=_make_http_status_error(503))
        with patch(
            "wecode.service.gcs.gcs_retry.asyncio.sleep", new_callable=AsyncMock
        ):
            with pytest.raises(GcsGatewayError) as exc_info:
                await retry_with_backoff(fn, op="test", user_id=1, max_retries=2)
        assert exc_info.value.error_code == "gcs_gateway_timeout"
        assert fn.await_count == 2

    @pytest.mark.asyncio
    async def test_gcs_gateway_error_not_retried(self):
        err = GcsGatewayError("gcs_file_too_large", "too large")
        fn = AsyncMock(side_effect=err)
        with pytest.raises(GcsGatewayError) as exc_info:
            await retry_with_backoff(fn, op="test", user_id=1, max_retries=3)
        assert exc_info.value.error_code == "gcs_file_too_large"
        fn.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_gcs_session_invalid_not_retried(self):
        fn = AsyncMock(side_effect=GcsSessionInvalid())
        with pytest.raises(GcsSessionInvalid):
            await retry_with_backoff(fn, op="test", user_id=1, max_retries=3)
        fn.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_auth_failed_retried_once_after_refresh(self):
        """gcs_auth_failed gets one retry (the 401 path invalidated the cache)."""
        fn = AsyncMock(
            side_effect=[
                GcsGatewayError("gcs_auth_failed", "stale token"),
                "ok",
            ]
        )
        with patch(
            "wecode.service.gcs.gcs_retry.asyncio.sleep", new_callable=AsyncMock
        ):
            result = await retry_with_backoff(fn, op="test", user_id=1, max_retries=3)
        assert result == "ok"
        assert fn.await_count == 2

    @pytest.mark.asyncio
    async def test_persistent_auth_failure_raises(self):
        """If the refreshed token still fails, don't retry forever."""
        fn = AsyncMock(side_effect=GcsGatewayError("gcs_auth_failed", "no perm"))
        with patch(
            "wecode.service.gcs.gcs_retry.asyncio.sleep", new_callable=AsyncMock
        ):
            with pytest.raises(GcsGatewayError) as exc_info:
                await retry_with_backoff(fn, op="test", user_id=1, max_retries=3)
        assert exc_info.value.error_code == "gcs_auth_failed"

    @pytest.mark.asyncio
    async def test_non_retryable_4xx_not_retried(self):
        fn = AsyncMock(side_effect=_make_http_status_error(400))
        with pytest.raises(httpx.HTTPStatusError):
            await retry_with_backoff(fn, op="test", user_id=1, max_retries=3)
        fn.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_read_timeout_uses_fewer_retries(self):
        """is_read_timeout=True caps effective_max at 2."""
        fn = AsyncMock(side_effect=httpx.ReadTimeout("timeout"))
        with patch(
            "wecode.service.gcs.gcs_retry.asyncio.sleep", new_callable=AsyncMock
        ):
            # ReadTimeout at the last attempt is not retried (should_retry returns
            # False when attempt >= effective_max), so the raw exception surfaces.
            with pytest.raises(httpx.ReadTimeout):
                await retry_with_backoff(
                    fn, op="test", user_id=1, max_retries=5, is_read_timeout=True
                )
        # effective_max=2, so 2 attempts
        assert fn.await_count == 2
