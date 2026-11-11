"""Non-secret evidence for rejected execution-environment selections."""

import json
import logging

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, ProjectChatAgent
from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.schemas.runner_routing import ExecutionPolicy
from app.services.device.runtime_route import runtime_device_route_id
from app.services.workspaces.storage import workspace_id_for_project

logger = logging.getLogger(__name__)


def log_environment_denial(
    db: Session,
    *,
    project_id: str,
    user_id: int,
    agent_id: str | None,
    policy: ExecutionPolicy,
    authorized_ids: set[int],
    phase: str = "execution",
) -> None:
    """Read raw grants only on denial, including rejected roles and statuses."""
    workspace_id = workspace_id_for_project(db, project_id)
    scopes = [
        (ResourceMember.entity_type == "project")
        & (ResourceMember.entity_id == project_id)
    ]
    if workspace_id is not None:
        scopes.append(
            (ResourceMember.entity_type == "workspace")
            & (ResourceMember.entity_id == str(workspace_id))
        )
    grants = (
        db.query(ResourceMember)
        .filter(ResourceMember.resource_type == "Device", or_(*scopes))
        .order_by(ResourceMember.id)
        .all()
    )
    device_ids = authorized_ids | {grant.resource_id for grant in grants}
    if policy.mode == "fixed":
        device_ids.add(int(policy.environment_id))
    agent = db.get(ProjectChatAgent, agent_id) if agent_id else None
    project = db.get(CloudProject, project_id)
    evidence = {
        "event": "runner_environment_denied",
        "phase": phase,
        "project_id": project_id,
        "workspace_id": workspace_id,
        "user_id": user_id,
        "agent_id": agent_id,
        "agent_device_id": agent.device_id if agent else None,
        "agent_authorization_version": (
            (agent.metadata_json or {}).get("authorization_version") if agent else None
        ),
        "legacy_device_revocations": (
            (project.metadata_json or {}).get("legacy_device_revocations", [])
            if project
            else []
        ),
        "execution_policy": policy.model_dump(exclude_none=True),
        "authorized_environment_ids": sorted(authorized_ids),
        "grants": [
            {
                "id": grant.id,
                "device_id": grant.resource_id,
                "scope": grant.entity_type,
                "scope_id": grant.entity_id,
                "role": grant.role,
                "status": grant.status,
            }
            for grant in grants
        ],
        "devices": [
            {
                "id": device.id,
                "name": device.name,
                "device_key": (
                    runtime_device_route_id(device)
                    if isinstance(device.json, dict)
                    and isinstance(device.json.get("spec", {}), dict)
                    else None
                ),
                "kind": device.kind,
                "namespace": device.namespace,
                "is_active": device.is_active,
                "owner_user_id": device.user_id,
            }
            for device in db.query(Kind)
            .filter(Kind.id.in_(device_ids))
            .order_by(Kind.id)
        ],
    }
    logger.warning("Runner routing denial: %s", json.dumps(evidence, sort_keys=True))
