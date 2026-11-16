"""Observe logical operations without inspecting their inputs or result bodies."""

import asyncio
import time
from contextvars import ContextVar
from datetime import datetime, timezone
from functools import wraps
from inspect import iscoroutinefunction, signature
from typing import Any, Callable, TypeVar, cast
from uuid import uuid4

from .catalogs.knowledge._common import loaded_scalar, observe
from .reporter import is_event_reporting_enabled

_active = ContextVar("knowledge_observed_operations", default=frozenset())
_identity = ContextVar("knowledge_operation_identity", default=(None, None))
F = TypeVar("F", bound=Callable[..., Any])


def operation_fact(
    event_type: str,
    *,
    operation: str,
    data_factory: Callable[[tuple[Any, ...], dict[str, Any]], dict[str, Any]] = (
        lambda args, kwargs: {}
    ),
) -> Callable[[F], F]:
    """One fact per logical call, including retries; nested same-kind calls coalesce."""

    def decorate(function: F) -> F:
        parameters = tuple(signature(function).parameters)

        def argument(args, kwargs, name):
            if name in kwargs:
                return kwargs[name]
            if name in parameters:
                index = parameters.index(name)
                if index < len(args):
                    return args[index]
            return None

        def finish(args, kwargs, result, error, identity, parent, started, started_at):
            def fields():
                return {
                    "kb_id": identity[0],
                    "status": (
                        "cancelled"
                        if isinstance(error, asyncio.CancelledError)
                        else "success" if error is None else "failed"
                    ),
                    "error_code": type(error).__name__ if error is not None else None,
                    # Monotonic elapsed; wall-clock data.started_at/finished_at
                    # stay informative but must not be subtracted for duration.
                    "duration_ms": max(
                        0, round((time.perf_counter() - started) * 1000)
                    ),
                    "data": {
                        "operation": operation,
                        "stage": "logical_call",
                        "result_status": loaded_scalar(result, "status"),
                        "result_count": loaded_scalar(result, "total"),
                        "indexed_count": loaded_scalar(result, "indexed_count"),
                        "deleted_chunks": loaded_scalar(result, "deleted_chunks"),
                        "document_ref": argument(args, kwargs, "doc_ref")
                        or loaded_scalar(
                            argument(args, kwargs, "chunk_metadata"), "doc_ref"
                        ),
                        "operation_id": identity[1],
                        "parent_operation_id": parent[1],
                        "started_at": started_at,
                        "finished_at": datetime.now(timezone.utc).isoformat(),
                        **data_factory(args, kwargs),
                    },
                }

            try:
                observe(event_type, fields)
            except Exception:
                pass

        def start(args, kwargs):
            try:
                if (
                    not is_event_reporting_enabled(event_type)
                    or event_type in _active.get()
                ):
                    return None
                parent = _identity.get()
                kb_id = argument(args, kwargs, "knowledge_id")
                if kb_id is None:
                    kb_id = loaded_scalar(
                        argument(args, kwargs, "chunk_metadata"), "knowledge_id"
                    )
                identity = (kb_id if kb_id is not None else parent[0], str(uuid4()))
                return (
                    identity,
                    parent,
                    time.perf_counter(),
                    datetime.now(timezone.utc).isoformat(),
                )
            except Exception:
                return None

        @wraps(function)
        def sync(*args, **kwargs):
            state = start(args, kwargs)
            if state is None:
                return function(*args, **kwargs)
            identity, parent, started, started_at = state
            token = _active.set(_active.get() | {event_type})
            identity_token = _identity.set(identity)
            result = error = None
            try:
                result = function(*args, **kwargs)
                return result
            except BaseException as exc:
                error = exc
                raise
            finally:
                _active.reset(token)
                _identity.reset(identity_token)
                finish(
                    args, kwargs, result, error, identity, parent, started, started_at
                )

        @wraps(function)
        async def asynchronous(*args, **kwargs):
            state = start(args, kwargs)
            if state is None:
                return await function(*args, **kwargs)
            identity, parent, started, started_at = state
            token = _active.set(_active.get() | {event_type})
            identity_token = _identity.set(identity)
            result = error = None
            try:
                result = await function(*args, **kwargs)
                return result
            except BaseException as exc:
                error = exc
                raise
            finally:
                _active.reset(token)
                _identity.reset(identity_token)
                finish(
                    args, kwargs, result, error, identity, parent, started, started_at
                )

        return cast(F, asynchronous if iscoroutinefunction(function) else sync)

    return decorate


def embedding_fact(operation: str) -> Callable[[F], F]:
    return operation_fact(
        "knowledge.embedding.call.finished",
        operation=operation,
        data_factory=lambda args, kwargs: {
            "model_role": "embedding",
            "model_name": loaded_scalar(args[0], "model_name"),
        },
    )


def storage_fact(storage_type: str, operation: str) -> Callable[[F], F]:
    return operation_fact(
        "knowledge.storage.operation.finished",
        operation=operation,
        data_factory=lambda args, kwargs: {"storage_type": storage_type},
    )
