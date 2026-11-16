# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared formatting helpers for subscription MCP tools."""

from typing import Any, Optional


def format_trigger_description(
    trigger_type: str, trigger_config: dict[str, Any]
) -> str:
    """Format a human-readable trigger description."""
    if trigger_type == "cron":
        expr = trigger_config.get("expression", "")
        tz = trigger_config.get("timezone", "UTC")
        return f"Cron表达式: `{expr}` (时区: {tz})"
    if trigger_type == "interval":
        value = trigger_config.get("value", 0)
        unit = trigger_config.get("unit", "")
        unit_zh = {"minutes": "分钟", "hours": "小时", "days": "天"}.get(unit, unit)
        return f"每 {value} {unit_zh}执行"
    if trigger_type == "one_time":
        execute_at = trigger_config.get("execute_at", "")
        tz = trigger_config.get("timezone", "UTC")
        return f"一次性执行于 {execute_at} (时区: {tz})"
    if trigger_type == "event":
        event_type = trigger_config.get("event_type", "event")
        return f"事件触发: {event_type}"
    return ""


def _isoformat(value: Any) -> Optional[str]:
    """Serialize an optional datetime-like value for MCP responses."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    isoformat = getattr(value, "isoformat", None)
    return isoformat() if callable(isoformat) else str(value)


def _enum_value(value: Any) -> Any:
    """Return an enum's value while allowing plain values in tests."""
    return value.value if hasattr(value, "value") else value


def _serialize_refs(values: Any) -> list[dict[str, Any]]:
    """Serialize optional pydantic reference lists without exposing extra fields."""
    if not values:
        return []
    return [
        value.model_dump(mode="json") if hasattr(value, "model_dump") else value
        for value in values
    ]


def serialize_subscription(
    subscription: Any,
    *,
    include_details: bool = False,
) -> dict[str, Any]:
    """Build a stable, client-safe subscription payload for MCP tools."""
    trigger_type = _enum_value(subscription.trigger_type)
    trigger_config = subscription.trigger_config or {}
    data = {
        "id": subscription.id,
        "name": subscription.name,
        "display_name": subscription.display_name,
        "description": subscription.description,
        "task_type": _enum_value(subscription.task_type),
        "trigger_type": trigger_type,
        "trigger_config": trigger_config,
        "trigger_summary": format_trigger_description(trigger_type, trigger_config),
        "team_id": subscription.team_id,
        "workspace_id": subscription.workspace_id or None,
        "model_ref": subscription.model_ref,
        "preserve_history": subscription.preserve_history,
        "history_message_count": subscription.history_message_count,
        "retry_count": subscription.retry_count,
        "timeout_seconds": subscription.timeout_seconds,
        "enabled": subscription.enabled,
        "is_active": True,
        "is_rental": subscription.is_rental,
        "next_execution_time": _isoformat(subscription.next_execution_time),
        "last_execution_time": _isoformat(subscription.last_execution_time),
        "last_execution_status": subscription.last_execution_status,
        "last_execution_message": subscription.last_execution_message,
        "execution_count": subscription.execution_count,
        "success_count": subscription.success_count,
        "failure_count": subscription.failure_count,
        "bound_task_id": subscription.bound_task_id or None,
        "expires_at": _isoformat(subscription.expires_at),
        "is_expired": subscription.is_expired,
        "trigger_config_valid": subscription.trigger_config_valid,
        "trigger_config_error": subscription.trigger_config_error,
        "created_at": _isoformat(subscription.created_at),
        "updated_at": _isoformat(subscription.updated_at),
        "management_url": f"/subscriptions/{subscription.id}",
    }
    if include_details:
        data.update(
            {
                "visibility": _enum_value(subscription.visibility),
                "prompt_template": subscription.prompt_template,
                "git_repo": subscription.git_repo,
                "git_domain": subscription.git_domain,
                "branch_name": subscription.branch_name,
                "knowledge_base_refs": _serialize_refs(
                    subscription.knowledge_base_refs
                ),
                "skill_refs": _serialize_refs(subscription.skill_refs),
                "source_subscription_id": subscription.source_subscription_id,
                "source_subscription_name": subscription.source_subscription_name,
                "source_subscription_display_name": (
                    subscription.source_subscription_display_name
                ),
                "source_owner_username": subscription.source_owner_username,
            }
        )
    return data
