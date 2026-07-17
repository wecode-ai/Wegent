# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Internal GCS proxy endpoints for the converter multimodal pipeline.

The converter microservice has no TAuth2 credentials and cannot reach the GCS
gateway directly, so it proxies upload through these endpoints. Used by
both video (always GCS gs://) and large images (> MULTIMODAL_INLINE_MAX_BYTES);
small images use inline base64 and never hit this proxy.

Upload is streaming on both paths — ``UploadFile.file`` (a BinaryIO) is passed
straight to the gateway so peak memory stays bounded regardless of chunk size
(the resumable chunk path previously buffered the whole chunk via
``await chunk.read()``; it now streams the BinaryIO directly).

For files >100 MB the converter instead drives the resumable endpoints
(``/upload-resumable/init|chunk|query|cancel``) here, which wrap
``GcsGatewayService.resumable_*``. Recovery (query → resume) is driven by the
converter because it holds the local file handle needed to re-read chunks.

Staged GCS objects are never deleted manually — the bucket lifecycle
(age > 1 day) reaps them — so this router exposes no delete endpoint.
"""

import re

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.services.auth.internal_service_token import verify_internal_service_token
from shared.utils.multimodal_limits import REMOTE_MEDIA_SIMPLE_MAX_BYTES
from wecode.service.gcs.gcs_gateway_service import (
    GcsGatewayError,
    GcsGatewayService,
    GcsSessionInvalid,
)

router = APIRouter(
    prefix="/multimodal-gcs",
    tags=["internal-multimodal-gcs"],
    dependencies=[Depends(verify_internal_service_token)],
)

# Stateless gateway; safe to share a module-level instance.
_gateway = GcsGatewayService()

# Input validation limits (defense-in-depth; the gateway also validates).
_FILENAME_MAX_LEN = 255
_CONTENT_TYPE_MAX_LEN = 127
# RFC 7230 token + slash + subtype. Rejects control chars, spaces, CRLF.
_CONTENT_TYPE_RE = re.compile(r"^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$")
# Filename: word chars, dot, dash, underscore, space, common CJK via broad unicode.
# Rejects path separators and control chars (path traversal / header injection).
_UNSAFE_FILENAME_CHARS = re.compile(r"[\x00-\x1f\x7f/\\]")


def _validate_filename(filename: str) -> str:
    """Sanitize a user-supplied filename before forwarding it to the gateway.

    Rejects empty / overlong filenames and any containing path separators or
    control characters (defense against path traversal and header injection).
    """
    if not filename or len(filename) > _FILENAME_MAX_LEN:
        raise HTTPException(status_code=400, detail="Invalid filename")
    if _UNSAFE_FILENAME_CHARS.search(filename):
        raise HTTPException(status_code=400, detail="Invalid filename")
    return filename


def _validate_content_type(content_type: str) -> str:
    """Validate a MIME content-type string (rejects control chars / CRLF)."""
    if (
        not content_type
        or len(content_type) > _CONTENT_TYPE_MAX_LEN
        or not _CONTENT_TYPE_RE.match(content_type)
    ):
        raise HTTPException(status_code=400, detail="Invalid content_type")
    return content_type


def _gateway_error_status(exc: GcsGatewayError) -> int:
    """Map a GcsGatewayError to an HTTP status code for the converter.

    The converter classifies upload failures by status code:
    - 413 (gcs_file_too_large): permanent — retrying wastes a Celery slot.
    - 410 (gcs_session_invalid): transient — re-init may recover the session.
    - 502 (default): transient — backend/GCS hiccup.
    """
    if isinstance(exc, GcsSessionInvalid):
        return 410
    if exc.error_code == "gcs_file_too_large":
        return 413
    return 502


@router.post("/upload")
async def upload_multimodal_to_gcs(
    filename: str = Form(...),
    content_type: str = Form(...),
    uploader_id: int = Form(0),
    file: UploadFile = File(...),
) -> JSONResponse:
    """Stream-upload a video/image to GCS for the converter (Gemini consumption)."""
    filename = _validate_filename(filename)
    content_type = _validate_content_type(content_type)
    # Guard: files >100 MB must use the resumable endpoints. Reject up-front so
    # we never forward an oversized payload to the gateway's simple upload
    # (which returns an ambiguous 400 that the proxy would otherwise map to
    # 502 and the converter would retry pointlessly). UploadFile.size comes
    # from the Content-Length header and may be None for chunked transfers —
    # skip the guard then and let the gateway classify.
    if file.size is not None and file.size > REMOTE_MEDIA_SIMPLE_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"GCS simple upload size {file.size} exceeds simple limit "
                f"{REMOTE_MEDIA_SIMPLE_MAX_BYTES}; use resumable upload"
            ),
        )
    try:
        result = await _gateway.upload_simple(
            user_id=uploader_id,  # audit trail; does not participate in TAuth signing
            filename=filename,
            content_type=content_type,
            file_stream=file.file,
        )
    except GcsGatewayError as exc:
        # Map known permanent causes to distinct status codes so the converter
        # can classify them correctly instead of treating every 4xx as
        # transient. gcs_file_too_large → 413 (permanent); gcs_session_invalid
        # → 410 (transient: re-init may recover); everything else stays 502.
        status_code = _gateway_error_status(exc)
        raise HTTPException(status_code=status_code, detail=f"GCS upload failed: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"GCS upload error: {exc}")

    return JSONResponse({"gs_url": result.gs_url, "object_name": result.object_name})


# ── Resumable upload endpoints (>100 MB) ─────────────────────────────


class ResumableInitRequest(BaseModel):
    filename: str
    content_type: str
    total_size: int
    uploader_id: int = 0  # audit trail; 0 = unknown (backward compat)


@router.post("/upload-resumable/init")
async def resumable_init(payload: ResumableInitRequest) -> JSONResponse:
    """Initialize a resumable upload session for a large file (>100 MB)."""
    payload.filename = _validate_filename(payload.filename)
    payload.content_type = _validate_content_type(payload.content_type)
    if payload.total_size <= 0:
        raise HTTPException(status_code=400, detail="total_size must be positive")
    try:
        result = await _gateway.resumable_init(
            user_id=payload.uploader_id,  # audit trail
            filename=payload.filename,
            content_type=payload.content_type,
            total_size=payload.total_size,
        )
    except GcsGatewayError as exc:
        raise HTTPException(
            status_code=_gateway_error_status(exc),
            detail=f"GCS resumable init failed: {exc}",
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"GCS init error: {exc}")

    return JSONResponse(
        {
            "session_uri": result.session_uri,
            "object_name": result.object_name,
            "chunk_size": result.chunk_size,
            "total_size": result.total_size,
        }
    )


@router.post("/upload-resumable/chunk")
async def resumable_put_chunk(
    session_uri: str = Form(...),
    object_name: str = Form(...),
    offset: int = Form(...),
    total_size: int = Form(...),
    uploader_id: int = Form(0),
    chunk: UploadFile = File(...),
) -> JSONResponse:
    """Upload a single chunk in a resumable session.

    Recovery (query → resume / re-init) is driven by the converter caller; this
    endpoint performs exactly one chunk put and returns the gateway result.

    The chunk BinaryIO is streamed to the gateway (not buffered into memory),
    so peak memory stays bounded regardless of chunk size.
    """
    # Input validation (defense-in-depth; the converter is trusted but a bug
    # could push inconsistent values straight into the gateway payload).
    if offset < 0:
        raise HTTPException(status_code=400, detail="offset must be non-negative")
    if offset >= total_size:
        raise HTTPException(status_code=400, detail="offset must be < total_size")
    if chunk.size is not None and offset + chunk.size > total_size:
        raise HTTPException(
            status_code=400,
            detail="offset + chunk size exceeds total_size",
        )
    try:
        result = await _gateway.resumable_put_chunk(
            user_id=uploader_id,  # audit trail
            session_uri=session_uri,
            object_name=object_name,
            offset=offset,
            total_size=total_size,
            chunk=chunk.file,  # BinaryIO — streamed, not buffered
        )
    except GcsSessionInvalid as exc:
        raise HTTPException(status_code=410, detail=f"GCS session invalid: {exc}")
    except GcsGatewayError as exc:
        raise HTTPException(
            status_code=_gateway_error_status(exc),
            detail=f"GCS chunk failed: {exc}",
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"GCS chunk error: {exc}")

    return JSONResponse(
        {
            "status": result.status,
            "next_offset": result.next_offset,
            "object_name": result.object_name,
            "gs_url": result.gs_url,
        }
    )


class ResumableQueryRequest(BaseModel):
    session_uri: str
    total_size: int
    uploader_id: int = 0  # audit trail; 0 = unknown (backward compat)


@router.post("/upload-resumable/query")
async def resumable_query(payload: ResumableQueryRequest) -> JSONResponse:
    """Query the current state of a resumable upload session."""
    try:
        result = await _gateway.resumable_query(
            user_id=payload.uploader_id,  # audit trail
            session_uri=payload.session_uri,
            total_size=payload.total_size,
        )
    except GcsSessionInvalid as exc:
        raise HTTPException(status_code=410, detail=f"GCS session invalid: {exc}")
    except GcsGatewayError as exc:
        raise HTTPException(
            status_code=_gateway_error_status(exc),
            detail=f"GCS query failed: {exc}",
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"GCS query error: {exc}")

    return JSONResponse(
        {
            "status": result.status,
            "received_byte": result.received_byte,
            "next_offset": result.next_offset,
            "object_name": result.object_name,
            "gs_url": result.gs_url,
        }
    )


class ResumableCancelRequest(BaseModel):
    session_uri: str
    uploader_id: int = 0  # audit trail; 0 = unknown (backward compat)


@router.post("/upload-resumable/cancel")
async def resumable_cancel(payload: ResumableCancelRequest) -> JSONResponse:
    """Best-effort cancel of a resumable upload session."""
    try:
        await _gateway.resumable_cancel(
            user_id=payload.uploader_id,  # audit trail
            session_uri=payload.session_uri,
        )
    except Exception:
        pass  # best-effort
    return JSONResponse({"ok": True})
