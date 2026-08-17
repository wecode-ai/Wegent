# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Validate that a Team can be resolved by the standard execution builder."""

from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.kind import Bot, Ghost, Shell, Team, TeamMember
from app.services.adapters.shell_utils import get_shell_by_name
from app.services.chat.config.model_resolver import get_model_config_for_bot
from app.services.readers import KindType, kindReader


def validate_team_execution_readiness(
    db: Session,
    *,
    team: Kind,
    execution_user_id: int,
) -> None:
    """Validate every Team member dependency used by ``TaskRequestBuilder``.

    Team children are resolved in the Team owner's scope, matching the request
    builder. Models are resolved in the execution user's scope because managed
    Tasks run with that user's model capabilities.
    """

    try:
        team_crd = Team.model_validate(team.json)
    except ValidationError as exc:
        raise ValueError(f"Team '{team.name}' configuration is invalid") from exc

    if not team_crd.spec.members:
        raise ValueError(f"Team '{team.name}' has no members")

    checked_refs: set[tuple[str, str]] = set()
    for member in team_crd.spec.members:
        ref = (member.botRef.namespace, member.botRef.name)
        if ref in checked_refs:
            continue
        checked_refs.add(ref)
        _validate_team_member(
            db,
            team=team,
            member=member,
            execution_user_id=execution_user_id,
        )


def _validate_team_member(
    db: Session,
    *,
    team: Kind,
    member: TeamMember,
    execution_user_id: int,
) -> None:
    bot_ref = member.botRef
    bot_label = f"{bot_ref.namespace}/{bot_ref.name}"
    bot = kindReader.get_by_name_and_namespace(
        db,
        team.user_id,
        KindType.BOT,
        bot_ref.namespace,
        bot_ref.name,
    )
    if bot is None:
        raise ValueError(f"Team member Bot '{bot_label}' is unavailable")

    try:
        bot_crd = Bot.model_validate(bot.json)
    except ValidationError as exc:
        raise ValueError(f"Bot '{bot_label}' configuration is invalid") from exc

    _validate_ghost(db, team=team, bot_label=bot_label, bot_crd=bot_crd)
    _validate_shell(db, team=team, bot_label=bot_label, bot_crd=bot_crd)
    _validate_model(
        db,
        bot=bot,
        bot_label=bot_label,
        execution_user_id=execution_user_id,
    )


def _validate_ghost(
    db: Session,
    *,
    team: Kind,
    bot_label: str,
    bot_crd: Bot,
) -> None:
    ghost_ref = bot_crd.spec.ghostRef
    ghost = kindReader.get_by_name_and_namespace(
        db,
        team.user_id,
        KindType.GHOST,
        ghost_ref.namespace,
        ghost_ref.name,
    )
    ghost_label = f"{ghost_ref.namespace}/{ghost_ref.name}"
    if ghost is None:
        raise ValueError(f"Bot '{bot_label}' Ghost '{ghost_label}' is unavailable")
    try:
        Ghost.model_validate(ghost.json)
    except ValidationError as exc:
        raise ValueError(
            f"Bot '{bot_label}' Ghost '{ghost_label}' configuration is invalid"
        ) from exc


def _validate_shell(
    db: Session,
    *,
    team: Kind,
    bot_label: str,
    bot_crd: Bot,
) -> None:
    shell_ref = bot_crd.spec.shellRef
    shell = get_shell_by_name(
        db,
        shell_ref.name,
        team.user_id,
        shell_ref.namespace,
    )
    shell_label = f"{shell_ref.namespace}/{shell_ref.name}"
    if shell is None:
        raise ValueError(f"Bot '{bot_label}' Shell '{shell_label}' is unavailable")
    try:
        Shell.model_validate(shell.json)
    except ValidationError as exc:
        raise ValueError(
            f"Bot '{bot_label}' Shell '{shell_label}' configuration is invalid"
        ) from exc


def _validate_model(
    db: Session,
    *,
    bot: Kind,
    bot_label: str,
    execution_user_id: int,
) -> None:
    try:
        get_model_config_for_bot(db, bot, execution_user_id)
    except ValueError as exc:
        raise ValueError(f"Bot '{bot_label}' model is unavailable: {exc}") from exc
