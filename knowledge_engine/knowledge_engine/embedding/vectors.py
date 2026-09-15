# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared batch embedding preparation and vector validation.

Storage backends receive already prepared vectors: resolving retrieval text,
calling the provider and validating the response all happen here so that the
adapter layer only ever sees vectors it can trust.
"""

from __future__ import annotations

import math
from numbers import Real
from typing import Any, Iterable, Sequence

from knowledge_engine.embedding.errors import EmbeddingDimensionMismatchError


class VectorPreparationError(ValueError):
    """Base class for deterministic vector preparation failures."""

    code = "embedding_vector_invalid"
    retryable = False


class EmptyEmbeddingBatchError(VectorPreparationError):
    """Raised when a batch contains no text to embed."""

    code = "embedding_batch_empty"

    def __init__(self) -> None:
        super().__init__("Cannot embed an empty batch of texts.")


class EmptyIndexableContentError(VectorPreparationError):
    """Raised when a document has no indexable content at all."""

    code = "empty_indexable_content"

    def __init__(self) -> None:
        super().__init__(
            "Document has no indexable content: every chunk is blank. "
            "An empty document must not be published as a successful index."
        )


class InvalidEmbeddingVectorError(VectorPreparationError):
    """Raised when a provider returns a vector that cannot be indexed."""

    code = "embedding_vector_invalid"

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(f"Embedding provider returned an invalid vector: {reason}.")


def prepare_text_vectors(embed_model, texts: Sequence[str]) -> list[list[float]]:
    """Embed retrieval texts and validate the resulting vectors.

    An empty batch never reaches the provider; a document with no indexable
    content must fail instead of publishing an empty index.
    """
    requested = list(texts)
    if not requested:
        raise EmptyEmbeddingBatchError()

    vectors = embed_model.get_text_embedding_batch(requested, show_progress=False)
    dimension = validate_vectors(
        vectors,
        expected_count=len(requested),
        expected_dimension=_configured_dimension(embed_model),
        model_name=read_model_name(embed_model),
    )
    return _normalize_vectors(vectors, dimension)


def validate_vectors(
    vectors: Iterable[Any],
    *,
    expected_count: int | None = None,
    expected_dimension: int | None = None,
    model_name: str | None = None,
) -> int:
    """Validate vector shape and values, returning the shared dimension."""
    materialized = list(vectors)
    if expected_count is not None and len(materialized) != expected_count:
        raise InvalidEmbeddingVectorError(
            f"expected {expected_count} vectors but received {len(materialized)}"
        )
    if not materialized:
        raise EmptyEmbeddingBatchError()

    dimension: int | None = None
    for vector in materialized:
        if not isinstance(vector, (list, tuple)) or not vector:
            raise InvalidEmbeddingVectorError("vector must be a non-empty sequence")
        if dimension is None:
            dimension = len(vector)
            if expected_dimension is not None and dimension != expected_dimension:
                raise EmbeddingDimensionMismatchError(
                    model=model_name or "unknown",
                    expected=expected_dimension,
                    actual=dimension,
                )
        elif len(vector) != dimension:
            raise InvalidEmbeddingVectorError(
                f"all vectors must share one dimension, got {dimension} and {len(vector)}"
            )
        _validate_components(vector)

    assert dimension is not None
    return dimension


def prepare_query_vector(embed_model, query: str) -> list[float]:
    """Embed one retrieval query with the query-side embedding entry point."""
    vector = embed_model.get_query_embedding(query)
    validate_vectors(
        [vector],
        expected_count=1,
        expected_dimension=_configured_dimension(embed_model),
        model_name=read_model_name(embed_model),
    )
    return [float(value) for value in vector]


def _validate_components(vector: Sequence[Any]) -> None:
    squared_norm = 0.0
    for value in vector:
        if isinstance(value, bool) or not isinstance(value, Real):
            raise InvalidEmbeddingVectorError("vector components must be numbers")
        numeric = float(value)
        if not math.isfinite(numeric):
            raise InvalidEmbeddingVectorError("vector components must be finite")
        squared_norm += numeric * numeric
    if not math.sqrt(squared_norm) > 0.0:
        raise InvalidEmbeddingVectorError("vector must not have a zero norm")


def _normalize_vectors(vectors: Iterable[Any], dimension: int) -> list[list[float]]:
    normalized: list[list[float]] = []
    for vector in vectors:
        values = [float(value) for value in vector]
        if len(values) != dimension:
            raise InvalidEmbeddingVectorError(
                "vector dimension changed during validation"
            )
        normalized.append(values)
    return normalized


def _configured_dimension(embed_model) -> int | None:
    dimension = getattr(embed_model, "_configured_dimension", None)
    return dimension if isinstance(dimension, int) and dimension > 0 else None


def read_model_name(embed_model) -> str | None:
    """Best-effort read of the provider-facing model identifier."""
    for attribute in ("model_name", "model", "_model_name"):
        value = getattr(embed_model, attribute, None)
        if isinstance(value, str) and value:
            return value
    return None
