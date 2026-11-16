"""Small scalar snapshots around the existing Code Wiki commits."""

from shared.event_reporting import is_event_reporting_enabled
from shared.event_reporting.catalogs.knowledge import loaded_scalar, observe


def generation_snapshot(generation: object) -> dict | None:
    if not is_event_reporting_enabled():
        return None
    return {
        "kb_id": loaded_scalar(generation, "kind_id"),
        "generation": loaded_scalar(generation, "id"),
        "generation_type": loaded_scalar(generation, "generation_type"),
    }


def report_generation(
    snapshot: dict | None,
    status: str,
    *,
    error_code: str | None = None,
    event_type: str = "knowledge.code_wiki.generation.finished",
    trigger: str | None = None,
) -> None:
    if snapshot is None:
        return
    observe(
        event_type,
        lambda: {
            "kb_id": snapshot["kb_id"],
            "status": status,
            "fact_key_parts": (snapshot["kb_id"], snapshot["generation"]),
            "error_code": error_code,
            "data": {
                "generation": snapshot["generation"],
                "generation_type": snapshot["generation_type"],
                "trigger": trigger,
            },
        },
    )
