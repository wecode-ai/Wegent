# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Embedding dimension contract shared by every provider adapter."""

from __future__ import annotations

from typing import Any, Optional, Sequence

from knowledge_engine.embedding.errors import EmbeddingDimensionMismatchError

# Declared dimension attributes: CustomEmbedding stores the configured value,
# the OpenAI adapter keeps the same value on its ``dimensions`` field.
DECLARED_DIMENSION_ATTRIBUTES = ("_configured_dimension", "dimensions")


def is_positive_int(value: Any) -> bool:
    """Return whether a value is a strictly positive integer (bools excluded)."""
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def resolve_declared_dimension(embed_model: Any) -> Optional[int]:
    """Return the positive dimension the embedding model declares, if any."""
    for attribute in DECLARED_DIMENSION_ATTRIBUTES:
        value = getattr(embed_model, attribute, None)
        if is_positive_int(value):
            return value
    return None


def ensure_declared_dimension(
    *,
    model: str,
    declared: Optional[int],
    vectors: Sequence[Sequence[float]],
) -> None:
    """Raise when a provider returns a vector that breaks the declared contract."""
    if declared is None:
        return
    for vector in vectors:
        if len(vector) != declared:
            raise EmbeddingDimensionMismatchError(
                model=model,
                expected=declared,
                actual=len(vector),
            )
