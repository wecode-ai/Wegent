# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
import logging
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx
from fastapi import HTTPException
from sqlalchemy import func, text
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.models.kind import Kind
from app.models.shared_team import SharedTeam
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User
from app.schemas.kind import Bot, Ghost, Model, Shell, Task, Team, Workspace
from app.schemas.task import TaskCreate, TaskDetail, TaskInDB, TaskStatus, TaskUpdate
from app.services.adapters.executor_kinds import executor_kinds_service
from app.services.adapters.team_kinds import team_kinds_service
from app.services.base import BaseService

logger = logging.getLogger(__name__)


class TaskKindsService(BaseService[Kind, TaskCreate, TaskUpdate]):
    """
    Task service class using kinds table
    """

    def create_task_or_append(
        self,
        db: Session,
        *,
        obj_in: TaskCreate,
        user: User,
        task_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Create user Task using kinds table
        """
        logger.info(
            f"create_task_or_append called with task_id={task_id}, user_id={user.id}"
        )
        task = None
        team = None

        # Set task ID
        if task_id is None:
            task_id = self.create_task_id(db, user.id)

        # Validate if task_id is valid
        if not self.validate_task_id(db, task_id):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid task_id: {task_id} does not exist in session",
            )

        # Check if already exists
        existing_task = (
            db.query(Kind)
            .filter(Kind.id == task_id, Kind.kind == "Task", Kind.is_active == True)
            .first()
        )
        if existing_task:
            # Handle existing task logic
            task_crd = Task.model_validate(existing_task.json)
            task_status = task_crd.status.status if task_crd.status else "PENDING"

            if task_status == "RUNNING":
                raise HTTPException(
                    status_code=400,
                    detail="Task is still running, please wait for it to complete",
                )
            elif task_status in ["DELETE"]:
                raise HTTPException(
                    status_code=400,
                    detail=f"Task has {task_status.lower()}, please create a new task",
                )
            elif task_status not in ["COMPLETED", "FAILED", "CANCELLED"]:
                raise HTTPException(
                    status_code=400,
                    detail="Task is in progress, please wait for it to complete",
                )

            if (
                task_crd.metadata.labels
                and task_crd.metadata.labels["autoDeleteExecutor"] == "true"
            ):
                raise HTTPException(
                    status_code=400,
                    detail="task already clear, please create a new task",
                )
            expire_hours = settings.APPEND_CHAT_TASK_EXPIRE_HOURS
            # Check if task is expired
            task_type = (
                task_crd.metadata.labels
                and task_crd.metadata.labels.get("taskType")
                or "chat"
            )
            # Only check expiration for code tasks, chat tasks have no expiration
            if task_type == "code":
                expire_hours = settings.APPEND_CODE_TASK_EXPIRE_HOURS

            task_shell_source = (
                task_crd.metadata.labels
                and task_crd.metadata.labels.get("source")
                or None
            )
            if task_shell_source != "chat_shell":
                if (
                    datetime.now() - existing_task.updated_at
                ).total_seconds() > expire_hours * 3600:
                    raise HTTPException(
                        status_code=400,
                        detail=f"{task_type} task has expired. You can only append tasks within {expire_hours} hours after last update.",
                    )

            # Get team reference information from task_crd and validate if team exists
            team_name = task_crd.spec.teamRef.name
            team_namespace = task_crd.spec.teamRef.namespace

            # For group chat members, allow using the task's team even if not owned by user
            from app.services.task_member_service import task_member_service

            is_group_member = task_member_service.is_member(db, task_id, user.id)

            if is_group_member:
                # Group chat member - get team without user ownership check
                team = team_kinds_service.get_team_by_name_and_namespace_without_user_check(
                    db, team_name, team_namespace
                )
            else:
                # Regular user - check team ownership
                team = team_kinds_service.get_team_by_name_and_namespace(
                    db, team_name, team_namespace, user.id
                )

            if not team:
                raise HTTPException(
                    status_code=404,
                    detail=f"Team '{team_name}' not found, it may be deleted or not shared",
                )

            # Update existing task status to PENDING
            if task_crd.status:
                task_crd.status.status = "PENDING"
                task_crd.status.progress = 0
            existing_task.json = task_crd.model_dump(mode="json", exclude_none=True)
            existing_task.updated_at = datetime.now()

            task = existing_task
        else:
            # Validate team exists and belongs to user
            team = team_kinds_service.get_team_by_id_or_name_and_namespace(
                db,
                team_id=obj_in.team_id,
                team_name=obj_in.team_name,
                team_namespace=obj_in.team_namespace,
                user_id=user.id,
            )

            if not team:
                raise HTTPException(
                    status_code=404,
                    detail="Team not found, it may be deleted or not shared",
                )

            # Additional business validation for prompt length
            if obj_in.prompt and len(obj_in.prompt.encode("utf-8")) > 60000:
                raise HTTPException(
                    status_code=400,
                    detail="Prompt content is too long. Maximum allowed size is 60000 bytes in UTF-8 encoding.",
                )

            # If title is empty, extract first 50 characters from prompt as title
            title = obj_in.title
            if not title and obj_in.prompt:
                title = obj_in.prompt[:50]
                if len(obj_in.prompt) > 50:
                    title += "..."

            # Create Workspace first
            workspace_name = f"workspace-{task_id}"
            workspace_json = {
                "kind": "Workspace",
                "spec": {
                    "repository": {
                        "gitUrl": obj_in.git_url,
                        "gitRepo": obj_in.git_repo,
                        "gitRepoId": obj_in.git_repo_id,
                        "gitDomain": obj_in.git_domain,
                        "branchName": obj_in.branch_name,
                    }
                },
                "status": {"state": "Available"},
                "metadata": {"name": workspace_name, "namespace": "default"},
                "apiVersion": "agent.wecode.io/v1",
            }

            workspace = Kind(
                user_id=user.id,
                kind="Workspace",
                name=workspace_name,
                namespace="default",
                json=workspace_json,
                is_active=True,
            )
            db.add(workspace)

        # If not exists, create new task
        if task is None:
            # Create Task JSON
            task_json = {
                "kind": "Task",
                "spec": {
                    "title": title,
                    "prompt": obj_in.prompt,
                    "teamRef": {"name": team.name, "namespace": team.namespace},
                    "workspaceRef": {"name": workspace_name, "namespace": "default"},
                },
                "status": {
                    "state": "Available",
                    "status": "PENDING",
                    "progress": 0,
                    "result": None,
                    "errorMessage": "",
                    "createdAt": datetime.now().isoformat(),
                    "updatedAt": datetime.now().isoformat(),
                    "completedAt": None,
                },
                "metadata": {
                    "name": f"task-{task_id}",
                    "namespace": "default",
                    "labels": {
                        "type": obj_in.type,  # default: online, offline
                        "taskType": obj_in.task_type,  # default: chat, code
                        "autoDeleteExecutor": obj_in.auto_delete_executor,  # default: false, true
                        "source": obj_in.source,
                        # Mark as API call if source is "api"
                        **(
                            {"is_api_call": "true"}
                            if obj_in.source == "api"
                            else {}
                        ),
                        # Model selection fields
                        **({"modelId": obj_in.model_id} if obj_in.model_id else {}),
                        **(
                            {"forceOverrideBotModel": "true"}
                            if obj_in.force_override_bot_model
                            else {}
                        ),
                        # Trusted source field
                        **(
                            {"api_trusted_source": obj_in.api_trusted_source}
                            if obj_in.api_trusted_source
                            else {}
                        ),
                    },
                },
                "apiVersion": "agent.wecode.io/v1",
            }

            task = Kind(
                id=task_id,  # Use the provided task_id
                user_id=user.id,
                kind="Task",
                name=f"task-{task_id}",
                namespace="default",
                json=task_json,
                is_active=True,
            )
            db.add(task)

        # Create subtasks for the task
        self._create_subtasks(db, task, team, user.id, obj_in.prompt)

        db.commit()
        db.refresh(task)
        db.flush()

        return self._convert_to_task_dict(task, db, user.id)

    def get_user_tasks_with_pagination(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Get user's Task list with pagination (only active tasks, excluding DELETE status)
        Optimized version using raw SQL to avoid MySQL "Out of sort memory" errors.
        DELETE status tasks are filtered in application layer.
        Includes tasks owned by user AND tasks user is a member of (group chats).
        """
        # Use raw SQL to get task IDs where user is owner OR member
        count_sql = text(
            """
            SELECT COUNT(DISTINCT k.id)
            FROM kinds k
            LEFT JOIN task_members tm ON k.id = tm.task_id AND tm.user_id = :user_id AND tm.status = 'ACTIVE'
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND (k.user_id = :user_id OR tm.id IS NOT NULL)
        """
        )
        total_result = db.execute(count_sql, {"user_id": user_id}).scalar()

        # Get task IDs sorted by created_at
        ids_sql = text(
            """
            SELECT DISTINCT k.id, k.created_at
            FROM kinds k
            LEFT JOIN task_members tm ON k.id = tm.task_id AND tm.user_id = :user_id AND tm.status = 'ACTIVE'
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND (k.user_id = :user_id OR tm.id IS NOT NULL)
            ORDER BY k.created_at DESC
            LIMIT :limit OFFSET :skip
        """
        )
        task_id_rows = db.execute(
            ids_sql, {"user_id": user_id, "limit": limit + 50, "skip": skip}
        ).fetchall()
        task_ids = [row[0] for row in task_id_rows]

        if not task_ids:
            return [], 0

        # Load full task data for the selected IDs
        tasks = db.query(Kind).filter(Kind.id.in_(task_ids)).all()

        # Filter out DELETE status tasks in application layer and restore order
        id_to_task = {}
        for t in tasks:
            task_crd = Task.model_validate(t.json)
            status = task_crd.status.status if task_crd.status else "PENDING"
            if status != "DELETE":
                id_to_task[t.id] = t

        # Restore the original order and apply limit
        filtered_tasks = []
        for tid in task_ids:
            if tid in id_to_task:
                filtered_tasks.append(id_to_task[tid])
                if len(filtered_tasks) >= limit:
                    break

        total = total_result if total_result else 0

        if not filtered_tasks:
            return [], total

        # Get all related data in batch to avoid N+1 queries
        related_data_batch = self._get_tasks_related_data_batch(
            db, filtered_tasks, user_id
        )

        result = []
        for task in filtered_tasks:
            task_crd = Task.model_validate(task.json)
            task_related_data = related_data_batch.get(str(task.id), {})
            result.append(
                self._convert_to_task_dict_optimized(task, task_related_data, task_crd)
            )

        return result, total

    def get_user_tasks_lite(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Get user's Task list with pagination (lightweight version for list display)
        Only returns essential fields without JOIN queries for better performance.
        Includes tasks owned by user AND tasks user is a member of (group chats).

        Uses raw SQL to avoid MySQL "Out of sort memory" errors caused by
        JSON_EXTRACT in WHERE clause combined with ORDER BY.
        """
        # Get task IDs where user is owner OR member
        # Use raw SQL with UNION for efficiency
        count_sql = text(
            """
            SELECT COUNT(DISTINCT k.id)
            FROM kinds k
            LEFT JOIN task_members tm ON k.id = tm.task_id AND tm.user_id = :user_id AND tm.status = 'ACTIVE'
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND (k.user_id = :user_id OR tm.id IS NOT NULL)
        """
        )
        total_result = db.execute(count_sql, {"user_id": user_id}).scalar()

        # Get task IDs sorted by created_at, including both owned and member tasks
        ids_sql = text(
            """
            SELECT DISTINCT k.id, k.created_at
            FROM kinds k
            LEFT JOIN task_members tm ON k.id = tm.task_id AND tm.user_id = :user_id AND tm.status = 'ACTIVE'
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND (k.user_id = :user_id OR tm.id IS NOT NULL)
            ORDER BY k.created_at DESC
            LIMIT :limit OFFSET :skip
        """
        )
        task_id_rows = db.execute(
            ids_sql, {"user_id": user_id, "limit": limit + 50, "skip": skip}
        ).fetchall()
        task_ids = [row[0] for row in task_id_rows]

        if not task_ids:
            return [], 0

        # Load full task data for the selected IDs
        tasks = db.query(Kind).filter(Kind.id.in_(task_ids)).all()

        # Filter out DELETE status tasks in application layer and restore order
        id_to_task = {}
        for t in tasks:
            task_crd = Task.model_validate(t.json)
            status = task_crd.status.status if task_crd.status else "PENDING"
            if status != "DELETE":
                id_to_task[t.id] = t

        # Restore the original order and apply limit
        tasks = []
        for tid in task_ids:
            if tid in id_to_task:
                tasks.append(id_to_task[tid])
                if len(tasks) >= limit:
                    break

        # Recalculate total excluding DELETE status (approximate)
        total = total_result if total_result else 0

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

        # Build lightweight result without expensive JOIN operations
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

            # Get team_id using direct SQL query (more efficient than ORM)
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
                    FROM kinds
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
                # Remove JSON quotes from extracted value
                git_repo = (
                    workspace_result[0].strip('"')
                    if isinstance(workspace_result[0], str)
                    else workspace_result[0]
                )

            # Check if this is a group chat
            # First check task.json.spec.is_group_chat, fallback to member count
            task_json = task.json or {}
            is_group_chat = task_json.get("spec", {}).get("is_group_chat", False)
            # Fallback: if not explicitly set, check member count
            if not is_group_chat:
                is_group_chat = member_counts.get(task.id, 0) > 0

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
                }
            )

        return result, total

    def get_new_tasks_since_id(
        self, db: Session, *, user_id: int, since_id: int, limit: int = 50
    ) -> List[Dict[str, Any]]:
        """
        Get new tasks created after the specified task ID.
        Returns tasks with ID greater than since_id, ordered by ID descending.
        Includes tasks owned by user AND tasks user is a member of (group chats).
        """
        # Get task IDs where user is owner OR member, with ID > since_id
        ids_sql = text(
            """
            SELECT DISTINCT k.id, k.created_at
            FROM kinds k
            LEFT JOIN task_members tm ON k.id = tm.task_id AND tm.user_id = :user_id AND tm.status = 'ACTIVE'
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND k.id > :since_id
            AND (k.user_id = :user_id OR tm.id IS NOT NULL)
            ORDER BY k.id DESC
            LIMIT :limit
        """
        )
        task_id_rows = db.execute(
            ids_sql, {"user_id": user_id, "since_id": since_id, "limit": limit}
        ).fetchall()
        task_ids = [row[0] for row in task_id_rows]

        if not task_ids:
            return []

        # Load full task data for the selected IDs
        tasks = db.query(Kind).filter(Kind.id.in_(task_ids)).all()

        # Filter out DELETE status tasks and restore order
        id_to_task = {}
        for t in tasks:
            task_crd = Task.model_validate(t.json)
            status = task_crd.status.status if task_crd.status else "PENDING"
            if status != "DELETE":
                id_to_task[t.id] = t

        # Restore the original order (by ID descending)
        tasks = [id_to_task[tid] for tid in task_ids if tid in id_to_task]

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

        # Build lightweight result (same structure as get_user_tasks_lite)
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
                    FROM kinds
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
                # Remove JSON quotes from extracted value
                git_repo = (
                    workspace_result[0].strip('"')
                    if isinstance(workspace_result[0], str)
                    else workspace_result[0]
                )

            # Check if this is a group chat
            # First check task.json.spec.is_group_chat, fallback to member count
            task_json = task.json or {}
            is_group_chat = task_json.get("spec", {}).get("is_group_chat", False)
            # Fallback: if not explicitly set, check member count
            if not is_group_chat:
                is_group_chat = member_counts.get(task.id, 0) > 0

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
                }
            )

        return result

    def get_user_tasks_by_title_with_pagination(
        self, db: Session, *, user_id: int, title: str, skip: int = 0, limit: int = 100
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Fuzzy search tasks by title for current user (pagination), excluding DELETE status
        Optimized version using raw SQL to avoid MySQL "Out of sort memory" errors.
        Title matching and DELETE status filtering are done in application layer.
        """
        # Use raw SQL to get task IDs without JSON_EXTRACT in WHERE clause
        count_sql = text(
            """
            SELECT COUNT(*) FROM kinds
            WHERE user_id = :user_id
            AND kind = 'Task'
            AND is_active = true
        """
        )
        total_result = db.execute(count_sql, {"user_id": user_id}).scalar()

        # Get task IDs sorted by created_at (fetch more to account for filtering)
        ids_sql = text(
            """
            SELECT id FROM kinds
            WHERE user_id = :user_id
            AND kind = 'Task'
            AND is_active = true
            ORDER BY created_at DESC
            LIMIT :limit OFFSET :skip
        """
        )
        task_id_rows = db.execute(
            ids_sql, {"user_id": user_id, "limit": limit + 100, "skip": skip}
        ).fetchall()
        task_ids = [row[0] for row in task_id_rows]

        if not task_ids:
            return [], 0

        # Load full task data for the selected IDs
        tasks = db.query(Kind).filter(Kind.id.in_(task_ids)).all()

        # Filter by title and DELETE status in application layer, restore order
        title_lower = title.lower()
        id_to_task = {}
        for t in tasks:
            task_crd = Task.model_validate(t.json)
            status = task_crd.status.status if task_crd.status else "PENDING"
            task_title = task_crd.spec.title or ""
            # Filter: not DELETE and title matches
            if status != "DELETE" and title_lower in task_title.lower():
                id_to_task[t.id] = t

        # Restore the original order and apply limit
        filtered_tasks = []
        for tid in task_ids:
            if tid in id_to_task:
                filtered_tasks.append(id_to_task[tid])
                if len(filtered_tasks) >= limit:
                    break

        # Approximate total (actual count would require full scan)
        total = len(id_to_task)

        if not filtered_tasks:
            return [], total

        # Get all related data in batch to avoid N+1 queries
        related_data_batch = self._get_tasks_related_data_batch(
            db, filtered_tasks, user_id
        )

        result = []
        for task in filtered_tasks:
            task_crd = Task.model_validate(task.json)
            task_related_data = related_data_batch.get(str(task.id), {})
            result.append(
                self._convert_to_task_dict_optimized(task, task_related_data, task_crd)
            )

        return result, total

    def get_task_by_id(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Optional[Dict[str, Any]]:
        """
        Get Task by ID and user ID (only active tasks)
        Allows access if user is the owner OR a member of the group chat
        """
        from app.services.task_member_service import task_member_service

        # First, check if task exists
        task = (
            db.query(Kind)
            .filter(
                Kind.id == task_id,
                Kind.kind == "Task",
                Kind.is_active == True,
                text("JSON_EXTRACT(json, '$.status.status') != 'DELETE'"),
            )
            .first()
        )

        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        # Check if user has access (owner or active member)
        if not task_member_service.is_member(db, task_id, user_id):
            raise HTTPException(status_code=404, detail="Task not found")

        # For group chat members, use the task owner's user_id to convert task dict
        # This ensures team and workspace lookups work correctly
        convert_user_id = task.user_id  # Always use task owner's user_id
        return self._convert_to_task_dict(task, db, convert_user_id)

    def get_task_detail(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Dict[str, Any]:
        """
        Get detailed task information including related user, team, subtasks and open links
        """
        from app.services.subtask import subtask_service
        from app.services.task_member_service import task_member_service

        task_dict = self.get_task_by_id(db, task_id=task_id, user_id=user_id)

        # Get related user
        user = db.query(User).filter(User.id == user_id).first()

        # Get related team
        team_id = task_dict.get("team_id")
        team = None
        if team_id:
            logger.info(
                f"[get_task_detail] task_id={task_id}, team_id={team_id}, user_id={user_id}"
            )
            team = db.query(Kind).filter(Kind.id == team_id).first()
            if team:
                # For both owner and group members, use the task owner's user_id to get team info
                # This ensures group members can see the team's bots and configuration
                task_owner_id = task_member_service.get_task_owner_id(db, task_id)
                logger.info(
                    f"[get_task_detail] task_owner_id={task_owner_id}, team found: {team is not None}"
                )
                if task_owner_id:
                    team = team_kinds_service._convert_to_team_dict(
                        team, db, task_owner_id
                    )
                    logger.info(
                        f"[get_task_detail] after _convert_to_team_dict, team: {team is not None}"
                    )
                else:
                    logger.warning(
                        f"[get_task_detail] task_owner_id is None for task_id={task_id}"
                    )
                    team = None
            else:
                logger.warning(
                    f"[get_task_detail] team not found for team_id={team_id}"
                )
        else:
            logger.info(f"[get_task_detail] task_id={task_id} has no team_id")

        # Get related subtasks
        # Use from_latest=True to get the latest N messages (default behavior for group chat)
        subtasks = subtask_service.get_by_task(
            db=db, task_id=task_id, user_id=user_id, from_latest=True
        )

        # Get all bot objects for the subtasks
        all_bot_ids = set()
        for subtask in subtasks:
            if subtask.bot_ids:
                all_bot_ids.update(subtask.bot_ids)

        bots = {}
        if all_bot_ids:
            # Get bots from kinds table (Bot kind)
            bot_objects = (
                db.query(Kind)
                .filter(
                    Kind.id.in_(list(all_bot_ids)),
                    Kind.kind == "Bot",
                    Kind.is_active == True,
                )
                .all()
            )

            # Convert bot objects to dict using bot JSON data
            # Convert bot objects to dict using bot JSON data
            for bot in bot_objects:
                bot_crd = Bot.model_validate(bot.json)

                # Initialize default values
                shell_type = ""
                agent_config = {}
                system_prompt = ""
                mcp_servers = {}

                # Get Ghost data from kinds table
                ghost = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == user_id,
                        Kind.kind == "Ghost",
                        Kind.name == bot_crd.spec.ghostRef.name,
                        Kind.namespace == bot_crd.spec.ghostRef.namespace,
                        Kind.is_active == True,
                    )
                    .first()
                )
                if ghost and ghost.json:
                    ghost_crd = Ghost.model_validate(ghost.json)
                    system_prompt = ghost_crd.spec.systemPrompt
                    mcp_servers = ghost_crd.spec.mcpServers or {}

                # Get Model data from kinds table (modelRef is optional)
                if bot_crd.spec.modelRef:
                    model = (
                        db.query(Kind)
                        .filter(
                            Kind.user_id == user_id,
                            Kind.kind == "Model",
                            Kind.name == bot_crd.spec.modelRef.name,
                            Kind.namespace == bot_crd.spec.modelRef.namespace,
                            Kind.is_active == True,
                        )
                        .first()
                    )
                    if model and model.json:
                        model_crd = Model.model_validate(model.json)
                        agent_config = model_crd.spec.modelConfig

                # Get Shell data from kinds table (first check user's shells, then public shells)
                shell = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == user_id,
                        Kind.kind == "Shell",
                        Kind.name == bot_crd.spec.shellRef.name,
                        Kind.namespace == bot_crd.spec.shellRef.namespace,
                        Kind.is_active == True,
                    )
                    .first()
                )
                if not shell:
                    # If not found in user's shells, check public shells (user_id = 0)
                    shell = (
                        db.query(Kind)
                        .filter(
                            Kind.user_id == 0,
                            Kind.kind == "Shell",
                            Kind.name == bot_crd.spec.shellRef.name,
                            Kind.is_active == True,
                        )
                        .first()
                    )
                if shell and shell.json:
                    shell_crd = Shell.model_validate(shell.json)
                    shell_type = shell_crd.spec.shellType

                # Create bot dict compatible with BotInDB schema
                bot_dict = {
                    "id": bot.id,
                    "user_id": bot.user_id,
                    "name": bot.name,
                    "shell_type": shell_type,
                    "agent_config": agent_config,
                    "system_prompt": system_prompt,
                    "mcp_servers": mcp_servers,
                    "is_active": bot.is_active,
                    "created_at": bot.created_at,
                    "updated_at": bot.updated_at,
                }
                bots[bot.id] = bot_dict
        # Convert subtasks to dict and replace bot_ids with bot objects
        subtasks_dict = []
        for subtask in subtasks:
            # Convert attachments to dict format
            attachments_list = []
            if hasattr(subtask, "attachments") and subtask.attachments:
                for attachment in subtask.attachments:
                    attachments_list.append(
                        {
                            "id": attachment.id,
                            "filename": attachment.original_filename,
                            "file_size": attachment.file_size,
                            "mime_type": attachment.mime_type,
                            "status": (
                                attachment.status.value
                                if hasattr(attachment.status, "value")
                                else attachment.status
                            ),
                            "file_extension": attachment.file_extension,
                            "created_at": attachment.created_at,
                        }
                    )

            # Convert subtask to dict
            subtask_dict = {
                # Subtask base fields
                "id": subtask.id,
                "task_id": subtask.task_id,
                "team_id": subtask.team_id,
                "title": subtask.title,
                "bot_ids": subtask.bot_ids,
                "role": subtask.role,
                "prompt": subtask.prompt,
                "executor_namespace": subtask.executor_namespace,
                "executor_name": subtask.executor_name,
                "message_id": subtask.message_id,
                "parent_id": subtask.parent_id,
                "status": subtask.status,
                "progress": subtask.progress,
                "result": subtask.result,
                "error_message": subtask.error_message,
                "user_id": subtask.user_id,
                "created_at": subtask.created_at,
                "updated_at": subtask.updated_at,
                "completed_at": subtask.completed_at,
                # Add bot objects as dict for each bot_id
                "bots": [
                    bots.get(bot_id) for bot_id in subtask.bot_ids if bot_id in bots
                ],
                # Add attachments
                "attachments": attachments_list,
                # Group chat fields
                "sender_type": subtask.sender_type,  # Already a string value, not enum
                "sender_user_id": subtask.sender_user_id,
                "sender_user_name": getattr(subtask, "sender_user_name", None),
                "reply_to_subtask_id": subtask.reply_to_subtask_id,
            }
            subtasks_dict.append(subtask_dict)

        task_dict["user"] = user
        task_dict["team"] = team
        task_dict["subtasks"] = subtasks_dict

        # Add group chat information
        from app.models.task_member import MemberStatus, TaskMember

        # Check if this task has any members (indicating it's a group chat)
        members = (
            db.query(TaskMember)
            .filter(
                TaskMember.task_id == task_id,
                TaskMember.status == MemberStatus.ACTIVE,
            )
            .all()
        )

        # First check task.json.spec.is_group_chat, fallback to member count
        # task_dict already contains the parsed task data from get_task_by_id
        is_group_chat = task_dict.get("is_group_chat", False)
        # If not set in task_dict, check member count
        if not is_group_chat:
            is_group_chat = len(members) > 0
        task_dict["is_group_chat"] = is_group_chat
        task_dict["is_group_owner"] = task_dict.get("user_id") == user_id
        task_dict["member_count"] = len(members) if is_group_chat else None

        return task_dict

    def update_task(
        self, db: Session, *, task_id: int, obj_in: TaskUpdate, user_id: int
    ) -> Dict[str, Any]:
        """
        Update user Task
        """
        task = (
            db.query(Kind)
            .filter(
                Kind.id == task_id,
                Kind.kind == "Task",
                Kind.is_active == True,
            )
            .first()
        )

        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        # Additional business validation for prompt length if being updated
        if obj_in.prompt is not None and len(obj_in.prompt.encode("utf-8")) > 60000:
            raise HTTPException(
                status_code=400,
                detail="Prompt content is too long. Maximum allowed size is 60000 bytes in UTF-8 encoding.",
            )

        update_data = obj_in.model_dump(exclude_unset=True)
        task_crd = Task.model_validate(task.json)

        # Update task spec fields
        if "title" in update_data:
            task_crd.spec.title = update_data["title"]
        if "prompt" in update_data:
            task_crd.spec.prompt = update_data["prompt"]

        # Update task status fields
        # Update task status fields
        if task_crd.status:
            if "status" in update_data:
                new_status = (
                    update_data["status"].value
                    if hasattr(update_data["status"], "value")
                    else update_data["status"]
                )
                current_status = task_crd.status.status

                # State transition protection: prevent final states from being overwritten by non-final states
                # Define final states and non-final states
                final_states = ["COMPLETED", "FAILED", "CANCELLED", "DELETE"]
                non_final_states = ["PENDING", "RUNNING", "CANCELLING"]

                # If current status is CANCELLING, only allow transition to CANCELLED or FAILED
                if current_status == "CANCELLING":
                    if new_status not in ["CANCELLED", "FAILED"]:
                        logger.warning(
                            f"Task {task_id}: Ignoring status update from CANCELLING to {new_status}. "
                            f"CANCELLING can only transition to CANCELLED or FAILED."
                        )
                        # Do not update status, but allow updating other fields (e.g., progress)
                    else:
                        task_crd.status.status = new_status
                        logger.info(
                            f"Task {task_id}: Status updated from CANCELLING to {new_status}"
                        )
                # If current status is already a final state, do not allow it to be overwritten by non-final states
                elif current_status in final_states and new_status in non_final_states:
                    logger.warning(
                        f"Task {task_id}: Ignoring status update from final state {current_status} to non-final state {new_status}"
                    )
                    # Do not update status, but allow updating other fields
                else:
                    # Normal state transition
                    task_crd.status.status = new_status
            if "progress" in update_data:
                task_crd.status.progress = update_data["progress"]
            if "result" in update_data:
                task_crd.status.result = update_data["result"]
            if "error_message" in update_data:
                task_crd.status.errorMessage = update_data["error_message"]

        # Update workspace if git-related fields are provided
        if any(
            field in update_data
            for field in [
                "git_url",
                "git_repo",
                "git_repo_id",
                "git_domain",
                "branch_name",
            ]
        ):
            workspace = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Workspace",
                    Kind.name == task_crd.spec.workspaceRef.name,
                    Kind.namespace == task_crd.spec.workspaceRef.namespace,
                    Kind.is_active == True,
                )
                .first()
            )

            if workspace:
                workspace_crd = Workspace.model_validate(workspace.json)

                if "git_url" in update_data:
                    workspace_crd.spec.repository.gitUrl = update_data["git_url"]
                if "git_repo" in update_data:
                    workspace_crd.spec.repository.gitRepo = update_data["git_repo"]
                if "git_repo_id" in update_data:
                    workspace_crd.spec.repository.gitRepoId = update_data["git_repo_id"]
                if "git_domain" in update_data:
                    workspace_crd.spec.repository.gitDomain = update_data["git_domain"]
                if "branch_name" in update_data:
                    workspace_crd.spec.repository.branchName = update_data[
                        "branch_name"
                    ]

                workspace.json = workspace_crd.model_dump()
                flag_modified(workspace, "json")

        # Update timestamps
        if task_crd.status:
            task_crd.status.updatedAt = datetime.now()
            if "status" in update_data and update_data["status"] in [
                "COMPLETED",
                "FAILED",
                "CANCELLED",
            ]:
                task_crd.status.completedAt = datetime.now()

        task.json = task_crd.model_dump(mode="json", exclude_none=True)
        task.updated_at = datetime.now()
        flag_modified(task, "json")

        db.commit()
        db.refresh(task)

        return self._convert_to_task_dict(task, db, user_id)

    def delete_task(self, db: Session, *, task_id: int, user_id: int) -> None:
        """
        Delete user Task and handle running subtasks.
        For group chat tasks:
        - If user is the owner: delete the entire task (soft delete)
        - If user is a member: leave the group chat (remove membership)
        """
        logger.info(f"Deleting task with id: {task_id}")

        # First check if user is the task owner
        task = (
            db.query(Kind)
            .filter(
                Kind.id == task_id,
                Kind.kind == "Task",
                Kind.is_active == True,
            )
            .first()
        )

        # If not the owner, check if user is a group chat member
        if not task:
            from app.models.task_member import MemberStatus, TaskMember

            # Check if this is a group chat task and user is a member
            task = (
                db.query(Kind)
                .filter(
                    Kind.id == task_id,
                    Kind.kind == "Task",
                    Kind.is_active == True,
                )
                .first()
            )

            if not task:
                raise HTTPException(status_code=404, detail="Task not found")

            # Check if user is a member of this task
            task_member = (
                db.query(TaskMember)
                .filter(
                    TaskMember.task_id == task_id,
                    TaskMember.user_id == user_id,
                    TaskMember.status == MemberStatus.ACTIVE,
                )
                .first()
            )

            if not task_member:
                raise HTTPException(status_code=404, detail="Task not found")

            # User is a member, not owner - handle as "leave group chat"
            logger.info(f"User {user_id} leaving group chat task {task_id}")
            task_member.status = MemberStatus.REMOVED
            task_member.removed_at = datetime.now()
            db.commit()
            return

        # Get all subtasks for the task
        task_subtasks = db.query(Subtask).filter(Subtask.task_id == task_id).all()

        # Collect unique executor keys to avoid duplicate calls (namespace + name)
        unique_executor_keys = set()
        for subtask in task_subtasks:
            if subtask.executor_name and not subtask.executor_deleted_at:
                unique_executor_keys.add(
                    (subtask.executor_namespace, subtask.executor_name)
                )

        # Stop running subtasks on executor (deduplicated by (namespace, name))
        for executor_namespace, executor_name in unique_executor_keys:
            try:
                logger.info(
                    f"deleting task - delete_executor_task ns={executor_namespace} name={executor_name}"
                )
                # Use sync version to avoid event loop issues
                executor_kinds_service.delete_executor_task_sync(
                    executor_name, executor_namespace
                )
            except Exception as e:
                # Log error but continue with status update
                logger.warning(
                    f"Failed to delete executor task ns={executor_namespace} name={executor_name}: {str(e)}"
                )

        # Update all subtasks to DELETE status
        db.query(Subtask).filter(Subtask.task_id == task_id).update(
            {
                Subtask.executor_deleted_at: True,
                Subtask.status: SubtaskStatus.DELETE,
                Subtask.updated_at: datetime.now(),
            }
        )

        # Update task status to DELETE
        task_crd = Task.model_validate(task.json)
        if task_crd.status:
            task_crd.status.status = "DELETE"
            task_crd.status.updatedAt = datetime.now()
        # Use model_dump's exclude_none and json_encoders options to ensure datetime is properly serialized
        task.json = task_crd.model_dump(mode="json", exclude_none=True)
        task.updated_at = datetime.now()
        task.is_active = False
        flag_modified(task, "json")

        db.commit()

    async def cancel_task(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        background_task_runner: Optional[Callable] = None,
    ) -> Dict[str, Any]:
        """
        Cancel a running task by calling executor_manager or Chat Shell cancel.

        Args:
            db: Database session
            task_id: Task ID to cancel
            user_id: User ID who owns the task
            background_task_runner: Optional callback to run background tasks (e.g., BackgroundTasks.add_task)

        Returns:
            Dict with message and status
        """
        # Verify user owns this task
        task_dict = self.get_task_detail(db=db, task_id=task_id, user_id=user_id)
        if not task_dict:
            raise HTTPException(status_code=404, detail="Task not found")

        # Check if task is already in a final state
        current_status = task_dict.get("status", "")
        final_states = ["COMPLETED", "FAILED", "CANCELLED", "DELETE"]

        if current_status in final_states:
            logger.warning(
                f"Task {task_id} is already in final state {current_status}, cannot cancel"
            )
            raise HTTPException(
                status_code=400,
                detail=f"Task is already {current_status.lower()}, cannot cancel",
            )

        # Check if task is already being cancelled
        if current_status == "CANCELLING":
            logger.info(f"Task {task_id} is already being cancelled")
            return {
                "message": "Task is already being cancelled",
                "status": "CANCELLING",
            }

        # Check if this is a Chat Shell task by looking at the source label
        is_chat_shell = False
        task_kind = (
            db.query(Kind)
            .filter(
                Kind.id == task_id,
                Kind.kind == "Task",
                Kind.is_active == True,
            )
            .first()
        )

        if task_kind and task_kind.json:
            task_crd = Task.model_validate(task_kind.json)
            if task_crd.metadata.labels:
                source = task_crd.metadata.labels.get("source", "")
                is_chat_shell = source == "chat_shell"

        logger.info(f"Task {task_id} is_chat_shell={is_chat_shell}")

        if is_chat_shell:
            # For Chat Shell tasks, find the running subtask and cancel via session manager
            running_subtask = (
                db.query(Subtask)
                .filter(
                    Subtask.task_id == task_id,
                    Subtask.user_id == user_id,
                    Subtask.role == SubtaskRole.ASSISTANT,
                    Subtask.status == SubtaskStatus.RUNNING,
                )
                .first()
            )

            if running_subtask:
                # Cancel the Chat Shell stream in background
                if background_task_runner:
                    background_task_runner(
                        self._call_chat_shell_cancel, running_subtask.id
                    )

                # Update subtask status to COMPLETED (not CANCELLED, to show partial content)
                running_subtask.status = SubtaskStatus.COMPLETED
                running_subtask.progress = 100
                running_subtask.completed_at = datetime.now()
                running_subtask.updated_at = datetime.now()
                running_subtask.error_message = ""
                db.commit()

                # Update task status to COMPLETED (not CANCELLING, for Chat Shell)
                try:
                    self.update_task(
                        db=db,
                        task_id=task_id,
                        obj_in=TaskUpdate(status="COMPLETED"),
                        user_id=user_id,
                    )
                    logger.info(
                        f"Chat Shell task {task_id} cancelled and marked as COMPLETED"
                    )
                except Exception as e:
                    logger.error(
                        f"Failed to update Chat Shell task {task_id} status: {str(e)}"
                    )
                return {"message": "Chat stopped successfully", "status": "COMPLETED"}
            else:
                # No running subtask found, just mark task as completed
                try:
                    self.update_task(
                        db=db,
                        task_id=task_id,
                        obj_in=TaskUpdate(status="COMPLETED"),
                        user_id=user_id,
                    )
                except Exception as e:
                    logger.error(f"Failed to update task {task_id} status: {str(e)}")

                return {"message": "No running stream to cancel", "status": "COMPLETED"}
        else:
            # For non-Chat Shell tasks, use executor_manager
            # Update task status to CANCELLING immediately
            try:
                self.update_task(
                    db=db,
                    task_id=task_id,
                    obj_in=TaskUpdate(status="CANCELLING"),
                    user_id=user_id,
                )
                logger.info(
                    f"Task {task_id} status updated to CANCELLING by user {user_id}"
                )
            except Exception as e:
                logger.error(
                    f"Failed to update task {task_id} status to CANCELLING: {str(e)}"
                )
                raise HTTPException(
                    status_code=500, detail=f"Failed to update task status: {str(e)}"
                )

            # Call executor_manager in the background
            if background_task_runner:
                background_task_runner(self._call_executor_cancel, task_id)

            return {"message": "Cancel request accepted", "status": "CANCELLING"}

    async def _call_executor_cancel(self, task_id: int):
        """Background task to call executor_manager cancel API"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    settings.EXECUTOR_CANCEL_TASK_URL,
                    json={"task_id": task_id},
                    timeout=60.0,
                )
                response.raise_for_status()
                logger.info(
                    f"Task {task_id} cancelled successfully via executor_manager"
                )
        except Exception as e:
            logger.error(
                f"Error calling executor_manager to cancel task {task_id}: {str(e)}"
            )

    async def _call_chat_shell_cancel(self, subtask_id: int):
        """Background task to cancel Chat Shell streaming via session manager"""
        try:
            from app.services.chat.session_manager import session_manager

            success = await session_manager.cancel_stream(subtask_id)
            if success:
                logger.info(
                    f"Chat Shell stream cancelled successfully for subtask {subtask_id}"
                )
            else:
                logger.warning(
                    f"Failed to cancel Chat Shell stream for subtask {subtask_id}"
                )
        except Exception as e:
            logger.error(
                f"Error cancelling Chat Shell stream for subtask {subtask_id}: {str(e)}"
            )

    def create_task_id(self, db: Session, user_id: int) -> int:
        """
        Create new task id using kinds table auto increment (pre-allocation mechanism)
        Compatible with concurrent scenarios
        """
        import json as json_lib

        from sqlalchemy import text

        try:
            # First check if user already has a Placeholder record
            existing_placeholder = db.execute(
                text(
                    """
                SELECT id FROM kinds
                WHERE user_id = :user_id AND kind = 'Placeholder' AND is_active = false
                LIMIT 1
            """
                ),
                {"user_id": user_id},
            ).fetchone()

            if existing_placeholder:
                # Return existing placeholder ID
                return existing_placeholder[0]

            # Create placeholder JSON data
            placeholder_json = {
                "kind": "Placeholder",
                "metadata": {"name": "temp-placeholder", "namespace": "default"},
                "spec": {},
                "status": {"state": "Reserved"},
            }

            # Insert placeholder record with real user_id, let MySQL auto-increment handle the ID allocation
            # Keep the placeholder record until validate_task_id is called
            result = db.execute(
                text(
                    """
                INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at)
                VALUES (:user_id, 'Placeholder', 'temp-placeholder', 'default', :json, false, NOW(), NOW())
            """
                ),
                {"user_id": user_id, "json": json_lib.dumps(placeholder_json)},
            )

            # Get the auto-generated ID
            allocated_id = result.lastrowid
            if not allocated_id:
                raise Exception("Failed to get allocated ID")

            # Do NOT delete the placeholder record here - keep it for validation
            db.commit()

            return allocated_id

        except Exception as e:
            db.rollback()
            raise HTTPException(
                status_code=500, detail=f"Unable to allocate task ID: {str(e)}"
            )

    def validate_task_id(self, db: Session, task_id: int) -> bool:
        """
        Validate that task_id is valid and clean up placeholder if exists
        """
        from sqlalchemy import text

        # Check if task_id exists and get its kind
        existing_record = db.execute(
            text("SELECT kind FROM kinds WHERE id = :task_id"), {"task_id": task_id}
        ).fetchone()

        if existing_record:
            kind = existing_record[0]

            # If it's a Placeholder, delete it and return True
            if kind == "Placeholder":
                db.execute(text("DELETE FROM kinds WHERE id = :id"), {"id": task_id})
                db.commit()
                return True

            # If it's any other kind, it's valid
            return True

        return False

    def _convert_to_task_dict(
        self, task: Kind, db: Session, user_id: int
    ) -> Dict[str, Any]:
        """
        Convert kinds Task to task-like dictionary
        """
        task_crd = Task.model_validate(task.json)

        # Get workspace data
        workspace = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Workspace",
                Kind.name == task_crd.spec.workspaceRef.name,
                Kind.namespace == task_crd.spec.workspaceRef.namespace,
                Kind.is_active == True,
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
        team = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Team",
                Kind.name == task_crd.spec.teamRef.name,
                Kind.namespace == task_crd.spec.teamRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )

        # If not found in user's own teams, check shared teams
        if not team:
            shared_teams = (
                db.query(SharedTeam)
                .filter(SharedTeam.user_id == user_id, SharedTeam.is_active == True)
                .all()
            )

            original_user_ids = [st.original_user_id for st in shared_teams]
            if original_user_ids:
                team = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id.in_(original_user_ids),
                        Kind.kind == "Team",
                        Kind.name == task_crd.spec.teamRef.name,
                        Kind.namespace == task_crd.spec.teamRef.namespace,
                        Kind.is_active == True,
                    )
                    .first()
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
        user = db.query(User).filter(User.id == user_id).first()
        user_name = user.user_name if user else ""

        type = (
            task_crd.metadata.labels
            and task_crd.metadata.labels.get("type")
            or "online"
        )
        task_type = (
            task_crd.metadata.labels
            and task_crd.metadata.labels.get("taskType")
            or "chat"
        )

        model_id = task_crd.metadata.labels and task_crd.metadata.labels.get("modelId")

        # Extract is_group_chat from task spec
        is_group_chat = (
            task_crd.spec.is_group_chat
            if hasattr(task_crd.spec, "is_group_chat")
            else False
        )

        return {
            "id": task.id,
            "type": type,
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
            "is_group_chat": is_group_chat,  # Add is_group_chat field
        }

    def _convert_team_to_dict(
        self, team: Kind, db: Session, user_id: int
    ) -> Dict[str, Any]:
        """
        Convert kinds Team to team-like dictionary (simplified version)
        """
        team_crd = Team.model_validate(team.json)

        # Convert members to bots format
        bots = []
        for member in team_crd.spec.members:
            # Find bot in kinds table
            bot = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Bot",
                    Kind.name == member.botRef.name,
                    Kind.namespace == member.botRef.namespace,
                    Kind.is_active == True,
                )
                .first()
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
        user = db.query(User).filter(User.id == team.user_id).first()
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

    def _create_subtasks(
        self, db: Session, task: Kind, team: Kind, user_id: int, user_prompt: str
    ) -> None:
        """
        Create subtasks based on team's workflow configuration
        """
        logger.info(
            f"_create_subtasks called with task_id={task.id}, team_id={team.id}, user_id={user_id}"
        )
        team_crd = Team.model_validate(team.json)
        task_crd = Task.model_validate(task.json)

        if not team_crd.spec.members:
            logger.warning(f"No members configured in team {team.id}")
            raise HTTPException(status_code=400, detail="No members configured in team")

        # Get bot IDs from team members
        bot_ids = []
        for member in team_crd.spec.members:
            # Find bot in kinds table
            bot = (
                db.query(Kind)
                .filter(
                    Kind.user_id == team.user_id,
                    Kind.kind == "Bot",
                    Kind.name == member.botRef.name,
                    Kind.namespace == member.botRef.namespace,
                    Kind.is_active == True,
                )
                .first()
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
            executor_namespace="",  # Add default empty string for NOT NULL constraint
            executor_name="",  # Add default empty string for NOT NULL constraint
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
            # Create individual subtasks for each bot in pipeline mode
            executor_infos = self._get_pipeline_executor_info(existing_subtasks)
            for i, member in enumerate(team_crd.spec.members):
                # Find bot in kinds table
                bot = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == team.user_id,
                        Kind.kind == "Bot",
                        Kind.name == member.botRef.name,
                        Kind.namespace == member.botRef.namespace,
                        Kind.is_active == True,
                    )
                    .first()
                )

                if bot is None:
                    raise Exception(
                        f"Bot {member.botRef.name} not found in kinds table"
                    )

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
                    # If executor_infos is not empty, take the i-th one, otherwise use empty string
                    executor_name=(
                        executor_infos[i].get("executor_name")
                        if len(executor_infos) > i
                        else ""
                    ),
                    executor_namespace=(
                        executor_infos[i].get("executor_namespace")
                        if len(executor_infos) > i
                        else ""
                    ),
                    error_message="",
                    completed_at=datetime.now(),
                    result=None,
                )

                # Update id of next message and parent
                next_message_id = next_message_id + 1
                parent_id = parent_id + 1

                db.add(subtask)
        else:
            # For other collaboration models, create a single assistant subtask
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

    def _get_pipeline_executor_info(
        self, existing_subtasks: List[Subtask]
    ) -> List[Dict[str, str]]:
        """
        Get executor info from existing subtasks for pipeline mode
        """
        first_group_assistants = []
        for s in existing_subtasks:
            if s.role == SubtaskRole.USER:
                break
            if s.role == SubtaskRole.ASSISTANT:
                first_group_assistants.append(
                    {
                        "executor_namespace": s.executor_namespace,
                        "executor_name": s.executor_name,
                    }
                )

        first_group_assistants.reverse()
        return first_group_assistants

    def _get_tasks_related_data_batch(
        self, db: Session, tasks: List[Kind], user_id: int
    ) -> Dict[str, Dict[str, Any]]:
        """
        Batch get workspace and team data for multiple tasks to reduce database queries
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
                team_refs.add(
                    (task_crd.spec.teamRef.name, task_crd.spec.teamRef.namespace)
                )

        # Batch query workspaces
        workspace_data = {}
        if workspace_refs:
            workspace_names, workspace_namespaces = zip(*workspace_refs)
            workspaces = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Workspace",
                    Kind.name.in_(workspace_names),
                    Kind.namespace.in_(workspace_namespaces),
                    Kind.is_active == True,
                )
                .all()
            )

            for workspace in workspaces:
                key = f"{workspace.name}:{workspace.namespace}"
                if workspace.json:
                    workspace_crd = Workspace.model_validate(workspace.json)
                    workspace_data[key] = {
                        "git_url": workspace_crd.spec.repository.gitUrl,
                        "git_repo": workspace_crd.spec.repository.gitRepo,
                        "git_repo_id": workspace_crd.spec.repository.gitRepoId or 0,
                        "git_domain": workspace_crd.spec.repository.gitDomain,
                        "branch_name": workspace_crd.spec.repository.branchName,
                    }
                else:
                    workspace_data[key] = {
                        "git_url": "",
                        "git_repo": "",
                        "git_repo_id": 0,
                        "git_domain": "",
                        "branch_name": "",
                    }

        # Batch query teams (including shared teams)
        team_data = {}
        if team_refs:
            team_names, team_namespaces = zip(*team_refs)
            # First query user's own teams
            teams = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Team",
                    Kind.name.in_(team_names),
                    Kind.namespace.in_(team_namespaces),
                    Kind.is_active == True,
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
                # Get all shared teams for this user
                shared_teams = (
                    db.query(SharedTeam)
                    .filter(SharedTeam.user_id == user_id, SharedTeam.is_active == True)
                    .all()
                )

                # Get original user IDs from shared teams
                original_user_ids = [st.original_user_id for st in shared_teams]

                if original_user_ids:
                    # Query teams from shared team owners
                    missing_team_names, missing_team_namespaces = zip(
                        *missing_team_refs
                    )
                    shared_team_kinds = (
                        db.query(Kind)
                        .filter(
                            Kind.user_id.in_(original_user_ids),
                            Kind.kind == "Team",
                            Kind.name.in_(missing_team_names),
                            Kind.namespace.in_(missing_team_namespaces),
                            Kind.is_active == True,
                        )
                        .all()
                    )

                    for team in shared_team_kinds:
                        key = f"{team.name}:{team.namespace}"
                        team_data[key] = team

        # Get user info once
        user = db.query(User).filter(User.id == user_id).first()
        user_name = user.user_name if user else ""

        # Build result mapping
        result = {}
        for task in tasks:
            task_crd = task_crd_map[task.id]

            # Get workspace data
            workspace_key = f"{task_crd.spec.workspaceRef.name}:{task_crd.spec.workspaceRef.namespace}"
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

        # Batch query member counts for is_group_chat detection
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
            task = db.query(Kind).filter(Kind.id == task_id).first()
            if task and task.json:
                is_group_chat = task.json.get("spec", {}).get("is_group_chat", False)
                if not is_group_chat:
                    is_group_chat = member_counts.get(task_id, 0) > 0
            else:
                is_group_chat = member_counts.get(task_id, 0) > 0
            data["is_group_chat"] = is_group_chat

        return result

    def _convert_to_task_dict_optimized(
        self, task: Kind, related_data: Dict[str, Any], task_crd: Task
    ) -> Dict[str, Any]:
        """
        Optimized version of _convert_to_task_dict that uses pre-fetched related data
        """
        workspace_data = related_data.get("workspace_data", {})

        # Get task type from metadata labels
        type = (
            task_crd.metadata.labels
            and task_crd.metadata.labels.get("type")
            or "online"
        )
        task_type = (
            task_crd.metadata.labels
            and task_crd.metadata.labels.get("taskType")
            or "chat"
        )

        return {
            "id": task.id,
            "type": type,
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
        }


task_kinds_service = TaskKindsService(Kind)
