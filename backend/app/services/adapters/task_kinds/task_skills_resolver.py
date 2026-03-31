# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Skill resolution chain for task skill queries."""

import json as json_lib
import logging
from typing import Any, Dict, Set, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.task import TaskResource
from app.schemas.kind import Bot, Ghost, Task, Team

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

    user_selected_skills = []
    if task_crd.metadata.labels:
        additional_skills_json = task_crd.metadata.labels.get("additionalSkills")
        if additional_skills_json:
            try:
                parsed_skills = json_lib.loads(additional_skills_json)
                if isinstance(parsed_skills, list):
                    user_selected_skills = [
                        skill
                        for skill in parsed_skills
                        if isinstance(skill, str) and skill
                    ]
                    logger.info(
                        "[get_task_skills] Found %s user-selected skills from task labels: %s",
                        len(user_selected_skills),
                        user_selected_skills,
                    )
            except json_lib.JSONDecodeError as exc:
                logger.warning(
                    "[get_task_skills] Failed to parse additionalSkills JSON for task %s: %s",
                    task_id,
                    exc,
                )

    team = kindReader.get_by_name_and_namespace(
        db, task_owner_id, KindType.TEAM, team_namespace, team_name
    )
    if not team:
        logger.warning(
            "[get_task_skills] Team not found for task %s: namespace=%s, name=%s",
            task_id,
            team_namespace,
            team_name,
        )
        return {
            "task_id": task_id,
            "team_id": None,
            "team_namespace": team_namespace,
            "skills": user_selected_skills,
            "preload_skills": [],
        }

    team_crd = Team.model_validate(team.json)
    all_skills = set()
    all_preload_skills = set()

    bot_refs = {
        (member.botRef.namespace, member.botRef.name)
        for member in (team_crd.spec.members or [])
        if getattr(member, "botRef", None)
    }
    bot_by_ref = _batch_load_kinds_by_refs(
        db, user_id=task_owner_id, kind_type=KindType.BOT, refs=bot_refs
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
        db, user_id=task_owner_id, kind_type=KindType.GHOST, refs=ghost_refs
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
            if ghost_crd.spec.preload_skills:
                all_preload_skills.update(ghost_crd.spec.preload_skills)

    if user_selected_skills:
        all_skills.update(user_selected_skills)

    logger.info(
        "[get_task_skills] task_id=%s, team_id=%s, skills=%s, preload_skills=%s, user_selected_skills=%s",
        task_id,
        team.id,
        list(all_skills),
        list(all_preload_skills),
        user_selected_skills,
    )

    return {
        "task_id": task_id,
        "team_id": team.id,
        "team_namespace": team.namespace or "default",
        "skills": list(all_skills),
        "preload_skills": list(all_preload_skills),
    }
