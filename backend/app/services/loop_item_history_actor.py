"""Automation attribution for Issue history, independent of authorization identity."""

from typing import Any


def automation_history_actor(context: dict[str, Any] | None) -> dict[str, Any]:
    """Snapshot the rule that caused an operation without replacing its user."""
    if not context or not context.get("rule_id") or not context.get("run_id"):
        return {}
    return {
        "automation": {
            "rule_id": str(context["rule_id"]),
            "rule_name": str(context.get("rule_name") or context["rule_id"]),
            "run_id": str(context["run_id"]),
        }
    }
