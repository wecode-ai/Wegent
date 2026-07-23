# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

"""Skill resolution chain for task skill queries."""

import json as json_lib
import logging
from typing import Any, Dict, List, Set, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.schemas.kind import Bot, Ghost, Task, Team
from app.services.kind_ref_resolver import (
    batch_load_kinds_by_refs as _batch_load_kinds_by_refs,
)
from app.services.kind_reference import resolve_kind_reference
from app.services.skill_binding_service import (
    SkillBindingContext,
    skill_binding_service,
)
from app.services.skill_resolution import (
    build_skill_ref_meta,
    find_skill_by_name,
    find_skill_by_ref,
    resolve_skill_refs_by_names,
)
from app.services.subscription.helpers import validate_subscription_for_read
from app.services.task_skill_selection import (
    parse_additional_skill_names_from_labels,
    parse_requested_skill_refs_from_labels,
)
from app.stores.tasks import task_store

logger = logging.getLogger(__name__)


def resolve_task_skills(db: Session, *, task_id: int, user_id: int) -> Dict[str, Any]:
    """Resolve task skills via task -> team -> bots -> ghosts."""
    from app.services.readers.kinds import KindType, kindReader
    from app.services.task_member_service import task_member_service

    task = task_store.get_active_task(db, task_id=task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if not task_member_service.is_member(db, task_id, user_id):
        raise HTTPException(status_code=404, detail="Task not found")

    task_crd = Task.model_validate(task.json)
    team_name = task_crd.spec.teamRef.name
    team_namespace = task_crd.spec.teamRef.namespace
    task_owner_id = task.user_id
    labels = task_crd.metadata.labels or {}
    requested_skill_refs = parse_requested_skill_refs_from_labels(labels)
    user_selected_skills = parse_additional_skill_names_from_labels(labels)

    team_ref = task_crd.spec.teamRef
    if getattr(team_ref, "id", None) is not None:
        team = resolve_kind_reference(
            db,
            kind="Team",
            ref=team_ref,
            actor_user_id=getattr(team_ref, "user_id", None) or task_owner_id,
        ).resource
    else:
        team = kindReader.get_by_name_and_namespace(
            db,
            getattr(team_ref, "user_id", None) or task_owner_id,
            KindType.TEAM,
            team_namespace,
            team_name,
        )
    team_owner_id = _resolve_team_owner_id(task=task, task_crd=task_crd, team=team)
    binding_context = _build_skill_binding_context(
        task=task,
        task_crd=task_crd,
        team=team,
    )
    if not team:
        logger.warning(
            "[get_task_skills] Team not found for task %s: namespace=%s, name=%s",
            task_id,
            team_namespace,
            team_name,
        )
        fallback_skills = list(user_selected_skills)
        fallback_skill_refs: Dict[str, Dict[str, Any]] = {}
        fallback_preload_skill_refs: Dict[str, Dict[str, Any]] = {}
        fallback_preload_skills = set(fallback_skills)
        _merge_user_default_skill_refs(
            db,
            user_id=user_id,
            skills=set(fallback_skills),
            skill_refs=fallback_skill_refs,
            preload_skills=fallback_preload_skills,
            preload_skill_refs=fallback_preload_skill_refs,
            context=binding_context,
        )
        fallback_skills = list(fallback_skill_refs.keys() | set(fallback_skills))
        for requested_ref in requested_skill_refs:
            skill_name = requested_ref["name"]
            if skill_name not in fallback_skills:
                fallback_skills.append(skill_name)
            skill = find_skill_by_ref(
                db,
                skill_name=skill_name,
                namespace=requested_ref["namespace"],
                is_public=requested_ref["is_public"],
                user_id=team_owner_id,
                team_namespace=team_namespace or "default",
            )
            if skill:
                ref_meta = build_skill_ref_meta(skill)
                fallback_skill_refs[skill_name] = ref_meta
                fallback_preload_skills.add(skill_name)
                fallback_preload_skill_refs[skill_name] = ref_meta
        return {
            "task_id": task_id,
            "team_id": None,
            "team_namespace": team_namespace,
            "skills": fallback_skills,
            "preload_skills": sorted(fallback_preload_skills),
            "skill_refs": fallback_skill_refs,
            "preload_skill_refs": fallback_preload_skill_refs,
        }

    team_crd = Team.model_validate(team.json)
    all_skills = set()
    all_preload_skills = set()
    skill_refs: Dict[str, Dict[str, Any]] = {}
    preload_skill_refs: Dict[str, Dict[str, Any]] = {}

    members = team_crd.spec.members or []
    legacy_bot_refs = {
        (member.botRef.namespace, member.botRef.name)
        for member in members
        if getattr(member.botRef, "id", None) is None
    }
    legacy_bots = _batch_load_kinds_by_refs(
        db,
        user_id=team_owner_id,
        kind_type=KindType.BOT,
        refs=legacy_bot_refs,
    )

    bot_crds = []
    for member in members:
        bot_ref = member.botRef
        if getattr(bot_ref, "id", None) is not None:
            bot = resolve_kind_reference(
                db,
                kind="Bot",
                ref=bot_ref,
                actor_user_id=team_owner_id,
            ).resource
        else:
            bot = legacy_bots.get((bot_ref.namespace, bot_ref.name))
        if bot and bot.json:
            bot_crds.append(Bot.model_validate(bot.json))

    legacy_ghost_refs = {
        (bot_crd.spec.ghostRef.namespace, bot_crd.spec.ghostRef.name)
        for bot_crd in bot_crds
        if bot_crd.spec.ghostRef and getattr(bot_crd.spec.ghostRef, "id", None) is None
    }
    legacy_ghosts = _batch_load_kinds_by_refs(
        db,
        user_id=team_owner_id,
        kind_type=KindType.GHOST,
        refs=legacy_ghost_refs,
    )

    for bot_crd in bot_crds:
        if not bot_crd.spec.ghostRef:
            continue
        ghost_ref = bot_crd.spec.ghostRef
        if getattr(ghost_ref, "id", None) is not None:
            ghost = resolve_kind_reference(
                db,
                kind="Ghost",
                ref=ghost_ref,
                actor_user_id=team_owner_id,
            ).resource
        else:
            ghost = legacy_ghosts.get((ghost_ref.namespace, ghost_ref.name))
        if ghost and ghost.json:
            ghost_crd = Ghost.model_validate(ghost.json)
            if ghost_crd.spec.skills:
                all_skills.update(ghost_crd.spec.skills)
                for skill_name in ghost_crd.spec.skills:
                    ghost_skill_ref = getattr(ghost_crd.spec, "skill_refs", {}) or {}
                    ref_meta = ghost_skill_ref.get(skill_name)
                    if ref_meta:
                        resolved_ref = ref_meta.model_dump()
                        if not resolved_ref.get("content_hash"):
                            skill = find_skill_by_name(
                                db,
                                skill_name=skill_name,
                                owner_user_id=team_owner_id,
                                team_namespace=team.namespace or "default",
                            )
                            if skill:
                                resolved_ref["content_hash"] = build_skill_ref_meta(
                                    skill
                                ).get("content_hash")
                        skill_refs[skill_name] = resolved_ref
                    else:
                        skill = find_skill_by_name(
                            db,
                            skill_name=skill_name,
                            owner_user_id=team_owner_id,
                            team_namespace=team.namespace or "default",
                        )
                        if skill:
                            skill_refs[skill_name] = build_skill_ref_meta(skill)
            if ghost_crd.spec.preload_skills:
                all_preload_skills.update(ghost_crd.spec.preload_skills)
                ghost_preload_refs = (
                    getattr(ghost_crd.spec, "preload_skill_refs", {}) or {}
                )
                for skill_name in ghost_crd.spec.preload_skills:
                    preload_ref = ghost_preload_refs.get(skill_name)
                    if preload_ref:
                        resolved_ref = preload_ref.model_dump()
                        if not resolved_ref.get("content_hash"):
                            resolved_ref["content_hash"] = skill_refs.get(
                                skill_name, {}
                            ).get("content_hash")
                        preload_skill_refs[skill_name] = resolved_ref
                    elif skill_name in skill_refs:
                        preload_skill_refs[skill_name] = skill_refs[skill_name]
        else:
            logger.warning(
                "[get_task_skills] Ghost missing for bot ghostRef=%s",
                ghost_ref,
            )

    subscription_skill_refs = _get_subscription_skill_refs_for_task(db, task_id=task_id)
    if subscription_skill_refs:
        for requested_ref in subscription_skill_refs:
            skill_name = requested_ref.name
            all_skills.add(skill_name)
            all_preload_skills.add(skill_name)
            skill = find_skill_by_ref(
                db,
                skill_name=skill_name,
                namespace=requested_ref.namespace,
                is_public=requested_ref.is_public,
                user_id=team_owner_id,
                team_namespace=team.namespace or "default",
            )
            if skill:
                ref_meta = build_skill_ref_meta(skill)
                skill_refs[skill_name] = ref_meta
                preload_skill_refs[skill_name] = ref_meta
            else:
                logger.warning(
                    "[get_task_skills] Subscription skill ref could not be resolved for task %s: %s/%s public=%s",
                    task_id,
                    requested_ref.namespace,
                    requested_ref.name,
                    requested_ref.is_public,
                )

    _merge_user_default_skill_refs(
        db,
        user_id=user_id,
        skills=all_skills,
        skill_refs=skill_refs,
        preload_skills=all_preload_skills,
        preload_skill_refs=preload_skill_refs,
        context=binding_context,
    )

    if requested_skill_refs:
        for requested_ref in requested_skill_refs:
            skill_name = requested_ref["name"]
            all_skills.add(skill_name)
            all_preload_skills.add(skill_name)
            skill = find_skill_by_ref(
                db,
                skill_name=skill_name,
                namespace=requested_ref["namespace"],
                is_public=requested_ref["is_public"],
                user_id=team_owner_id,
                team_namespace=team.namespace or "default",
            )
            if skill:
                ref_meta = build_skill_ref_meta(skill)
                skill_refs[skill_name] = ref_meta
                preload_skill_refs[skill_name] = ref_meta
            else:
                logger.warning(
                    "[get_task_skills] Requested task skill ref could not be resolved for task %s: %s/%s public=%s",
                    task_id,
                    requested_ref["namespace"],
                    skill_name,
                    requested_ref["is_public"],
                )
    elif user_selected_skills:
        all_skills.update(user_selected_skills)
        all_preload_skills.update(user_selected_skills)
        resolved_user_refs = resolve_skill_refs_by_names(
            db,
            skill_names=user_selected_skills,
            user_id=team_owner_id,
            namespace=team.namespace or "default",
        )
        skill_refs.update(resolved_user_refs)
        for skill_name, ref_meta in resolved_user_refs.items():
            preload_skill_refs[skill_name] = ref_meta

    for skill_name in list(all_preload_skills):
        if skill_name not in preload_skill_refs and skill_name in skill_refs:
            preload_skill_refs[skill_name] = skill_refs[skill_name]

    logger.info(
        "[get_task_skills] Resolved task skills: task_id=%s, team_id=%s, skills=%s, preload_skills=%s, skill_refs=%s, preload_skill_refs=%s",
        task_id,
        team.id,
        list(all_skills),
        list(all_preload_skills),
        list(skill_refs.keys()),
        list(preload_skill_refs.keys()),
    )

    return {
        "task_id": task_id,
        "team_id": team.id,
        "team_namespace": team.namespace or "default",
        "skills": sorted(all_skills),
        "preload_skills": sorted(all_preload_skills),
        "skill_refs": skill_refs,
        "preload_skill_refs": preload_skill_refs,
    }


def _merge_user_default_skill_refs(
    db: Session,
    *,
    user_id: int,
    skills: set[str],
    skill_refs: Dict[str, Dict[str, Any]],
    preload_skills: set[str],
    preload_skill_refs: Dict[str, Dict[str, Any]],
    context: SkillBindingContext,
) -> None:
    """Merge the user's automatic Skill bindings into available/preloaded Skills."""
    for ref in skill_binding_service.list_user_default_skill_refs(
        db,
        user_id,
        context=context,
    ):
        skill_name = ref["name"]
        skills.add(skill_name)
        if skill_name not in skill_refs:
            skill_refs[skill_name] = {
                "skill_id": ref["skill_id"],
                "namespace": ref.get("namespace", "default"),
                "is_public": ref.get("is_public", False),
            }
        if ref.get("force_preload"):
            preload_skills.add(skill_name)
            preload_skill_refs[skill_name] = skill_refs[skill_name]


def _derive_task_mode(task_crd: Task) -> str:
    labels = task_crd.metadata.labels or {}
    return str(labels.get("taskType") or labels.get("type") or "chat")


def _build_skill_binding_context(
    *, task: TaskResource, task_crd: Task, team: Kind | None
) -> SkillBindingContext:
    return SkillBindingContext(
        mode=_derive_task_mode(task_crd),
        agent_id=team.id if team else None,
        project_id=getattr(task, "project_id", None),
    )


def _resolve_team_owner_id(
    *, task: TaskResource, task_crd: Task, team: Kind | None
) -> int:
    """Resolve the owner used for team-scoped resource lookups.

    Shared teams execute under the task creator's context, but their related
    Bots, Ghosts, and private Skills still belong to the original team owner.
    """
    if team and getattr(team, "user_id", None):
        return team.user_id

    team_ref_user_id = getattr(task_crd.spec.teamRef, "user_id", None)
    if team_ref_user_id:
        return team_ref_user_id

    return task.user_id


def _get_subscription_skill_refs_for_task(db: Session, *, task_id: int) -> List[Any]:
    """Load subscription skillRefs for a task when the task belongs to a subscription."""
    execution = (
        db.query(BackgroundExecution)
        .filter(BackgroundExecution.task_id == task_id)
        .order_by(BackgroundExecution.created_at.desc())
        .first()
    )
    if not execution or not execution.subscription_id:
        return []

    subscription = (
        db.query(Kind)
        .filter(
            Kind.id == execution.subscription_id,
            Kind.kind == "Subscription",
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )
    if not subscription or not subscription.json:
        return []

    try:
        subscription_crd = validate_subscription_for_read(subscription.json)
    except Exception as exc:
        logger.warning(
            "[get_task_skills] Failed to parse subscription %s for task %s: %s",
            execution.subscription_id,
            task_id,
            exc,
        )
        return []

    return list(subscription_crd.spec.skillRefs or [])
