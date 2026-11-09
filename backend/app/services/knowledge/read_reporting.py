"""Content-free facts from the original per-document response."""

from contextvars import ContextVar
from typing import Any

from shared.event_reporting.catalogs.knowledge import observe

suppressed_read_events: ContextVar[bool] = ContextVar(
    "suppressed_read_events", default=False
)


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
