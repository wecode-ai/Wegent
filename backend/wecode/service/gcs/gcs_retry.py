# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""GCS gateway retry logic with exponential backoff.

Extracted from ``gcs_gateway_service.py`` and split into three focused
functions to stay under the 50-line function-length limit (AGENTS.md):
- :func:`should_retry` — decide whether to retry and compute backoff delay.
- :func:`classify_exhausted_error` — map the last exception to a
  :class:`GcsGatewayError` after retries are exhausted.
- :func:`retry_with_backoff` — thin orchestrator that calls ``fn`` and
  delegates retry decisions to the two helpers above.
"""

import asyncio
import logging
import random
from typing import Any, Optional, Tuple

import httpx

from wecode.service.gcs.gcs_models import (
    GCS_MAX_RETRIES,
    GcsGatewayError,
    GcsSessionInvalid,
)

logger = logging.getLogger(__name__)


def _log_call(level: int, op: str, user_id: int, **fields: Any) -> None:
    """Emit a structured GCS log line with consistent field naming."""
    kv = " ".join(f"{k}={v}" for k, v in {"user_id": user_id, **fields}.items())
    logger.log(level, "gcs %s: %s", op, kv)


def should_retry(
    exc: Exception,
    *,
    is_read_timeout: bool,
    attempt: int,
    effective_max: int,
) -> Tuple[bool, float]:
    """Decide whether to retry on ``exc`` and compute the backoff delay.

    Returns ``(should_retry, delay_seconds)``. When ``should_retry`` is
    ``False`` the caller must re-raise ``exc`` immediately.

    Retryable: 5xx, 429, ConnectError, ConnectTimeout, ReadTimeout.
    Non-retryable: 4xx (except 429), GcsGatewayError subclasses.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status == 429 or status >= 500:
            delay = 1.0 * (2 ** (attempt - 1)) + random.uniform(0, 0.5)
            return True, delay
        # Non-retryable HTTP error — let caller re-raise.
        return False, 0.0

    if isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout)):
        delay = 1.0 * (2 ** (attempt - 1)) + random.uniform(0, 0.5)
        return True, delay

    if isinstance(exc, httpx.ReadTimeout):
        if attempt < effective_max:
            delay = 1.0 * (2 ** (attempt - 1)) + random.uniform(0, 0.5)
            return True, delay
        return False, 0.0

    # GcsGatewayError / GcsSessionInvalid and unknown exceptions are not retried,
    # EXCEPT gcs_auth_failed: the 401/403 path already invalidated the TAuth
    # cache, so a single retry with a fresh token may recover a transient auth
    # blip (e.g. Redis returning a stale token). Without this the system would
    # keep hammering the gateway with the same bad token until the 3h TTL.
    if isinstance(exc, GcsGatewayError) and exc.error_code == "gcs_auth_failed":
        if attempt < effective_max:
            return True, 0.5  # short delay; token was just refreshed
        return False, 0.0

    # Other GcsGatewayError / GcsSessionInvalid and unknown exceptions: not retried.
    return False, 0.0


def classify_exhausted_error(last_exc: Optional[Exception]) -> GcsGatewayError:
    """Map the last exception after retries are exhausted to a GcsGatewayError."""
    if isinstance(last_exc, GcsGatewayError):
        return last_exc
    if isinstance(last_exc, httpx.HTTPStatusError):
        status = last_exc.response.status_code
        if status >= 500:
            return GcsGatewayError(
                "gcs_gateway_timeout", "Gateway timeout after retries"
            )
        if status == 429:
            return GcsGatewayError(
                "gcs_quota_exceeded", "Gateway rate-limited after retries"
            )
    if isinstance(last_exc, (httpx.ConnectError, httpx.ConnectTimeout)):
        return GcsGatewayError("gcs_network_error", "Network error after retries")
    if isinstance(last_exc, httpx.ReadTimeout):
        return GcsGatewayError(
            "gcs_gateway_timeout", "Gateway read timeout after retries"
        )
    return GcsGatewayError("gcs_upstream_error", "Upload failed after retries")


async def retry_with_backoff(
    fn,
    *,
    op: str,
    user_id: int,
    max_retries: int = GCS_MAX_RETRIES,
    base_delay: float = 1.0,
    is_read_timeout: bool = False,
) -> Any:
    """Call *fn* with exponential-backoff retry on retryable errors.

    Thin orchestrator: retry decisions are delegated to :func:`should_retry`
    and exhausted-error classification to :func:`classify_exhausted_error`.
    """
    effective_max = 2 if is_read_timeout else max_retries
    last_exc: Optional[Exception] = None

    for attempt in range(1, effective_max + 1):
        try:
            return await fn()
        except GcsSessionInvalid:
            raise
        except GcsGatewayError as exc:
            # Allow one retry after the 401/403 path invalidated the TAuth
            # cache. should_retry gates this to a single additional attempt.
            if exc.error_code != "gcs_auth_failed":
                raise
            last_exc = exc
            do_retry, delay = should_retry(
                exc,
                is_read_timeout=is_read_timeout,
                attempt=attempt,
                effective_max=effective_max,
            )
            if not do_retry:
                raise
            if attempt < effective_max:
                _log_retry(op, user_id, attempt, exc, delay)
                await asyncio.sleep(delay)
        except Exception as exc:
            last_exc = exc
            do_retry, delay = should_retry(
                exc,
                is_read_timeout=is_read_timeout,
                attempt=attempt,
                effective_max=effective_max,
            )
            if not do_retry:
                raise
            if attempt < effective_max:
                _log_retry(op, user_id, attempt, exc, delay)
                await asyncio.sleep(delay)

    _log_call(
        logging.ERROR,
        f"{op} failed",
        user_id,
        error=type(last_exc).__name__ if last_exc else "unknown",
        attempt=effective_max,
    )
    raise classify_exhausted_error(last_exc)


def _log_retry(
    op: str, user_id: int, attempt: int, exc: Exception, delay: float
) -> None:
    """Log a retry attempt with consistent fields."""
    _log_call(
        logging.WARNING,
        f"{op} retry",
        user_id,
        attempt=attempt,
        error=type(exc).__name__,
        delay=f"{delay:.1f}s",
    )
