# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal attachment video-download-url resolver (multimodal pipeline).

Extracted from the open-source attachments endpoint so the open-source file
stays unmodified. Resolves a fresh short-lived Weibo CDN download URL for a
video attachment at converter task execution time, decoupling URL lifetime
from queue wait time (multimodal_dispatch P1 fix).

Self-mounted under the same ``/api/internal/attachments`` prefix the
open-source converter already targets.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.models.knowledge import KnowledgeDocument
from app.models.subtask_context import ContextType, SubtaskContext
from app.models.user import User
from app.services.auth.internal_service_token import verify_internal_service_token
from app.services.context import context_service
from app.services.media.weibo_media_service import weibo_media_service
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/attachments",
    tags=["internal-attachments-multimodal"],
    dependencies=[Depends(verify_internal_service_token)],
)

# Conservative estimate of the Weibo CDN URL lifetime (seconds). The real
# expiry is decided by Weibo and not returned by the API; this is a hint for
# callers that retry on stale URLs.
_WEIBO_DOWNLOAD_URL_ESTIMATED_TTL = 1800


@trace_sync("resolve_video_download_url", "attachments.internal")
@router.get("/{attachment_id}/video-download-url")
def resolve_video_download_url(
    attachment_id: int, db: Session = Depends(get_db)
) -> JSONResponse:
    """Resolve a fresh short-lived Weibo CDN download URL for a video attachment.

    Called by the converter at task execution time (not at dispatch time) so
    the URL's lifetime is bound to execution, not queue wait time. Videos have
    no ``storage_key`` (they live on Weibo's file platform), so the generic
    download endpoint cannot serve them.

    Scoping: the attachment must be linked to a knowledge-base document and be
    a Weibo-backed video, so a buggy/compromised converter cannot mint a CDN
    URL for an arbitrary Weibo video by id.
    """
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

    # Verify the attachment is linked to a knowledge-base document (the only
    # legitimate caller path is the multimodal conversion pipeline). Without
    # this check the endpoint would mint a CDN URL for any Weibo video id.
    kb_doc = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.attachment_id == attachment_id)
        .first()
    )
    if not kb_doc:
        raise HTTPException(status_code=404, detail="Attachment not found")

    type_data = context.type_data if isinstance(context.type_data, dict) else {}
    if not (
        context_service.is_video_context(context)
        and type_data.get("storage_backend") == "weibo"
    ):
        raise HTTPException(
            status_code=400,
            detail="This endpoint only supports Weibo-backed video attachments",
        )
    fid = type_data.get("fid")
    if not fid:
        raise HTTPException(
            status_code=400,
            detail="Video attachment has no fid (not a Weibo-uploaded video)",
        )

    uploader = db.query(User).filter(User.id == context.user_id).first()
    try:
        video_url = weibo_media_service.get_download_url(int(fid), uploader)
    except (TypeError, ValueError) as exc:
        # Malformed fid (non-numeric) — a data-integrity issue, not transient.
        raise HTTPException(
            status_code=400,
            detail=f"Video attachment has a malformed fid: {exc}",
        )
    except Exception as exc:  # noqa: BLE001 — surface as 502 to converter
        raise HTTPException(
            status_code=502,
            detail=f"Failed to resolve Weibo video download URL: {exc}",
        )
    if not video_url:
        raise HTTPException(
            status_code=502,
            detail="Failed to resolve Weibo video download URL",
        )

    return JSONResponse(
        {
            "url": video_url,
            "expires_in": _WEIBO_DOWNLOAD_URL_ESTIMATED_TTL,
        }
    )
