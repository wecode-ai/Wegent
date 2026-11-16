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
from shared.event_reporting.dimensions import ActorDimensions, resolve_actor_dimensions
from shared.event_reporting.reporter import is_event_reporting_enabled
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
    actor_dimensions: ActorDimensions | None = None


def _actor_fields(usage: UsageContext) -> dict[str, str]:
    dimensions = usage.actor_dimensions
    if dimensions is None or dimensions.org_id is None:
        return {}
    fields = {"actor_org_id": dimensions.org_id}
    if dimensions.org_version is not None:
        fields["actor_org_version"] = dimensions.org_version
    return fields


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
            **_actor_fields(usage),
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
                "status": _outcome_status(error),
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
                "status": _outcome_status(error),
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


def _create_usage_context(
    entrypoint: str,
    client_surface: str | None,
    actor_user_id: int | None,
    actor_type: str,
    task_id: int | None,
    subtask_id: int | None,
    invocation_id: str | None,
) -> UsageContext:
    actor_dimensions = None
    if actor_type == "user" and is_event_reporting_enabled():
        actor_dimensions = resolve_actor_dimensions(actor_user_id)
    resolved_client_surface = client_surface or {
        "chat": "chat_shell",
        "mcp": "mcp",
        "openapi": "external_api",
    }.get(entrypoint, "unknown")
    return UsageContext(
        invocation_id=invocation_id or str(uuid4()),
        actor_user_id=actor_user_id,
        actor_type=actor_type,
        entrypoint=entrypoint,
        client_surface=resolved_client_surface,
        task_id=task_id,
        subtask_id=subtask_id,
        actor_dimensions=actor_dimensions,
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
    if current_usage_context() is not None:
        return await execute()

    usage = _create_usage_context(
        entrypoint,
        client_surface,
        actor_user_id,
        actor_type,
        task_id,
        subtask_id,
        invocation_id,
    )
    token = _usage_context.set(usage)
    result = None
    error = None
    try:
        result = await execute()
        records = loaded_scalar(result, "records")
        if loaded_scalar(result, "mode") == "mixed_restricted_retrieval":
            records = loaded_scalar(result, "external_records")
        if isinstance(records, (list, tuple)):
            report_document_usage_for_result(records)
        return result
    except (Exception, asyncio.CancelledError) as exc:
        error = exc
        raise
    finally:
        try:
            _report_retrieval_finished(
                usage,
                requested_kb_ids,
                effective_kb_ids,
                route_mode,
                restricted_mode,
                result,
                error,
            )
        except Exception:
            pass
        finally:
            _usage_context.reset(token)


def _outcome_status(error: BaseException | None) -> str:
    if isinstance(error, asyncio.CancelledError):
        return "cancelled"
    return "failure" if error is not None else "success"


def _report_retrieval_finished(
    usage: UsageContext,
    requested_kb_ids: list[int],
    effective_kb_ids: list[int],
    route_mode: str,
    restricted_mode: bool,
    result: object,
    error: BaseException | None,
) -> None:
    observe(
        "knowledge.retrieval.request.finished",
        lambda: {
            "status": _outcome_status(error),
            "error_code": error_code_for(error) if error is not None else None,
            "data": {
                "request_id": get_request_id(),
                "invocation_id": usage.invocation_id,
                "actor_user_id": usage.actor_user_id,
                "actor_type": usage.actor_type,
                "entrypoint": usage.entrypoint,
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
                **_actor_fields(usage),
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
            **_actor_fields(usage),
        )
