"""Public routing diagnostics contain identities and reasons, never credentials."""

import json
import logging
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import ProjectChatAgent
from app.models.kind import Kind

logger = logging.getLogger(__name__)

DIAGNOSTIC_CODES = {
    "ISSUE_RUNNER_CONFLICT",
    "ISSUE_RUNNER_CONFIGURATION_REQUIRED",
    "RUNNER_ENVIRONMENT_UNAVAILABLE",
}


def _environment_identity(
    db: Session, environment_id: str | None, visible: set[int]
) -> dict | None:
    if not environment_id:
        return None
    device = (
        db.get(Kind, int(environment_id)) if int(environment_id) in visible else None
    )
    spec = (
        (device.json or {}).get("spec")
        if device and isinstance(device.json, dict)
        else None
    )
    name = spec.get("displayName") if isinstance(spec, dict) else None
    return {"id": environment_id, "name": (name or device.name) if device else None}


def _denial_reason(
    db: Session,
    project_id: str,
    bound: str | None,
    fixed: str | None,
    allowed: set[int],
    code: str,
) -> str:
    from app.services.runner_routing import active_device, device_grants
    from app.services.workspaces.storage import workspace_id_for_project

    if code == "ISSUE_RUNNER_CONFIGURATION_REQUIRED":
        return "history_requires_configuration"
    target = bound or fixed
    if not target:
        return (
            "no_authorized_environment"
            if code == "RUNNER_ENVIRONMENT_UNAVAILABLE"
            else "history_requires_configuration"
        )
    if bound and fixed and bound != fixed:
        return "policy_mismatch"
    if int(target) not in allowed:
        workspace_id = workspace_id_for_project(db, project_id)
        workspace_granted = workspace_id is not None and int(target) in device_grants(
            db, "workspace", str(workspace_id)
        )
        return (
            "project_authorization_missing"
            if workspace_granted
            else "workspace_authorization_missing"
        )
    if active_device(db, target) is None:
        return "environment_unavailable"
    return "policy_mismatch"


def attach_routing_context(db: Session, error: HTTPException, **kwargs: Any) -> None:
    """Explain the selected policy and the exact failed authorization boundary."""
    from app.services.runner_routing import (
        execution_environment_ids,
        issue_binding,
        visible_environment_ids,
    )

    if not isinstance(error.detail, dict):
        return
    if error.detail.get("error_code") not in DIAGNOSTIC_CODES:
        return
    project_id, user_id = kwargs["project_id"], kwargs["user_id"]
    policy = kwargs["config"].get("execution_policy") or {}
    selection = kwargs.get("selection") or {}
    if policy.get("mode") == "user_select":
        policy = selection.get("execution_policy") or policy
    try:
        bound = issue_binding(db, kwargs["issue_id"])
    except HTTPException:
        bound = None
    allowed = execution_environment_ids(db, project_id, kwargs.get("agent_id"))
    visible = visible_environment_ids(db, user_id, project_id)

    fixed = policy.get("environment_id") if policy.get("mode") == "fixed" else None
    agent = (
        db.get(ProjectChatAgent, kwargs.get("agent_id"))
        if kwargs.get("agent_id")
        else None
    )
    context = {
        "issue_id": kwargs["issue_id"],
        "agent_id": kwargs.get("agent_id"),
        "agent_name": (
            agent.name if agent and agent.cloud_project_id == project_id else None
        ),
        "reason": _denial_reason(
            db, project_id, bound, fixed, allowed, error.detail["error_code"]
        ),
        "execution_policy": policy,
        "bound_environment": _environment_identity(db, bound, visible),
        "policy_environment": _environment_identity(db, fixed, visible),
        "authorized_environments": [
            _environment_identity(db, str(value), visible) for value in sorted(allowed)
        ],
    }
    error.detail["routing_context"] = context
    logger.warning("Runner selection denied: %s", json.dumps(context, sort_keys=True))
