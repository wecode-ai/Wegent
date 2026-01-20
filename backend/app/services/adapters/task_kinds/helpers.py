# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Task helper utilities.

This module contains helper functions for task operations,
including subtask creation and batch data fetching.
"""

import logging
from datetime import datetime
from typing import Any, Dict, List

from fastapi import HTTPException
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.schemas.kind import Task, Team, Workspace
from app.services.adapters.pipeline_stage import pipeline_stage_service
from app.services.readers.kinds import KindType, kindReader
from app.services.readers.users import userReader

logger = logging.getLogger(__name__)


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

    # For followup tasks: query existing subtasks and add one more
    existing_subtasks = (
        db.query(Subtask)
        .filter(Subtask.task_id == task.id, Subtask.user_id == user_id)
        .order_by(Subtask.message_id.desc())
        .all()
    )

    # Get the next message_id for the new subtask
    next_message_id = 1
    parent_id = 0
    if existing_subtasks:
        next_message_id = existing_subtasks[0].message_id + 1
        parent_id = existing_subtasks[0].message_id

    # Create USER role subtask based on task object
    user_subtask = Subtask(
        user_id=user_id,
        task_id=task.id,
        team_id=team.id,
        title=f"{task_crd.spec.title} - User",
        bot_ids=bot_ids,
        role=SubtaskRole.USER,
        executor_namespace="",
        executor_name="",
        prompt=user_prompt,
        status=SubtaskStatus.COMPLETED,
        progress=0,
        message_id=next_message_id,
        parent_id=parent_id,
        error_message="",
        completed_at=datetime.now(),
        result=None,
    )
    db.add(user_subtask)

    # Update id of next message and parent
    if parent_id == 0:
        parent_id = 1
    next_message_id = next_message_id + 1

    # Create ASSISTANT role subtask based on team workflow
    collaboration_model = team_crd.spec.collaborationModel

    if collaboration_model == "pipeline":
        _create_pipeline_subtask(
            db,
            task,
            team,
            team_crd,
            task_crd,
            user_id,
            existing_subtasks,
            bot_ids,
            next_message_id,
            parent_id,
        )
    else:
        _create_standard_subtask(
            db,
            task,
            team,
            task_crd,
            user_id,
            existing_subtasks,
            bot_ids,
            next_message_id,
            parent_id,
        )


def _create_pipeline_subtask(
    db: Session,
    task: Kind,
    team: Kind,
    team_crd: Team,
    task_crd: Task,
    user_id: int,
    existing_subtasks: List[Subtask],
    bot_ids: List[int],
    next_message_id: int,
    parent_id: int,
) -> None:
    """Create subtask for pipeline collaboration model."""
    # Pipeline mode: determine which bot to create subtask for
    # Use pipeline_stage_service to get current stage information
    should_stay, current_stage_index = (
        pipeline_stage_service.should_stay_at_current_stage(
            existing_subtasks, team_crd, db
        )
    )

    # Determine which stage to create subtask for
    if should_stay and current_stage_index is not None:
        target_stage_index = current_stage_index
        logger.info(
            f"Pipeline create_subtasks: staying at stage {target_stage_index} (requireConfirmation)"
        )
    elif existing_subtasks and current_stage_index is not None:
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

    # Pipeline mode: all bots run in the same executor
    # Get executor info from any existing assistant subtask
    executor_name = ""
    executor_namespace = ""
    for s in existing_subtasks:
        if s.role == SubtaskRole.ASSISTANT and s.executor_name:
            executor_name = s.executor_name
            executor_namespace = s.executor_namespace
            break

    subtask = Subtask(
        user_id=user_id,
        task_id=task.id,
        team_id=team.id,
        title=f"{task_crd.spec.title} - {bot.name}",
        bot_ids=[bot.id],
        role=SubtaskRole.ASSISTANT,
        prompt="",
        status=SubtaskStatus.PENDING,
        progress=0,
        message_id=next_message_id,
        parent_id=parent_id,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
        error_message="",
        completed_at=datetime.now(),
        result=None,
    )
    db.add(subtask)


def _create_standard_subtask(
    db: Session,
    task: Kind,
    team: Kind,
    task_crd: Task,
    user_id: int,
    existing_subtasks: List[Subtask],
    bot_ids: List[int],
    next_message_id: int,
    parent_id: int,
) -> None:
    """Create subtask for standard (non-pipeline) collaboration models."""
    executor_name = ""
    executor_namespace = ""
    if existing_subtasks:
        # Take executor_name and executor_namespace from the last existing subtask
        executor_name = existing_subtasks[0].executor_name
        executor_namespace = existing_subtasks[0].executor_namespace

    assistant_subtask = Subtask(
        user_id=user_id,
        task_id=task.id,
        team_id=team.id,
        title=f"{task_crd.spec.title} - Assistant",
        bot_ids=bot_ids,
        role=SubtaskRole.ASSISTANT,
        prompt="",
        status=SubtaskStatus.PENDING,
        progress=0,
        message_id=next_message_id,
        parent_id=parent_id,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
        error_message="",
        completed_at=datetime.now(),
        result=None,
    )
    db.add(assistant_subtask)


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

    # Batch query workspaces
    workspace_data = _batch_query_workspaces(db, workspace_refs, user_id)

    # Batch query teams (including shared teams)
    team_data = _batch_query_teams(db, team_refs, user_id)

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
            "user_name": user_name,
            "created_at": created_at or task.created_at,
            "updated_at": updated_at or task.updated_at,
            "completed_at": completed_at,
        }

    # Add is_group_chat to result
    _add_group_chat_info(db, tasks, result)

    return result


def _batch_query_workspaces(
    db: Session, workspace_refs: set, user_id: int
) -> Dict[str, Dict[str, Any]]:
    """Batch query workspaces and return data dict."""
    workspace_data = {}
    if not workspace_refs:
        return workspace_data

    workspace_names, workspace_namespaces = zip(*workspace_refs)
    workspaces = (
        db.query(TaskResource)
        .filter(
            TaskResource.user_id == user_id,
            TaskResource.kind == "Workspace",
            TaskResource.name.in_(workspace_names),
            TaskResource.namespace.in_(workspace_namespaces),
            TaskResource.is_active.is_(True),
        )
        .all()
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
    team_data = {}
    if not team_refs:
        return team_data

    team_names, team_namespaces = zip(*team_refs)

    # First query user's own teams
    teams = (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.name.in_(team_names),
            Kind.namespace.in_(team_namespaces),
            Kind.is_active.is_(True),
        )
        .all()
    )

    for team in teams:
        key = f"{team.name}:{team.namespace}"
        team_data[key] = team

    # Then query shared teams for missing team refs
    missing_team_refs = [
        ref for ref in team_refs if f"{ref[0]}:{ref[1]}" not in team_data
    ]
    if missing_team_refs:
        # Get all shared team_ids for this user
        from app.services.readers.shared_teams import sharedTeamReader

        shared_team_ids = sharedTeamReader.get_shared_team_ids(db, user_id)

        if shared_team_ids:
            # Query teams from shared team ids
            missing_team_names, missing_team_namespaces = zip(*missing_team_refs)
            shared_team_kinds = (
                db.query(Kind)
                .filter(
                    Kind.id.in_(shared_team_ids),
                    Kind.kind == "Team",
                    Kind.name.in_(missing_team_names),
                    Kind.namespace.in_(missing_team_namespaces),
                    Kind.is_active.is_(True),
                )
                .all()
            )

            for team in shared_team_kinds:
                key = f"{team.name}:{team.namespace}"
                team_data[key] = team

    return team_data


def _add_group_chat_info(
    db: Session, tasks: List[Kind], result: Dict[str, Dict[str, Any]]
) -> None:
    """Add is_group_chat info to result dict."""
    from app.models.task_member import MemberStatus, TaskMember

    task_ids = [t.id for t in tasks]
    member_count_results = (
        db.query(TaskMember.task_id, func.count(TaskMember.id).label("count"))
        .filter(
            TaskMember.task_id.in_(task_ids),
            TaskMember.status == MemberStatus.ACTIVE,
        )
        .group_by(TaskMember.task_id)
        .all()
    )
    member_counts = {row[0]: row[1] for row in member_count_results}

    # Add is_group_chat to result
    for task_id_str, data in result.items():
        task_id = int(task_id_str)
        # First check task JSON, fallback to member count
        task = db.query(TaskResource).filter(TaskResource.id == task_id).first()
        if task and task.json:
            is_group_chat = task.json.get("spec", {}).get("is_group_chat", False)
            if not is_group_chat:
                is_group_chat = member_counts.get(task_id, 0) > 0
        else:
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

    # Get task member counts in batch for is_group_chat detection
    from app.models.task_member import MemberStatus, TaskMember

    task_ids_for_members = [t.id for t in tasks]
    member_counts = {}
    if task_ids_for_members:
        member_count_results = (
            db.query(TaskMember.task_id, func.count(TaskMember.id).label("count"))
            .filter(
                TaskMember.task_id.in_(task_ids_for_members),
                TaskMember.status == MemberStatus.ACTIVE,
            )
            .group_by(TaskMember.task_id)
            .all()
        )
        member_counts = {row[0]: row[1] for row in member_count_results}

    result = []
    for task in tasks:
        task_crd = Task.model_validate(task.json)

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
        status = task_crd.status.status if task_crd.status else "PENDING"

        # Parse timestamps
        created_at = task.created_at
        updated_at = task.updated_at
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
                pass

        # Get team_id using direct SQL query
        team_name = task_crd.spec.teamRef.name
        team_namespace = task_crd.spec.teamRef.namespace
        team_result = db.execute(
            text(
                """
                SELECT id FROM kinds
                WHERE user_id = :user_id
                AND kind = 'Team'
                AND name = :name
                AND namespace = :namespace
                AND is_active = true
                LIMIT 1
            """
            ),
            {"user_id": user_id, "name": team_name, "namespace": team_namespace},
        ).fetchone()

        # If not found in user's teams, check shared teams
        team_id = team_result[0] if team_result else None
        if not team_id:
            shared_team_result = db.execute(
                text(
                    """
                    SELECT k.id FROM kinds k
                    INNER JOIN shared_teams st ON k.user_id = st.original_user_id
                    WHERE st.user_id = :user_id
                    AND st.is_active = true
                    AND k.kind = 'Team'
                    AND k.name = :name
                    AND k.namespace = :namespace
                    AND k.is_active = true
                    LIMIT 1
                """
                ),
                {
                    "user_id": user_id,
                    "name": team_name,
                    "namespace": team_namespace,
                },
            ).fetchone()
            team_id = shared_team_result[0] if shared_team_result else None

        # Get git_repo from workspace using direct SQL query
        workspace_name = task_crd.spec.workspaceRef.name
        workspace_namespace = task_crd.spec.workspaceRef.namespace
        workspace_result = db.execute(
            text(
                """
                SELECT JSON_EXTRACT(json, '$.spec.repository.gitRepo') as git_repo
                FROM tasks
                WHERE user_id = :user_id
                AND kind = 'Workspace'
                AND name = :name
                AND namespace = :namespace
                AND is_active = true
                LIMIT 1
            """
            ),
            {
                "user_id": user_id,
                "name": workspace_name,
                "namespace": workspace_namespace,
            },
        ).fetchone()

        git_repo = None
        if workspace_result and workspace_result[0]:
            git_repo = (
                workspace_result[0].strip('"')
                if isinstance(workspace_result[0], str)
                else workspace_result[0]
            )

        # Check if this is a group chat
        task_json = task.json or {}
        is_group_chat = task_json.get("spec", {}).get("is_group_chat", False)
        if not is_group_chat:
            is_group_chat = member_counts.get(task.id, 0) > 0

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
                "created_at": created_at,
                "updated_at": updated_at,
                "completed_at": completed_at,
                "team_id": team_id,
                "git_repo": git_repo,
                "is_group_chat": is_group_chat,
                "knowledge_base_id": knowledge_base_id,
            }
        )

    return result
