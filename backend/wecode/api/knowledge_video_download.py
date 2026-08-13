# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Knowledge-base video download endpoint.

Knowledge-base uploaded videos are stored on Weibo's file platform: the
attachment carries a Weibo ``fid`` but no local ``storage_key``, so the generic
attachment ``/download`` endpoint (which reads bytes from local storage)
rejects them via ``_raise_if_weibo_video_download_unsupported``. The CDN URL
resolved from the ``fid`` also points at an *internal* OSS endpoint that
browser clients cannot reach (and which CORS would block even if they could).

This dedicated, self-contained endpoint serves knowledge-base video downloads
by stream-proxying: it resolves the ``fid`` to a short-lived CDN URL (reachable
from the backend inside the VPC) and streams the bytes back to the client with
a proper ``Content-Disposition``. It is intentionally isolated from the shared
``attachments`` module so existing attachment download behaviour is untouched.

Concurrency: a module-level semaphore caps simultaneous downloads per process
so a single user cannot exhaust backend file descriptors / connections. Range
requests (``Range`` header) are forwarded to the upstream CDN so browser
``<video>`` seeking works, returning the upstream's 206/200 status verbatim.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Optional
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.api.dependencies import get_db
from app.core import security
from app.models.knowledge import KnowledgeDocument
from app.models.subtask_context import ContextType, SubtaskContext
from app.models.user import User
from app.services.context import context_service
from app.services.knowledge import KnowledgeService
from app.services.media.weibo_media_service import weibo_media_service
from wecode.config.multimodal_config import multimodal_settings

logger = logging.getLogger(__name__)

router = APIRouter()

# Per-process concurrency cap for video downloads. Each download holds an
# upstream httpx connection + a downstream streaming response for the full
# (potentially multi-minute) transfer. Created lazily so the configured value
# is read at first use (test-friendly).
_download_semaphore: Optional[asyncio.Semaphore] = None


def _get_download_semaphore() -> asyncio.Semaphore:
    global _download_semaphore
    if _download_semaphore is None:
        _download_semaphore = asyncio.Semaphore(
            multimodal_settings.MAX_CONCURRENT_VIDEO_DOWNLOADS
        )
    return _download_semaphore


# Max seconds to wait for the next byte from the Weibo CDN. A healthy transfer
# sends bytes continuously, so this bounds how long a stalled upstream can hold
# a download slot + connection. ``read=None`` would hang forever on a CDN that
# opens the connection then stops sending, eventually exhausting the semaphore.
_UPSTREAM_READ_TIMEOUT = 60.0


def _safe_video_mime(stored: Optional[str]) -> str:
    """Only allow video/* MIME types; force a safe default otherwise.

    The stored ``mime_type`` is DB-sourced and user-influenced (attachment
    metadata). Restricting to ``video/*`` prevents a malicious value like
    ``text/html`` from causing the browser to render downloaded content as HTML.
    """
    if stored and stored.lower().startswith("video/"):
        return stored
    return "video/mp4"


def _build_content_disposition(filename: str) -> str:
    """Build a Content-Disposition header with RFC 5987 fallback for non-ASCII.

    Control characters (CRLF, etc.) are stripped from the filename to prevent
    header injection via a DB-stored ``original_filename``.
    """
    if not filename:
        return "attachment"
    # Strip control chars (CRLF header injection defense) and surrounding space.
    safe = re.sub(r"[\x00-\x1f\x7f]", "", filename).strip()
    if not safe:
        return "attachment"
    try:
        safe.encode("latin-1")
    except UnicodeEncodeError:
        return f"attachment; filename*=UTF-8''{quote(safe)}"
    escaped = safe.replace("\\", "\\\\").replace('"', '\\"')
    return f'attachment; filename="{escaped}"'


def _get_kb_video_attachment(
    db: Session,
    attachment_id: int,
    user_id: int,
    *,
    document_id: int | None = None,
) -> SubtaskContext:
    """Load a knowledge-base Weibo video attachment, enforcing KB access.

    Raises ``HTTPException`` (404 / 403) when the attachment does not exist,
    is not a knowledge-base document attachment, is not a Weibo-backed video,
    or the user lacks access to the owning knowledge base.
    """
    document_filters = [
        KnowledgeDocument.attachment_id == attachment_id,
        KnowledgeDocument.is_active.is_(True),
    ]
    if document_id is not None:
        document_filters.append(KnowledgeDocument.id == document_id)
    kb_doc = db.query(KnowledgeDocument).filter(*document_filters).first()
    if not kb_doc:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Reuse the canonical KB access check so permission rules stay in one place.
    _, has_access = KnowledgeService.get_knowledge_base(
        db=db,
        knowledge_base_id=kb_doc.kind_id,
        user_id=user_id,
    )
    if not has_access:
        raise HTTPException(status_code=404, detail="Attachment not found")

    context = (
        db.query(SubtaskContext)
        .filter(
            SubtaskContext.id == attachment_id,
            SubtaskContext.context_type == ContextType.ATTACHMENT.value,
        )
        .first()
    )
    if not context:
        raise HTTPException(status_code=404, detail="Attachment not found")

    type_data = context.type_data if isinstance(context.type_data, dict) else {}
    if not (
        context_service.is_video_context(context)
        and type_data.get("storage_backend") == "weibo"
    ):
        # Non-Weibo-video attachments should use the generic download endpoint.
        raise HTTPException(
            status_code=400,
            detail="This endpoint only supports Weibo-backed video attachments",
        )

    return context


