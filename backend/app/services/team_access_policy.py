# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Team usage permissions, separate from configuration access."""

from copy import deepcopy
from typing import Any

from sqlalchemy.orm import Session

from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.schemas.base_role import BaseRole
from app.schemas.namespace import GroupRole
from app.services.group_permission import check_group_permission, get_user_group_roles

TEAM_USE_ROLE = BaseRole.RestrictedAnalyst


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

    roles = get_user_group_roles(db, user_id)
    restricted_namespaces = {
        namespace
        for namespace, role in roles.items()
        if role == GroupRole.RestrictedAnalyst
    }
    if team_namespace in restricted_namespaces:
        return True
    if not restricted_namespaces:
        return False

    namespace_ids = [
        str(row.id)
        for row in db.query(Namespace.id)
        .filter(
            Namespace.name.in_(restricted_namespaces),
            Namespace.is_active.is_(True),
        )
        .all()
    ]
    if not namespace_ids:
        return False

    team_resource_types = [ResourceType.TEAM.value, ResourceType.TEAM.name]
    approved_statuses = [MemberStatus.APPROVED.value, "APPROVED"]
    return (
        db.query(ResourceMember.id)
        .filter(
            ResourceMember.resource_id == team_id,
            ResourceMember.resource_type.in_(team_resource_types),
            ResourceMember.entity_type == "namespace",
            ResourceMember.entity_id.in_(namespace_ids),
            ResourceMember.status.in_(approved_statuses),
        )
        .first()
        is not None
    )
