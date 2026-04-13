# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Skill resolution chain for task skill queries."""

import json as json_lib
import logging
from typing import Any, Dict, List, Set, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.task import TaskResource
from app.schemas.kind import Bot, Ghost, Task, Team
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

logger = logging.getLogger(__name__)


def _batch_load_kinds_by_refs(
    db: Session,
    *,
    user_id: int,
    kind_type: Any,
    refs: Set[Tuple[str, str]],
) -> Dict[Tuple[str, str], Kind]:
    """
    Batch load kinds by namespace/name refs with fallback behavior.

    Behavior aligns with kindReader.get_by_name_and_namespace for BOT/GHOST:
    - default namespace: personal (user_id) first, fallback to public (user_id=0)
    - non-default namespace: group resource lookup
    """
    if not refs:
        return {}

    result: Dict[Tuple[str, str], Kind] = {}
    default_refs = {ref for ref in refs if ref[0] == "default"}
    group_refs = refs - default_refs

    if default_refs:
        default_names = [name for _, name in default_refs]
        if user_id != 0:
            personal_rows = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == kind_type.value,
                    Kind.namespace == "default",
                    Kind.name.in_(default_names),
                    Kind.is_active == True,
                )
                .all()
            )
            for row in personal_rows:
                key = (row.namespace, row.name)
                if key in default_refs:
                    result[key] = row

        missing_default_refs = default_refs - set(result.keys())
        if missing_default_refs:
            missing_names = [name for _, name in missing_default_refs]
            public_rows = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == kind_type.value,
                    Kind.namespace == "default",
                    Kind.name.in_(missing_names),
                    Kind.is_active == True,
                )
                .all()
            )
            for row in public_rows:
                key = (row.namespace, row.name)
                if key in missing_default_refs:
                    result[key] = row

    if group_refs:
        group_names = [name for _, name in group_refs]
        group_namespaces = [namespace for namespace, _ in group_refs]
        group_rows = (
            db.query(Kind)
            .filter(
                Kind.kind == kind_type.value,
                Kind.namespace.in_(group_namespaces),
                Kind.name.in_(group_names),
                Kind.is_active == True,
            )
            .all()
        )
        for row in group_rows:
            key = (row.namespace, row.name)
            if key in group_refs and key not in result:
                result[key] = row

    return result


def resolve_task_skills(db: Session, *, task_id: int, user_id: int) -> Dict[str, Any]:
    """Resolve task skills via task -> team -> bots -> ghosts."""
    from app.services.readers.kinds import KindType, kindReader
    from app.services.task_member_service import task_member_service

    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active.in_(TaskResource.is_active_query()),
        )
        .first()
    )
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

    team = kindReader.get_by_name_and_namespace(
        db, task_owner_id, KindType.TEAM, team_namespace, team_name
    )
    team_owner_id = _resolve_team_owner_id(task=task, task_crd=task_crd, team=team)
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
                fallback_preload_skill_refs[skill_name] = ref_meta
        return {
            "task_id": task_id,
            "team_id": None,
            "team_namespace": team_namespace,
            "skills": fallback_skills,
            "preload_skills": fallback_skills,
            "skill_refs": fallback_skill_refs,
            "preload_skill_refs": fallback_preload_skill_refs,
        }

    team_crd = Team.model_validate(team.json)
    all_skills = set()
    all_preload_skills = set()
    skill_refs: Dict[str, Dict[str, Any]] = {}
    preload_skill_refs: Dict[str, Dict[str, Any]] = {}

    bot_refs = {
        (member.botRef.namespace, member.botRef.name)
        for member in (team_crd.spec.members or [])
        if getattr(member, "botRef", None)
    }
    bot_by_ref = _batch_load_kinds_by_refs(
        db, user_id=team_owner_id, kind_type=KindType.BOT, refs=bot_refs
    )

    bot_crd_by_ref = {}
    ghost_refs: Set[Tuple[str, str]] = set()
    for ref, bot in bot_by_ref.items():
        if not bot:
            continue
        bot_crd = Bot.model_validate(bot.json)
        bot_crd_by_ref[ref] = bot_crd
        if bot_crd.spec.ghostRef:
            ghost_refs.add(
                (bot_crd.spec.ghostRef.namespace, bot_crd.spec.ghostRef.name)
            )

    ghost_by_ref = _batch_load_kinds_by_refs(
        db, user_id=team_owner_id, kind_type=KindType.GHOST, refs=ghost_refs
    )

    for bot_crd in bot_crd_by_ref.values():
        if not bot_crd.spec.ghostRef:
            continue
        ghost_ref = (bot_crd.spec.ghostRef.namespace, bot_crd.spec.ghostRef.name)
        ghost = ghost_by_ref.get(ghost_ref)
        if ghost and ghost.json:
            ghost_crd = Ghost.model_validate(ghost.json)
            if ghost_crd.spec.skills:
                all_skills.update(ghost_crd.spec.skills)
                for skill_name in ghost_crd.spec.skills:
                    ghost_skill_ref = getattr(ghost_crd.spec, "skill_refs", {}) or {}
                    ref_meta = ghost_skill_ref.get(skill_name)
                    if ref_meta:
                        skill_refs[skill_name] = ref_meta.model_dump()
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
                        preload_skill_refs[skill_name] = preload_ref.model_dump()
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
