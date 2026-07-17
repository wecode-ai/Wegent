# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""GCS Gateway service for Gemini video upload.

Proxies video file uploads to the GCS Gateway (i.aigc.weibo.com) using
TAuth2 authentication.  All gateway requests are signed with the shared
service UID (WEIBO_VIDEO_UID) and the GCS appkey.

This module is internal-private and is stripped from the open-source build
alongside the rest of the Weibo video upload code.

Design reference: tmp/gemini-video-gcs-design.md

Architecture: data classes, exceptions, constants, response parsing, retry
logic, and TAuth helpers have been extracted into sibling modules
(``gcs_models``, ``gcs_response``, ``gcs_retry``, ``gcs_auth``) to keep
each file focused and under the size limits. This module retains only the
:class:`GcsGatewayService` class and re-exports the public symbols so
existing imports (``from wecode.service.gcs.gcs_gateway_service import
GcsGatewayError, GcsGatewayService, GcsSessionInvalid``) stay valid.
"""

import asyncio
import atexit
import json
import logging
import time
from typing import Any, BinaryIO

import httpx

from shared.utils.multimodal_limits import REMOTE_MEDIA_MAX_FILE_SIZE
from wecode.service.gcs.gcs_auth import get_auth_headers
from wecode.service.gcs.gcs_models import (
    GCS_CHUNK_SIZE,
    GCS_GATEWAY_BASE,
    GCS_RESUMABLE_TIMEOUT,
    GCS_TIMEOUT,
    GcsChunkResult,
    GcsGatewayError,
    GcsInitResult,
    GcsQueryResult,
    GcsSessionInvalid,
    GcsUploadResult,
)
from wecode.service.gcs.gcs_response import (
    common_params,
    parse_chunk_result,
    parse_gateway_response,
    parse_init_result,
    parse_query_result,
    parse_upload_result,
)
from wecode.service.gcs.gcs_retry import _log_call, retry_with_backoff

# Re-export public symbols for backward-compatible imports.
__all__ = [
    "GcsGatewayError",
    "GcsGatewayService",
    "GcsSessionInvalid",
]

logger = logging.getLogger(__name__)


class GcsGatewayService:
    """Client for the GCS Gateway (i.aigc.weibo.com).

    All methods are async and use TAuth2-signed headers.  *user_id* is
    used for logging/audit only and does **not** participate in the
    TAuth signature.

    A long-lived :class:`httpx.AsyncClient` is shared across all calls so
    connection pool / keepalive / TLS session resumption are reused. This is
    critical for resumable uploads (a 2 GB file = ~256 chunk puts; per-call
    clients would pay 256× TLS handshake overhead). The client is created
    lazily on first use; cleanup is best-effort via :mod:`atexit` since the
    open-source ``app/main.py`` shutdown hook cannot be modified from the
    internal overlay.
    """

    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self._client_lock: asyncio.Lock | None = None

    def _get_client(self) -> httpx.AsyncClient:
        """Return the shared client, creating it lazily on first use.

        Synchronous creation is safe: httpx.AsyncClient construction does no
        I/O — the connection pool is populated on the first request.
        """
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=GCS_TIMEOUT,
                limits=httpx.Limits(
                    max_connections=32,
                    max_keepalive_connections=8,
                    keepalive_expiry=60.0,
                ),
            )
        return self._client

    async def aclose(self) -> None:
        """Close the pooled client. Called on app shutdown (best-effort via atexit)."""
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()

    @staticmethod
    def _common_params() -> dict[str, str]:
        return common_params()

    async def _execute_with_logging(
        self,
        coro_fn,
        *,
        op: str,
        user_id: int,
        is_read_timeout: bool = False,
        error_code: str = "gcs_upstream_error",
        error_msg: str = "Operation failed",
    ) -> Any:
        """Execute ``coro_fn`` with retry + success/error duration logging.

        Wraps the repeated pattern: retry_with_backoff → log duration on
        success → wrap unexpected exceptions into GcsGatewayError on failure.
        """
        start = time.perf_counter()
        try:
            result = await retry_with_backoff(
                coro_fn, op=op, user_id=user_id, is_read_timeout=is_read_timeout
            )
            duration = int((time.perf_counter() - start) * 1000)
            _log_call(logging.INFO, f"{op} done", user_id, duration_ms=duration)
            return result
        except GcsGatewayError:
            raise
        except Exception as exc:
            duration = int((time.perf_counter() - start) * 1000)
            _log_call(
                logging.ERROR,
                f"{op} failed",
                user_id,
                error=type(exc).__name__,
                duration_ms=duration,
            )
            raise GcsGatewayError(error_code, f"{error_msg}: {exc}")

    # ── simple upload (≤100 MB) ──────────────────────────────────

    async def upload_simple(
        self,
        *,
        user_id: int,
        filename: str,
        content_type: str,
        file_stream: BinaryIO,
    ) -> GcsUploadResult:
        """Upload a file ≤100 MB via single multipart POST."""
        _log_call(
            logging.INFO,
            "upload_simple start",
            user_id,
            filename=filename,
            content_type=content_type,
        )
        url = f"{GCS_GATEWAY_BASE}/files/upload"
        params = self._common_params()

        async def _do() -> GcsUploadResult:
            headers = get_auth_headers()
            client = self._get_client()
            resp = await client.post(
                url,
                params=params,
                headers=headers,
                files={"file": (filename, file_stream, content_type)},
            )
            data = parse_gateway_response(resp, "upload_simple", user_id)
            return parse_upload_result(data)

        return await self._execute_with_logging(
            _do,
            op="upload_simple",
            user_id=user_id,
            error_code="gcs_upstream_error",
            error_msg="Simple upload failed",
        )

    # ── resumable init ──────────────────────────────────────────

    async def resumable_init(
        self,
        *,
        user_id: int,
        filename: str,
        content_type: str,
        total_size: int,
    ) -> GcsInitResult:
        """Initialize a resumable upload session for files >100 MB."""
        if total_size > REMOTE_MEDIA_MAX_FILE_SIZE:
            raise GcsGatewayError(
                "gcs_file_too_large",
                f"File size {total_size} exceeds GCS limit {REMOTE_MEDIA_MAX_FILE_SIZE}",
            )
        url = f"{GCS_GATEWAY_BASE}/files/resumable_upload"
        params = self._common_params()
        payload = {
            "api_ext": {
                "action": "init",
                "filename": filename,
                "content_type": content_type,
                "total_size": total_size,
                "chunk_size": GCS_CHUNK_SIZE,
            }
        }

        async def _do() -> GcsInitResult:
            headers = get_auth_headers()
            headers["Content-Type"] = "application/json"
            client = self._get_client()
            resp = await client.post(url, params=params, headers=headers, json=payload)
            data = parse_gateway_response(resp, "resumable_init", user_id)
            return parse_init_result(data)

        return await self._execute_with_logging(
            _do,
            op="resumable_init",
            user_id=user_id,
            error_code="gcs_init_failed",
            error_msg="Resumable init failed",
        )

    # ── resumable put_chunk ─────────────────────────────────────

    async def resumable_put_chunk(
        self,
        *,
        user_id: int,
        session_uri: str,
        object_name: str,
        offset: int,
        total_size: int,
        chunk: BinaryIO,
    ) -> GcsChunkResult:
        """Upload a single chunk in a resumable session (single attempt).

        Recovery (query → resume) is driven by the caller, which holds the
        local file handle needed to re-read the chunk at a new offset. This
        method performs one put; on failure it raises and the caller decides
        whether to query+resume or re-init.

        ``chunk`` is a BinaryIO streamed directly to the gateway (no full
        buffering), so peak memory stays bounded regardless of chunk size.
        """
        return await self._raw_put_chunk(
            user_id=user_id,
            session_uri=session_uri,
            object_name=object_name,
            offset=offset,
            total_size=total_size,
            chunk=chunk,
        )

    async def _raw_put_chunk(
        self,
        *,
        user_id: int,
        session_uri: str,
        object_name: str,
        offset: int,
        total_size: int,
        chunk: BinaryIO,
    ) -> GcsChunkResult:
        """Single put_chunk attempt without recovery logic."""
        url = f"{GCS_GATEWAY_BASE}/files/resumable_upload"
        params = self._common_params()
        body_field = json.dumps(
            {
                "api_ext": {
                    "action": "put_chunk",
                    "session_uri": session_uri,
                    "object_name": object_name,
                    "offset": offset,
                    "total_size": total_size,
                }
            }
        )

        async def _do() -> GcsChunkResult:
            headers = get_auth_headers()
            client = self._get_client()
            resp = await client.post(
                url,
                params=params,
                headers=headers,
                files={
                    "body": (None, body_field, "application/json"),
                    "file": ("chunk.bin", chunk, "application/octet-stream"),
                },
            )
            data = parse_gateway_response(resp, "put_chunk", user_id)
            return parse_chunk_result(data)

        return await retry_with_backoff(
            _do,
            op="put_chunk",
            user_id=user_id,
            is_read_timeout=True,
        )

    # ── resumable query ─────────────────────────────────────────

    async def resumable_query(
        self,
        *,
        user_id: int,
        session_uri: str,
        total_size: int,
    ) -> GcsQueryResult:
        """Query the current state of a resumable upload session."""
        url = f"{GCS_GATEWAY_BASE}/files/resumable_upload"
        params = self._common_params()
        payload = {
            "api_ext": {
                "action": "query",
                "session_uri": session_uri,
                "total_size": total_size,
            }
        }

        async def _do() -> dict:
            headers = get_auth_headers()
            headers["Content-Type"] = "application/json"
            client = self._get_client()
            resp = await client.post(url, params=params, headers=headers, json=payload)
            data = parse_gateway_response(resp, "resumable_query", user_id)
            return data

        try:
            data = await retry_with_backoff(_do, op="resumable_query", user_id=user_id)
        except GcsSessionInvalid:
            return GcsQueryResult(
                status="empty",
                received_byte=None,
                next_offset=None,
                object_name=None,
                gs_url=None,
            )

        return parse_query_result(data)

    # ── resumable cancel ────────────────────────────────────────

    async def resumable_cancel(
        self,
        *,
        user_id: int,
        session_uri: str,
    ) -> None:
        """Cancel a resumable upload session (idempotent)."""
        url = f"{GCS_GATEWAY_BASE}/files/resumable_upload"
        params = self._common_params()
        payload = {
            "api_ext": {
                "action": "cancel",
                "session_uri": session_uri,
            }
        }

        try:
            headers = get_auth_headers()
            headers["Content-Type"] = "application/json"
            client = self._get_client()
            resp = await client.post(url, params=params, headers=headers, json=payload)
            parse_gateway_response(resp, "resumable_cancel", user_id)
        except GcsSessionInvalid:
            pass  # Session already gone — idempotent success
        except Exception as exc:
            # Cancel is best-effort; log warning but don't propagate
            _log_call(
                logging.WARNING,
                "resumable cancel error (ignored)",
                user_id,
                error=type(exc).__name__,
            )

        _log_call(
            logging.INFO,
            "resumable cancelled",
            user_id,
            session_uri=session_uri[:80],
        )


# Module-level singleton
gcs_gateway_service = GcsGatewayService()


def _close_client_at_exit() -> None:
    """Best-effort synchronous cleanup of the pooled client at process exit.

    ``aclose`` is async; we run it via a fresh event loop because the app's
    shutdown hook (open-source ``app/main.py``) cannot be modified from the
    internal overlay. httpx tolerates this — connections are dropped, not
    gracefully closed, which is acceptable for a process that is exiting.
    """
    svc = gcs_gateway_service
    if svc._client is not None and not svc._client.is_closed:  # noqa: SLF001
        try:
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(svc.aclose())
            finally:
                loop.close()
        except Exception:  # noqa: BLE001 — atexit must never raise
            pass


atexit.register(_close_client_at_exit)
