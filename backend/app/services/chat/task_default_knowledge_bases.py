# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve explicit and agent-default task knowledge bases."""

from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.kind import Bot, Ghost, Task, Team
from app.services.adapters.task_kinds.converters import resolve_task_ref_team
from app.services.kind_ref_resolver import batch_load_kinds_by_refs
from app.services.knowledge.knowledge_visibility_query import (
    get_acl_accessible_knowledge_base_ids,
)
from app.services.readers import KindType
from app.services.share import team_share_service
from app.stores.tasks import task_store


def _get_accessible_knowledge_base(
    db: Session, user_id: int, knowledge_base_id: int
) -> Kind | None:
    """Return the knowledge base if the current user can access it."""
    from app.services.share.knowledge_share_service import KnowledgeShareService

    return KnowledgeShareService()._get_resource(db, knowledge_base_id, user_id)


def _get_active_knowledge_base(db: Session, knowledge_base_id: int) -> Kind | None:
    """Load an active knowledge base without depending on KnowledgeService."""
    return (
        db.query(Kind)
        .filter(
            Kind.id == knowledge_base_id,
            Kind.kind == "KnowledgeBase",
            Kind.is_active == True,
        )
        .first()
    )


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
    bot_refs = [
        (member.botRef.namespace, member.botRef.name)
        for member in team_crd.spec.members or []
    ]
    bots = batch_load_kinds_by_refs(
        db,
        user_id=team.user_id,
        kind_type=KindType.BOT,
        refs=set(bot_refs),
    )
    bot_crds = [
        Bot.model_validate(bots[ref].json)
        for ref in bot_refs
        if ref in bots and bots[ref].json
    ]
    ghost_refs = [
        (bot.spec.ghostRef.namespace, bot.spec.ghostRef.name) for bot in bot_crds
    ]
    ghosts = batch_load_kinds_by_refs(
        db,
        user_id=team.user_id,
        kind_type=KindType.GHOST,
        refs=set(ghost_refs),
    )

    for ref in ghost_refs:
        ghost = ghosts.get(ref)
        if not ghost or not ghost.json:
            continue
        ghost_crd = Ghost.model_validate(ghost.json)
        for ref in ghost_crd.spec.defaultKnowledgeBaseRefs or []:
            knowledge_base_ids.append(ref.id)

    return knowledge_base_ids


def _resolve_task_default_knowledge_bases(
    db: Session,
    task_id: int,
    user_id: int,
    knowledge_base_id: int | None = None,
) -> tuple[Kind | None, list[int]]:
    """Resolve the current Team and defaults its owner may still access."""
    task = task_store.get_active_task(db, task_id=task_id)
    if task is None or not isinstance(task.json, dict):
        return None, []

    try:
        task_crd = Task.model_validate(task.json)
    except ValueError:
        return None, []

    team = resolve_task_ref_team(db, task_crd, user_id)
    if team is None or team_share_service.get_resource(db, team.id, user_id) is None:
        return None, []

    candidate_ids = list(
        dict.fromkeys(_iter_team_member_default_knowledge_base_ids(db, team))
    )
    if knowledge_base_id is not None:
        if knowledge_base_id not in candidate_ids:
            return team, []
        candidate_ids = [knowledge_base_id]
    allowed_ids = get_acl_accessible_knowledge_base_ids(
        db,
        user_id=team.user_id,
        candidate_ids=candidate_ids,
    )
    accessible_ids = [kb_id for kb_id in candidate_ids if kb_id in allowed_ids]
    return team, accessible_ids


def resolve_task_default_knowledge_base_ids(
    db: Session,
    task_id: int,
    user_id: int,
) -> list[int]:
    """Resolve current agent defaults for an authorized task user."""
    _, knowledge_base_ids = _resolve_task_default_knowledge_bases(
        db,
        task_id,
        user_id,
    )
    return knowledge_base_ids


def resolve_task_default_knowledge_base_read_user_id(
    db: Session,
    task_id: int,
    user_id: int,
    knowledge_base_id: int,
) -> int | None:
    """Return the KB owner after validating task-scoped agent default access."""
    team, knowledge_base_ids = _resolve_task_default_knowledge_bases(
        db,
        task_id,
        user_id,
        knowledge_base_id,
    )
    if team is None or knowledge_base_id not in knowledge_base_ids:
        return None
    knowledge_base = _get_active_knowledge_base(db, knowledge_base_id)
    return knowledge_base.user_id if knowledge_base is not None else None


def build_initial_task_knowledge_base_refs(
    db: Session,
    user: User,
    team,
    knowledge_base_id: int | None = None,
) -> list[dict[str, Any]]:
    """Build task-level refs for an explicitly selected knowledge base."""
    bound_at = datetime.now().isoformat()
    refs_by_id: dict[int, dict[str, Any]] = {}

    candidates = []
    if knowledge_base_id is not None:
        candidates.append((knowledge_base_id, user.id))

    for candidate_id, access_user_id in candidates:
        if candidate_id in refs_by_id:
            continue

        knowledge_base = _get_accessible_knowledge_base(
            db, access_user_id, candidate_id
        )
        if not knowledge_base:
            continue

        refs_by_id[candidate_id] = _build_task_knowledge_base_ref(
            knowledge_base=knowledge_base,
            user_name=user.user_name,
            bound_at=bound_at,
        )

    return list(refs_by_id.values())
