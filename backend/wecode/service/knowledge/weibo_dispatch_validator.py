# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Weibo dispatch validator — registered via register_dispatch_validator().

Replaces the old ``weibo_multimodal_patch`` monkeypatch. The validator runs
AFTER the universal preflight (model, attachment ownership/type, capability,
Gemini checks) inside ``validate_multimodal_dispatch``. It receives the
already-validated ``MultimodalDispatchContext`` and only *injects* Weibo-
specific fields via ``dataclasses.replace`` — it does NOT skip or repeat the
universal validation. No monkeypatch, no lock, no concurrency race.

Injection rules:
- video + fid → inject ``video_source_ref={fid}`` + the internal
  video-download-url resolver path + the GCS upload proxy path.
- video without fid → return ctx unchanged (downstream closed-loop gate in
  ``multimodal_pipeline.py`` rejects it).
- image → inject the GCS upload proxy path so large images stage via GCS.
- anything else → return ctx unchanged.

Registered at import time as a side effect of ``import wecode.api``, mirroring
the existing ``register_video_upload_provider`` pattern.
"""

from __future__ import annotations

import logging
from dataclasses import replace
from typing import Any

from app.models.subtask_context import SubtaskContext
from app.services.knowledge.multimodal_dispatch import (
    MultimodalDispatchContext,
    register_dispatch_validator,
)
from wecode.config.multimodal_config import multimodal_settings

logger = logging.getLogger(__name__)


def weibo_dispatch_validator(
    ctx: MultimodalDispatchContext,
    *,
    db: Any,
    knowledge_base: Any,
    attachment_id: Any,
    uploader: Any,
    file_extension: Any = None,
) -> MultimodalDispatchContext:
    """Inject Weibo-specific fields into an already-validated ctx.

    Does NOT skip/repeat the universal validation (attachment ownership, type,
    capability, Gemini checks) — that ran before us in the default flow. We
    only add: fid + download_url_path + gcs_upload_path (video);
    gcs_upload_path (image).
    """
    if ctx.media_type == "video":
        # Read the fid to decide whether this is a Weibo-backed video.
        # The attachment was already ownership-validated by the default flow,
        # but that flow doesn't read type_data.fid — so we read it here.
        attachment = (
            db.query(SubtaskContext).filter(SubtaskContext.id == attachment_id).first()
        )
        fid = (
            attachment.type_data.get("fid")
            if attachment and attachment.type_data
            else None
        )
        if not fid:
            # Not a Weibo video — return ctx unchanged. Downstream closed-loop
            # gate (multimodal_pipeline.py) rejects it (no video_source_ref).
            return ctx
        logger.info(
            "[WeiboDispatch] injecting fid=%s for attachment=%s",
            fid,
            attachment_id,
        )
        return replace(
            ctx,
            video_source_ref={"fid": int(fid)},
            video_download_url_path=(
                f"/api/internal/attachments/{attachment_id}/video-download-url"
            ),
            gcs_upload_path=multimodal_settings.MULTIMODAL_GCS_UPLOAD_PATH,
        )

    if ctx.media_type == "image":
        # Inject the GCS upload proxy path so large images (> inline threshold)
        # stage via GCS instead of the NoOp staging provider. Small images stay
        # inline and never read this path, so unconditional injection is safe.
        return replace(
            ctx,
            gcs_upload_path=multimodal_settings.MULTIMODAL_GCS_UPLOAD_PATH,
        )

    return ctx


# Register at import time (side effect of ``import wecode.api``), mirroring the
# register_video_upload_provider pattern. Idempotent.
register_dispatch_validator(weibo_dispatch_validator)
