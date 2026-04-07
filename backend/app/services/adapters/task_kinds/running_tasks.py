# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for finding active running tasks that belong to a team."""

from typing import Any, Dict, Iterable, List, Optional, Set

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.schemas.kind import Task
from app.services.group_member_helper import get_group_members
from app.services.readers.groups import groupReader

RUNNING_TASK_STATUSES = frozenset({"PENDING", "RUNNING"})


def _iterate_namespace_ancestors(namespace: str) -> Iterable[str]:
    parts = namespace.split("/")
    for index in range(1, len(parts) + 1):
        yield "/".join(parts[:index])


def _get_candidate_task_user_ids(db: Session, team: Kind) -> Optional[Set[int]]:
    """Return candidate task owners for a team, or None when narrowing is unsafe."""
    if team.namespace == "default":
        shared_user_ids = {
            row[0]
            for row in (
                db.query(ResourceMember.user_id)
                .filter(
                    ResourceMember.resource_type == ResourceType.TEAM,
                    ResourceMember.resource_id == team.id,
                    ResourceMember.status == MemberStatus.APPROVED,
                )
                .all()
            )
        }
        return {team.user_id, *shared_user_ids}

    if groupReader.is_public(db, team.namespace):
        return None

    candidate_user_ids = {team.user_id}
    for group_name in _iterate_namespace_ancestors(team.namespace):
        for member in get_group_members(db, group_name):
            candidate_user_ids.add(member.user_id)

    return candidate_user_ids


def _task_belongs_to_team(task: TaskResource, task_crd: Task, team: Kind) -> bool:
    team_ref = getattr(task_crd.spec, "teamRef", None)
    if not team_ref:
        return False

    if team_ref.name != team.name or team_ref.namespace != team.namespace:
        return False

    task_status = task_crd.status.status if task_crd.status else None
    if task_status not in RUNNING_TASK_STATUSES:
        return False

    if team.namespace != "default":
        return True

    team_ref_user_id = getattr(team_ref, "user_id", None)
    if team_ref_user_id is not None:
        return team_ref_user_id == team.user_id

    return task.user_id == team.user_id


def get_running_tasks_for_team(db: Session, team: Kind) -> List[Dict[str, Any]]:
    """Load running tasks for the provided team without JSON filtering in SQL."""
    query = db.query(TaskResource).filter(
        TaskResource.kind == "Task",
        TaskResource.is_active == TaskResource.STATE_ACTIVE,
    )

    candidate_user_ids = _get_candidate_task_user_ids(db, team)
    if candidate_user_ids:
        query = query.filter(TaskResource.user_id.in_(sorted(candidate_user_ids)))

    running_tasks: List[Dict[str, Any]] = []
    for task in query.all():
        task_crd = Task.model_validate(task.json)
        if not _task_belongs_to_team(task, task_crd, team):
            continue

        running_tasks.append(
            {
                "task_id": task.id,
                "task_name": task.name,
                "task_title": task_crd.spec.title,
                "status": task_crd.status.status if task_crd.status else "UNKNOWN",
            }
        )

    return running_tasks
