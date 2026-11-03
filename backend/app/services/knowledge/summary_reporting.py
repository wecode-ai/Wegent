"""Content-free summary facts at the existing persistence/decision points."""

from typing import Any

from shared.event_reporting import is_event_reporting_enabled
from shared.event_reporting.catalogs.knowledge import observe


def report_summary_state(
    state: dict[str, Any] | None,
    *,
    kb_id: int | None = None,
    document_id: int | None = None,
) -> None:
    if not is_event_reporting_enabled() or not state:
        return
    if state.get("status") not in {"completed", "failed", "skipped"}:
        return
    observe(
        "knowledge.summary.attempt.finished",
        lambda: {
            "kb_id": kb_id,
            "document_id": document_id,
            "status": state["status"],
            "data": {
                "task_id": state.get("task_id"),
                "target_kind": (
                    "document" if document_id is not None else "knowledge_base"
                ),
                "reason": state.get("reason"),
            },
        },
    )
