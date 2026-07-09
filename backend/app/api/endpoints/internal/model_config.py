# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Internal model-config resolve endpoint for the converter service.

The standalone converter microservice has no DB access and no decryption
credentials, so it cannot resolve a KB's ``multimodalAnalysisModelRef`` into a
usable runtime config on its own. Instead of shipping the decrypted config
through the Celery broker, the converter calls this endpoint at task execution
time with just the model reference + uploader identity, and receives the
already-decrypted, already-placeholder-resolved runtime config (api_key +
default_headers + base_url + ...).

Trust boundary: same as the chat_shell HTTP path — plaintext over the internal
network, authenticated by ``BACKEND_INTERNAL_TOKEN``. This keeps the broker
free of sensitive config (P5 fix) while reusing the single canonical resolver
(``resolve_model_config_by_ref`` → ``extract_and_process_model_config``).
"""

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.services.auth.internal_service_token import verify_internal_service_token
from app.services.knowledge.model_ref_resolver import (
    ModelRefResolutionError,
    resolve_model_config_by_ref,
)
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/model-config",
    tags=["model-config-internal"],
    dependencies=[Depends(verify_internal_service_token)],
)


class ModelConfigResolveRequest(BaseModel):
    """Request body for the internal model-config resolve endpoint.

    ``model_ref`` is the KB's ``multimodalAnalysisModelRef`` dict
    (``{name, namespace, type}``). ``uploader_id`` / ``uploader_name``
    identify the per-uploader billing scope. ``media_type`` drives the backend
    capability gate: video requires supportsVideo, image requires supportsImage
    (or supportsVideo — a video-capable Gemini model also handles images).
    """

    model_ref: Dict[str, Any]
    uploader_id: int
    uploader_name: Optional[str] = None
    media_type: str  # "video" | "image"


class ModelConfigResolveResponse(BaseModel):
    """Response body carrying the resolved runtime model config.

    The config is the output of ``extract_and_process_model_config``: api_key
    is decrypted, ``${env.X}`` placeholders in ``default_headers`` are
    resolved. It crosses the internal network in plaintext, protected by
    ``BACKEND_INTERNAL_TOKEN`` — same trust boundary as the chat_shell path.

    NOTE: the field name is ``runtime_config`` (not ``model_config``) because
    Pydantic v2 reserves ``model_config`` for model configuration.
    """

    runtime_config: Dict[str, Any]


@trace_sync("resolve_model_config", "model_config.internal")
@router.post("/resolve", response_model=ModelConfigResolveResponse)
def resolve_model_config(
    request: ModelConfigResolveRequest, db: Session = Depends(get_db)
) -> ModelConfigResolveResponse:
    """Resolve a multimodal analysis model ref into a runtime config.

    Called by the converter at task execution time. Returns the full runtime
    config with api_key decrypted and ``default_headers`` placeholders resolved.

    Raises:
        HTTPException 404: model not found / not configured / no api_key.
        HTTPException 400: structurally invalid model_ref, or model does not
            declare the required capability for ``media_type``.
    """
    try:
        cfg = resolve_model_config_by_ref(
            db,
            model_ref=request.model_ref,
            user_id=request.uploader_id,
            user_name=request.uploader_name,
        )
    except ModelRefResolutionError as exc:
        raise HTTPException(status_code=400, detail=f"{exc.code}: {exc}")

    if not cfg:
        raise HTTPException(
            status_code=404,
            detail="Multimodal analysis model not configured or not found",
        )
    if not cfg.get("api_key"):
        raise HTTPException(
            status_code=404,
            detail="Configured multimodal analysis model has no api_key",
        )

    # Capability gate: reject when the model does not declare any multimodal
    # capability for the media type being processed. Mirrors the frontend
    # selector's acceptance criteria so that API calls, stale KB configs, or
    # concurrent model edits cannot bypass it and push the failure all the way
    # to the Gemini call (after staging cost).
    #
    # Per the KB schema (knowledge.py), the multimodal analysis model is a
    # Gemini video-capable model that "also handles image analysis" — i.e. the
    # same supportsVideo=true model serves BOTH media types. So:
    # - video: requires supportsVideo=true (strict)
    # - image: accepts supportsImage=true OR supportsVideo=true (a video-capable
    #   Gemini model has no separate supportsImage toggle but still analyzes
    #   images). Only reject when the model declares NEITHER.
    capabilities = cfg.get("modelCapabilities") or {}
    supports_video = capabilities.get("supportsVideo") is True
    supports_image = capabilities.get("supportsImage") is True
    if request.media_type == "video" and not supports_video:
        raise HTTPException(
            status_code=400,
            detail="MODEL_NOT_SUPPORT_VIDEO: configured multimodal analysis "
            "model does not declare supportsVideo=true",
        )
    if request.media_type == "image" and not supports_image and not supports_video:
        raise HTTPException(
            status_code=400,
            detail="MODEL_NOT_SUPPORT_IMAGE: configured multimodal analysis "
            "model declares neither supportsImage=true nor supportsVideo=true",
        )

    logger.info(
        "[model-config.resolve] resolved model_id=%s media_type=%s uploader_id=%s",
        cfg.get("model_id"),
        request.media_type,
        request.uploader_id,
    )
    return ModelConfigResolveResponse(runtime_config=cfg)
