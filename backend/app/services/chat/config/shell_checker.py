# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shell type checker for Chat Shell.

This module provides utilities to check shell types for teams and bots.

NOTE: should_use_direct_chat and is_direct_chat_shell have been removed.
All teams now use ExecutionDispatcher for unified task routing.
"""

import logging

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.kind import Bot, Shell, Team
from app.services.readers import KindType, kindReader

logger = logging.getLogger(__name__)


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
    bot = kindReader.get_by_name_and_namespace(
        db,
        team.user_id,
        KindType.BOT,
        first_member.botRef.namespace,
        first_member.botRef.name,
    )

    if bot:
        return get_shell_type(db, bot, team.user_id)

    return ""


def is_deep_research_protocol(db: Session, team: Kind) -> bool:
    """
    Check if the team's first bot uses gemini-deep-research protocol.

    This protocol does not support follow-up questions (multi-turn conversation).
    Each task can only have one user message.

    Args:
        db: Database session
        team: Team Kind object

    Returns:
        bool: True if the team uses gemini-deep-research protocol
    """
    from app.schemas.kind import Model

    team_crd = Team.model_validate(team.json)

    if not team_crd.spec.members:
        return False

    first_member = team_crd.spec.members[0]

    # Get first bot
    bot = kindReader.get_by_name_and_namespace(
        db,
        team.user_id,
        KindType.BOT,
        first_member.botRef.namespace,
        first_member.botRef.name,
    )

    if not bot:
        return False

    bot_crd = Bot.model_validate(bot.json)
    if not bot_crd.spec or not bot_crd.spec.modelRef:
        return False

    # Get model from bot's modelRef (kindReader handles public fallback)
    model = kindReader.get_by_name_and_namespace(
        db,
        team.user_id,
        KindType.MODEL,
        bot_crd.spec.modelRef.namespace,
        bot_crd.spec.modelRef.name,
    )

    if not model or not model.json:
        return False

    model_crd = Model.model_validate(model.json)
    protocol = model_crd.spec.protocol if model_crd.spec else None

    return protocol == "gemini-deep-research"
