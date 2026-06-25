# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for initializing task-level knowledge base bindings from Ghost defaults."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Bot, Ghost, Task, Team
from app.services.knowledge.namespace_utils import is_organization_namespace
from app.services.readers import KindType, kindReader
from app.services.task_team_resolver import (
    can_user_use_team,
    resolve_task_team_ref,
)
from shared.models.knowledge import KnowledgeBaseScope


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


def _get_task_team(db: Session, task: TaskResource, task_crd: Task) -> Kind | None:
    """Resolve the Team used by a task using teamRef.user_id when present."""
    return resolve_task_team_ref(
        db,
        team_ref=task_crd.spec.teamRef,
        fallback_user_id=task.user_id,
    )


def _get_default_knowledge_base(db: Session, knowledge_base_id: int) -> Kind | None:
    """Load an active knowledge base by ID."""
    return (
        db.query(Kind)
        .filter(
            Kind.id == knowledge_base_id,
            Kind.kind == "KnowledgeBase",
            Kind.is_active.is_(True),
        )
        .first()
    )


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


def _can_user_read_kb(db: Session, user_id: int | None, knowledge_base_id: int) -> bool:
    """Return whether the given user currently has read access to a KB."""
    if not user_id:
        return False
    return _get_accessible_knowledge_base(db, user_id, knowledge_base_id) is not None


def _can_user_use_team(db: Session, user_id: int, team: Kind) -> bool:
    """Return whether the current task actor can use the task's Team."""
    return can_user_use_team(db, user_id, team)


def get_task_default_knowledge_base_resolution(
    db: Session,
    task_id: int,
    user_id: int,
) -> DefaultKnowledgeBaseResolution:
    """Resolve runtime default KB scopes for the task's current Team config."""
    task = (
        db.query(TaskResource)
        .filter(TaskResource.id == task_id, TaskResource.kind == "Task")
        .first()
    )
    if not task or not task.json:
        return DefaultKnowledgeBaseResolution()

    task_crd = Task.model_validate(task.json)
    team = _get_task_team(db, task, task_crd)
    if not team or not team.json:
        return DefaultKnowledgeBaseResolution()
    if not _can_user_use_team(db, user_id, team):
        return DefaultKnowledgeBaseResolution()

    team_crd = Team.model_validate(team.json)
    is_public_team = team.user_id == 0
    scopes_by_id: dict[int, KnowledgeBaseScope] = {}
    warnings: list[DefaultKnowledgeBaseWarning] = []
    warning_ids: set[int] = set()

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
            if ref.id in scopes_by_id:
                continue
            knowledge_base = _get_default_knowledge_base(db, ref.id)
            if not knowledge_base:
                continue
            if is_public_team:
                if not _can_use_public_default_kb(db, knowledge_base):
                    if ref.id not in warning_ids:
                        warnings.append(
                            DefaultKnowledgeBaseWarning(
                                knowledge_base_id=ref.id,
                                knowledge_base_name=ref.name,
                                reason="public_team_requires_organization_kb",
                            )
                        )
                        warning_ids.add(ref.id)
                    continue
            else:
                if not _can_user_read_kb(db, team.user_id, ref.id):
                    if ref.id not in warning_ids:
                        warnings.append(
                            DefaultKnowledgeBaseWarning(
                                knowledge_base_id=ref.id,
                                knowledge_base_name=ref.name,
                                reason="team_owner_cannot_read_kb",
                            )
                        )
                        warning_ids.add(ref.id)
                    continue
            scopes_by_id[ref.id] = KnowledgeBaseScope(
                knowledge_base_id=ref.id,
                scope_restricted=False,
                document_ids=[],
            )

    return DefaultKnowledgeBaseResolution(
        scopes=list(scopes_by_id.values()),
        warnings=warnings,
    )


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
