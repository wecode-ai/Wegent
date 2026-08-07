# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge-base video playback URL resolver.

Returns a browser-reachable, short-lived signed CDN URL for a Weibo-backed KB
video. The backend only resolves the URL; it does
NOT proxy video bytes — the browser ``<video src>`` connects to Weibo CDN
directly, keeping backend load minimal.

The stored ``fid`` is resolved through the existing media service.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.knowledge import KnowledgeDocument
from app.models.user import User
from app.services.media.weibo_media_service import weibo_media_service
from wecode.api.knowledge_video_download import _get_kb_video_attachment

logger = logging.getLogger(__name__)

router = APIRouter()


class VideoPlayUrlResponse(BaseModel):
    """Browser-reachable OSS signed URL for a KB video (from downloadlink)."""

    url: str
    mime_type: str = "video/mp4"


@router.get(
    "/{document_id}/video-play-url",
    response_model=VideoPlayUrlResponse,
)
async def resolve_video_play_url(
    document_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> VideoPlayUrlResponse:
    """Resolve a playable CDN URL for a KB video attachment.

    404 when the attachment is missing or the user lacks KB access; 409 when
    the video exists but is not yet playable (e.g. transcoding in progress).
    """
    document = (
        db.query(KnowledgeDocument).filter(KnowledgeDocument.id == document_id).first()
    )
    if document is None:
        raise HTTPException(status_code=404, detail="Video document not found")
    attachment_id = document.attachment_id
    context = _get_kb_video_attachment(db, attachment_id, current_user.id)
    type_data = context.type_data if isinstance(context.type_data, dict) else {}
    fid = type_data.get("fid")
    if not fid:
        raise HTTPException(
            status_code=400,
            detail="Weibo video attachment has no fid",
        )

    # Resolve a browser-reachable OSS signed URL via the downloadlink API.
    # Backend only resolves the URL; the browser <video src> reaches OSS
    # directly (no byte proxying). The signed URL embeds credentials in the
    # query string, so it works as a plain <video src> without auth headers.
    play_url = await run_in_threadpool(
        weibo_media_service.get_download_url, int(fid), current_user
    )
    if not play_url:
        logger.info(
            "[knowledge_video_play] not playable attachment_id=%s fid=%s",
            attachment_id,
            fid,
        )
        raise HTTPException(
            status_code=409,
            detail="Video URL could not be resolved, please retry later",
        )

    logger.info(
        "[knowledge_video_play] resolved attachment_id=%s fid=%s",
        attachment_id,
        fid,
    )
    return VideoPlayUrlResponse(
        url=play_url,
        mime_type="video/mp4",
    )
