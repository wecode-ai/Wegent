# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Multimodal (video/image Gemini) pipeline helpers for the knowledge orchestrator.

Isolated from orchestrator.py / knowledge_transfer.py to minimize merge
conflicts. Unlike the internal overlay build, this open-source module is a
direct implementation — there is no ``try import wecode`` fallback. The whole
multimodal branch is gated by the global ``KNOWLEDGE_MULTIMODAL_ENABLED``
switch; when False, files are never classified as multimodal so no
dispatch/Gemini runs anywhere, and these helpers reduce to no-ops/mineru-only.

Helpers:
- ``conversion_pipeline``: classify a file (multimodal / mineru / None)
- ``resolve_dispatch_or_none``: pre-flight gate for a not-yet-created document
- ``resolve_dispatch_for_document_or_none``: pre-flight gate for an existing document
- ``schedule_multimodal_indexing_or_none``: enqueue the Gemini conversion task
- ``apply_multimodal_prompt_override``: persist/clear per-doc prompt override
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus
from app.models.user import User
from shared.utils.multimodal_ext import (
    _MULTIMODAL_EXTENSIONS,
)

logger = logging.getLogger(__name__)


def conversion_pipeline(file_extension: Optional[str], app_settings) -> Optional[str]:
    """Return the conversion pipeline for a file type.

    Returns ``"multimodal"`` for video/image files (Gemini analysis), ``"mineru"``
    for files that need MinerU conversion, or ``None`` for direct indexing.

    The multimodal branch is gated by the global ``KNOWLEDGE_MULTIMODAL_ENABLED``
    switch — when False, video/image files are never classified as multimodal so
    no multimodal dispatch / Gemini conversion runs anywhere.
    """
    from app.services.knowledge.orchestrator import _normalize_file_extension

    ext = _normalize_file_extension(file_extension).lower()
    if ext in _MULTIMODAL_EXTENSIONS and settings.KNOWLEDGE_MULTIMODAL_ENABLED:
        return "multimodal"
    if app_settings.needs_conversion(ext):
        return "mineru"
    return None


def resolve_dispatch_or_none(
    db: Session,
    knowledge_base: Kind,
    app_settings: Any,
    *,
    file_extension: Optional[str],
    attachment_id: Optional[int],
    uploader: User,
) -> Optional[Any]:
    """Pre-flight gate: if the file is multimodal, validate and resolve dispatch ctx.

    Returns a ``MultimodalDispatchContext`` for multimodal files, or ``None``
    for non-multimodal files (caller proceeds with the normal path).

    Raises ``ModelRefResolutionError`` if multimodal is enabled but misconfigured.
    """
    if conversion_pipeline(file_extension, app_settings) != "multimodal":
        return None

    from app.services.knowledge.model_ref_resolver import ModelRefResolutionError
    from app.services.knowledge.multimodal_dispatch import (
        validate_multimodal_dispatch,
    )

    kb_spec = (knowledge_base.json or {}).get("spec", {})
    if not kb_spec.get("multimodalAnalysisEnabled"):
        raise ModelRefResolutionError(
            "MULTIMODAL_ANALYSIS_DISABLED",
            "Multimodal analysis is not enabled for this knowledge base",
        )
    if not kb_spec.get("multimodalAnalysisModelRef"):
        raise ModelRefResolutionError(
            "MULTIMODAL_ANALYSIS_MODEL_NOT_CONFIGURED",
            "No multimodal analysis model configured for this knowledge base",
        )
    ctx = validate_multimodal_dispatch(
        db,
        knowledge_base=knowledge_base,
        attachment_id=attachment_id,
        uploader=uploader,
        file_extension=file_extension,
    )
    # Closed-loop staging gate. The switch (KNOWLEDGE_MULTIMODAL_VIDEO_STAGING_ENABLED)
    # only means "video is allowed", not "a staging provider is actually wired".
    # Internal deployments inject video_source_ref / gcs paths via a patch that
    # WRAPS validate_multimodal_dispatch, so this check runs AFTER that patch has
    # applied and is safe — internal injection is unaffected. In the open-source
    # build (or any deployment that enables the switch without a provider), all
    # provider fields stay empty: fail fast here instead of persisting the doc
    # and failing later in the worker (NoOp provider).
    if (
        ctx is not None
        and getattr(ctx, "media_type", None) == "video"
        and not getattr(ctx, "video_source_ref", None)
        and not getattr(ctx, "media_staging_config", None)
        and not getattr(ctx, "gcs_upload_path", None)
    ):
        raise ModelRefResolutionError(
            "MULTIMODAL_VIDEO_STAGING_NOT_CONFIGURED",
            "Video multimodal staging provider is not configured",
        )
    return ctx


