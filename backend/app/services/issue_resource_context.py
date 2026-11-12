"""Resolve an existing binding's source without changing its Thread work owner."""

from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    CollaborationChatGroup,
    LoopItem,
    ProjectChatAgent,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.schemas.base_role import BaseRole
from app.services.collaboration_container_access import (
    get_collaboration_container,
    require_collaboration_container_access,
)
from app.services.collaboration_permissions import collaboration_permission_service
from app.services.project_classification_access import require_classification_project
from app.services.thread_participation import require_thread_participation
from app.services.thread_project_links import linked_project_id


def require_resource_owner(
    db: Session,
    *,
    container_id: str,
    resource_owner_id: str,
    user_id: int,
    item: LoopItem | None = None,
    classification: CloudProject | None = None,
    execute: bool = False,
) -> str:
    """Authorize both owners; classification is a server-authorized create context."""
    from app.services.project_chat.group_message_authority import (
        prepare_group_message_authority,
    )

    prepare_group_message_authority(
        db,
        group_id=str(container_id),
        thread_id=str(item.id) if item else None,
        actor_user_id=user_id,
    )
    access = require_collaboration_container_access(
        db, container_id, user_id, BaseRole.Developer, write=True
    )
    if item is not None and str(item.cloud_project_id) != str(access.project.id):
        raise HTTPException(404, "Thread not found")
    if execute and item is not None:
        require_thread_participation(db, item, user_id, execute=True)
    if str(resource_owner_id) == str(access.project.id):
        return str(resource_owner_id)
    if not isinstance(access.project, CollaborationChatGroup):
        raise HTTPException(422, "Resource binding belongs to another work container")
    source_id = (
        linked_project_id(db, str(item.id), lock=True)
        if item is not None
        else str(classification.id) if classification is not None else None
    )
    if source_id != str(resource_owner_id):
        raise HTTPException(
            422, "Resource binding is not in the current linked project"
        )
    require_classification_project(db, source_id, user_id)
    return source_id


def require_assignment_agent(
    db: Session,
    *,
    container_id: str,
    agent_id: str,
    user_id: int,
    item: LoopItem | None = None,
    classification: CloudProject | None = None,
    execute: bool = False,
) -> ProjectChatAgent:
    """The globally unique binding supplies its actual Group or Project identity."""
    agent = db.get(ProjectChatAgent, agent_id)
    if agent is None:
        raise HTTPException(422, "Agent is unavailable")
    owner_id = require_resource_owner(
        db,
        container_id=container_id,
        resource_owner_id=str(agent.cloud_project_id),
        user_id=user_id,
        item=item,
        classification=classification,
        execute=execute,
    )
    return collaboration_permission_service.require_project_agent(
        db, owner_id, agent.id, user_id=user_id, current=True
    )


def execution_resource_agent_id(execution: LoopItemExecution) -> str:
    return str(
        execution.agent_id
        or execution.runtime_origin_context.get("manager_agent_id")
        or ""
    )


def group_assignment_reference(
    container: CloudProject | CollaborationChatGroup, group: dict[str, Any]
) -> dict[str, Any]:
    value = {"id": str(group["id"]), "name": str(group["name"])}
    if isinstance(container, CollaborationChatGroup):
        value["binding_owner_id"] = group["binding_owner_id"]
    return value


def _require_group_crew_agents(
    db: Session, group: dict, source_id: str, actor: int
) -> None:
    from app.services.collaboration_group_execution import (
        resolve_collaboration_group_agent,
    )

    agents = (
        db.query(ProjectChatAgent)
        .filter_by(cloud_project_id=source_id, status="active")
        .all()
    )
    references = [group.get("leader"), *(group.get("members") or [])]
    references.extend(stage.get("assignee") for stage in group.get("stages", []))
    for reference in references:
        if not isinstance(reference, dict) or reference.get("kind") != "agent":
            continue
        agent = resolve_collaboration_group_agent(
            agents, str(reference.get("id") or "")
        )
        if agent is None:
            raise HTTPException(422, "Collaboration group Agent is unavailable")
        collaboration_permission_service.require_project_agent(
            db, source_id, agent.id, user_id=actor, current=True
        )


