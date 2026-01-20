# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Task query methods.

This module contains methods for querying tasks with various filters,
pagination, and search capabilities.
"""

import logging
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.task import TaskResource
from app.schemas.kind import Bot, Ghost, Model, Shell, Task, Team

from .converters import convert_to_task_dict, convert_to_task_dict_optimized
from .filters import (
    filter_tasks_for_display,
    filter_tasks_since_id,
    filter_tasks_with_title_match,
    is_background_task,
    is_non_interacted_subscription_task,
)
from .helpers import build_lite_task_list, get_tasks_related_data_batch

logger = logging.getLogger(__name__)


class TaskQueryMixin:
    """Mixin class providing task query methods."""

    def get_user_tasks_with_pagination(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Get user's Task list with pagination (only active tasks, excluding DELETE status).

        Optimized version using raw SQL to avoid MySQL "Out of sort memory" errors.
        DELETE status tasks are filtered in application layer.
        Includes tasks owned by user AND tasks user is a member of (group chats).
        """
        # Use raw SQL to get task IDs where user is owner OR member
        # Exclude system namespace tasks (background tasks)
        count_sql = text(
            """
            SELECT COUNT(DISTINCT k.id)
            FROM tasks k
            LEFT JOIN task_members tm ON k.id = tm.task_id AND tm.user_id = :user_id AND tm.status = 'ACTIVE'
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND k.namespace != 'system'
            AND (k.user_id = :user_id OR tm.id IS NOT NULL)
        """
        )
        total_result = db.execute(count_sql, {"user_id": user_id}).scalar()

        # Get task IDs sorted by created_at
        ids_sql = text(
            """
            SELECT DISTINCT k.id, k.created_at
            FROM tasks k
            LEFT JOIN task_members tm ON k.id = tm.task_id AND tm.user_id = :user_id AND tm.status = 'ACTIVE'
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND k.namespace != 'system'
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
        tasks = db.query(TaskResource).filter(TaskResource.id.in_(task_ids)).all()

        # Filter tasks for display
        id_to_task = filter_tasks_for_display(tasks)

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
        related_data_batch = get_tasks_related_data_batch(db, filtered_tasks, user_id)

        result = []
        for task in filtered_tasks:
            task_crd = Task.model_validate(task.json)
            task_related_data = related_data_batch.get(str(task.id), {})
            result.append(
                convert_to_task_dict_optimized(task, task_related_data, task_crd)
            )

        return result, total

    def get_user_tasks_lite(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Get user's Task list with pagination (lightweight version for list display).

        Only returns essential fields without JOIN queries for better performance.
        Includes tasks owned by user AND tasks user is a member of (group chats).
        """
        # Get task IDs where user is owner OR member
        count_sql = text(
            """
            SELECT COUNT(DISTINCT k.id)
            FROM tasks k
            LEFT JOIN task_members tm ON k.id = tm.task_id AND tm.user_id = :user_id AND tm.status = 'ACTIVE'
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND k.namespace != 'system'
            AND (k.user_id = :user_id OR tm.id IS NOT NULL)
        """
        )
        total_result = db.execute(count_sql, {"user_id": user_id}).scalar()

        # Get task IDs sorted by created_at
        ids_sql = text(
            """
            SELECT DISTINCT k.id, k.created_at
            FROM tasks k
            LEFT JOIN task_members tm ON k.id = tm.task_id AND tm.user_id = :user_id AND tm.status = 'ACTIVE'
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND k.namespace != 'system'
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
        tasks = db.query(TaskResource).filter(TaskResource.id.in_(task_ids)).all()

        # Filter tasks for display
        id_to_task = filter_tasks_for_display(tasks)

        # Restore the original order and apply limit
        filtered_tasks = []
        for tid in task_ids:
            if tid in id_to_task:
                filtered_tasks.append(id_to_task[tid])
                if len(filtered_tasks) >= limit:
                    break

        total = total_result if total_result else 0

        # Get task member counts in batch for is_group_chat detection
        from app.models.task_member import MemberStatus, TaskMember

        task_ids_for_members = [t.id for t in filtered_tasks]
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

        # Build lightweight result
        result = self._build_lite_result(db, filtered_tasks, user_id, member_counts)

        return result, total

    def get_user_group_tasks_lite(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 50
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Get user's group chat task list with pagination (lightweight version).

        Returns only group chat tasks sorted by updated_at descending.
        """
        from app.models.task_member import MemberStatus, TaskMember

        # Get task IDs that are group chats (have members)
        member_task_ids_sql = text(
            """
            SELECT DISTINCT tm.task_id
            FROM task_members tm
            INNER JOIN tasks k ON k.id = tm.task_id
            WHERE tm.status = 'ACTIVE'
            AND k.kind = 'Task'
            AND k.is_active = true
            AND k.namespace != 'system'
            AND (k.user_id = :user_id OR tm.user_id = :user_id)
        """
        )
        member_task_ids_result = db.execute(
            member_task_ids_sql, {"user_id": user_id}
        ).fetchall()
        member_task_ids = {row[0] for row in member_task_ids_result}

        # Also get tasks where is_group_chat is explicitly set to true
        explicit_group_sql = text(
            """
            SELECT DISTINCT k.id
            FROM tasks k
            LEFT JOIN task_members tm ON k.id = tm.task_id AND tm.user_id = :user_id AND tm.status = 'ACTIVE'
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND k.namespace != 'system'
            AND (k.user_id = :user_id OR tm.id IS NOT NULL)
            AND JSON_EXTRACT(k.json, '$.spec.is_group_chat') = true
        """
        )
        explicit_group_result = db.execute(
            explicit_group_sql, {"user_id": user_id}
        ).fetchall()
        explicit_group_ids = {row[0] for row in explicit_group_result}

        # Combine both sets
        all_group_task_ids = member_task_ids | explicit_group_ids

        if not all_group_task_ids:
            return [], 0

        # Load full task data for all group chat IDs
        tasks = (
            db.query(TaskResource).filter(TaskResource.id.in_(all_group_task_ids)).all()
        )

        # Filter out DELETE status tasks
        valid_tasks = []
        for t in tasks:
            task_crd = Task.model_validate(t.json)
            status = task_crd.status.status if task_crd.status else "PENDING"
            if status != "DELETE":
                valid_tasks.append(t)

        # Sort by updated_at descending
        valid_tasks.sort(key=lambda t: t.updated_at, reverse=True)

        # Apply pagination
        paginated_tasks = valid_tasks[skip : skip + limit]

        # Build lightweight result
        result = build_lite_task_list(db, paginated_tasks, user_id)

        return result, len(valid_tasks)

    def get_user_personal_tasks_lite(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int = 0,
        limit: int = 50,
        types: List[str] = None,
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Get user's personal (non-group-chat) task list with pagination.

        Args:
            types: List of task types to include. Options: 'online', 'offline', 'subscription'.
                   Default is ['online', 'offline'] if None.
        """
        if types is None:
            types = ["online", "offline"]

        from app.models.task_member import MemberStatus, TaskMember

        # Get all task IDs that are group chats (have members)
        member_task_ids_sql = text(
            """
            SELECT DISTINCT tm.task_id
            FROM task_members tm
            INNER JOIN tasks k ON k.id = tm.task_id
            WHERE tm.status = 'ACTIVE'
            AND k.kind = 'Task'
            AND k.is_active = true
            AND k.namespace != 'system'
        """
        )
        member_task_ids_result = db.execute(member_task_ids_sql).fetchall()
        member_task_ids = {row[0] for row in member_task_ids_result}

        # Also get task IDs where is_group_chat is explicitly set to true
        explicit_group_sql = text(
            """
            SELECT DISTINCT k.id
            FROM tasks k
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND k.namespace != 'system'
            AND k.user_id = :user_id
            AND JSON_EXTRACT(k.json, '$.spec.is_group_chat') = true
        """
        )
        explicit_group_result = db.execute(
            explicit_group_sql, {"user_id": user_id}
        ).fetchall()
        explicit_group_ids = {row[0] for row in explicit_group_result}

        # Combine all group task IDs to exclude
        all_group_task_ids = member_task_ids | explicit_group_ids

        # Get user's owned tasks (not group chats)
        count_sql = text(
            """
            SELECT COUNT(*)
            FROM tasks k
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND k.namespace != 'system'
            AND k.user_id = :user_id
        """
        )
        total_result = db.execute(count_sql, {"user_id": user_id}).scalar()

        # Get task IDs sorted by created_at
        ids_sql = text(
            """
            SELECT k.id, k.created_at
            FROM tasks k
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND k.namespace != 'system'
            AND k.user_id = :user_id
            ORDER BY k.created_at DESC
            LIMIT :limit OFFSET :skip
        """
        )
        task_id_rows = db.execute(
            ids_sql, {"user_id": user_id, "limit": limit + 100, "skip": skip}
        ).fetchall()
        task_ids = [row[0] for row in task_id_rows]

        if not task_ids:
            return [], 0

        # Load full task data
        tasks = db.query(TaskResource).filter(TaskResource.id.in_(task_ids)).all()

        # Filter tasks
        valid_tasks = self._filter_personal_tasks(tasks, all_group_task_ids, types)

        # Restore original order and apply limit
        id_to_task = {t.id: t for t in valid_tasks}
        ordered_tasks = []
        for tid in task_ids:
            if tid in id_to_task:
                ordered_tasks.append(id_to_task[tid])
                if len(ordered_tasks) >= limit:
                    break

        # Build lightweight result
        result = build_lite_task_list(db, ordered_tasks, user_id)

        # Recalculate total
        total = total_result - len(all_group_task_ids) if total_result else 0
        if total < 0:
            total = len(ordered_tasks)

        return result, max(total, len(ordered_tasks))

    def _filter_personal_tasks(
        self,
        tasks: List[TaskResource],
        all_group_task_ids: set,
        types: List[str],
    ) -> List[TaskResource]:
        """Filter personal tasks based on type criteria."""
        valid_tasks = []
        include_online = "online" in types
        include_offline = "offline" in types
        include_subscription = "subscription" in types

        for t in tasks:
            # Skip group chat tasks
            if t.id in all_group_task_ids:
                continue

            task_crd = Task.model_validate(t.json)
            status = task_crd.status.status if task_crd.status else "PENDING"
            if status == "DELETE":
                continue

            # Determine task type from labels
            labels = task_crd.metadata.labels or {}
            is_subscription = labels.get("type") == "subscription"
            task_type_label = labels.get("taskType", "chat")
            is_code = task_type_label == "code"

            # Apply type filter
            if is_subscription:
                if not include_subscription:
                    continue
            elif is_code:
                if not include_offline:
                    continue
            else:
                if not include_online:
                    continue

            valid_tasks.append(t)

        return valid_tasks

    def get_new_tasks_since_id(
        self, db: Session, *, user_id: int, since_id: int, limit: int = 50
    ) -> List[Dict[str, Any]]:
        """
        Get new tasks created after the specified task ID.

        Returns tasks with ID greater than since_id, ordered by ID descending.
        """
        # Get task IDs where user is owner OR member, with ID > since_id
        ids_sql = text(
            """
            SELECT DISTINCT k.id, k.created_at
            FROM tasks k
            LEFT JOIN task_members tm ON k.id = tm.task_id AND tm.user_id = :user_id AND tm.status = 'ACTIVE'
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND k.namespace != 'system'
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

        # Load full task data
        tasks = db.query(TaskResource).filter(TaskResource.id.in_(task_ids)).all()

        # Filter tasks
        id_to_task = filter_tasks_since_id(tasks)

        # Restore the original order
        filtered_tasks = [id_to_task[tid] for tid in task_ids if tid in id_to_task]

        # Get task member counts
        from app.models.task_member import MemberStatus, TaskMember

        task_ids_for_members = [t.id for t in filtered_tasks]
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

        # Build lightweight result
        result = self._build_lite_result(db, filtered_tasks, user_id, member_counts)

        return result

    def get_user_tasks_by_title_with_pagination(
        self, db: Session, *, user_id: int, title: str, skip: int = 0, limit: int = 100
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Fuzzy search tasks by title for current user (pagination).

        Excludes DELETE status tasks.
        """
        # Get task IDs
        count_sql = text(
            """
            SELECT COUNT(*) FROM tasks
            WHERE user_id = :user_id
            AND kind = 'Task'
            AND is_active = true
            AND namespace != 'system'
        """
        )
        total_result = db.execute(count_sql, {"user_id": user_id}).scalar()

        ids_sql = text(
            """
            SELECT id FROM tasks
            WHERE user_id = :user_id
            AND kind = 'Task'
            AND is_active = true
            AND namespace != 'system'
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

        # Load full task data
        tasks = db.query(TaskResource).filter(TaskResource.id.in_(task_ids)).all()

        # Filter by title
        title_lower = title.lower()
        id_to_task = filter_tasks_with_title_match(tasks, title_lower)

        # Restore the original order and apply limit
        filtered_tasks = []
        for tid in task_ids:
            if tid in id_to_task:
                filtered_tasks.append(id_to_task[tid])
                if len(filtered_tasks) >= limit:
                    break

        total = len(id_to_task)

        if not filtered_tasks:
            return [], total

        # Get all related data in batch
        related_data_batch = get_tasks_related_data_batch(db, filtered_tasks, user_id)

        result = []
        for task in filtered_tasks:
            task_crd = Task.model_validate(task.json)
            task_related_data = related_data_batch.get(str(task.id), {})
            result.append(
                convert_to_task_dict_optimized(task, task_related_data, task_crd)
            )

        return result, total

    def get_task_by_id(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Optional[Dict[str, Any]]:
        """
        Get Task by ID and user ID (only active tasks).

        Allows access if user is the owner OR a member of the group chat.
        """
        from app.services.task_member_service import task_member_service

        # Check if task exists
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.is_(True),
                text("JSON_EXTRACT(json, '$.status.status') != 'DELETE'"),
            )
            .first()
        )

        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        # Check if user has access (owner or active member)
        if not task_member_service.is_member(db, task_id, user_id):
            raise HTTPException(status_code=404, detail="Task not found")

        # Use task owner's user_id for conversion
        convert_user_id = task.user_id
        return convert_to_task_dict(task, db, convert_user_id)

    def get_task_detail(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Dict[str, Any]:
        """
        Get detailed task information including related user, team, subtasks.
        """
        from app.services.adapters.team_kinds import team_kinds_service
        from app.services.readers.kinds import KindType, kindReader
        from app.services.readers.users import userReader
        from app.services.subtask import subtask_service
        from app.services.task_member_service import task_member_service

        task_dict = self.get_task_by_id(db, task_id=task_id, user_id=user_id)

        # Get related user
        user = userReader.get_by_id(db, user_id)

        # Get related team
        team_id = task_dict.get("team_id")
        team = None
        if team_id:
            logger.info(
                f"[get_task_detail] task_id={task_id}, team_id={team_id}, user_id={user_id}"
            )
            team = kindReader.get_by_id(db, KindType.TEAM, team_id)
            if team:
                task_owner_id = task_member_service.get_task_owner_id(db, task_id)
                logger.info(
                    f"[get_task_detail] task_owner_id={task_owner_id}, team found: {team is not None}"
                )
                if task_owner_id:
                    team = team_kinds_service._convert_to_team_dict(
                        team, db, task_owner_id
                    )
                else:
                    logger.warning(
                        f"[get_task_detail] task_owner_id is None for task_id={task_id}"
                    )
                    team = None

        # Get related subtasks
        subtasks = subtask_service.get_by_task(
            db=db, task_id=task_id, user_id=user_id, from_latest=True
        )

        # Get all bot objects for the subtasks
        all_bot_ids = set()
        for subtask in subtasks:
            if subtask.bot_ids:
                all_bot_ids.update(subtask.bot_ids)

        bots = self._get_bots_for_subtasks(db, all_bot_ids)

        # Convert subtasks to dict
        subtasks_dict = self._convert_subtasks_to_dict(subtasks, bots)

        task_dict["user"] = user
        task_dict["team"] = team
        task_dict["subtasks"] = subtasks_dict

        # Add group chat information
        self._add_group_chat_info_to_task(db, task_id, task_dict, user_id)

        return task_dict

    def _get_bots_for_subtasks(
        self, db: Session, all_bot_ids: set
    ) -> Dict[int, Dict[str, Any]]:
        """Get bot information for subtasks."""
        from app.services.readers.kinds import KindType, kindReader

        bots = {}
        if not all_bot_ids:
            return bots

        bot_objects = kindReader.get_by_ids(db, KindType.BOT, list(all_bot_ids))

        for bot in bot_objects:
            bot_crd = Bot.model_validate(bot.json)

            # Initialize default values
            shell_type = ""
            agent_config = {}
            system_prompt = ""
            mcp_servers = {}

            # Get Ghost data
            ghost = kindReader.get_by_name_and_namespace(
                db,
                bot.user_id,
                KindType.GHOST,
                bot_crd.spec.ghostRef.namespace,
                bot_crd.spec.ghostRef.name,
            )
            if ghost and ghost.json:
                ghost_crd = Ghost.model_validate(ghost.json)
                system_prompt = ghost_crd.spec.systemPrompt
                mcp_servers = ghost_crd.spec.mcpServers or {}

            # Get Model data
            if bot_crd.spec.modelRef:
                model = kindReader.get_by_name_and_namespace(
                    db,
                    bot.user_id,
                    KindType.MODEL,
                    bot_crd.spec.modelRef.namespace,
                    bot_crd.spec.modelRef.name,
                )
                if model and model.json:
                    model_crd = Model.model_validate(model.json)
                    agent_config = model_crd.spec.modelConfig

            # Get Shell data
            shell = kindReader.get_by_name_and_namespace(
                db,
                bot.user_id,
                KindType.SHELL,
                bot_crd.spec.shellRef.namespace,
                bot_crd.spec.shellRef.name,
            )
            if shell and shell.json:
                shell_crd = Shell.model_validate(shell.json)
                shell_type = shell_crd.spec.shellType

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

        return bots

    def _convert_subtasks_to_dict(
        self, subtasks: List, bots: Dict[int, Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Convert subtasks to dictionary format."""
        subtasks_dict = []
        for subtask in subtasks:
            # Convert contexts to dict format
            contexts_list = []
            if hasattr(subtask, "contexts") and subtask.contexts:
                for ctx in subtask.contexts:
                    ctx_dict = {
                        "id": ctx.id,
                        "context_type": ctx.context_type,
                        "name": ctx.name,
                        "status": (
                            ctx.status.value
                            if hasattr(ctx.status, "value")
                            else ctx.status
                        ),
                    }
                    # Add type-specific fields
                    if ctx.context_type == "attachment":
                        ctx_dict.update(
                            {
                                "file_extension": ctx.file_extension,
                                "file_size": ctx.file_size,
                                "mime_type": ctx.mime_type,
                            }
                        )
                    elif ctx.context_type == "knowledge_base":
                        ctx_dict.update({"document_count": ctx.document_count})
                    elif ctx.context_type == "table":
                        type_data = ctx.type_data or {}
                        url = type_data.get("url")
                        if url:
                            ctx_dict["source_config"] = {"url": url}
                    contexts_list.append(ctx_dict)

            subtask_dict = {
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
                "bots": [
                    bots.get(bot_id) for bot_id in subtask.bot_ids if bot_id in bots
                ],
                "contexts": contexts_list,
                "attachments": [],
                "sender_type": subtask.sender_type,
                "sender_user_id": subtask.sender_user_id,
                "sender_user_name": getattr(subtask, "sender_user_name", None),
                "reply_to_subtask_id": subtask.reply_to_subtask_id,
            }
            subtasks_dict.append(subtask_dict)

        return subtasks_dict

    def _add_group_chat_info_to_task(
        self, db: Session, task_id: int, task_dict: Dict[str, Any], user_id: int
    ) -> None:
        """Add group chat information to task dict."""
        from app.models.task_member import MemberStatus, TaskMember

        members = (
            db.query(TaskMember)
            .filter(
                TaskMember.task_id == task_id,
                TaskMember.status == MemberStatus.ACTIVE,
            )
            .all()
        )

        is_group_chat = task_dict.get("is_group_chat", False)
        if not is_group_chat:
            is_group_chat = len(members) > 0
        task_dict["is_group_chat"] = is_group_chat
        task_dict["is_group_owner"] = task_dict.get("user_id") == user_id
        task_dict["member_count"] = len(members) if is_group_chat else None

    def _build_lite_result(
        self,
        db: Session,
        tasks: List[TaskResource],
        user_id: int,
        member_counts: Dict[int, int],
    ) -> List[Dict[str, Any]]:
        """Build lightweight task list result."""
        result = []
        for task in tasks:
            task_crd = Task.model_validate(task.json)

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

            # Get team_id
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

            # Get git_repo
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

            # Check if group chat
            task_json = task.json or {}
            is_group_chat = task_json.get("spec", {}).get("is_group_chat", False)
            if not is_group_chat:
                is_group_chat = member_counts.get(task.id, 0) > 0

            # Extract knowledge_base_id
            knowledge_base_id = None
            if task_type == "knowledge" and task_crd.spec.knowledgeBaseRefs:
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