def resolve_dispatch_for_document_or_none(
    db: Session, knowledge_base: Kind, document: Any, app_settings: Any
) -> Optional[Any]:
    """Pre-flight gate for an existing document (update / reindex / transfer).

    Fast-paths non-multimodal files to ``None`` without an uploader lookup.
    For multimodal files, resolves the uploader from ``document.user_id``
    (per-uploader billing) and delegates to ``resolve_dispatch_or_none``.
    Raises ``ValueError`` if the uploader cannot be found.
    """
    if (
        conversion_pipeline(getattr(document, "file_extension", None), app_settings)
        != "multimodal"
    ):
        return None

    uploader = db.query(User).filter(User.id == document.user_id).first()
    if not uploader:
        raise ValueError(
            f"Uploader user {document.user_id} not found for document {document.id}"
        )
    return resolve_dispatch_or_none(
        db,
        knowledge_base,
        app_settings,
        file_extension=getattr(document, "file_extension", None),
        attachment_id=document.attachment_id,
        uploader=uploader,
    )


def apply_multimodal_prompt_override(
    document: Any, multimodal_prompt_override: Optional[str], db: Session
) -> None:
    """Persist (or clear) a per-document multimodal prompt override.

    Non-blank string → write override; blank string → clear (revert to KB
    default); ``None`` → leave unchanged (no-op). Used by the re-index endpoint
    to power the "modify prompt & re-analyze" flow.
    """
    if multimodal_prompt_override is None:
        return
    from sqlalchemy.orm.attributes import flag_modified

    source_config = dict(document.source_config or {})
    prompt_text = multimodal_prompt_override.strip()
    if prompt_text:
        source_config["multimodal_analysis_prompt"] = prompt_text
    else:
        source_config.pop("multimodal_analysis_prompt", None)
    document.source_config = source_config
    flag_modified(document, "source_config")
    db.commit()


def schedule_multimodal_indexing_or_none(
    db: Session,
    knowledge_base: Kind,
    document: Any,
    user: User,
    multimodal_dispatch_ctx: Optional[Any],
    normalized_extension: str,
    generation: int,
    index_dispatch_payload: Dict[str, Any],
    app_settings: Any,
) -> Optional[Any]:
    """Build the multimodal index dispatch payload and enqueue the Gemini task.

    Returns the Celery ``AsyncResult`` for multimodal docs, or ``None`` for
    non-multimodal docs (caller proceeds with mineru/direct indexing). Raises
    ``ModelRefResolutionError`` if a multimodal doc lacks its dispatch context.
    """
    if conversion_pipeline(normalized_extension, app_settings) != "multimodal":
        return None

    from app.services.knowledge.model_ref_resolver import ModelRefResolutionError
    from app.services.knowledge.multimodal_dispatch import (
        build_multimodal_conversion_kwargs,
    )

    if multimodal_dispatch_ctx is None:
        raise ModelRefResolutionError(
            "MULTIMODAL_DISPATCH_CONTEXT_MISSING",
            f"multimodal_dispatch_ctx not provided for multimodal document {document.id}",
        )

    document.index_status = DocumentIndexStatus.PENDING_CONVERSION
    document.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()

    task_kwargs = build_multimodal_conversion_kwargs(
        dispatch_ctx=multimodal_dispatch_ctx,
        knowledge_base=knowledge_base,
        document=document,
        normalized_extension=normalized_extension,
        generation=generation,
        index_dispatch_payload=index_dispatch_payload,
    )

    from app.core.celery_app import celery_app

    async_result = celery_app.send_task(
        "knowledge_doc_converter.convert_multimodal",
        kwargs=task_kwargs,
        queue=settings.KNOWLEDGE_MULTIMODAL_CONVERSION_QUEUE,
    )
    logger.info(
        "[Orchestrator] Multimodal conversion task enqueued: "
        "document_id=%s, media_type=%s, file_ext=%s, "
        "index_generation=%s, celery_task_id=%s",
        document.id,
        multimodal_dispatch_ctx.media_type,
        normalized_extension,
        generation,
        async_result.id,
    )
    return async_result
