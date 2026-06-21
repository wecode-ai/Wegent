# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Task helper utilities.

This module contains helper functions for task operations,
including subtask creation and batch data fetching.
"""

import logging
from typing import Any, Dict, List

from fastapi import HTTPException
from sqlalchemy import and_, func, or_, tuple_
from sqlalchemy.orm import Session

import app.stores.tasks as task_stores
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.schemas.base_role import BaseRole
from app.schemas.kind import Task, Team, Workspace
from app.services.adapters.pipeline_stage import pipeline_stage_service
from app.services.device.display_name import resolve_device_display_name
from app.services.readers.kinds import KindType, kindReader
from app.services.readers.users import userReader
from app.services.task_fork_history import task_fork_history_resolver
from app.stores.tasks import WorkspaceRefLookup

from .converters import (
    get_task_execution_workspace_path,
    get_task_execution_workspace_source,
)

logger = logging.getLogger(__name__)

REPORTER_OR_HIGHER_ROLES = (
    BaseRole.Owner.value,
    BaseRole.Maintainer.value,
    BaseRole.Developer.value,
    BaseRole.Reporter.value,
)


def create_subtasks(
    db: Session, task: Kind, team: Kind, user_id: int, user_prompt: str
) -> None:
    """
    Create subtasks based on team's workflow configuration.

    Args:
        db: Database session
        task: Task Kind object
        team: Team Kind object
        user_id: User ID
        user_prompt: User's prompt text
    """
    logger.info(
        f"create_subtasks called with task_id={task.id}, team_id={team.id}, user_id={user_id}"
    )
    team_crd = Team.model_validate(team.json)
    task_crd = Task.model_validate(task.json)

    if not team_crd.spec.members:
        logger.warning(f"No members configured in team {team.id}")
        raise HTTPException(status_code=400, detail="No members configured in team")

    # Get bot IDs from team members
    bot_ids = []
    for member in team_crd.spec.members:
        # Find bot using kindReader
        bot = kindReader.get_by_name_and_namespace(
            db,
            team.user_id,
            KindType.BOT,
            member.botRef.namespace,
            member.botRef.name,
        )
        if bot:
            bot_ids.append(bot.id)

    if not bot_ids:
        raise HTTPException(
            status_code=400,
            detail="No valid bots found in team configuration, please check that the bots referenced by the team exist and are active",
        )

    existing_subtasks = [
        item.subtask
        for item in task_fork_history_resolver.resolve_for_task(
            db,
            task_id=task.id,
            user_id=user_id,
        )
    ]
    next_message_id = task_fork_history_resolver.get_next_message_id(
        db,
        task_id=task.id,
        user_id=user_id,
    )
    parent_id = next_message_id - 1 if next_message_id > 1 else 0

    collaboration_model = team_crd.spec.collaborationModel
    if collaboration_model == "pipeline":
        assistant_title, assistant_bot_ids = _build_pipeline_assistant_subtask_plan(
            db,
            task,
            team,
            team_crd,
            task_crd,
            existing_subtasks,
        )
    else:
        assistant_title, assistant_bot_ids = _build_standard_assistant_subtask_plan(
            task_crd,
            bot_ids,
        )

    task_stores.subtask_store.create_user_and_assistant_subtasks(
        db,
        user_id=user_id,
        task_id=task.id,
        team_id=team.id,
        title=f"{task_crd.spec.title} - User",
        assistant_title=assistant_title,
        bot_ids=assistant_bot_ids,
        prompt=user_prompt,
        user_message_id=next_message_id,
        user_parent_id=parent_id,
        assistant_message_id=next_message_id + 1,
        assistant_parent_id=next_message_id,
        progress=0,
    )


def _build_pipeline_assistant_subtask_plan(
    db: Session,
    task: Kind,
    team: Kind,
    team_crd: Team,
    task_crd: Task,
    existing_subtasks: List[Subtask],
) -> tuple[str, List[int]]:
    """Build assistant subtask title and bot IDs for pipeline collaboration."""
    # Pipeline mode: determine which bot to create subtask for
    # Use pipeline_stage_service to get current stage from task.spec.currentStage
    should_stay, current_stage_index = (
        pipeline_stage_service.should_stay_at_current_stage(db, task.id, team_crd)
    )

    # Determine which stage to create subtask for
    # current_stage_index is always valid (defaults to 0)
    if should_stay:
        target_stage_index = current_stage_index
        logger.info(
            f"Pipeline create_subtasks: staying at stage {target_stage_index} (requireConfirmation)"
        )
    elif existing_subtasks:
        target_stage_index = current_stage_index
        logger.info(
            f"Pipeline create_subtasks: follow-up at stage {target_stage_index}"
        )
    else:
        target_stage_index = 0
        logger.info(
            f"Pipeline create_subtasks: new conversation, starting from stage 0"
        )

    # Get the target bot for the determined stage
    target_member = team_crd.spec.members[target_stage_index]
    bot = kindReader.get_by_name_and_namespace(
        db,
        team.user_id,
        KindType.BOT,
        target_member.botRef.namespace,
        target_member.botRef.name,
    )

    if bot is None:
        raise Exception(f"Bot {target_member.botRef.name} not found in kinds table")

    return f"{task_crd.spec.title} - {bot.name}", [bot.id]


def _build_standard_assistant_subtask_plan(
    task_crd: Task,
    bot_ids: List[int],
) -> tuple[str, List[int]]:
    """Build assistant subtask title and bot IDs for standard collaboration."""
    return f"{task_crd.spec.title} - Assistant", bot_ids


def get_tasks_related_data_batch(
    db: Session, tasks: List[Kind], user_id: int
) -> Dict[str, Dict[str, Any]]:
    """
    Batch get workspace and team data for multiple tasks to reduce database queries.

    Args:
        db: Database session
        tasks: List of Task Kind objects
        user_id: User ID for looking up related data

    Returns:
        Dict mapping task ID (as string) to related data dict
    """
    if not tasks:
        return {}

    # Extract workspace and team references from all tasks
    workspace_refs = set()
    team_refs = set()
    device_ids = set()
    task_crd_map = {}

    for task in tasks:
        task_crd = Task.model_validate(task.json)
        task_crd_map[task.id] = task_crd

        if hasattr(task_crd.spec, "workspaceRef") and task_crd.spec.workspaceRef:
            workspace_refs.add(
                (
                    task_crd.spec.workspaceRef.name,
                    task_crd.spec.workspaceRef.namespace,
                )
            )

        if hasattr(task_crd.spec, "teamRef") and task_crd.spec.teamRef:
            team_refs.add((task_crd.spec.teamRef.name, task_crd.spec.teamRef.namespace))

        device_id = getattr(task_crd.spec, "device_id", None)
        if device_id:
            device_ids.add(device_id)

    # Batch query workspaces
    workspace_data = _batch_query_workspaces(db, workspace_refs, user_id)

    # Batch query teams (including shared teams)
    team_data = _batch_query_teams(db, team_refs, user_id)

    # Batch query device display names
    device_data = _batch_query_devices(db, device_ids, user_id)

    # Get user info once
    user = userReader.get_by_id(db, user_id)
    user_name = user.user_name if user else ""

    # Build result mapping
    result = {}
    for task in tasks:
        task_crd = task_crd_map[task.id]

        # Get workspace data
        workspace_key = (
            f"{task_crd.spec.workspaceRef.name}:{task_crd.spec.workspaceRef.namespace}"
        )
        task_workspace_data = workspace_data.get(
            workspace_key,
            {
                "git_url": "",
                "git_repo": "",
                "git_repo_id": 0,
                "git_domain": "",
                "branch_name": "",
            },
        )

        # Get team data
        team_key = f"{task_crd.spec.teamRef.name}:{task_crd.spec.teamRef.namespace}"
        task_team = team_data.get(team_key)
        team_id = task_team.id if task_team else None
        team_name = task_team.name if task_team else task_crd.spec.teamRef.name
        team_namespace = (
            task_team.namespace if task_team else task_crd.spec.teamRef.namespace
        )
        team_display_name = _get_team_display_name(task_team)
        team_icon = _get_team_icon(task_team)

        device_id = getattr(task_crd.spec, "device_id", None)
        device_name = device_data.get(device_id) if device_id else None

        # Parse timestamps
        created_at = None
        updated_at = None
        completed_at = None

        if task_crd.status:
            try:
                if task_crd.status.createdAt:
                    created_at = task_crd.status.createdAt
                if task_crd.status.updatedAt:
                    updated_at = task_crd.status.updatedAt
                if task_crd.status.completedAt:
                    completed_at = task_crd.status.completedAt
            except:
                # Fallback to task timestamps
                created_at = task.created_at
                updated_at = task.updated_at

        result[str(task.id)] = {
            "workspace_data": task_workspace_data,
            "team_id": team_id,
            "team_name": team_name,
            "team_namespace": team_namespace,
            "team_display_name": team_display_name,
            "team_icon": team_icon,
            "device_id": device_id,
            "device_name": device_name,
            "user_name": user_name,
            "created_at": created_at or task.created_at,
            "updated_at": updated_at or task.updated_at,
            "completed_at": completed_at,
        }

    # Add is_group_chat to result
    _add_group_chat_info(db, tasks, result)

    return result


def _get_team_display_name(team: Kind | None) -> str | None:
    """Return a team's display name from CRD metadata if available."""
    if not team or not team.json:
        return None
    try:
        team_crd = Team.model_validate(team.json)
        return team_crd.metadata.displayName
    except Exception:
        return team.json.get("metadata", {}).get("displayName")


