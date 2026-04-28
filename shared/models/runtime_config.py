# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime configuration models for retriever, embedding, and retrieval settings."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _RuntimeConfigModel(BaseModel):
    """Base model for runtime configuration with strict field validation."""

    model_config = ConfigDict(extra="forbid")


RetrievalMode = Literal["vector", "keyword", "hybrid"]


class RuntimeRetrieverConfig(_RuntimeConfigModel):
    """Resolved retriever identity and storage configuration."""

    name: str
    namespace: str = "default"
    storage_config: dict[str, Any] = Field(default_factory=dict)


class RuntimeEmbeddingModelConfig(_RuntimeConfigModel):
    """Resolved embedding model configuration."""

    model_name: str
    model_namespace: str = "default"
    resolved_config: dict[str, Any] = Field(default_factory=dict)


class RuntimeRetrievalConfig(_RuntimeConfigModel):
    """Normalized retrieval config for a single knowledge base target."""

    top_k: int = Field(default=20, gt=0)
    score_threshold: float = Field(default=0.7, ge=0.0, le=1.0)
    retrieval_mode: RetrievalMode = "vector"
    vector_weight: float | None = Field(default=None, ge=0.0, le=1.0)
    keyword_weight: float | None = Field(default=None, ge=0.0, le=1.0)
