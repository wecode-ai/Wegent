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

    def __init__(self, *, model: str, expected: int, actual: int) -> None:
        self.model = model
        self.expected = expected
        self.actual = actual
        self.details = {
            "model": model,
            "expected_dimensions": expected,
            "actual_dimensions": actual,
        }
        super().__init__(
            f"Embedding model '{model}' returned {actual} dimensions; "
            f"expected {expected}."
        )