def _get_team_icon(team: Kind | None) -> str | None:
    """Return a team's configured icon from CRD spec if available."""
    if not team or not team.json:
        return None
    try:
        team_crd = Team.model_validate(team.json)
        return team_crd.spec.icon
    except Exception:
        return team.json.get("spec", {}).get("icon")


def _batch_query_workspaces(
    db: Session, workspace_refs: set, user_id: int
) -> Dict[str, Dict[str, Any]]:
    """Batch query workspaces and return data dict."""
    workspace_data = {}
    if not workspace_refs:
        return workspace_data

    workspaces = task_stores.task_store.list_workspaces_by_refs(
        db,
        refs=[
            WorkspaceRefLookup(user_id=user_id, name=name, namespace=namespace)
            for name, namespace in workspace_refs
        ],
    )

    for workspace in workspaces:
        key = f"{workspace.name}:{workspace.namespace}"
        if workspace.json:
            try:
                workspace_crd = Workspace.model_validate(workspace.json)
                workspace_data[key] = {
                    "git_url": workspace_crd.spec.repository.gitUrl,
                    "git_repo": workspace_crd.spec.repository.gitRepo,
                    "git_repo_id": workspace_crd.spec.repository.gitRepoId or 0,
                    "git_domain": workspace_crd.spec.repository.gitDomain,
                    "branch_name": workspace_crd.spec.repository.branchName,
                }
            except Exception:
                workspace_data[key] = {
                    "git_url": "",
                    "git_repo": "",
                    "git_repo_id": 0,
                    "git_domain": "",
                    "branch_name": "",
                }
        else:
            workspace_data[key] = {
                "git_url": "",
                "git_repo": "",
                "git_repo_id": 0,
                "git_domain": "",
                "branch_name": "",
            }

    return workspace_data


