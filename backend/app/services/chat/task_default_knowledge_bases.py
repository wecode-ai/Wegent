# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for initializing task-level knowledge base bindings from Ghost defaults."""

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Bot, Ghost, Task, Team
from app.services.kind_ref_resolver import batch_load_kinds_by_refs
from app.services.knowledge.namespace_utils import is_organization_namespace
from app.services.readers import KindType
from app.services.share.knowledge_share_service import KnowledgeShareService
from app.services.task_team_resolver import (
    can_user_use_team,
    resolve_task_team_ref,
)
from app.stores.tasks import task_store
from shared.models.knowledge import KnowledgeBaseScope

logger = logging.getLogger(__name__)


def _get_accessible_knowledge_base(
    db: Session, user_id: int, knowledge_base_id: int
) -> Kind | None:
    """Return the knowledge base if the current user can access it."""
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


def _get_task_team(db: Session, task: TaskResource, task_crd: Task) -> Kind | None:
    """Resolve the Team used by a task using teamRef.user_id when present."""
    return resolve_task_team_ref(
        db,
        team_ref=task_crd.spec.teamRef,
        fallback_user_id=task.user_id,
    )


def _get_default_knowledge_bases(
    db: Session, knowledge_base_ids: list[int]
) -> dict[int, Kind]:
    """Batch load active knowledge bases by ID."""
    if not knowledge_base_ids:
        return {}

    unique_ids = list(dict.fromkeys(knowledge_base_ids))
    knowledge_bases = (
        db.query(Kind)
        .filter(
            Kind.id.in_(unique_ids),
            Kind.kind == "KnowledgeBase",
            Kind.is_active.is_(True),
        )
        .all()
    )
    return {knowledge_base.id: knowledge_base for knowledge_base in knowledge_bases}


def _can_use_public_default_kb(db: Session, knowledge_base: Kind) -> bool:
    """Public agents may only use organization knowledge bases as defaults."""
    return is_organization_namespace(db, knowledge_base.namespace)


@dataclass
class DefaultKnowledgeBaseWarning:
    """Diagnostic for a default KB that was not loaded."""

    knowledge_base_id: int
    knowledge_base_name: str
    reason: str


@dataclass
class DefaultKnowledgeBaseResolution:
    """Resolved runtime default KB scopes plus non-sensitive diagnostics."""

    scopes: list[KnowledgeBaseScope] = field(default_factory=list)
    warnings: list[DefaultKnowledgeBaseWarning] = field(default_factory=list)


def _can_user_read_knowledge_base(
    db: Session,
    user_id: int | None,
    knowledge_base: Kind,
    share_service: KnowledgeShareService,
) -> bool:
    """Return whether a user can read an already-loaded knowledge base."""
    if not user_id:
        return False
    has_access, _, _, _ = share_service._compute_kb_access_core(
        db, knowledge_base, user_id, include_sources=False
    )
    return has_access


def _can_user_use_team(db: Session, user_id: int, team: Kind) -> bool:
    """Return whether the current task actor can use the task's Team."""
    return can_user_use_team(db, user_id, team)


def _add_default_kb_warning(
    warnings: list[DefaultKnowledgeBaseWarning],
    warning_ids: set[int],
    *,
    knowledge_base_id: int,
    knowledge_base_name: str,
    reason: str,
) -> None:
    """Add one non-sensitive warning per default KB id."""
    if knowledge_base_id in warning_ids:
        return
    warnings.append(
        DefaultKnowledgeBaseWarning(
            knowledge_base_id=knowledge_base_id,
            knowledge_base_name=knowledge_base_name,
            reason=reason,
        )
    )
    warning_ids.add(knowledge_base_id)


def _add_default_kb_scope(
    scopes_by_id: dict[int, KnowledgeBaseScope],
    knowledge_base_id: int,
) -> None:
    """Add an unrestricted whole-KB runtime scope once."""
    scopes_by_id[knowledge_base_id] = KnowledgeBaseScope(
        knowledge_base_id=knowledge_base_id,
        scope_restricted=False,
        document_ids=[],
    )


