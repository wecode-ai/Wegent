# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shell type checker for Chat Shell.

This module provides utilities to check shell types and determine
if a team supports direct chat mode (bypassing Docker Executor).
"""

import logging
from typing import List

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.kind import Bot, Shell, Team

logger = logging.getLogger(__name__)

# Shell types that support direct chat (bypass executor)
DIRECT_CHAT_SHELL_TYPES = ["Chat"]


def is_direct_chat_shell(shell_type: str) -> bool:
    """
    Check if the shell type supports direct chat.

    Args:
        shell_type: The shell type to check

    Returns:
        bool: True if the shell type supports direct chat
    """
    return shell_type in DIRECT_CHAT_SHELL_TYPES


def get_shell_type(db: Session, bot: Kind, user_id: int) -> str:
    """
    Get shell type for a bot.

    Args:
        db: Database session
        bot: Bot Kind object
        user_id: User ID to check for custom shells

    Returns:
        str: Shell type string, empty string if not found
    """
    bot_crd = Bot.model_validate(bot.json)

    # First check user's custom shells
    shell = (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == "Shell",
            Kind.name == bot_crd.spec.shellRef.name,
            Kind.namespace == bot_crd.spec.shellRef.namespace,
            Kind.is_active == True,
        )
        .first()
    )

    # If not found, check public shells
    if not shell:
        public_shell = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Shell",
                Kind.name == bot_crd.spec.shellRef.name,
                Kind.namespace == bot_crd.spec.shellRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )
        if public_shell and public_shell.json:
            shell_crd = Shell.model_validate(public_shell.json)
            return shell_crd.spec.shellType
        return ""

    if shell and shell.json:
        shell_crd = Shell.model_validate(shell.json)
        return shell_crd.spec.shellType

    return ""


def should_use_direct_chat(db: Session, team: Kind, user_id: int) -> bool:
    """
    Check if the team should use direct chat mode.

    Returns True only if ALL bots in the team use Chat Shell type.

    Args:
        db: Database session
        team: Team Kind object
        user_id: User ID for shell lookup

    Returns:
        bool: True if all bots in team support direct chat
    """
    team_crd = Team.model_validate(team.json)

    for member in team_crd.spec.members:
        # Find bot
        bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Bot",
                Kind.name == member.botRef.name,
                Kind.namespace == member.botRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )

        if not bot:
            return False

        shell_type = get_shell_type(db, bot, team.user_id)
        if not is_direct_chat_shell(shell_type):
            return False

    return True


def get_team_first_bot_shell_type(db: Session, team: Kind) -> str:
    """
    Get the shell type of the first bot in a team.

    Args:
        db: Database session
        team: Team Kind object

    Returns:
        str: Shell type of the first bot, empty string if not found
    """
    team_crd = Team.model_validate(team.json)

    if not team_crd.spec.members:
        return ""

    first_member = team_crd.spec.members[0]
    bot = (
        db.query(Kind)
        .filter(
            Kind.user_id == team.user_id,
            Kind.kind == "Bot",
            Kind.name == first_member.botRef.name,
            Kind.namespace == first_member.botRef.namespace,
            Kind.is_active == True,
        )
        .first()
    )

    if bot:
        return get_shell_type(db, bot, team.user_id)

    return ""
