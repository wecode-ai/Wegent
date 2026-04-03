# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for initializing task-level knowledge base bindings from Ghost defaults."""

from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.kind import Bot, Ghost, Team
from app.services.readers import KindType, kindReader


def _get_accessible_knowledge_base(
    db: Session, user_id: int, knowledge_base_id: int
) -> Kind | None:
    """Return the knowledge base if the current user can access it."""
    from app.services.share.knowledge_share_service import KnowledgeShareService

    return KnowledgeShareService()._get_resource(db, knowledge_base_id, user_id)


def _get_knowledge_base_display_name(knowledge_base: Kind) -> str:
    """Return the current display name for a knowledge base."""
    spec = knowledge_base.json.get("spec", {}) if knowledge_base.json else {}
    return spec.get("name", knowledge_base.name)


def _build_task_knowledge_base_ref(
    knowledge_base: Kind,
    user_name: str,
    bound_at: str,
) -> dict[str, Any]:
    """Build the task-level knowledge base ref stored in Task.spec."""
    return {
        "id": knowledge_base.id,
        "name": _get_knowledge_base_display_name(knowledge_base),
        "boundBy": user_name,
        "boundAt": bound_at,
    }


def _iter_team_member_default_knowledge_base_ids(
    db: Session,
    team,
) -> list[int]:
    """Collect default knowledge base IDs from all team member Ghosts."""
    team_crd = Team.model_validate(team.json)
    knowledge_base_ids: list[int] = []

    for member in team_crd.spec.members or []:
        bot = kindReader.get_by_name_and_namespace(
            db,
            team.user_id,
            KindType.BOT,
            member.botRef.namespace,
            member.botRef.name,
        )
        if not bot or not bot.json:
            continue

        bot_crd = Bot.model_validate(bot.json)
        ghost = kindReader.get_by_name_and_namespace(
            db,
            team.user_id,
            KindType.GHOST,
            bot_crd.spec.ghostRef.namespace,
            bot_crd.spec.ghostRef.name,
        )
        if not ghost or not ghost.json:
            continue

        ghost_crd = Ghost.model_validate(ghost.json)
        for ref in ghost_crd.spec.defaultKnowledgeBaseRefs or []:
            knowledge_base_ids.append(ref.id)

    return knowledge_base_ids


def build_initial_task_knowledge_base_refs(
    db: Session,
    user: User,
    team,
    knowledge_base_id: int | None = None,
) -> list[dict[str, Any]]:
    """Build task-level knowledge base refs from Ghost defaults plus explicit selection."""
    bound_at = datetime.now().isoformat()
    refs_by_id: dict[int, dict[str, Any]] = {}

    candidate_ids = _iter_team_member_default_knowledge_base_ids(db, team)
    if knowledge_base_id is not None:
        candidate_ids.append(knowledge_base_id)

    for candidate_id in candidate_ids:
        if candidate_id in refs_by_id:
            continue

        knowledge_base = _get_accessible_knowledge_base(db, user.id, candidate_id)
        if not knowledge_base:
            continue

        refs_by_id[candidate_id] = _build_task_knowledge_base_ref(
            knowledge_base=knowledge_base,
            user_name=user.user_name,
            bound_at=bound_at,
        )

    return list(refs_by_id.values())
