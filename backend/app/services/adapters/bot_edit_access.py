# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Source-edit authority for Bots referenced by Teams."""

from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.base_role import BaseRole
from app.schemas.kind import Team
from app.services.adapters.shell_utils import get_shell_by_name, get_shell_info_by_name
from app.services.group_permission import check_group_permission
from app.services.team_access_policy import can_edit_team


def team_references_bot(team: Kind, bot: Kind) -> bool:
    """Match a private Bot in its owner's scope, not just by name."""
    if bot.namespace != "default" or bot.user_id == 0 or bot.user_id != team.user_id:
        return False
    try:
        team_crd = Team.model_validate(team.json)
    except ValueError:
        return False
    return any(
        member.botRef.name == bot.name
        and (member.botRef.namespace or "default") == "default"
        for member in team_crd.spec.members
    )


def can_edit_bot(
    db: Session, bot: Kind, user_id: int, team: Kind | None = None
) -> bool:
    """Keep group Bot authority independent from a Team's namespace."""
    if bot.user_id == user_id:
        return True
    if bot.namespace != "default":
        return check_group_permission(db, user_id, bot.namespace, BaseRole.Developer)
    return bool(
        team and can_edit_team(db, team, user_id) and team_references_bot(team, bot)
    )


def can_reference_bot(
    db: Session, bot: Kind, user_id: int, team: Kind | None = None
) -> bool:
    """Public Bot use does not confer source-edit authority."""
    if (
        team is not None
        and bot.namespace == "default"
        and bot.user_id not in (0, team.user_id)
    ):
        return False
    return (bot.user_id == 0 and bot.namespace == "default") or can_edit_bot(
        db, bot, user_id, team
    )


def resolve_replacement_shell_info(
    db: Session, *, name: str, owner_id: int, editor_id: int
) -> dict[str, Any]:
    """A new Shell must be accessible and resolve to the same owner-side asset."""
    try:
        info = get_shell_info_by_name(db, name, editor_id)
    except ValueError as exc:
        raise HTTPException(403, "Shell access denied") from exc
    namespace = info.get("namespace", "default")
    selected = get_shell_by_name(db, name, editor_id, namespace)
    owner_shell = get_shell_by_name(db, name, owner_id, namespace)
    if not selected or not owner_shell or selected.id != owner_shell.id:
        raise HTTPException(403, "Shell is unavailable in the Bot owner's scope")
    return info
