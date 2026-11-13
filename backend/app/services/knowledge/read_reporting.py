"""Content-free facts from the original per-document response."""

from contextvars import ContextVar
from functools import wraps
from inspect import signature
from typing import Any, Callable, ParamSpec, Protocol, TypeVar

from shared.event_reporting.catalogs.knowledge import observe

suppressed_read_events: ContextVar[bool] = ContextVar(
    "suppressed_read_events", default=False
)
P = ParamSpec("P")


class _DocumentReadResult(Protocol):
    document_id: int

    def model_dump(self) -> dict[str, Any]: ...


R = TypeVar("R", bound=_DocumentReadResult)


def report_single_read(function: Callable[P, R]) -> Callable[P, R]:
    """Report a single read after its complete response has been validated."""
    call_signature = signature(function)

    @wraps(function)
    def wrapped(*args: P.args, **kwargs: P.kwargs) -> R:
        arguments = call_signature.bind(*args, **kwargs).arguments
        try:
            user_id = getattr(arguments["user"], "id", None)
        except Exception:
            user_id = None
        event_result = {
            "id": arguments["document_id"],
            "error_code": "DOCUMENT_READ_FAILED",
        }
        token = suppressed_read_events.set(True)
        try:
            result = function(*args, **kwargs)
            try:
                event_result = {**result.model_dump(), "id": result.document_id}
            except Exception:
                pass
            return result
        finally:
            suppressed_read_events.reset(token)
            try:
                report_read(
                    event_result,
                    user_id=user_id,
                    actor_user_id=user_id,
                    subtask_id=None,
                    entrypoint=arguments.get("entrypoint"),
                )
            except Exception:
                pass

    return wrapped


def report_read(
    result: dict[str, Any],
    *,
    user_id: int | None,
    subtask_id: int | None,
    entrypoint: str | None,
    task_id: int | None = None,
    actor_user_id: int | None = None,
    invocation_id: str | None = None,
) -> None:
    if suppressed_read_events.get():
        return
    observe(
        "knowledge.document.read.finished",
        lambda: {
            "document_id": result.get("id"),
            "kb_id": result.get("kb_id"),
            "status": "failed" if result.get("error_code") else "success",
            "error_code": result.get("error_code"),
            "data": {
                "stage": "content_delivery",
                "entrypoint": entrypoint,
                "user_id": user_id,
                "effective_reader_id": user_id,
                "actor_user_id": actor_user_id,
                "task_id": task_id,
                "invocation_id": invocation_id,
                "subtask_id": subtask_id,
                "offset": result.get("offset"),
                "returned_length": result.get("returned_length"),
                "total_length": result.get("total_length"),
                "has_more": result.get("has_more"),
            },
        },
    )
