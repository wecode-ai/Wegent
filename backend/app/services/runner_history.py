"""Interpret explicit historical runner configuration without database upgrades."""

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, LoopItemTaskBinding
from app.models.loop_item_execution import LoopItemExecution
from app.services.device.identity import resolve_owned_device_alias


def historical_issue_binding(db: Session, issue: LoopItem) -> str | None:
    """Resolve an unambiguous historical runner, preserving aliases and owners."""
    from app.services.runner_routing import routing_error

    metadata = issue.metadata_json or {}
    if metadata.get("runner_binding_conflict"):
        raise routing_error(
            "ISSUE_RUNNER_CONFIGURATION_REQUIRED",
            "Historical executions used conflicting or unavailable runners; review the Issue binding",
        )
    binding = metadata.get("runner_binding")
    if binding is not None:
        identity = (
            str(binding.get("environment_id", "")) if isinstance(binding, dict) else ""
        )
        if identity.isdecimal() and int(identity) > 0:
            return identity
        raise routing_error(
            "ISSUE_RUNNER_CONFIGURATION_REQUIRED", "Invalid Issue runner binding"
        )

    history = (
        db.query(
            LoopItemExecution.executor_owner_user_id,
            LoopItemExecution.runtime_device_id,
        )
        .filter(
            LoopItemExecution.loop_item_id == issue.id,
            LoopItemExecution.runtime_device_id != "",
        )
        .distinct()
        .all()
    )
    history += (
        db.query(LoopItemTaskBinding.task_user_id, LoopItemTaskBinding.device_id)
        .filter(
            LoopItemTaskBinding.loop_item_id == issue.id,
            LoopItemTaskBinding.device_id.is_not(None),
            LoopItemTaskBinding.device_id != "",
        )
        .distinct()
        .all()
    )
    identities: set[str] = set()
    for owner_id, alias in history:
        device = resolve_owned_device_alias(db, user_id=owner_id or 0, device_id=alias)
        identities.add(str(device.id) if device else f"unresolved:{owner_id}:{alias}")
    if not identities:
        return None
    if len(identities) == 1 and not next(iter(identities)).startswith("unresolved:"):
        return next(iter(identities))
    raise routing_error(
        "ISSUE_RUNNER_CONFIGURATION_REQUIRED",
        "Historical executions used conflicting or unavailable runners; review the Issue binding",
    )
