# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Record existing request/execution facts without inspecting retrieved content.

result_count copies the response's original total (for merged queries, before
max_results truncation). total_estimated_tokens is the original content-length
estimate, never provider usage. Neither field measures relevance or correctness.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Iterable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import TypeVar
from uuid import uuid4

from app.services.rag.runtime_specs import IndexRuntimeSpec, QueryRuntimeSpec
from shared.event_reporting.catalogs.knowledge import (
    error_code_for,
    loaded_scalar,
    observe,
    report_document_usage,
    report_kb_usage,
)
from shared.telemetry.context import get_request_id

T = TypeVar("T")


@dataclass(frozen=True)
class IndexExecutionContext:
    trigger: str = "unknown"
    generation: int | None = None
    attempt: int | None = None
    retry_scheduled: bool = False


_index_execution_context: ContextVar[IndexExecutionContext] = ContextVar(
    "index_execution_context", default=IndexExecutionContext()
)


@dataclass(frozen=True)
class UsageContext:
    invocation_id: str
    actor_user_id: int | None
    actor_type: str
    entrypoint: str
    client_surface: str
    task_id: int | None = None
    subtask_id: int | None = None


_usage_context: ContextVar[UsageContext | None] = ContextVar(
    "knowledge_usage_context", default=None
)


def current_usage_context() -> UsageContext | None:
    """Return the logical usage identity for the current retrieval call."""
    return _usage_context.get()


def report_document_usage_for_result(records: Iterable[object]) -> None:
    """Record selected documents without allowing telemetry to affect retrieval."""
    usage = current_usage_context()
    if usage is None:
        return
    try:
        report_document_usage(
            records,
            invocation_id=usage.invocation_id,
            actor_user_id=usage.actor_user_id,
            actor_type=usage.actor_type,
            entrypoint=usage.entrypoint,
            client_surface=usage.client_surface,
            task_id=usage.task_id,
            subtask_id=usage.subtask_id,
        )
    except Exception:
        pass


@contextmanager
def index_execution_context(
    *,
    trigger: str,
    generation: int | None,
    attempt: int | None,
    retry_scheduled: bool,
) -> Iterator[None]:
    token = _index_execution_context.set(
        IndexExecutionContext(trigger, generation, attempt, retry_scheduled)
    )
    try:
        yield
    finally:
        _index_execution_context.reset(token)


async def report_index_execution(
    *,
    execution_mode: str,
    spec: IndexRuntimeSpec,
    execute: Callable[[], Awaitable[dict]],
) -> dict:
    result = None
    error = None
    try:
        result = await execute()
        return result
    except (Exception, asyncio.CancelledError) as exc:
        error = exc
        raise
    finally:
        observe(
            "knowledge.index.execution.finished",
            lambda: {
                "kb_id": spec.knowledge_base_id,
                "document_id": spec.document_id,
                "status": "failure" if error is not None else "success",
                "error_code": error_code_for(error) if error is not None else None,
                "data": {
                    "execution_mode": execution_mode,
                    "request_id": get_request_id(),
                    "chunk_count": loaded_scalar(result, "indexed_count"),
                    **vars(_index_execution_context.get()),
                },
            },
        )


async def report_query_execution(
    *,
    execution_mode: str,
    spec: QueryRuntimeSpec,
    execute: Callable[[], Awaitable[dict]],
) -> dict:
    if spec.route_mode == "direct_injection":
        return await execute()
    result = None
    error = None
    try:
        result = await execute()
        return result
    except (Exception, asyncio.CancelledError) as exc:
        error = exc
        raise
    finally:
        usage = current_usage_context()
        observe(
            "knowledge.retrieval.execution.finished",
            lambda: {
                "status": "failure" if error is not None else "success",
                "error_code": error_code_for(error) if error is not None else None,
                "data": {
                    "request_id": get_request_id(),
                    "invocation_id": usage.invocation_id if usage else None,
                    "knowledge_base_ids": spec.knowledge_base_ids,
                    "execution_mode": execution_mode,
                    "result_count": loaded_scalar(result, "total"),
                },
            },
        )


async def report_retrieval_request(
    *,
    entrypoint: str,
    requested_kb_ids: list[int],
    effective_kb_ids: list[int],
    route_mode: str,
    execute: Callable[[], Awaitable[T]],
    client_surface: str | None = None,
    restricted_mode: bool = False,
    actor_user_id: int | None = None,
    actor_type: str = "user",
    task_id: int | None = None,
    subtask_id: int | None = None,
    invocation_id: str | None = None,
) -> T:
    parent_usage = current_usage_context()
    resolved_client_surface = (
        client_surface
        or (parent_usage.client_surface if parent_usage else None)
        or {
            "chat": "chat_shell",
            "mcp": "mcp",
            "openapi": "external_api",
        }.get(entrypoint, "unknown")
    )
    usage = UsageContext(
        invocation_id=(
            invocation_id
            or (parent_usage.invocation_id if parent_usage else None)
            or str(uuid4())
        ),
        actor_user_id=(
            actor_user_id
            if actor_user_id is not None
            else (parent_usage.actor_user_id if parent_usage else None)
        ),
        actor_type=actor_type,
        entrypoint=entrypoint,
        client_surface=resolved_client_surface,
        task_id=(
            task_id
            if task_id is not None
            else (parent_usage.task_id if parent_usage else None)
        ),
        subtask_id=(
            subtask_id
            if subtask_id is not None
            else (parent_usage.subtask_id if parent_usage else None)
        ),
    )
    token = _usage_context.set(usage)
    result = None
    error = None
    try:
        result = await execute()
        if parent_usage is None:
            try:
                records = loaded_scalar(result, "records")
                if isinstance(records, (list, tuple)):
                    report_document_usage_for_result(records)
            except Exception:
                pass
        return result
    except (Exception, asyncio.CancelledError) as exc:
        error = exc
        raise
    finally:
        try:
            observe(
                "knowledge.retrieval.request.finished",
                lambda: {
                    "status": "failure" if error is not None else "success",
                    "error_code": error_code_for(error) if error is not None else None,
                    "data": {
                        "request_id": get_request_id(),
                        "invocation_id": usage.invocation_id,
                        "actor_user_id": usage.actor_user_id,
                        "actor_type": usage.actor_type,
                        "entrypoint": entrypoint,
                        "client_surface": usage.client_surface,
                        "task_id": usage.task_id,
                        "subtask_id": usage.subtask_id,
                        "requested_kb_ids": requested_kb_ids,
                        "knowledge_base_ids": effective_kb_ids,
                        "route_mode": loaded_scalar(result, "mode") or route_mode,
                        "restricted_mode": restricted_mode,
                        "result_count": loaded_scalar(result, "total"),
                        "total_estimated_tokens": loaded_scalar(
                            result, "total_estimated_tokens"
                        ),
                    },
                },
            )
            if error is None:
                report_kb_usage(
                    invocation_id=usage.invocation_id,
                    kb_ids=effective_kb_ids,
                    actor_user_id=usage.actor_user_id,
                    actor_type=usage.actor_type,
                    entrypoint=usage.entrypoint,
                    client_surface=usage.client_surface,
                    task_id=usage.task_id,
                    subtask_id=usage.subtask_id,
                )
        except Exception:
            pass
        finally:
            _usage_context.reset(token)
