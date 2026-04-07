# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List, Tuple

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.kind import Bot, Ghost, Team
from app.schemas.prompt_optimization import (
    ApplyPromptChangesResponse,
    PromptChange,
    PromptSource,
)
from app.services.group_permission import get_effective_role_in_group
from app.services.readers import kindReader
from app.services.readers.kinds import KindType


def can_view_prompt(db: Session, user: User, resource: Kind) -> bool:
    """Check if user can view the prompt of a resource."""
    # Owner can always view
    if resource.user_id == user.id:
        return True

    # Admin can always view
    if user.role == "admin":
        return True

    # Check group permission for non-default namespace
    if resource.namespace != "default":
        user_role = get_effective_role_in_group(db, user.id, resource.namespace)
        if user_role:
            return has_permission(user_role, BaseRole.Reporter)

    return False


def can_edit_prompt(db: Session, user: User, resource: Kind) -> bool:
    """Check if user can edit the prompt of a resource."""
    # Owner can always edit
    if resource.user_id == user.id:
        return True

    # Admin can always edit
    if user.role == "admin":
        return True

    # Check group permission for non-default namespace
    if resource.namespace != "default":
        user_role = get_effective_role_in_group(db, user.id, resource.namespace)
        if user_role:
            return has_permission(user_role, BaseRole.Developer)

    return False


def resolve_team_from_task(db: Session, task_id: int, user_id: int) -> Kind:
    """Resolve the Team Kind from a task_id.

    Looks up the TaskResource, extracts teamRef from spec,
    then queries Kind table for the Team.

    Args:
        db: Database session
        task_id: Task ID
        user_id: User ID

    Returns:
        Kind object for the Team

    Raises:
        ValueError: If task or team not found
    """
    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
        )
        .first()
    )
    if not task:
        raise ValueError(f"Task {task_id} not found")

    spec = (task.json or {}).get("spec", {})
    team_ref = spec.get("teamRef", {})
    team_name = team_ref.get("name")
    team_namespace = team_ref.get("namespace", "default")

    if not team_name:
        raise ValueError(f"Task {task_id} has no teamRef")

    team = (
        db.query(Kind)
        .filter(
            Kind.kind == "Team",
            Kind.name == team_name,
            Kind.namespace == team_namespace,
            Kind.user_id == user_id,
            Kind.is_active == True,
        )
        .first()
    )
    if not team:
        raise ValueError(f"Team '{team_name}' (namespace='{team_namespace}') not found")

    return team


def assemble_team_prompt(
    db: Session, team_id: int, user_id: int
) -> Tuple[str, List[PromptSource]]:
    """
    Assemble the complete system prompt for a team and return source mapping.

    Args:
        db: Database session
        team_id: Team ID
        user_id: User ID

    Returns:
        Tuple of (assembled_prompt, list of source mappings)
    """
    # Get team
    team = (
        db.query(Kind)
        .filter(
            Kind.id == team_id,
            Kind.kind == "Team",
            Kind.user_id == user_id,
            Kind.is_active == True,
        )
        .first()
    )

    if not team:
        raise ValueError(f"Team {team_id} not found")

    team_crd = Team.model_validate(team.json)
    sources = []

    for index, member in enumerate(team_crd.spec.members or []):
        # Get bot
        bot = kindReader.get_by_name_and_namespace(
            db=db,
            user_id=team.user_id,
            kind=KindType.BOT,
            namespace=member.botRef.namespace,
            name=member.botRef.name,
        )

        if not bot:
            continue

        bot_crd = Bot.model_validate(bot.json)

        # Get ghost
        if bot_crd.spec and bot_crd.spec.ghostRef:
            ghost = kindReader.get_by_name_and_namespace(
                db=db,
                user_id=team.user_id,
                kind=KindType.GHOST,
                namespace=bot_crd.spec.ghostRef.namespace,
                name=bot_crd.spec.ghostRef.name,
            )

            if ghost and ghost.json:
                ghost_crd = Ghost.model_validate(ghost.json)
                if ghost_crd.spec and ghost_crd.spec.systemPrompt:
                    sources.append(
                        PromptSource(
                            type="ghost",
                            id=ghost.id,
                            name=ghost.name,
                            field="systemPrompt",
                            content=ghost_crd.spec.systemPrompt,
                        )
                    )

        # Add member prompt if exists
        if member.prompt:
            sources.append(
                PromptSource(
                    type="member",
                    id=team.id,
                    name=bot.name,
                    index=index,
                    field="prompt",
                    content=member.prompt,
                )
            )

    # Assemble the complete prompt
    assembled_parts = []
    for source in sources:
        if source.type == "ghost":
            assembled_parts.append(f"<base_prompt>\n{source.content}")
        elif source.type == "member":
            assembled_parts.append(f"\n{source.content}")

    if assembled_parts:
        assembled_parts[-1] += "\n</base_prompt>"

    assembled_prompt = "\n\n".join(assembled_parts) if assembled_parts else ""

    return assembled_prompt, sources


def apply_prompt_changes(
    db: Session, user: User, team_id: int, changes: List[PromptChange]
) -> ApplyPromptChangesResponse:
    """
    Apply prompt changes to Ghost or TeamMember.

    Args:
        db: Database session
        user: User making the changes
        team_id: Team ID (for context, not directly used)
        changes: List of prompt changes to apply

    Returns:
        ApplyPromptChangesResponse with success status and any errors
    """
    errors = []
    applied = 0

    for change in changes:
        try:
            if change.type == "ghost":
                # Apply to Ghost
                ghost = (
                    db.query(Kind)
                    .filter(
                        Kind.id == change.id,
                        Kind.kind == "Ghost",
                        Kind.is_active == True,
                    )
                    .first()
                )

                if not ghost:
                    errors.append(f"Ghost {change.id} not found")
                    continue

                if not can_edit_prompt(db, user, ghost):
                    errors.append(f"No permission to edit Ghost {change.id}")
                    continue

                # Update Ghost
                ghost_crd = Ghost.model_validate(ghost.json)
                if change.field == "systemPrompt":
                    ghost_crd.spec.systemPrompt = change.value

                ghost.json = ghost_crd.model_dump()
                db.flush()
                applied += 1

            elif change.type == "member":
                # Apply to Team Member
                team = (
                    db.query(Kind)
                    .filter(
                        Kind.id == change.team_id,
                        Kind.kind == "Team",
                        Kind.is_active == True,
                    )
                    .first()
                )

                if not team:
                    errors.append(f"Team {change.team_id} not found")
                    continue

                if not can_edit_prompt(db, user, team):
                    errors.append(f"No permission to edit Team {change.team_id}")
                    continue

                # Update Team Member
                team_crd = Team.model_validate(team.json)
                if change.index is not None and change.index < len(
                    team_crd.spec.members or []
                ):
                    team_crd.spec.members[change.index].prompt = change.value
                    team.json = team_crd.model_dump()
                    db.flush()
                    applied += 1
                else:
                    errors.append(f"Invalid member index {change.index}")

        except Exception as e:
            errors.append(f"Failed to apply change: {str(e)}")

    db.commit()

    return ApplyPromptChangesResponse(
        success=len(errors) == 0, applied_changes=applied, errors=errors
    )