def execution_resource_owner(db: Session, execution: LoopItemExecution) -> str:
    """Revalidate the live relationship before queue, claim and runtime work."""
    item = db.get(LoopItem, execution.loop_item_id)
    container = get_collaboration_container(db, execution.cloud_project_id)
    if not isinstance(container, CollaborationChatGroup):
        return str(execution.cloud_project_id)
    if item is None:
        raise HTTPException(404, "Thread not found")
    group = execution.runtime_origin_context.get("collaboration_group")
    if isinstance(group, dict):
        source_id = str(group.get("binding_owner_id") or "")
        if not source_id:
            # Migrated Project runs retain their original unique Agent binding.
            original = db.get(ProjectChatAgent, execution_resource_agent_id(execution))
            if original is None or not isinstance(
                get_collaboration_container(db, original.cloud_project_id), CloudProject
            ):
                raise HTTPException(422, "Original collaboration source is unavailable")
            source_id = str(original.cloud_project_id)
        if source_id:
            require_resource_owner(
                db,
                container_id=str(container.id),
                resource_owner_id=source_id,
                user_id=execution.assigner_user_id,
                item=item,
                execute=True,
            )
            collaboration_permission_service.require_project_group(
                db, source_id, str(group.get("id") or ""), current=True
            )
            agent_id = execution_resource_agent_id(execution)
            if agent_id:
                collaboration_permission_service.require_project_agent(
                    db,
                    source_id,
                    agent_id,
                    user_id=execution.assigner_user_id,
                    current=True,
                )
            return source_id
    agent_id = execution_resource_agent_id(execution)
    if not agent_id:
        return str(container.id)
    agent = require_assignment_agent(
        db,
        container_id=str(container.id),
        agent_id=str(agent_id),
        user_id=execution.assigner_user_id,
        item=item,
        execute=True,
    )
    return str(agent.cloud_project_id)


def require_assignment_group(
    db: Session,
    *,
    container_id: str,
    group_id: str,
    user_id: int,
    source_id: str | None = None,
    item: LoopItem | None = None,
    classification: CloudProject | None = None,
) -> dict:
    """A Crew definition may have distinct Group and Project enabling bindings."""
    from app.services.workspaces import workspace_service

    if (
        not group_id.isascii()
        or not group_id.isdecimal()
        or str(int(group_id)) != group_id
    ):
        raise HTTPException(422, "Collaboration group is unavailable")
    container = get_collaboration_container(db, container_id)
    if not isinstance(container, CollaborationChatGroup):
        selected = source_id or str(container_id)
    elif source_id is not None:
        selected = source_id
    else:
        project_id = (
            linked_project_id(db, str(item.id), lock=True)
            if item
            else str(classification.id) if classification else None
        )
        candidates = [("chat_group", str(container_id))]
        if (
            project_id
            and collaboration_permission_service.check(
                db, user_id, "read", project_id
            ).allowed
        ):
            candidates.append(("project", project_id))
        enabled = [
            owner_id
            for kind, owner_id in candidates
            if db.query(ResourceMember.id)
            .filter_by(
                resource_type="CollaborationGroup",
                resource_id=int(group_id),
                entity_type=kind,
                entity_id=owner_id,
                status="approved",
            )
            .filter(ResourceMember.role.in_(("Owner", "Maintainer", "Developer")))
            .first()
        ]
        if len(enabled) != 1:
            raise HTTPException(422, "Choose the enabled collaboration group source")
        selected = enabled[0]
    selected = require_resource_owner(
        db,
        container_id=str(container_id),
        resource_owner_id=str(selected),
        user_id=user_id,
        item=item,
        classification=classification,
    )
    collaboration_permission_service.require_project_group(
        db, selected, group_id, current=True
    )
    group = next(
        (
            row
            for row in workspace_service.list_project_collaboration_groups(
                db, int(selected), user_id
            )
            if str(row["id"]) == group_id
        ),
        None,
    )
    if group is None:
        raise HTTPException(422, "Collaboration group is unavailable")
    if isinstance(container, CollaborationChatGroup):
        _require_group_crew_agents(db, group, selected, user_id)
    return {**group, "binding_owner_id": selected}
