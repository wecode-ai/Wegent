"""Wiki request outcomes and bounded facts at existing transaction seams."""

import asyncio
from contextvars import ContextVar
from functools import wraps
from inspect import signature
from typing import Any, Callable

from sqlalchemy.orm import Session

from app.services.knowledge.event_logging import FactSnapshot, emit_fact_snapshots
from shared.event_reporting import is_event_reporting_enabled
from shared.event_reporting.catalogs.knowledge import loaded_scalar, observe

_context = ContextVar("wiki_fact_context", default=None)
_BINDING = "knowledge.wiki.binding.changed"


def wiki_stage(
    stage: str, *, connector_type: str | None = None, reason: str | None = None
) -> None:
    state = _context.get()
    if state is not None:
        state.update(stage=stage, connector_type=connector_type, reason=reason)


def wiki_request(action: str) -> Callable:
    def decorate(function):
        call_signature = signature(function, eval_str=True)
        event = (
            "knowledge.wiki.connection_test.finished"
            if action == "test"
            else "knowledge.wiki.binding.request.finished"
        )

        @wraps(function)
        async def wrapped(*args, **kwargs):
            if not is_event_reporting_enabled(event) and not (
                action != "test" and is_event_reporting_enabled(_BINDING)
            ):
                return await function(*args, **kwargs)
            arguments = call_signature.bind(*args, **kwargs).arguments
            body = arguments.get("body")
            state = {
                "action": action,
                "stage": "validation",
                "connection_id": loaded_scalar(body, "connection_id"),
                "kb_id": arguments.get("knowledge_base_id"),
                "document_id": arguments.get("document_id"),
                "remaining": 128,
            }
            token = _context.set(state)
            result = error = None
            try:
                result = await function(*args, **kwargs)
                return result
            except BaseException as exc:
                error = exc
                raise
            finally:
                _context.reset(token)
                observe(event, lambda: _request_fields(state, result, error))

        wrapped.__signature__ = call_signature
        return wrapped

    return decorate


def _request_fields(
    state: dict[str, Any], result: object, error: BaseException | None
) -> dict[str, Any]:
    ok = loaded_scalar(result, "ok")
    return {
        "kb_id": state.get("kb_id"),
        "document_id": state.get("document_id"),
        "status": (
            "cancelled"
            if isinstance(error, asyncio.CancelledError)
            else "failed" if error is not None or ok is False else "success"
        ),
        "error_code": type(error).__name__ if error is not None else None,
        "data": {
            "action": state["action"],
            "stage": state["stage"],
            "connection_id": state.get("connection_id"),
            "connector_type": state.get("connector_type"),
            "reason_code": state.get("reason"),
            "ok": ok,
            "version": loaded_scalar(result, "version"),
        },
    }


def binding_fact(
    db: Session, document: object, decision: str, *, committed: bool = False
) -> FactSnapshot | None:
    """Only Wiki entrypoints activate this context; never inspect external metadata."""
    try:
        state = _context.get()
        if (
            state is None
            or state["action"] == "test"
            or state["remaining"] <= 0
            or not is_event_reporting_enabled(_BINDING)
        ):
            return None
        state["remaining"] -= 1
        fields = {
            "kb_id": loaded_scalar(document, "kind_id"),
            "document_id": loaded_scalar(document, "id"),
            "status": "success",
            "data": {
                "connection_id": state.get("connection_id"),
                "action": state["action"],
                "decision": decision,
                "stage": "committed" if committed else "decision",
            },
        }
        if committed:
            return (_BINDING, fields)
        else:
            observe(_BINDING, lambda: fields)
    except Exception:
        return None
    return None


def emit_binding_snapshot(snapshot: FactSnapshot | None) -> None:
    """Emit a binding fact only after the caller's database commit succeeds."""
    if snapshot is not None:
        emit_fact_snapshots((snapshot,))