@router.get("/attachments/{attachment_id}/video-download")
async def download_knowledge_video(
    attachment_id: int,
    request: Request,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Stream-download a knowledge-base Weibo video attachment.

    Resolves the stored ``fid`` to a short-lived Weibo CDN URL and streams the
    bytes back to the client with a ``Content-Disposition`` header so the
    generic ``downloadAttachment`` flow works unchanged for video files.

    The client's ``Range`` header is forwarded to the upstream CDN so browser
    ``<video>`` seeking works; the upstream 206/200 status + Content-Range are
    passed through verbatim.
    """
    context = _get_kb_video_attachment(db, attachment_id, current_user.id)

    type_data = context.type_data if isinstance(context.type_data, dict) else {}
    fid = type_data.get("fid")
    if not fid:
        raise HTTPException(
            status_code=400,
            detail="Weibo video attachment has no fid (cannot resolve download URL)",
        )

    # get_download_url is a sync httpx call; offload so the event loop stays free.
    video_url = await run_in_threadpool(
        weibo_media_service.get_download_url, fid, current_user
    )
    if not video_url:
        raise HTTPException(
            status_code=502,
            detail="Failed to resolve Weibo video download URL",
        )
    logger.info(
        "[knowledge_video] Proxying attachment %s (fid=%s) from CDN",
        attachment_id,
        fid,
    )

    # Forward the client Range header so browser <video> seeking works.
    range_header = request.headers.get("range")
    req_headers: dict[str, str] = {}
    if range_header:
        req_headers["range"] = range_header

    # Resolve response metadata up front (pure functions on ``context``) so
    # nothing between acquiring the slot and returning StreamingResponse can
    # raise and leak the slot / upstream connection.
    resp_headers: dict[str, str] = {
        "Content-Disposition": _build_content_disposition(
            context.original_filename or ""
        ),
        "Accept-Ranges": "bytes",
    }
    media_type = _safe_video_mime(context.mime_type)

    # Acquire the concurrency slot BEFORE opening the upstream connection. The
    # cap must bound *open upstream connections*, not merely active byte
    # streaming — acquiring inside _stream() (which runs after this function
    # returns) would let a contending request open its upstream connection
    # first and then block on the slot, exceeding the configured limit.
    # StreamingResponse consumes _stream() after we return, so the slot is
    # released in _stream()'s finally (completion / client disconnect via
    # CancelledError / upstream error).
    semaphore = _get_download_semaphore()
    await semaphore.acquire()
    client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=_UPSTREAM_READ_TIMEOUT))
    upstream: Optional[httpx.Response] = None
    try:
        upstream = await client.send(
            client.build_request("GET", video_url, headers=req_headers),
            stream=True,
        )
    except httpx.HTTPError:
        await client.aclose()
        semaphore.release()
        raise HTTPException(status_code=502, detail="Failed to connect to Weibo CDN")
    except BaseException:
        # CancelledError (client disconnect) is a BaseException, not caught by
        # the httpx.HTTPError handler above. Release the slot + close the client
        # so a cancellation does not permanently leak a download slot.
        await client.aclose()
        semaphore.release()
        raise

    assert upstream is not None  # guaranteed by the try/except above

    if upstream.status_code >= 400:
        await upstream.aclose()
        await client.aclose()
        semaphore.release()
        raise HTTPException(
            status_code=502,
            detail=f"Weibo CDN returned status {upstream.status_code}",
        )

    async def _stream():
        # Slot was acquired before opening upstream; release it here so the
        # hold covers the full transfer duration.
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            semaphore.release()
            await upstream.aclose()
            await client.aclose()

    # Pass through the upstream status (200 or 206 for Range) + range / length
    # / encoding headers so the browser correctly handles partial content and
    # any upstream content-encoding. ``content-encoding`` MUST be forwarded
    # alongside ``content-length``: aiter_raw() yields the still-encoded bytes,
    # so omitting the encoding header would make the browser save compressed
    # bytes as a raw video file (silently corrupted download).
    for h in ("content-range", "content-length", "content-encoding"):
        v = upstream.headers.get(h)
        if v:
            resp_headers[h.title()] = v

    return StreamingResponse(
        _stream(),
        status_code=upstream.status_code,
        media_type=media_type,
        headers=resp_headers,
    )
