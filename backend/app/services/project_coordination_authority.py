"""Current binding authority for project coordination, independent of caller snapshots."""

from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.loop_item_execution import LoopItemExecution
from app.services.device.identity import resolve_owned_device_alias
from app.services.device.runtime_route import runtime_device_route_id


def coordination_scope(
    db: Session, execution: LoopItemExecution
) -> dict[str, Any] | None:
    context = execution.runtime_origin_context
    parent_id = context.get("collaboration_dispatch_execution_id")
    parent_scope = None
    if parent_id:
        parent = db.get(LoopItemExecution, parent_id)
        if (
            parent is None
            or parent.cloud_project_id != execution.cloud_project_id
            or parent.loop_item_id != execution.loop_item_id
            or parent.executor_type != "collaboration_group_dispatch"
        ):
            raise HTTPException(
                403, "The original collaboration dispatch is unavailable"
            )
        parent_scope = parent.runtime_origin_context.get("project_coordination")
        if "project_coordination" in parent.runtime_origin_context and not isinstance(
            parent_scope, dict
        ):
            raise HTTPException(403, "The original coordination scope is invalid")
    scope = context.get("project_coordination", parent_scope)
    if scope is None and "project_coordination" not in context:
        return None
    if not isinstance(scope, dict) or parent_scope and scope != parent_scope:
        raise HTTPException(403, "Project coordination context is invalid")
    return scope


def binding_matches(binding: Any, scope: dict[str, Any], actor: int) -> bool:
    return (
        isinstance(binding, dict)
        and binding.get("enabled") is True
        and type(binding.get("userId")) is int
        and binding["userId"] == actor
        and type(scope.get("userId")) is int
        and scope["userId"] == actor
        and all(
            isinstance(scope.get(key), str)
            and bool(scope[key])
            and binding.get(key) == scope[key]
            for key in ("deviceId", "generation")
        )
    )


def require_binding(
    db: Session, execution: LoopItemExecution, scope: dict[str, Any]
) -> None:
    from app.schemas.base_role import BaseRole
    from app.services.cloud_projects.access import require_cloud_project_role

    if (
        scope.get("projectId") != execution.cloud_project_id
        or not isinstance(scope.get("groupId"), str)
        or not scope["groupId"]
    ):
        raise HTTPException(403, "Project coordination scope is invalid")
    access = require_cloud_project_role(
        db,
        execution.cloud_project_id,
        execution.assigner_user_id,
        BaseRole.Developer,
    )
    bindings = (access.project.metadata_json or {}).get("projectCoordination") or {}
    binding = bindings.get(scope["groupId"]) if isinstance(bindings, dict) else None
    if not binding_matches(binding, scope, execution.assigner_user_id):
        raise HTTPException(
            403, "Project coordination binding is revoked or superseded"
        )
    device = resolve_owned_device_alias(
        db, user_id=execution.assigner_user_id, device_id=scope["deviceId"]
    )
    if device is None or runtime_device_route_id(device) != scope["deviceId"]:
        raise HTTPException(403, "Project coordination device is unavailable")