def _batch_query_teams(db: Session, team_refs: set, user_id: int) -> Dict[str, Kind]:
    """Batch query teams (including shared teams) and return data dict."""
    if not team_refs:
        return {}

    team_resource_type_variants = [ResourceType.TEAM.value, ResourceType.TEAM.name]
    approved_status_variants = [MemberStatus.APPROVED.value, "APPROVED"]
    accessible_team_ids = _get_accessible_team_ids(
        db, user_id, team_resource_type_variants, approved_status_variants
    )
    owner_filter = Kind.user_id.in_([user_id, 0])
    access_filter = (
        or_(owner_filter, Kind.id.in_(accessible_team_ids))
        if accessible_team_ids
        else owner_filter
    )
    accessible_teams = (
        db.query(Kind)
        .filter(
            Kind.kind == "Team",
            tuple_(Kind.name, Kind.namespace).in_(team_refs),
            Kind.is_active.is_(True),
            access_filter,
        )
        .all()
    )

    team_data: Dict[str, Kind] = {}
    team_priorities: Dict[str, int] = {}
    for team in accessible_teams:
        key = f"{team.name}:{team.namespace}"
        priority = _get_team_scope_priority(team, user_id)
        if key not in team_data or priority < team_priorities[key]:
            team_data[key] = team
            team_priorities[key] = priority

    return team_data


def _get_accessible_team_ids(
    db: Session,
    user_id: int,
    team_resource_type_variants: List[str],
    approved_status_variants: List[str],
) -> set[int]:
    """Return shared Team ids accessible to a user without SQL subqueries."""
    team_ids = _get_direct_shared_team_ids(
        db, user_id, team_resource_type_variants, approved_status_variants
    )
    namespace_ids = _get_user_accessible_namespace_ids(
        db, user_id, approved_status_variants
    )
    if namespace_ids:
        team_ids.update(
            _get_namespace_granted_team_ids(
                db,
                namespace_ids,
                team_resource_type_variants,
                approved_status_variants,
            )
        )
    return team_ids


def _get_direct_shared_team_ids(
    db: Session,
    user_id: int,
    team_resource_type_variants: List[str],
    approved_status_variants: List[str],
) -> set[int]:
    """Return Team ids directly shared with the user."""
    rows = (
        db.query(ResourceMember.resource_id)
        .filter(
            ResourceMember.resource_type.in_(team_resource_type_variants),
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.status.in_(approved_status_variants),
        )
        .all()
    )
    return {row.resource_id for row in rows}


