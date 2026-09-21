# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Stable embedding errors shared across runtime adapters."""

from __future__ import annotations


class EmbeddingResponseFormatError(ValueError):
    """Raised when a provider response violates the configured wire format."""

    retryable: bool = False


class EmbeddingDimensionMismatchError(RuntimeError):
    """Raised when a provider returns a vector with an unexpected dimension."""

    code = "embedding_dimension_mismatch"
    retryable = False
    _message_template = (
        "Embedding model '{model}' returned {actual} dimensions; expected {expected}."
    )

    def __init__(
        self,
        *,
        model: str,
        expected: int,
        actual: int,
        message: str | None = None,
    ) -> None:
        self.model = model
        self.expected = expected
        self.actual = actual
        self.details = {
            "model": model,
            "expected_dimensions": expected,
            "actual_dimensions": actual,
        }
        super().__init__(
            message
            or self._message_template.format(
                model=model, expected=expected, actual=actual
            )
        )


class CollectionDimensionMismatchError(EmbeddingDimensionMismatchError):
    """Raised when a collection does not hold the declared vector dimension.

    The reported ``actual`` dimension is ``0`` when the collection exists but
    does not declare a readable dense vector field.
    """

    _message_template = (
        "Embedding model '{model}' declares {expected} dimensions, but the existing "
        "collection stores {actual} dimensions; rebuild the index to match."
    )

    @classmethod
    def missing_vector_dimension(
        cls,
        *,
        model: str,
        expected: int,
    ) -> "CollectionDimensionMismatchError":
        """Build the error for a collection without a dense vector dimension."""
        return cls(
            model=model,
            expected=expected,
            actual=0,
            message=(
                f"Embedding model '{model}' declares {expected} dimensions, but the "
                "existing collection does not declare a dense vector dimension."
            ),
        )