def _normalize_ref_namespace(namespace: str | None) -> str:
    """Normalize empty CRD ref namespaces to default."""
    return namespace or "default"


def _get_team_member_bots(
    db: Session,
    team: Kind,
    team_crd: Team,
) -> dict[tuple[str, str], Kind]:
    """Batch load Bots referenced by Team members."""
    bot_refs = {
        (member.botRef.name, _normalize_ref_namespace(member.botRef.namespace))
        for member in team_crd.spec.members or []
    }
    if not bot_refs:
        return {}

    bots = batch_load_kinds_by_refs(
        db,
        user_id=team.user_id,
        kind_type=KindType.BOT,
        refs={(namespace, name) for name, namespace in bot_refs},
    )
    return {
        (bot.name, _normalize_ref_namespace(bot.namespace)): bot
        for bot in bots.values()
        if bot.json
    }


def _get_ghosts_for_bots(
    db: Session,
    team: Kind,
    bots: list[Kind],
) -> dict[tuple[str, str], Kind]:
    """Batch load Ghosts referenced by Bot specs."""
    ghost_refs: set[tuple[str, str]] = set()
    for bot in bots:
        try:
            bot_crd = Bot.model_validate(bot.json)
        except Exception:
            logger.warning(
                "runtime_default_kb_bot_parse_failed",
                extra={"team_id": team.id, "bot_id": bot.id},
            )
            continue
        ghost_refs.add(
            (
                bot_crd.spec.ghostRef.name,
                _normalize_ref_namespace(bot_crd.spec.ghostRef.namespace),
            )
        )

    if not ghost_refs:
        return {}

    ghosts = batch_load_kinds_by_refs(
        db,
        user_id=team.user_id,
        kind_type=KindType.GHOST,
        refs={(namespace, name) for name, namespace in ghost_refs},
    )
    return {
        (ghost.name, _normalize_ref_namespace(ghost.namespace)): ghost
        for ghost in ghosts.values()
        if ghost.json
    }


def _collect_default_knowledge_base_refs(
    team: Kind,
    team_crd: Team,
    bots_by_ref: dict[tuple[str, str], Kind],
    ghosts_by_ref: dict[tuple[str, str], Kind],
) -> list[Any]:
    """Collect default KB refs from batch-loaded Team member Bot/Ghost resources."""
    refs: list[Any] = []
    for member in team_crd.spec.members or []:
        bot_ref = (
            member.botRef.name,
            _normalize_ref_namespace(member.botRef.namespace),
        )
        bot = bots_by_ref.get(bot_ref)
        if not bot:
            continue
        try:
            bot_crd = Bot.model_validate(bot.json)
        except Exception:
            logger.warning(
                "runtime_default_kb_bot_parse_failed",
                extra={"team_id": team.id, "bot_id": bot.id},
            )
            continue

        ghost_ref = (
            bot_crd.spec.ghostRef.name,
            _normalize_ref_namespace(bot_crd.spec.ghostRef.namespace),
        )
        ghost = ghosts_by_ref.get(ghost_ref)
        if not ghost:
            continue
        try:
            ghost_crd = Ghost.model_validate(ghost.json)
        except Exception:
            logger.warning(
                "runtime_default_kb_ghost_parse_failed",
                extra={"team_id": team.id, "ghost_id": ghost.id},
            )
            continue
        refs.extend(ghost_crd.spec.defaultKnowledgeBaseRefs or [])
    return refs


