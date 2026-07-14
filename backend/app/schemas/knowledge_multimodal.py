# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Multimodal (video/image Gemini) analysis schema fragments.

Isolated from schemas/knowledge.py to minimize merge conflicts: the multimodal
field definitions live here as mixins, and KnowledgeBaseResponse.from_kind
reads multimodal spec keys through ``multimodal_response_kwargs``. The base
schemas/knowledge.py only adds one base class per model and one ``**`` spread,
instead of ~90 inline lines.

The V1 open API (KnowledgeDocumentCreateV1) intentionally does NOT expose the
per-document multimodal prompt override — create_document_with_content does not
forward it. Multimodal prompt override is only available via the internal REST
POST /documents (KnowledgeDocumentCreate) and the re-index endpoint below.
"""

from typing import Any, Dict, Optional

from pydantic import BaseModel, Field


class MultimodalAnalysisFieldsMixin(BaseModel):
    """Multimodal config fields shared by KnowledgeBaseCreate / Update.

    ``enabled`` is Optional — None means "leave unchanged" on update; the
    create endpoint normalizes None to False.
    """

    multimodal_analysis_enabled: Optional[bool] = Field(
        None,
        description="Enable multimodal (video/image) file uploads and Gemini analysis",
    )
    multimodal_analysis_model_ref: Optional[Dict[str, str]] = Field(
        None,
        description="Model reference for multimodal analysis. Must reference a supportsVideo=true model (a Gemini video-capable model also handles image analysis).",
    )
    multimodal_analysis_video_prompt: Optional[str] = Field(
        None,
        max_length=2000,
        description="Custom video analysis prompt; None/empty = use the system default",
    )
    multimodal_analysis_image_prompt: Optional[str] = Field(
        None,
        max_length=2000,
        description="Custom image analysis prompt; None/empty = use the system default",
    )


class MultimodalAnalysisResponseFieldsMixin(BaseModel):
    """Multimodal config fields for KnowledgeBaseResponse.

    ``enabled`` is a non-optional bool (default False) since responses always
    report a concrete state.
    """

    multimodal_analysis_enabled: bool = Field(
        default=False,
        description="Enable multimodal (video/image) file uploads and Gemini analysis",
    )
    multimodal_analysis_model_ref: Optional[Dict[str, str]] = Field(
        None,
        description="Model reference for multimodal analysis",
    )
    multimodal_analysis_video_prompt: Optional[str] = Field(
        None,
        max_length=2000,
        description="Custom video analysis prompt; None = system default",
    )
    multimodal_analysis_image_prompt: Optional[str] = Field(
        None,
        max_length=2000,
        description="Custom image analysis prompt; None = system default",
    )


class MultimodalDocumentPromptMixin(BaseModel):
    """Per-document multimodal prompt override (KnowledgeDocumentCreate)."""

    multimodal_analysis_prompt: Optional[str] = Field(
        None,
        max_length=2000,
        description="Per-document multimodal analysis prompt override; None = inherit KB default. "
        "For video, the {{VIDEO_FILENAME}} placeholder (if present) is substituted "
        "by the converter at dispatch time.",
    )


def multimodal_response_kwargs(spec: Dict[str, Any]) -> Dict[str, Any]:
    """Read multimodal fields from a KB spec into response kwargs.

    Used by KnowledgeBaseResponse.from_kind — spread as
    ``**multimodal_response_kwargs(spec)`` inside the ``cls(...)`` call so
    from_kind carries a single multimodal line instead of eight.
    """
    return {
        "multimodal_analysis_enabled": spec.get("multimodalAnalysisEnabled", False),
        "multimodal_analysis_model_ref": spec.get("multimodalAnalysisModelRef"),
        "multimodal_analysis_video_prompt": spec.get("multimodalAnalysisVideoPrompt"),
        "multimodal_analysis_image_prompt": spec.get("multimodalAnalysisImagePrompt"),
    }


class DocumentReindexRequest(BaseModel):
    """Optional body for the document re-index endpoint.

    When ``multimodal_analysis_prompt`` is provided it is persisted into the
    document's ``source_config`` (overriding the KB default) before re-dispatch,
    so the "modify prompt & re-analyze" flow reuses the re-index pipeline.
    """

    multimodal_analysis_prompt: Optional[str] = Field(
        None,
        max_length=2000,
        description="Per-document multimodal analysis prompt override written "
        "before re-index; blank/None = inherit the KB default. For video, the "
        "{{VIDEO_FILENAME}} placeholder (if present) is substituted at dispatch.",
    )
