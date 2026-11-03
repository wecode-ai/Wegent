"""Content-free facts from the original per-document response."""

from typing import Any

from shared.event_reporting.catalogs.knowledge import observe


def report_read(
    result: dict[str, Any],
    *,
    user_id: int | None,
    subtask_id: int | None,
    entrypoint: str | None,
) -> None:
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
                "subtask_id": subtask_id,
                "offset": result.get("offset"),
                "returned_length": result.get("returned_length"),
                "total_length": result.get("total_length"),
                "has_more": result.get("has_more"),
            },
        },
    )
