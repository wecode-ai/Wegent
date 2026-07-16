# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Multimodal analysis error classification.

Shared by video and image analysis. Two categories drive the retry decision:
- :class:`TransientError`: retryable (429 / 5xx / timeout / network). Celery
  retries with exponential backoff.
- :class:`PermanentError`: not retryable (401 key invalid / safety block /
  empty response / quota exhausted / video staging not configured). Fails fast
  to avoid burning money.

Both carry a stable ``error_class`` code used by metrics + callback messages.
"""


class VideoAnalysisError(Exception):
    """Base for multimodal analysis errors. Carries an ``error_class`` code."""

    error_class: str = "unknown"

    def __init__(self, error_class: str, message: str) -> None:
        self.error_class = error_class
        super().__init__(message)


class TransientError(VideoAnalysisError):
    """Retryable error — a later attempt often succeeds."""


class PermanentError(VideoAnalysisError):
    """Non-retryable error — retrying wastes money (e.g. bad key, safety)."""
