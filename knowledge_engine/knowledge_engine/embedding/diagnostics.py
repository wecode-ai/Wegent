# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Safe diagnostics for embedding adapter retry attempts."""

from __future__ import annotations

import logging

from tenacity import RetryCallState

from knowledge_engine.diagnostics import log_timing


def log_embedding_attempt(state: RetryCallState, *, model: str | None = None) -> None:
    """Identify an adapter attempt without exposing its text or HTTP headers."""
    log_timing(
        "embedding_attempt",
        "start",
        level=logging.DEBUG if state.attempt_number == 1 else logging.INFO,
        model=model or getattr(state.args[0], "model_name", "-"),
        attempt=state.attempt_number,
    )


def log_embedding_retry(state: RetryCallState, *, model: str | None = None) -> None:
    """Report retry scheduling without formatting provider exceptions."""
    exc = state.outcome.exception() if state.outcome else None
    status = getattr(getattr(exc, "response", None), "status_code", None)
    log_timing(
        "embedding_retry",
        "scheduled",
        level=logging.WARNING,
        model=model or getattr(state.args[0], "model_name", "-"),
        attempt=state.attempt_number,
        elapsed_ms=round((state.seconds_since_start or 0) * 1000, 2),
        sleep_ms=round(state.next_action.sleep * 1000, 2),
        error_type=type(exc).__name__ if exc else "-",
        http_status=status if isinstance(status, int) else "-",
    )
