"""Project definition editing is distinct from shared resource ownership."""

from sqlalchemy.orm import Session

from app.models.delivery import ProjectChatAgent
from app.schemas.base_role import BaseRole, has_permission
from app.services.cloud_projects.access import CloudProjectAccess
from app.services.collaboration_permissions import (
    collaboration_permission_service,
    project_agent_visible,
)


def can_edit_project_definition(
    db: Session,
    agent: ProjectChatAgent,
    user_id: int,
    access: CloudProjectAccess | None = None,
) -> bool:
    """Only current project administrators may edit visible inline definitions."""
    if (agent.metadata_json or {}).get("wegent_team_id") is not None:
        return False
    if not project_agent_visible(agent, user_id):
        return False
    if access is not None:
        if access.project.id != agent.cloud_project_id:
            raise ValueError("Agent must belong to the authorized project")
        return has_permission(access.role, BaseRole.Maintainer)
    return collaboration_permission_service.check(
        db, user_id, "manage", agent.cloud_project_id
    ).allowed


def preserve_redacted_mcp_servers(
    existing: dict, submitted: dict, *, is_creator: bool
) -> dict:
    """Saving another field must not replace hidden MCP configuration with {}."""
    if is_creator:
        return submitted
    return {
        name: existing.get(name, {}) if configuration == {} else configuration
        for name, configuration in submitted.items()
    }
