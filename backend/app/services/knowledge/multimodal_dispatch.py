# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Multimodal dispatch pre-flight validation and resolution (provider-neutral).

The KB multimodal analysis pipeline serves BOTH video and image from one model
+ one switch. This module resolves everything the converter task needs *before*
the document is persisted, so a validation failure leaves no orphan document
stuck in ``PENDING_CONVERSION``.

The resolver produces an immutable, dispatch-ready context. No api_key or
default_headers cross the Redis broker — the payload carries only the model
reference (``model_ref``) and uploader identity; the converter resolves the
runtime config (api_key decrypted, placeholders resolved) at execution time via
the backend internal endpoint ``/api/internal/model-config/resolve`` (P5 fix).

media_type branching (the only place video/image diverge at dispatch time):
- ``video``: requires a configured media staging provider (the open-source
  default ships none, so video is rejected up-front via the
  ``KNOWLEDGE_MULTIMODAL_VIDEO_STAGING_ENABLED`` switch). The concrete video
  source reference (vendor-specific, e.g. a CDN fid) is opaque to the core
  pipeline — internal deployments inject it through ``video_source_ref``.
- ``image``: build ``content_download_path`` (images have storage_key; the
  staging vs inline-base64 decision is deferred to the task based on size).

Billing: the model is resolved against the *uploader* (per-uploader billing).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.subtask_context import ContextType, SubtaskContext
from app.models.user import User
from app.services.knowledge.model_ref_resolver import (
    ModelRefResolutionError,
    resolve_multimodal_analysis_model,
)
from shared.utils.multimodal_ext import (
    is_multimodal_extension,
    multimodal_media_type,
)


