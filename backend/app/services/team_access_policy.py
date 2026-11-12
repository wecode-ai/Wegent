# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Team usage permissions, separate from configuration access."""

from copy import deepcopy
from typing import Any

from sqlalchemy import String
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.schemas.base_role import BaseRole
from app.schemas.namespace import GroupRole
from app.services.group_permission import (
    check_group_permission,
    has_restricted_analyst_group,
)

TEAM_USE_ROLE = BaseRole.RestrictedAnalyst


def can_edit_team(db: Session, team: Kind, user_id: int) -> bool:
    """Match the Team update contract without granting edits through project roles."""

    if not team.is_active or team.kind != "Team":
        return False
    if team.namespace == "default":
        return team.user_id == user_id
    return check_group_permission(db, user_id, team.namespace, GroupRole.Developer)


def can_use_group_teams(db: Session, user_id: int, namespace: str) -> bool:
    """Allow approved group members to use agents, including restricted analysts."""
    return namespace != "default" and check_group_permission(
        db, user_id, namespace, TEAM_USE_ROLE
    )


def team_usage_summary(team: dict[str, Any]) -> dict[str, Any]:
    """Keep chat capabilities while removing prompts and model credentials."""
    summary = deepcopy(team)
    model_reference_fields = {
        "bind_model",
        "bind_model_type",
        "bind_model_namespace",
        "allowed_models",
    }
    for member in summary.get("bots", []):
        member["bot_prompt"] = ""
        bot = member.get("bot")
        if bot:
            config = bot.get("agent_config") or {}
            bot["agent_config"] = {
                key: value
                for key, value in config.items()
                if key in model_reference_fields
            }
    return summary


def should_redact_team_for_user(
    db: Session,
    *,
    user_id: int,
    team_id: int,
    team_user_id: int,
    team_namespace: str,
) -> bool:
    """Return whether a team response should hide private agent configuration."""
    if team_user_id == user_id or team_namespace == "default":
        return False

    team_resource_types = [ResourceType.TEAM.value, ResourceType.TEAM.name]
    approved_statuses = [MemberStatus.APPROVED.value, "APPROVED"]
    shared_names = [
        row[0]
        for row in db.query(Namespace.name)
        .join(ResourceMember, ResourceMember.entity_id == Namespace.id.cast(String))
        .filter(
            Namespace.is_active.is_(True),
            ResourceMember.resource_id == team_id,
            ResourceMember.resource_type.in_(team_resource_types),
            ResourceMember.entity_type == "namespace",
            ResourceMember.status.in_(approved_statuses),
        )
        .all()
    ]
    return has_restricted_analyst_group(db, user_id, [team_namespace, *shared_names])
