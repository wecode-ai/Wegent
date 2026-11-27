"""Assignment candidates collected within an already-authorized project Session."""

from typing import Any

from sqlalchemy.orm import Session

from app.models.delivery import CloudProject
from app.services.cloud_projects.service import cloud_project_service
from app.services.project_chat.service import project_chat_service
from app.services.workspaces.service import workspace_service
from app.services.workspaces.storage import workspace_id_for_project


def read(db: Session, project: CloudProject, user_id: int) -> dict[str, Any]:
    """Read candidate values without opening a second database Session."""
    members = cloud_project_service.list_members(db, project.id, user_id)
    robots = project_chat_service.list_agents(
        db, user_id=user_id, project_id=str(project.id)
    )
    teams = (
        workspace_service.list_project_collaboration_groups(db, project.id, user_id)
        if workspace_id_for_project(db, project.id) is not None
        else []
    )
    return {
        "members": [
            {
                "id": value["user_id"],
                "name": value["user_name"],
                "role": value["role"],
                "capability": value.get("capability_description") or "",
            }
            for value in members
        ],
        "robots": [
            {
                "id": robot.id,
                "name": robot.name or "AI",
                "runtime": robot.runtime,
                "capability": robot.capability_description or "",
            }
            for robot in robots
        ],
        "groups": [
            {
                "id": team["id"],
                "name": team["name"],
                "capability": team.get("description") or "",
            }
            for team in teams
        ],
    }
