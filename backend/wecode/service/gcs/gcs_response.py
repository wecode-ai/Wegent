# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""GCS gateway response parsing.

Extracted from ``gcs_gateway_service.py``. Parses raw gateway HTTP responses
into typed data classes, mapping business errors and non-2xx statuses to
:class:`GcsGatewayError` subclasses.
"""

from typing import Any

import httpx

from wecode.service.gcs.gcs_models import (
    GcsChunkResult,
    GcsGatewayError,
    GcsInitResult,
    GcsQueryResult,
    GcsSessionInvalid,
    GcsUploadResult,
)

# Body tokens that signal a gateway 400 is actually a "file too large"
# rejection — the gateway returns 400 (not 413) for oversized simple uploads.
# Matched case-insensitively against the response body so the proxy can map
# these to 413 (permanent) instead of the default 502 (transient retry).
_GCS_TOO_LARGE_SIGNALS = (
    "too large",
    "size limit",
    "exceed",
    "超过",
    "过大",
)


def _raise_for_client_error(resp: httpx.Response) -> None:
    """Classify a 4xx gateway response into the appropriate GcsGatewayError.

    Handles the ambiguous case where the gateway returns 400 (not 413) for
    oversized files by inspecting the body for "too large" signals.
    """
    body_text = resp.text[:500]
    lowered = body_text.lower()
    if any(tok in lowered for tok in _GCS_TOO_LARGE_SIGNALS):
        raise GcsGatewayError(
            "gcs_file_too_large",
            f"Gateway {resp.status_code} (file too large): {body_text}",
            code=resp.status_code,
        )
    raise GcsGatewayError(
        "gcs_upstream_error",
        f"Gateway {resp.status_code}: {body_text}",
        code=resp.status_code,
    )


def parse_gateway_response(resp: httpx.Response, op: str, user_id: int) -> dict:
    """Parse a gateway HTTP response.

    Returns the ``response_data`` dict on success.  Raises
    :class:`GcsGatewayError` for business errors (HTTP 200 but code≠200)
    or non-2xx status codes.

    On 401/403 the cached TAuth token is invalidated before raising so the
    next request re-fetches a fresh token (otherwise a stale token keeps
    failing until the 3h cache TTL expires naturally).
    """
    if resp.status_code >= 500:
        raise httpx.HTTPStatusError(
            f"Gateway 5xx: {resp.status_code}",
            request=resp.request,
            response=resp,
        )
    if resp.status_code in (401, 403):
        # Invalidate the cached TAuth token so the next request re-fetches a
        # fresh one. Delayed import avoids a circular dependency at module load.
        from wecode.service.gcs.gcs_auth import invalidate_tauth_cache

        invalidate_tauth_cache()
        raise GcsGatewayError(
            "gcs_auth_failed", f"Gateway auth failed: HTTP {resp.status_code}"
        )
    if resp.status_code == 410:
        raise GcsSessionInvalid()
    if resp.status_code == 413:
        raise GcsGatewayError("gcs_file_too_large", "File exceeds GCS size limit")
    if resp.status_code == 429:
        raise httpx.HTTPStatusError(
            f"Gateway rate-limited: {resp.status_code}",
            request=resp.request,
            response=resp,
        )
    if 400 <= resp.status_code < 500:
        _raise_for_client_error(resp)

    # HTTP 200 — check business code
    body = resp.json()
    code = body.get("code")
    if code != 200:
        msg = body.get("msg") or body.get("message") or "gateway business error"
        raise GcsGatewayError("gcs_upstream_error", msg, code=code)

    return body.get("response_data", {})


def parse_upload_result(data: dict) -> GcsUploadResult:
    """Parse a simple-upload ``response_data`` into :class:`GcsUploadResult`."""
    return GcsUploadResult(
        object_name=data.get("object_name", ""),
        gs_url=data.get("gs_url", ""),
        request_id=data.get("request_id"),
        file_size=data.get("file_size", 0),
        content_type=data.get("content_type", ""),
    )


def parse_init_result(data: dict) -> GcsInitResult:
    """Parse a resumable-init ``response_data`` into :class:`GcsInitResult`."""
    api_ext = data.get("api_ext", data)
    return GcsInitResult(
        session_uri=api_ext.get("session_uri", ""),
        object_name=api_ext.get("object_name", ""),
        bucket=api_ext.get("bucket", ""),
        total_size=api_ext.get("total_size", 0),
        chunk_size=api_ext.get("chunk_size", 8 * 1024 * 1024),
        content_type=api_ext.get("content_type", ""),
    )


def parse_chunk_result(data: dict) -> GcsChunkResult:
    """Parse a put_chunk ``response_data`` into :class:`GcsChunkResult`."""
    api_ext = data.get("api_ext", data)
    status = api_ext.get("status", "continue")
    return GcsChunkResult(
        status=status if status in ("continue", "done") else "continue",
        next_offset=api_ext.get("next_offset"),
        object_name=api_ext.get("object_name"),
        gs_url=api_ext.get("gs_url"),
        request_id=data.get("request_id"),
    )


def parse_query_result(data: dict) -> GcsQueryResult:
    """Parse a resumable-query ``response_data`` into :class:`GcsQueryResult`."""
    api_ext = data.get("api_ext", data)
    status = api_ext.get("status", "in_progress")
    return GcsQueryResult(
        status=(
            status if status in ("done", "in_progress", "empty") else "in_progress"
        ),
        received_byte=api_ext.get("received_byte"),
        next_offset=api_ext.get("next_offset"),
        object_name=api_ext.get("object_name"),
        gs_url=api_ext.get("gs_url"),
    )


def common_params() -> dict[str, str]:
    """Return the common query-string params shared by all gateway requests."""
    from wecode.service.gcs.gcs_models import (
        GCS_APPKEY,
        GCS_MESSAGE,
        GCS_MODEL_ID,
        GCS_TYPE,
    )

    return {
        "appkey": GCS_APPKEY,
        "type": GCS_TYPE,
        "model_id": GCS_MODEL_ID,
        "message": GCS_MESSAGE,
        "use_ext_first": "1",
    }