def _get_user_accessible_namespace_ids(
    db: Session, user_id: int, approved_status_variants: List[str]
) -> set[str]:
    """Return namespace ids accessible through direct or parent membership."""
    direct_namespaces = (
        db.query(Namespace.id, Namespace.name)
        .join(
            ResourceMember,
            and_(
                ResourceMember.resource_type == "Namespace",
                ResourceMember.resource_id == Namespace.id,
            ),
        )
        .filter(
            Namespace.is_active.is_(True),
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.status.in_(approved_status_variants),
            ResourceMember.role.in_(REPORTER_OR_HIGHER_ROLES),
        )
        .all()
    )
    namespace_ids = {str(row.id) for row in direct_namespaces}
    parent_names = [row.name for row in direct_namespaces]
    if not parent_names:
        return namespace_ids

    child_filters = [
        Namespace.name.like(f"{_escape_sql_like(name)}/%", escape="\\")
        for name in parent_names
    ]
    child_rows = (
        db.query(Namespace.id)
        .filter(Namespace.is_active.is_(True), or_(*child_filters))
        .all()
    )
    namespace_ids.update(str(row.id) for row in child_rows)
    return namespace_ids


def _escape_sql_like(value: str) -> str:
    """Escape SQL LIKE wildcard characters."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _get_namespace_granted_team_ids(
    db: Session,
    namespace_ids: set[str],
    team_resource_type_variants: List[str],
    approved_status_variants: List[str],
) -> set[int]:
    """Return Team ids granted to accessible namespaces."""
    rows = (
        db.query(ResourceMember.resource_id)
        .filter(
            ResourceMember.resource_type.in_(team_resource_type_variants),
            ResourceMember.entity_type == "namespace",
            ResourceMember.entity_id.in_(namespace_ids),
            ResourceMember.status.in_(approved_status_variants),
        )
        .all()
    )
    return {row.resource_id for row in rows}


def _get_team_scope_priority(team: Kind, user_id: int) -> int:
    """Return lower priority for the preferred team scope."""
    if team.user_id == user_id:
        return 0
    if team.user_id == 0:
        return 2
    return 1


def _batch_query_devices(
    db: Session, device_ids: set[str], user_id: int
) -> Dict[str, str]:
    """Batch query device display names by device ID."""
    if not device_ids:
        return {}

    devices = (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.name.in_(device_ids),
            Kind.is_active.is_(True),
        )
        .all()
    )

    device_data = {}
    for device in devices:
        device_json = device.json or {}
        device_data[device.name] = resolve_device_display_name(device_json, device.name)

    return device_data


def _add_group_chat_info(
    db: Session, tasks: List[Kind], result: Dict[str, Dict[str, Any]]
) -> None:
    """Add is_group_chat info to result dict using ResourceMember."""
    from app.models.resource_member import MemberStatus, ResourceMember
    from app.models.share_link import ResourceType

    task_ids = [t.id for t in tasks]
    member_count_results = (
        db.query(
            ResourceMember.resource_id, func.count(ResourceMember.id).label("count")
        )
        .filter(
            ResourceMember.resource_type == ResourceType.TASK,
            ResourceMember.resource_id.in_(task_ids),
            ResourceMember.status == MemberStatus.APPROVED,
            # Exclude share records (copied_resource_id > 0), only count actual group chat members
            ResourceMember.copied_resource_id == 0,
        )
        .group_by(ResourceMember.resource_id)
        .all()
    )
    member_counts = {row[0]: row[1] for row in member_count_results}

    task_map = {task.id: task for task in tasks}

    # Add is_group_chat to result
    for task_id_str, data in result.items():
        task_id = int(task_id_str)
        # Use the access store so sharded and legacy task metadata stay consistent.
        task = task_map.get(task_id)
        is_group_chat = task_stores.task_access_store.is_group_chat(db, task_id=task_id)
        if task and not is_group_chat:
            task_json = task.json if task.json else {}
            is_group_chat = task_json.get("spec", {}).get("is_group_chat", False)
        if not is_group_chat:
            is_group_chat = member_counts.get(task_id, 0) > 0
        data["is_group_chat"] = is_group_chat


def build_lite_task_list(
    db: Session,
    tasks: List[TaskResource],
    user_id: int,
) -> List[Dict[str, Any]]:
    """
    Build lightweight task list result from task resources.

    Shared helper method for get_user_group_tasks_lite and get_user_personal_tasks_lite.

    Args:
        db: Database session
        tasks: List of TaskResource objects
        user_id: User ID for looking up related data

    Returns:
        List of task dictionaries with essential fields
    """
    if not tasks:
        return []

    related_data_batch = get_tasks_related_data_batch(db, tasks, user_id)

    result = []
    for task in tasks:
        task_crd = Task.model_validate(task.json)
        task_related_data = related_data_batch.get(str(task.id), {})
        workspace_data = task_related_data.get("workspace_data", {})

        # Extract basic fields from task JSON
        task_type = (
            task_crd.metadata.labels
            and task_crd.metadata.labels.get("taskType")
            or "chat"
        )
        type_value = (
            task_crd.metadata.labels
            and task_crd.metadata.labels.get("type")
            or "online"
        )
        labels = task_crd.metadata.labels or {}
        source_label = labels.get("source")
        source = source_label if isinstance(source_label, str) else None
        status = task_crd.status.status if task_crd.status else "PENDING"

        created_at = task_related_data.get("created_at", task.created_at)
        updated_at = task_related_data.get("updated_at", task.updated_at)
        completed_at = task_related_data.get("completed_at")
        team_id = task_related_data.get("team_id")
        team_name = task_related_data.get("team_name")
        team_namespace = task_related_data.get("team_namespace")
        team_display_name = task_related_data.get("team_display_name")
        team_icon = task_related_data.get("team_icon")
        device_id = task_related_data.get("device_id")
        device_name = task_related_data.get("device_name")
        execution_workspace_source = get_task_execution_workspace_source(task_crd)
        execution_workspace_path = get_task_execution_workspace_path(task_crd)
        git_repo = workspace_data.get("git_repo")
        is_group_chat = task_related_data.get(
            "is_group_chat",
            (task.json or {}).get("spec", {}).get("is_group_chat", False),
        )

        # Extract knowledge_base_id from knowledgeBaseRefs for knowledge type tasks
        knowledge_base_id = None
        if task_type == "knowledge" and task_crd.spec.knowledgeBaseRefs:
            # Get the first knowledge base reference's id
            first_kb_ref = task_crd.spec.knowledgeBaseRefs[0]
            knowledge_base_id = first_kb_ref.id

        result.append(
            {
                "id": task.id,
                "title": task_crd.spec.title,
                "status": status,
                "task_type": task_type,
                "type": type_value,
                "source": source,
                "created_at": created_at,
                "updated_at": updated_at,
                "completed_at": completed_at,
                "team_id": team_id,
                "team_name": team_name,
                "team_namespace": team_namespace,
                "team_display_name": team_display_name,
                "team_icon": team_icon,
                "project_id": task.project_id or 0,
                "client_origin": task.client_origin,
                "device_id": device_id,
                "device_name": device_name,
                "execution_workspace_source": execution_workspace_source,
                "execution_workspace_path": execution_workspace_path,
                "git_repo": git_repo,
                "is_group_chat": is_group_chat,
                "knowledge_base_id": knowledge_base_id,
            }
        )

    return result


def build_lite_task_groups(
    db: Session,
    tasks: List[TaskResource],
    user_id: int,
) -> List[Dict[str, Any]]:
    """Group the current lightweight task page by device or team."""
    task_items = build_lite_task_list(db, tasks, user_id)
    groups: Dict[str, Dict[str, Any]] = {}

    for item in task_items:
        device_id = item.get("device_id")
        if device_id:
            group_type = "device"
            group_key = f"device:{device_id}"
        else:
            group_type = "team"
            team_id = item.get("team_id")
            team_name = item.get("team_name") or "unknown"
            group_key = (
                f"team:{team_id}" if team_id is not None else f"team:{team_name}"
            )

        if group_key not in groups:
            groups[group_key] = _create_lite_task_group(
                item, group_type=group_type, group_key=group_key
            )

        groups[group_key]["items"].append(item)

    return list(groups.values())


def _create_lite_task_group(
    item: Dict[str, Any], *, group_type: str, group_key: str
) -> Dict[str, Any]:
    """Create group metadata from the first task item in that group."""
    if group_type == "device":
        return {
            "group_type": group_type,
            "group_key": group_key,
            "team_id": None,
            "team_name": None,
            "team_namespace": None,
            "team_display_name": None,
            "team_icon": None,
            "device_id": item.get("device_id"),
            "device_name": item.get("device_name") or item.get("device_id"),
            "items": [],
        }

    return {
        "group_type": group_type,
        "group_key": group_key,
        "team_id": item.get("team_id"),
        "team_name": item.get("team_name"),
        "team_namespace": item.get("team_namespace"),
        "team_display_name": item.get("team_display_name"),
        "team_icon": item.get("team_icon"),
        "device_id": None,
        "device_name": None,
        "items": [],
    }
