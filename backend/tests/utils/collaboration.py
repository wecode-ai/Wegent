"""Build explicit collaboration relationships for service-level fixtures."""

import uuid

from sqlalchemy.orm import Session

from app.models.delivery import CloudProject
from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.services.workspaces.storage import workspace_kind_payload


def authorize_project(db: Session, project: CloudProject) -> Kind:
    """Give a fixture one real parent and an explicit creator admin grant."""
    space = Kind(
        kind="CollaborationWorkspace",
        name=f"fixture-{uuid.uuid4().hex}",
        namespace="default",
        user_id=project.created_by_user_id,
        is_active=True,
        json=workspace_kind_payload(
            name="Fixture",
            description="",
            namespace="default",
            public_id=str(uuid.uuid4()),
            is_default=False,
            created_by_user_id=project.created_by_user_id,
        ),
    )
    db.add(space)
    db.flush()
    project.membership_mode = "inherit"
    db.add(project)
    db.flush()
    db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=int(project.id),
            entity_type="workspace",
            entity_id=str(space.id),
            role="Owner",
            status="approved",
        )
    )
    db.flush()
    db.refresh(project)
    db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=int(project.id),
            entity_id=str(project.created_by_user_id),
            role="Maintainer",
            status="approved",
        )
    )
    db.flush()
    return space


def authorize_resource(db: Session, project: CloudProject, resource: Kind) -> None:
    """Share a resource to the parent and enable devices in the project."""
    scopes = [("workspace", str(project.workspace_id))]
    if resource.kind == "Device":
        scopes.append(("project", str(project.id)))
    for entity_type, entity_id in scopes:
        existing = (
            db.query(ResourceMember)
            .filter_by(
                resource_type=resource.kind,
                resource_id=resource.id,
                entity_type=entity_type,
                entity_id=entity_id,
            )
            .first()
        )
        if existing is None:
            db.add(
                ResourceMember.create(
                    resource_type=resource.kind,
                    resource_id=resource.id,
                    entity_type=entity_type,
                    entity_id=entity_id,
                    role="Developer",
                    status="approved",
                )
            )
    db.flush()


def authorize_project_agent(db: Session, agent) -> None:
    """Explicitly share an inline fixture definition with its parent space."""
    agent.metadata_json = {**(agent.metadata_json or {}), "authorization_version": 2}
    db.add(agent)
    db.flush()
    if (agent.metadata_json or {}).get("wegent_team_id"):
        return
    project = db.get(CloudProject, str(agent.cloud_project_id))
    db.add(
        ResourceMember.create(
            resource_type="Workspace",
            resource_id=project.workspace_id,
            entity_type="project_agent",
            entity_id=agent.id,
            role="Developer",
            status="approved",
        )
    )
    db.flush()