def _resolve_default_knowledge_base_refs(
    db: Session,
    *,
    team: Kind,
    team_crd: Team,
    is_public_team: bool,
    scopes_by_id: dict[int, KnowledgeBaseScope],
    warnings: list[DefaultKnowledgeBaseWarning],
    warning_ids: set[int],
) -> None:
    """Resolve default KB refs from a Team using batch-loaded dependencies."""
    bots_by_ref = _get_team_member_bots(db, team, team_crd)
    ghosts_by_ref = _get_ghosts_for_bots(db, team, list(bots_by_ref.values()))
    refs = _collect_default_knowledge_base_refs(
        team, team_crd, bots_by_ref, ghosts_by_ref
    )
    knowledge_bases_by_id = _get_default_knowledge_bases(db, [ref.id for ref in refs])
    share_service = KnowledgeShareService()

    for ref in refs:
        if ref.id in scopes_by_id:
            continue
        knowledge_base = knowledge_bases_by_id.get(ref.id)
        if not knowledge_base:
            logger.warning(
                "runtime_default_kb_ref_unresolved",
                extra={
                    "team_id": team.id,
                    "team_user_id": team.user_id,
                    "knowledge_base_id": ref.id,
                    "knowledge_base_name": ref.name,
                },
            )
            _add_default_kb_warning(
                warnings,
                warning_ids,
                knowledge_base_id=ref.id,
                knowledge_base_name=ref.name,
                reason="knowledge_base_not_found",
            )
            continue
        if is_public_team and not _can_use_public_default_kb(db, knowledge_base):
            _add_default_kb_warning(
                warnings,
                warning_ids,
                knowledge_base_id=ref.id,
                knowledge_base_name=ref.name,
                reason="public_team_requires_organization_kb",
            )
            continue
        if not is_public_team and not _can_user_read_knowledge_base(
            db, team.user_id, knowledge_base, share_service
        ):
            _add_default_kb_warning(
                warnings,
                warning_ids,
                knowledge_base_id=ref.id,
                knowledge_base_name=ref.name,
                reason="team_owner_cannot_read_kb",
            )
            continue
        _add_default_kb_scope(scopes_by_id, ref.id)


def _get_task_default_knowledge_base_resolution_from_team(
    db: Session,
    team: Kind,
) -> DefaultKnowledgeBaseResolution:
    """Resolve runtime default KB scopes for a validated Team."""
    team_crd = Team.model_validate(team.json)
    is_public_team = team.user_id == 0
    scopes_by_id: dict[int, KnowledgeBaseScope] = {}
    warnings: list[DefaultKnowledgeBaseWarning] = []
    warning_ids: set[int] = set()
    _resolve_default_knowledge_base_refs(
        db,
        team=team,
        team_crd=team_crd,
        is_public_team=is_public_team,
        scopes_by_id=scopes_by_id,
        warnings=warnings,
        warning_ids=warning_ids,
    )
    return DefaultKnowledgeBaseResolution(
        scopes=list(scopes_by_id.values()),
        warnings=warnings,
    )


def get_task_default_knowledge_base_resolution(
    db: Session,
    task_id: int,
    user_id: int,
) -> DefaultKnowledgeBaseResolution:
    """Resolve runtime default KB scopes for the task's current Team config."""
    task = task_store.get_by_id(db, task_id=task_id)
    if not task or task.kind != "Task" or not task.json:
        return DefaultKnowledgeBaseResolution()

    task_crd = Task.model_validate(task.json)
    team = _get_task_team(db, task, task_crd)
    if not team or not team.json:
        return DefaultKnowledgeBaseResolution()
    if not _can_user_use_team(db, user_id, team):
        return DefaultKnowledgeBaseResolution()

    return _get_task_default_knowledge_base_resolution_from_team(db, team)


def get_task_default_knowledge_base_scopes(
    db: Session,
    task_id: int,
    user_id: int,
) -> list[KnowledgeBaseScope]:
    """Resolve runtime default KB scopes for callers that only need scopes."""
    return get_task_default_knowledge_base_resolution(db, task_id, user_id).scopes


def build_initial_task_knowledge_base_refs(
    db: Session,
    user: User,
    team,
    knowledge_base_id: int | None = None,
) -> list[dict[str, Any]]:
    """Build task-level knowledge base refs only from explicit user selection.

    Ghost-level default knowledge bases are resolved at runtime and must not be
    persisted into Task.spec.knowledgeBaseRefs.
    """
    bound_at = datetime.now().isoformat()
    refs_by_id: dict[int, dict[str, Any]] = {}

    candidates: list[tuple[int, int]] = []
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
