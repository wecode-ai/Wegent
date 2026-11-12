# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Correlated retrieval timings without logging request bodies or credentials."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from time import perf_counter

from shared.telemetry.context.span import get_request_id

logger = logging.getLogger(__name__)
_knowledge_id: ContextVar[str | None] = ContextVar("query_knowledge_id", default=None)
_task_id: ContextVar[int | None] = ContextVar("query_task_id", default=None)


@contextmanager
def task_context(task_id: int | None) -> Iterator[None]:
    """Scope diagnostic task identity without affecting retrieval authorization."""
    token = _task_id.set(task_id)
    try:
        yield
    finally:
        _task_id.reset(token)


@contextmanager
def knowledge_context(knowledge_id: str) -> Iterator[None]:
    """Keep each knowledge base distinct across concurrent worker threads."""
    token = _knowledge_id.set(knowledge_id)
    try:
        yield
    finally:
        _knowledge_id.reset(token)


def log_timing(
    stage: str, event: str, *, level: int = logging.INFO, **fields: object
) -> None:
    """Log only caller-supplied diagnostic metadata, never exception messages."""
    logger.log(
        level,
        "[KnowledgeTiming] request_id=%s kb_id=%s stage=%s event=%s task_id=%s %s",
        get_request_id() or "-",
        _knowledge_id.get() or "-",
        stage,
        event,
        _task_id.get() if _task_id.get() is not None else "-",
        " ".join(f"{key}={value}" for key, value in fields.items()),
    )


@contextmanager
def timed_stage(
    stage: str, *, level: int = logging.INFO, **fields: object
) -> Iterator[None]:
    """Expose stage entry and elapsed time, including failures and cancellation."""
    started = perf_counter()
    log_timing(stage, "start", level=logging.DEBUG, **fields)
    try:
        yield
    except BaseException as exc:
        log_timing(
            stage,
            "error",
            level=logging.ERROR,
            **fields,
            duration_ms=round((perf_counter() - started) * 1000, 2),
            error_type=type(exc).__name__,
        )
        raise
    else:
        log_timing(
            stage,
            "end",
            level=level,
            **fields,
            duration_ms=round((perf_counter() - started) * 1000, 2),
        )
