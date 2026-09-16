# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Team usage permissions, separate from configuration access."""

from copy import deepcopy
from typing import Any

from sqlalchemy.orm import Session

from app.schemas.base_role import BaseRole
from app.services.group_permission import check_group_permission

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
