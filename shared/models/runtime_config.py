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

# The one source of truth for "no threshold configured". Zero means "do not
# cut": a threshold is a rule about a score scale, and the scale belongs to the
# engine, so any non-zero default is wrong on some engine. Every layer that
# resolves an absent score_threshold reads this constant instead of a literal.
DEFAULT_SCORE_THRESHOLD: float = 0.0


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
    score_threshold: float = Field(default=DEFAULT_SCORE_THRESHOLD, ge=0.0, le=1.0)
    retrieval_mode: RetrievalMode = "vector"
    vector_weight: float | None = Field(default=None, ge=0.0, le=1.0)
    keyword_weight: float | None = Field(default=None, ge=0.0, le=1.0)