def resolve_multimodal_prompt_override(
    media_type: str,
    *,
    document_source_config: Optional[Dict[str, Any]] = None,
    knowledge_base_spec: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    """Resolve the effective multimodal prompt via 3-layer precedence.

    document override > knowledge base default > system default (None here).

    Returns the prompt text to send to the converter, or ``None`` to let the
    converter use its built-in shared default. Blank/whitespace values are
    treated as absent so an empty override falls through to the next layer
    (mirrors the frontend ``resolveEffectivePrompt`` helper).
    """
    doc_prompt = (document_source_config or {}).get("multimodal_analysis_prompt")
    if doc_prompt and doc_prompt.strip():
        return doc_prompt.strip()
    spec = knowledge_base_spec or {}
    kb_prompt = (
        spec.get("multimodalAnalysisVideoPrompt")
        if media_type == "video"
        else spec.get("multimodalAnalysisImagePrompt")
    )
    if kb_prompt and kb_prompt.strip():
        return kb_prompt.strip()
    return None


@dataclass(frozen=True)
class MultimodalDispatchContext:
    """Resolved, dispatch-ready context for a multimodal conversion task.

    Produced by :func:`validate_multimodal_dispatch` before the document is
    persisted, so a validation failure leaves no orphan document. No api_key
    or default_headers are carried — only the model reference and uploader
    identity; the converter resolves the runtime config at execution time via
    the internal model-config endpoint (P5 fix).

    ``media_type`` selects the prompt + delivery path inside the task. For
    ``video`` only ``video_source_ref`` is set (an opaque, vendor-specific
    reference the converter/staging provider understands); for ``image`` only
    ``content_download_path`` is set.
    """

    media_type: str  # "video" | "image"
    model_ref: Dict[str, Any]
    uploader_id: int
    uploader_name: Optional[str]
    original_filename: str
    # video only: opaque, vendor-specific source reference the staging provider
    # understands (e.g. a CDN file id). None in the open-source default build.
    video_source_ref: Optional[Dict[str, Any]] = None
    # image only: generic attachment download endpoint (image has storage_key).
    content_download_path: Optional[str] = None
    # media staging config forwarded to the converter; None = no staging
    # provider configured (image still works via inline base64).
    media_staging_config: Dict[str, Any] = field(default_factory=dict)
    # video only: backend internal endpoint path the converter calls to resolve
    # a fresh short-lived download URL at execution time. None in the open-source
    # default build; internal deployments inject the video source resolver path.
    video_download_url_path: Optional[str] = None
    # video only: staging proxy upload/delete paths. None in the open-source
    # default build; internal deployments inject GCS proxy paths.
    gcs_upload_path: Optional[str] = None
    gcs_delete_path: Optional[str] = None


def validate_multimodal_dispatch(
    db: Session,
    *,
    knowledge_base: Kind,
    attachment_id: Optional[int],
    uploader: User,
    file_extension: Optional[str] = None,
) -> MultimodalDispatchContext:
    """Resolve everything the multimodal task needs, or fail fast with a coded error.

    Call this *before* ``create_document()`` so a missing model / api_key /
    download path rejects the request without leaving an orphan document.

    Args:
        db: Database session.
        knowledge_base: Knowledge base Kind (already access-verified).
        attachment_id: Attachment id of the uploaded video/image.
        uploader: The uploading user (per-uploader billing source).
        file_extension: File extension, used to classify media_type. When None,
            the attachment's own ``file_extension`` is used.

    Returns:
        A :class:`MultimodalDispatchContext` carrying ``media_type``, the
        model reference + uploader identity (no api_key), the original
        filename, and either the video source reference (video) or the
        content download path (image).

    Raises:
        ModelRefResolutionError: on any precondition failure, carrying a
            stable ``code`` the API layer can map to a user-facing message.
    """
    # 1. Model + api_key preflight (resolves KB's multimodalAnalysisModelRef,
    #    per-uploader). The resolved config is NOT shipped — only used to
    #    verify the model exists and has an api_key so a misconfiguration
    #    rejects the request without leaving an orphan document. The converter
    #    re-resolves at execution time via the internal model-config endpoint.
    model_config = resolve_multimodal_analysis_model(
        db,
        kb=knowledge_base,
        user_id=uploader.id,
        user_name=uploader.user_name,
    )
    if not model_config:
        raise ModelRefResolutionError(
            "MULTIMODAL_ANALYSIS_MODEL_NOT_CONFIGURED",
            "Multimodal analysis model not configured for this knowledge base",
        )
    if not model_config.get("api_key"):
        raise ModelRefResolutionError(
            "MULTIMODAL_ANALYSIS_MODEL_KEY_MISSING",
            "Configured multimodal analysis model has no api_key",
        )
    model_ref = (
        (knowledge_base.json or {}).get("spec", {}).get("multimodalAnalysisModelRef")
    )

    # 2. Attachment must exist.
    attachment = (
        db.query(SubtaskContext)
        .filter(
            SubtaskContext.id == attachment_id,
            SubtaskContext.context_type == ContextType.ATTACHMENT.value,
        )
        .first()
    )
    if not attachment:
        raise ModelRefResolutionError(
            "MULTIMODAL_ATTACHMENT_NOT_FOUND",
            f"Multimodal attachment {attachment_id} not found",
        )

    ext = file_extension or attachment.file_extension
    media_type = multimodal_media_type(ext)

    original_filename = attachment.original_filename or attachment.name or ""

    if media_type == "video":
        # Video requires a configured media staging provider (Gemini needs a
        # gs:///https URI for large media). The open-source default ships none,
        # so reject up-front when the switch is off. Internal deployments enable
        # the switch and inject a vendor-specific ``video_source_ref``.
        if not settings.KNOWLEDGE_MULTIMODAL_VIDEO_STAGING_ENABLED:
            raise ModelRefResolutionError(
                "MULTIMODAL_VIDEO_STAGING_NOT_CONFIGURED",
                "Video multimodal analysis requires a configured media staging "
                "provider (KNOWLEDGE_MULTIMODAL_VIDEO_STAGING_ENABLED is False)",
            )
        return MultimodalDispatchContext(
            media_type="video",
            model_ref=model_ref,
            uploader_id=uploader.id,
            uploader_name=uploader.user_name,
            original_filename=original_filename,
            # Opaque vendor-specific source ref; populated by a staging
            # provider extension when configured. None in the default build.
            video_source_ref=None,
        )

    # Image: build content_download_path (image has storage_key). The staging
    # vs inline-base64 decision is made by the task based on file size, so no
    # URL resolution is needed here.
    return MultimodalDispatchContext(
        media_type="image",
        model_ref=model_ref,
        uploader_id=uploader.id,
        uploader_name=uploader.user_name,
        original_filename=original_filename,
        content_download_path=f"/api/internal/attachments/{attachment_id}/download",
    )


def build_multimodal_conversion_kwargs(
    *,
    dispatch_ctx: MultimodalDispatchContext,
    knowledge_base: Kind,
    document: Any,
    normalized_extension: str,
    generation: int,
    index_dispatch_payload: Dict[str, Any],
) -> Dict[str, Any]:
    """Build the Celery kwargs for the ``convert_multimodal`` task.

    Centralizes the multimodal dispatch payload (media type, download paths,
    model reference + uploader identity, staging config, and the 3-layer-resolved
    prompt override) so the orchestrator's multimodal branch is a single call.
    No api_key or default_headers cross the broker — the converter resolves the
    runtime config at execution time via the internal model-config endpoint
    (P5 fix). The prompt override is resolved here from the document's
    ``source_config`` and the KB spec (document override > KB default > None =
    converter default).
    """
    kb_spec = (knowledge_base.json or {}).get("spec", {})
    prompt_override = resolve_multimodal_prompt_override(
        dispatch_ctx.media_type,
        document_source_config=document.source_config,
        knowledge_base_spec=kb_spec,
    )
    return {
        "document_id": document.id,
        "knowledge_base_id": knowledge_base.id,
        "attachment_id": document.attachment_id,
        "file_extension": normalized_extension,
        "media_type": dispatch_ctx.media_type,
        "original_filename": dispatch_ctx.original_filename,
        # video-only: opaque vendor-specific source reference (None in the
        # default build; internal deployments inject a CDN fid, etc.).
        "video_source_ref": dispatch_ctx.video_source_ref,
        # image-only: generic attachment download endpoint.
        "content_download_path": dispatch_ctx.content_download_path,
        "index_generation": generation,
        "callback_status_path": "/api/internal/conversion/callback/status",
        "callback_completed_path": "/api/internal/conversion/callback/completed",
        "index_dispatch_payload": index_dispatch_payload,
        # P5: model ref + uploader identity instead of the resolved/encrypted
        # model config. The converter calls model_config_resolve_path at
        # execution time to fetch the decrypted runtime config.
        "model_ref": dispatch_ctx.model_ref,
        "uploader_id": dispatch_ctx.uploader_id,
        "uploader_name": dispatch_ctx.uploader_name,
        "model_config_resolve_path": settings.MULTIMODAL_MODEL_CONFIG_RESOLVE_PATH,
        # Media staging config forwarded to the converter's pluggable provider.
        # Empty in the default build (image still works via inline base64).
        "media_staging_config": dispatch_ctx.media_staging_config,
        # video-only: download URL resolver path + staging proxy paths.
        # None in the default build; internal deployments inject these.
        "video_download_url_path": dispatch_ctx.video_download_url_path,
        "gcs_upload_path": dispatch_ctx.gcs_upload_path,
        "gcs_delete_path": dispatch_ctx.gcs_delete_path,
        "request_id": f"multimodal-{document.id}",
        # Resolved effective prompt; None ⇒ converter uses its built-in default.
        "prompt_override": prompt_override,
    }
