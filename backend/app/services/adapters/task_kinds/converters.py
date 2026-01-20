# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Task data conversion utilities.

This module contains functions for converting Task and related Kind objects
to dictionary format for API responses.
"""

import logging
from typing import Any, Dict

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.task import TaskResource
from app.schemas.kind import Task, Team, Workspace
from app.services.readers.kinds import KindType, kindReader
from app.services.readers.users import userReader

logger = logging.getLogger(__name__)


def convert_to_task_dict(task: Kind, db: Session, user_id: int) -> Dict[str, Any]:
    """
    Convert kinds Task to task-like dictionary.

    Args:
        task: Task Kind object
        db: Database session
        user_id: User ID for looking up related data

    Returns:
        Dictionary representation of the task
    """
    task_crd = Task.model_validate(task.json)

    # Get workspace data
    workspace = (
        db.query(TaskResource)
        .filter(
            TaskResource.user_id == user_id,
            TaskResource.kind == "Workspace",
            TaskResource.name == task_crd.spec.workspaceRef.name,
            TaskResource.namespace == task_crd.spec.workspaceRef.namespace,
            TaskResource.is_active.is_(True),
        )
        .first()
    )

    git_url = ""
    git_repo = ""
    git_repo_id = 0
    git_domain = ""
    branch_name = ""

    if workspace and workspace.json:
        try:
            workspace_crd = Workspace.model_validate(workspace.json)
            git_url = workspace_crd.spec.repository.gitUrl
            git_repo = workspace_crd.spec.repository.gitRepo
            git_repo_id = workspace_crd.spec.repository.gitRepoId or 0
            git_domain = workspace_crd.spec.repository.gitDomain
            branch_name = workspace_crd.spec.repository.branchName
        except Exception:
            # Handle workspaces with incomplete repository data
            pass

    # Get team data (including shared teams)
    team = kindReader.get_by_name_and_namespace(
        db,
        user_id,
        KindType.TEAM,
        task_crd.spec.teamRef.namespace,
        task_crd.spec.teamRef.name,
    )

    team_id = team.id if team else None

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

    # Get user info
    user = userReader.get_by_id(db, user_id)
    user_name = user.user_name if user else ""

    type_value = (
        task_crd.metadata.labels and task_crd.metadata.labels.get("type") or "online"
    )
    task_type = (
        task_crd.metadata.labels and task_crd.metadata.labels.get("taskType") or "chat"
    )

    model_id = task_crd.metadata.labels and task_crd.metadata.labels.get("modelId")

    # Extract is_group_chat from task spec
    is_group_chat = (
        task_crd.spec.is_group_chat
        if hasattr(task_crd.spec, "is_group_chat")
        else False
    )

    # Extract app from task status
    app_data = None
    if task_crd.status and task_crd.status.app:
        app_data = task_crd.status.app.model_dump()
        logger.info(f"[convert_to_task_dict] Found app data: {app_data}")
    else:
        logger.info(
            f"[convert_to_task_dict] No app data found. status={task_crd.status}, app={task_crd.status.app if task_crd.status else 'N/A'}"
        )

    return {
        "id": task.id,
        "type": type_value,
        "task_type": task_type,
        "user_id": task.user_id,
        "user_name": user_name,
        "title": task_crd.spec.title,
        "team_id": team_id,
        "git_url": git_url,
        "git_repo": git_repo,
        "git_repo_id": git_repo_id,
        "git_domain": git_domain,
        "branch_name": branch_name,
        "prompt": task_crd.spec.prompt,
        "status": task_crd.status.status if task_crd.status else "PENDING",
        "progress": task_crd.status.progress if task_crd.status else 0,
        "result": task_crd.status.result if task_crd.status else None,
        "error_message": task_crd.status.errorMessage if task_crd.status else None,
        "created_at": created_at or task.created_at,
        "updated_at": updated_at or task.updated_at,
        "completed_at": completed_at,
        "model_id": model_id,
        "is_group_chat": is_group_chat,
        "app": app_data,
    }


def convert_to_task_dict_optimized(
    task: Kind, related_data: Dict[str, Any], task_crd: Task
) -> Dict[str, Any]:
    """
    Optimized version of convert_to_task_dict that uses pre-fetched related data.

    Args:
        task: Task Kind object
        related_data: Pre-fetched related data (workspace, team, user info)
        task_crd: Pre-parsed Task CRD

    Returns:
        Dictionary representation of the task
    """
    workspace_data = related_data.get("workspace_data", {})

    # Get task type from metadata labels
    type_value = (
        task_crd.metadata.labels and task_crd.metadata.labels.get("type") or "online"
    )
    task_type = (
        task_crd.metadata.labels and task_crd.metadata.labels.get("taskType") or "chat"
    )

    return {
        "id": task.id,
        "type": type_value,
        "task_type": task_type,
        "user_id": task.user_id,
        "user_name": related_data.get("user_name", ""),
        "title": task_crd.spec.title,
        "team_id": related_data.get("team_id"),
        "git_url": workspace_data.get("git_url", ""),
        "git_repo": workspace_data.get("git_repo", ""),
        "git_repo_id": workspace_data.get("git_repo_id", 0),
        "git_domain": workspace_data.get("git_domain", ""),
        "branch_name": workspace_data.get("branch_name", ""),
        "prompt": task_crd.spec.prompt,
        "status": task_crd.status.status if task_crd.status else "PENDING",
        "progress": task_crd.status.progress if task_crd.status else 0,
        "result": task_crd.status.result if task_crd.status else None,
        "error_message": task_crd.status.errorMessage if task_crd.status else None,
        "created_at": related_data.get("created_at", task.created_at),
        "updated_at": related_data.get("updated_at", task.updated_at),
        "completed_at": related_data.get("completed_at"),
        "is_group_chat": related_data.get("is_group_chat", False),
        "app": (
            task_crd.status.app.model_dump()
            if task_crd.status and task_crd.status.app
            else None
        ),
    }


def convert_team_to_dict(team: Kind, db: Session, user_id: int) -> Dict[str, Any]:
    """
    Convert kinds Team to team-like dictionary (simplified version).

    Args:
        team: Team Kind object
        db: Database session
        user_id: User ID for looking up related data

    Returns:
        Dictionary representation of the team
    """
    team_crd = Team.model_validate(team.json)

    # Convert members to bots format
    bots = []
    for member in team_crd.spec.members:
        # Find bot using kindReader
        bot = kindReader.get_by_name_and_namespace(
            db, user_id, KindType.BOT, member.botRef.namespace, member.botRef.name
        )

        if bot:
            bot_info = {
                "bot_id": bot.id,
                "bot_prompt": member.prompt or "",
                "role": member.role or "",
            }
            bots.append(bot_info)

    # Convert collaboration model to workflow format
    workflow = {"mode": team_crd.spec.collaborationModel}

    # Get user info for user name
    user = userReader.get_by_id(db, team.user_id)
    user_name = user.user_name if user else ""

    return {
        "id": team.id,
        "user_id": team.user_id,
        "user_name": user_name,
        "name": team.name,
        "bots": bots,
        "workflow": workflow,
        "is_active": team.is_active,
        "created_at": team.created_at,
        "updated_at": team.updated_at,
    }
