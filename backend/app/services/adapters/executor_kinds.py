# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import logging
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Bot, Shell, Task, Team
from app.schemas.subtask import SubtaskExecutorUpdate
from app.services.adapters.subtask_formatter import subtask_formatter
from app.services.base import BaseService
from app.services.webhook_notification import Notification, webhook_notification_service

logger = logging.getLogger(__name__)


def _get_thinking_details_type(step: Dict[str, Any]) -> Optional[str]:
    """Get the details.type from a thinking step."""
    details = step.get("details")
    if isinstance(details, dict):
        return details.get("type")
    return None


def merge_thinking_steps(thinking_steps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Merge adjacent thinking steps that have the same title, next_action, and details.type.

    This reduces the size of thinking data by combining consecutive steps of the same type,
    particularly useful for reasoning content that comes in token-by-token.
    """
    if not thinking_steps:
        return []

    merged: List[Dict[str, Any]] = []

    def copy_step(step: Dict[str, Any]) -> Dict[str, Any]:
        """Create a deep copy of a step to avoid mutating the original."""
        copied = {**step}
        if "details" in copied and isinstance(copied["details"], dict):
            copied["details"] = {**copied["details"]}
        return copied

    for step in thinking_steps:
        if not merged:
            merged.append(copy_step(step))
            continue

        last = merged[-1]
        current_details_type = _get_thinking_details_type(step)
        last_details_type = _get_thinking_details_type(last)

        can_merge = (
            step.get("title") == last.get("title")
            and step.get("next_action") == last.get("next_action")
            and current_details_type == last_details_type
            and current_details_type is not None
        )

        if can_merge:
            last_content = last.get("details", {}).get("content", "")
            new_content = step.get("details", {}).get("content", "")
            if "details" not in last:
                last["details"] = {}
            last["details"]["content"] = last_content + new_content
        else:
            merged.append(copy_step(step))

    return merged


class ExecutorKindsService(
    BaseService[Kind, SubtaskExecutorUpdate, SubtaskExecutorUpdate]
):
    """
    Executor service class using tasks table for Task operations
    """

    async def dispatch_tasks(
        self,
        db: Session,
        *,
        status: str = "PENDING",
        limit: int = 1,
        task_ids: Optional[List[int]] = None,
        type: str = "online",
    ) -> Dict[str, List[Dict]]:
        """
        Task dispatch logic with subtask support using tasks table

        Args:
            status: Subtask status to filter by
            limit: Maximum number of subtasks to return (only used when task_ids is None)
            task_ids: Optional list of task IDs to filter by
            type: Task type to filter by (default: "online")
        """
        if task_ids:
            # Scenario 1: Specify task ID list, query subtasks for these tasks
            # When multiple task_ids are provided, ignore limit parameter, each task will only take 1 subtask
            subtasks = []

            for task_id in task_ids:
                # First query tasks table to check task status
                task = (
                    db.query(TaskResource)
                    .filter(
                        TaskResource.id == task_id,
                        TaskResource.kind == "Task",
                        TaskResource.is_active,
                    )
                    .params(type=type)
                    .first()
                )
                if not task:
                    # Task doesn't exist, skip
                    continue
                # Check task status from JSON, skip if not PENDING or RUNNING
                task_crd = Task.model_validate(task.json)
                task_status = task_crd.status.status if task_crd.status else "PENDING"
                if task_status not in ["PENDING", "RUNNING"]:
                    continue

                # Check if the specified task has RUNNING status subtasks
                running_subtasks = (
                    db.query(Subtask)
                    .filter(
                        Subtask.task_id == task_id,
                        Subtask.status == SubtaskStatus.RUNNING,
                    )
                    .count()
                )

                if running_subtasks > 0:
                    # If there are running subtasks, skip this task
                    continue

                # Get subtasks for this task, only take 1 per task
                task_subtasks = self._get_subtasks_for_task(db, task_id, status, 1)
                if task_subtasks:
                    subtasks.extend(task_subtasks)
        else:
            # Scenario 2: No task_ids, first query tasks, then query first subtask for each task
            subtasks = self._get_first_subtasks_for_tasks(db, status, limit, type)

        if not subtasks:
            return {"tasks": []}

        # Update subtask status to RUNNING (concurrent safe)
        updated_subtasks = self._update_subtasks_to_running(db, subtasks)
        db.commit()

        # Format return data
        result = self._format_subtasks_response(db, updated_subtasks)
        return result

    def _get_subtasks_for_task(
        self, db: Session, task_id: int, status: str, limit: int
    ) -> List[Subtask]:
        """Get subtasks for specified task, return first one sorted by message_id"""
        return (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.status == status,
            )
            .order_by(Subtask.message_id.asc(), Subtask.created_at.asc())
            .limit(limit)
            .all()
        )

    def _get_first_subtasks_for_tasks(
        self, db: Session, status: str, limit: int, type: str
    ) -> List[Subtask]:
        """Get first subtask for multiple tasks using tasks table.

        Note: This method filters out Chat Shell type tasks because they are handled
        directly by the backend (via WebSocket or Subscription Scheduler), not by executor_manager.
        Chat Shell tasks are identified by:
        - source='chat_shell' (WebSocket chat)
        - source='subscription' with Chat shell type (Subscription Scheduler triggered)
        """
        # Step 1: First query tasks table to get limit tasks
        # Exclude tasks that should be handled by Chat Shell (not executor_manager)
        # - source='chat_shell': Direct WebSocket chat
        # - source='subscription': Subscription Scheduler triggered (Chat Shell type is handled by Subscription Scheduler directly)
        tasks = None
        # Note: We exclude 'chat_shell' source tasks because they are handled
        # directly by the backend (via WebSocket). However, we DO NOT exclude
        # 'subscription' source tasks because Subscription Scheduler can trigger Executor-type tasks
        # that need to be picked up by executor_manager.
        if type == "offline":
            tasks = (
                db.query(TaskResource)
                .filter(
                    TaskResource.kind == "Task",
                    TaskResource.is_active.is_(True),
                    text(
                        "JSON_EXTRACT(json, '$.metadata.labels.type') = 'offline' "
                        "and JSON_EXTRACT(json, '$.status.status') = :status "
                        "and (JSON_EXTRACT(json, '$.metadata.labels.source') IS NULL "
                        "    OR JSON_EXTRACT(json, '$.metadata.labels.source') != 'chat_shell')"
                    ),
                )
                .params(status=status)
                .order_by(TaskResource.created_at.desc())
                .limit(limit)
                .all()
            )
        else:
            # Include 'subscription' type tasks for executor to pick up (Subscription Scheduler triggered Executor-type tasks)
            tasks = (
                db.query(TaskResource)
                .filter(
                    TaskResource.kind == "Task",
                    TaskResource.is_active.is_(True),
                    text(
                        "(JSON_EXTRACT(json, '$.metadata.labels.type') IS NULL "
                        "    OR JSON_EXTRACT(json, '$.metadata.labels.type') = 'online' "
                        "    OR JSON_EXTRACT(json, '$.metadata.labels.type') = 'subscription') "
                        "and JSON_EXTRACT(json, '$.status.status') = :status "
                        "and (JSON_EXTRACT(json, '$.metadata.labels.source') IS NULL "
                        "    OR JSON_EXTRACT(json, '$.metadata.labels.source') != 'chat_shell')"
                    ),
                )
                .params(status=status)
                .order_by(TaskResource.created_at.desc())
                .limit(limit)
                .all()
            )

        if not tasks:
            return []

        task_ids = [task.id for task in tasks]
        # Step 2: Query first subtask with matching status for each task
        subtasks = []
        for tid in task_ids:
            first_subtask = (
                db.query(Subtask)
                .filter(
                    Subtask.task_id == tid,
                    Subtask.role == SubtaskRole.ASSISTANT,
                    Subtask.status == status,
                )
                .order_by(Subtask.message_id.asc(), Subtask.created_at.asc())
                .first()
            )

            if first_subtask:
                subtasks.append(first_subtask)

        return subtasks

    def _update_subtasks_to_running(
        self, db: Session, subtasks: List[Subtask]
    ) -> List[Subtask]:
        """Concurrently and safely update subtask status to RUNNING"""
        updated_subtasks = []

        for subtask in subtasks:
            # Use optimistic locking mechanism to ensure concurrent safety
            result = (
                db.query(Subtask)
                .filter(
                    Subtask.id == subtask.id,
                    Subtask.status
                    == SubtaskStatus.PENDING,  # Ensure only PENDING status can be updated
                )
                .update(
                    {
                        Subtask.status: SubtaskStatus.RUNNING,
                        Subtask.updated_at: datetime.now(),
                    }
                )
            )

            if result > 0:  # If update is successful
                # Reload the updated subtask
                updated_subtask = db.query(Subtask).get(subtask.id)
                updated_subtasks.append(updated_subtask)
                # update task status to RUNNING
                self._update_task_to_running(db, updated_subtask.task_id)

                # Get shell_type from the subtask's first bot for WebSocket event
                shell_type = self._get_shell_type_for_subtask(db, updated_subtask)

                # Send chat:start WebSocket event for executor tasks
                # This allows frontend to establish subtask-to-task mapping
                # and prepare for receiving chat:done event later
                self._emit_chat_start_ws_event(
                    task_id=updated_subtask.task_id,
                    subtask_id=updated_subtask.id,
                    shell_type=shell_type,
                )

        return updated_subtasks

    def _get_shell_type_for_subtask(self, db: Session, subtask: Subtask) -> str:
        """
        Get shell_type from the subtask's first bot.

        Args:
            db: Database session
            subtask: Subtask object

        Returns:
            shell_type string (e.g., 'Chat', 'ClaudeCode', 'Agno'), defaults to 'Chat'
        """
        if not subtask.bot_ids or len(subtask.bot_ids) == 0:
            logger.warning(
                f"Subtask {subtask.id} has no bots, defaulting shell_type to 'Chat'"
            )
            return "Chat"

        try:
            # Get first bot
            bot_id = subtask.bot_ids[0]
            bot = (
                db.query(Kind)
                .filter(Kind.id == bot_id, Kind.is_active.is_(True))
                .first()
            )

            if not bot:
                logger.warning(
                    f"Bot {bot_id} not found for subtask {subtask.id}, defaulting to 'Chat'"
                )
                return "Chat"

            bot_crd = Bot.model_validate(bot.json)

            # Get shell
            shell, _ = self._query_shell(
                db,
                bot_crd.spec.shellRef.name,
                bot_crd.spec.shellRef.namespace,
                bot.user_id,
            )

            if shell and shell.json:
                shell_crd = Shell.model_validate(shell.json)
                shell_type = shell_crd.spec.shellType
                logger.info(f"Got shell_type '{shell_type}' for subtask {subtask.id}")
                return shell_type

            logger.warning(f"No shell found for bot {bot_id}, defaulting to 'Chat'")
            return "Chat"

        except Exception as e:
            logger.error(
                f"Error getting shell_type for subtask {subtask.id}: {e}", exc_info=True
            )
            return "Chat"

    def _update_task_to_running(self, db: Session, task_id: int) -> None:
        """Update task status to RUNNING (only when task is PENDING) using tasks table"""
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.is_(True),
            )
            .first()
        )

        if task:
            if task:
                task_crd = Task.model_validate(task.json)
                current_status = (
                    task_crd.status.status if task_crd.status else "PENDING"
                )

                # Ensure only PENDING status can be updated
                if current_status == "PENDING":
                    if task_crd.status:
                        task_crd.status.status = "RUNNING"
                        task_crd.status.updatedAt = datetime.now()
                    task.json = task_crd.model_dump(mode="json")
                    task.updated_at = datetime.now()
                    flag_modified(task, "json")

                    # Send WebSocket event for task status update (PENDING -> RUNNING)
                    self._emit_task_status_ws_event(
                        user_id=task.user_id,
                        task_id=task_id,
                        status="RUNNING",
                        progress=task_crd.status.progress if task_crd.status else 0,
                    )

    def _format_subtasks_response(
        self, db: Session, subtasks: List[Subtask]
    ) -> Dict[str, List[Dict]]:
        """Format subtask response data using kinds table for task information.

        This method delegates to subtask_formatter for the actual formatting logic.
        """
        return subtask_formatter.format_subtasks_response(db, subtasks)

    def _query_shell(
        self,
        db: Session,
        shell_ref_name: str,
        shell_ref_namespace: str,
        bot_user_id: int,
    ) -> tuple[Optional[Kind], Optional[str]]:
        """Query Shell resource based on namespace.

        This method delegates to subtask_formatter for the actual query logic.
        """
        return subtask_formatter._query_shell(
            db, shell_ref_name, shell_ref_namespace, bot_user_id
        )

    async def update_subtask(
        self, db: Session, *, subtask_update: SubtaskExecutorUpdate
    ) -> Dict:
        """
        Update subtask and automatically update associated task status using kinds table.

        For streaming support:
        - When status is RUNNING and result contains content, emit chat:chunk events
        - Track previous content length to send only incremental updates
        """
        logger.info(
            f"update subtask subtask_id={subtask_update.subtask_id}, subtask_status={subtask_update.status}, subtask_progress={subtask_update.progress}"
        )

        # Get subtask
        subtask = db.query(Subtask).get(subtask_update.subtask_id)
        if not subtask:
            raise HTTPException(status_code=404, detail="Subtask not found")

        # Track previous content for streaming chunk calculation
        # IMPORTANT: Must capture this BEFORE updating subtask fields
        previous_content = ""
        if subtask.result and isinstance(subtask.result, dict):
            prev_value = subtask.result.get("value", "")
            if isinstance(prev_value, str):
                previous_content = prev_value

        # Calculate new content from update for chunk emission
        # Do this BEFORE updating the subtask to avoid using stale data
        new_content = ""
        if subtask_update.status == SubtaskStatus.RUNNING and subtask_update.result:
            if isinstance(subtask_update.result, dict):
                new_value = subtask_update.result.get("value", "")
                if isinstance(new_value, str):
                    new_content = new_value

            # CRITICAL FIX: If executor sends empty value but we have previous content,
            # keep the previous content in the update to prevent data loss
            # This happens when executor temporarily clears value between thinking steps
            # NOTE: Only apply this fix during RUNNING status, not COMPLETED
            # When COMPLETED, we should always use the final result from executor
            if not new_content and previous_content:
                # Keep previous content by updating the result dict
                if subtask_update.result and isinstance(subtask_update.result, dict):
                    subtask_update.result["value"] = previous_content
                    new_content = previous_content

        # Update subtask title (if provided)
        if subtask_update.subtask_title:
            subtask.title = subtask_update.subtask_title

        # Update task title (if provided) using tasks table
        if subtask_update.task_title:
            task = (
                db.query(TaskResource)
                .filter(
                    TaskResource.id == subtask.task_id,
                    TaskResource.kind == "Task",
                    TaskResource.is_active.is_(True),
                )
                .first()
            )
            if task:
                task_crd = Task.model_validate(task.json)
                task_crd.spec.title = subtask_update.task_title
                task.json = task_crd.model_dump(mode="json")
                task.updated_at = datetime.now()
                flag_modified(task, "json")
                db.add(task)

        # Merge thinking steps before saving to DB to reduce storage size
        # This combines adjacent thinking steps with same title/next_action/details.type
        if subtask_update.result and isinstance(subtask_update.result, dict):
            raw_thinking = subtask_update.result.get("thinking", [])
            if isinstance(raw_thinking, list) and raw_thinking:
                merged_thinking = merge_thinking_steps(raw_thinking)
                subtask_update.result["thinking"] = merged_thinking

        # Update other subtask fields
        update_data = subtask_update.model_dump(
            exclude={"subtask_title", "task_title"}, exclude_unset=True
        )
        for field, value in update_data.items():
            if field == "result" and value is not None:
                # Preserve existing thinking when task fails without new thinking data
                # This handles OOM/crash scenarios where executor sends error without thinking
                existing_result = subtask.result or {}
                new_has_thinking = isinstance(value, dict) and value.get("thinking")
                existing_has_thinking = isinstance(
                    existing_result, dict
                ) and existing_result.get("thinking")

                if (
                    subtask_update.status == SubtaskStatus.FAILED
                    and not new_has_thinking
                    and existing_has_thinking
                ):
                    value["thinking"] = existing_result["thinking"]

                # Sanitize thinking data before storing to database
                # This removes sensitive tool input/output from thinking steps
                if isinstance(value, dict) and value.get("thinking"):
                    from app.utils.thinking_sanitizer import sanitize_result_for_storage

                    value = sanitize_result_for_storage(value)

            setattr(subtask, field, value)

        # Set completion time
        if subtask_update.status == SubtaskStatus.COMPLETED:
            subtask.completed_at = datetime.now()

        db.add(subtask)
        db.flush()  # Ensure subtask update is complete

        # Emit chat:chunk event for streaming content updates
        # This allows frontend to display content in real-time during executor task execution
        # For executor tasks, result contains thinking and workbench data, not just value
        if subtask_update.status == SubtaskStatus.RUNNING and subtask_update.result:
            if isinstance(subtask_update.result, dict):
                # For executor tasks, send the full result (thinking, workbench)
                # new_content was already calculated before updating subtask

                # Calculate offset based on value content length
                offset = len(new_content) if new_content else 0

                # Check if there's any meaningful data to send (thinking or workbench)
                has_thinking = bool(subtask_update.result.get("thinking"))
                has_workbench = bool(subtask_update.result.get("workbench"))
                has_new_content = new_content and len(new_content) > len(
                    previous_content
                )

                if has_thinking or has_workbench or has_new_content:
                    # Calculate chunk content for text streaming
                    chunk_content = ""
                    if has_new_content:
                        chunk_content = new_content[len(previous_content) :]
                        offset = len(previous_content)

                    logger.info(
                        f"[WS] Emitting chat:chunk for executor task={subtask.task_id} subtask={subtask.id} "
                        f"offset={offset} has_thinking={has_thinking} has_workbench={has_workbench}"
                    )

                    # Get shell_type for this subtask and include it in the result
                    # This allows frontend to properly route thinking display
                    shell_type = self._get_shell_type_for_subtask(db, subtask)

                    # Add shell_type to result for frontend routing
                    result_with_shell_type = {
                        **subtask_update.result,
                        "shell_type": shell_type,
                    }

                    self._emit_chat_chunk_ws_event(
                        task_id=subtask.task_id,
                        subtask_id=subtask.id,
                        content=chunk_content,
                        offset=offset,
                        result=result_with_shell_type,  # Send full result with thinking, workbench, and shell_type
                    )

        # Update associated task status
        self._update_task_status_based_on_subtasks(db, subtask.task_id)

        db.commit()

        return {
            "subtask_id": subtask.id,
            "task_id": subtask.task_id,
            "status": subtask.status,
            "progress": subtask.progress,
            "message": "Subtask updated successfully",
        }

    def _update_task_status_based_on_subtasks(self, db: Session, task_id: int) -> None:
        """Update task status based on subtask status using tasks table"""
        # Get task from tasks table
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.is_(True),
            )
            .first()
        )
        if not task:
            return

        # Force refresh to get latest data from database
        db.refresh(task)

        # Debug: Check labels in raw task.json
        try:
            raw_json = task.json or {}
            metadata = raw_json.get("metadata", {})
            labels = metadata.get("labels", {})
            logger.info(
                f"[_update_task_status_based_on_subtasks] Task {task_id} raw labels from DB: {labels}"
            )
        except Exception as e:
            logger.error(
                f"[_update_task_status_based_on_subtasks] Error reading labels: {e}"
            )

        subtasks = (
            db.query(Subtask)
            .filter(Subtask.task_id == task_id, Subtask.role == SubtaskRole.ASSISTANT)
            .order_by(Subtask.message_id.asc())
            .all()
        )
        if not subtasks:
            return

        total_subtasks = len(subtasks)
        completed_subtasks = len(
            [s for s in subtasks if s.status == SubtaskStatus.COMPLETED]
        )
        failed_subtasks = len([s for s in subtasks if s.status == SubtaskStatus.FAILED])
        cancelled_subtasks = len(
            [s for s in subtasks if s.status == SubtaskStatus.CANCELLED]
        )

        task_crd = Task.model_validate(task.json)
        current_task_status = task_crd.status.status if task_crd.status else "PENDING"

        # Calculate task progress
        progress = int((completed_subtasks / total_subtasks) * 100)
        if task_crd.status:
            task_crd.status.progress = progress

        # Find the last non-pending subtask
        last_non_pending_subtask = None
        for subtask in reversed(subtasks):
            if subtask.status != SubtaskStatus.PENDING:
                last_non_pending_subtask = subtask
                break

        # Priority 1: Handle CANCELLED status
        # If task is in CANCELLING state and any subtask is CANCELLED, update task to CANCELLED
        if current_task_status == "CANCELLING" and cancelled_subtasks > 0:
            if task_crd.status:
                task_crd.status.status = "CANCELLED"
                task_crd.status.progress = 100
                task_crd.status.completedAt = datetime.now()
                if last_non_pending_subtask:
                    task_crd.status.result = last_non_pending_subtask.result
                    task_crd.status.errorMessage = (
                        last_non_pending_subtask.error_message
                        or "Task was cancelled by user"
                    )
                else:
                    task_crd.status.errorMessage = "Task was cancelled by user"
                logger.info(
                    f"Task {task_id} status updated from CANCELLING to CANCELLED (cancelled_subtasks={cancelled_subtasks})"
                )
        # Priority 2: Check if the last non-pending subtask is cancelled
        elif (
            last_non_pending_subtask
            and last_non_pending_subtask.status == SubtaskStatus.CANCELLED
        ):
            if task_crd.status:
                task_crd.status.status = "CANCELLED"
                task_crd.status.progress = 100
                task_crd.status.completedAt = datetime.now()
                if last_non_pending_subtask.error_message:
                    task_crd.status.errorMessage = (
                        last_non_pending_subtask.error_message
                    )
                else:
                    task_crd.status.errorMessage = "Task was cancelled by user"
                if last_non_pending_subtask.result:
                    task_crd.status.result = last_non_pending_subtask.result
                logger.info(
                    f"Task {task_id} status updated to CANCELLED based on last subtask"
                )
        # Priority 3: Check if the last non-pending subtask is failed
        elif (
            last_non_pending_subtask
            and last_non_pending_subtask.status == SubtaskStatus.FAILED
        ):
            if task_crd.status:
                task_crd.status.status = "FAILED"
                if last_non_pending_subtask.error_message:
                    task_crd.status.errorMessage = (
                        last_non_pending_subtask.error_message
                    )
                if last_non_pending_subtask.result:
                    task_crd.status.result = last_non_pending_subtask.result
        # Priority 4: Check if the last non-pending subtask is completed
        # For pipeline mode, we need to check if the just-completed stage requires confirmation
        elif (
            last_non_pending_subtask
            and last_non_pending_subtask.status == SubtaskStatus.COMPLETED
        ):
            # Check if this is a pipeline task that needs stage confirmation
            should_wait_confirmation = self._check_pipeline_stage_confirmation(
                db, task, subtasks
            )

            if should_wait_confirmation:
                # Set task to PENDING_CONFIRMATION status
                if task_crd.status:
                    task_crd.status.status = "PENDING_CONFIRMATION"
                    task_crd.status.result = last_non_pending_subtask.result
                    task_crd.status.errorMessage = None
                    logger.info(
                        f"Task {task_id} status set to PENDING_CONFIRMATION for pipeline stage confirmation"
                    )
            elif subtasks[-1].status == SubtaskStatus.COMPLETED:
                # Check if this is pipeline mode and we need to create next stage subtask
                next_stage_created = self._create_next_pipeline_stage_subtask(
                    db, task, task_crd, subtasks
                )

                if next_stage_created:
                    # Next stage subtask created, task stays in RUNNING status
                    logger.info(
                        f"Task {task_id} pipeline: next stage subtask created, staying in RUNNING"
                    )
                else:
                    # All subtasks completed - mark task as completed
                    last_subtask = subtasks[-1]
                    if task_crd.status:
                        task_crd.status.status = last_subtask.status.value
                        task_crd.status.result = last_subtask.result
                        task_crd.status.errorMessage = last_subtask.error_message
                        task_crd.status.progress = 100
                        task_crd.status.completedAt = datetime.now()
            # else: task stays in RUNNING status (pipeline in progress)
        else:
            # Update to running status (only if not in a final state)
            if task_crd.status and current_task_status not in [
                "CANCELLED",
                "COMPLETED",
                "FAILED",
                "PENDING_CONFIRMATION",
            ]:
                task_crd.status.status = "RUNNING"
                # If there is only one subtask, use the subtask's progress
                if total_subtasks == 1:
                    task_crd.status.progress = subtasks[0].progress
                    task_crd.status.result = subtasks[0].result
                    task_crd.status.errorMessage = subtasks[0].error_message

        # Update timestamps
        if task_crd.status:
            task_crd.status.updatedAt = datetime.now()

        # CRITICAL: Merge with latest task.json from database to preserve labels
        # set by other processes (e.g., subscription tasks set backgroundExecutionId)
        db.refresh(task)
        latest_task_crd = Task.model_validate(task.json)
        # Preserve metadata.labels from the latest database version
        if latest_task_crd.metadata.labels:
            if task_crd.metadata.labels is None:
                task_crd.metadata.labels = {}
            # Merge: keep existing labels in task_crd, but add any new ones from DB
            for key, value in latest_task_crd.metadata.labels.items():
                if key not in task_crd.metadata.labels:
                    task_crd.metadata.labels[key] = value
                    logger.info(
                        f"[_sync_task_status] Merged label '{key}' from DB for task {task_id}"
                    )

        task.json = task_crd.model_dump(mode="json")
        task.updated_at = datetime.now()
        flag_modified(task, "json")

        # auto delete executor
        self._auto_delete_executors_if_enabled(db, task_id, task_crd, subtasks)

        # Send notification when task is completed or failed
        self._send_task_completion_notification(db, task_id, task_crd)

        # Update BackgroundExecution status if this is a Subscription task
        self._update_background_execution_status(db, task_id, task_crd)

        # Send WebSocket event for task status update
        if task_crd.status:
            self._emit_task_status_ws_event(
                user_id=task.user_id,
                task_id=task_id,
                status=task_crd.status.status,
                progress=task_crd.status.progress,
            )

        # Send chat:done WebSocket event for completed/failed subtasks
        # This allows frontend to receive message content in real-time via WebSocket
        # instead of relying on polling
        if last_non_pending_subtask and last_non_pending_subtask.status in [
            SubtaskStatus.COMPLETED,
            SubtaskStatus.FAILED,
        ]:
            # Get shell_type and add to result for frontend routing
            shell_type = self._get_shell_type_for_subtask(db, last_non_pending_subtask)
            result_with_shell_type = None
            if last_non_pending_subtask.result:
                result_with_shell_type = {
                    **last_non_pending_subtask.result,
                    "shell_type": shell_type,
                }

            self._emit_chat_done_ws_event(
                task_id=task_id,
                subtask_id=last_non_pending_subtask.id,
                result=result_with_shell_type,
                message_id=last_non_pending_subtask.message_id,
            )

        db.add(task)

    def _check_pipeline_stage_confirmation(
        self,
        db: Session,
        task: TaskResource,
        subtasks: List[Subtask],
    ) -> bool:
        """
        Check if the current pipeline stage requires user confirmation.

        In the new pipeline architecture, subtasks are created one at a time.
        When a stage completes, we check if it has requireConfirmation set.
        If so, we return True to pause and wait for user confirmation.

        Args:
            db: Database session
            task: Task resource
            subtasks: List of assistant subtasks ordered by message_id

        Returns:
            True if confirmation is required, False otherwise
        """
        # Get team_id from subtasks (TaskResource doesn't have team_id attribute)
        if not subtasks:
            return False

        team_id = subtasks[0].team_id

        # Get team to check collaboration model
        team = (
            db.query(Kind)
            .filter(
                Kind.id == team_id,
                Kind.kind == "Team",
                Kind.is_active.is_(True),
            )
            .first()
        )

        if not team:
            return False

        team_crd = Team.model_validate(team.json)

        # Only applies to pipeline mode
        if team_crd.spec.collaborationModel != "pipeline":
            return False

        members = team_crd.spec.members
        total_stages = len(members)

        if total_stages == 0:
            return False

        # Get all subtasks (including USER) to find the current round
        # The subtasks parameter only contains ASSISTANT subtasks, so we need to query again
        all_subtasks = (
            db.query(Subtask)
            .filter(Subtask.task_id == task.id)
            .order_by(Subtask.message_id.desc())
            .all()
        )

        # Count completed stages in the current round (after the last USER message)
        recent_assistant_subtasks = []
        for s in all_subtasks:
            if s.role == SubtaskRole.USER:
                break
            if s.role == SubtaskRole.ASSISTANT:
                recent_assistant_subtasks.insert(0, s)

        completed_stages = len(
            [
                s
                for s in recent_assistant_subtasks
                if s.status == SubtaskStatus.COMPLETED
            ]
        )

        # The current stage index is the number of completed stages minus 1
        # (since we just completed a stage)
        current_stage_index = completed_stages - 1

        if current_stage_index < 0 or current_stage_index >= len(members):
            return False

        # Check if this member has requireConfirmation set
        current_member = members[current_stage_index]
        require_confirmation = current_member.requireConfirmation or False

        if not require_confirmation:
            return False

        # Also check if there are more stages to go
        # If this is the last stage, no need for confirmation
        has_more_stages = (current_stage_index + 1) < total_stages

        logger.info(
            f"Pipeline _check_pipeline_stage_confirmation: task_id={task.id}, "
            f"current_stage_index={current_stage_index}, require_confirmation={require_confirmation}, "
            f"has_more_stages={has_more_stages}, completed_stages={completed_stages}, total_stages={total_stages}"
        )

        return require_confirmation and has_more_stages

    def _create_next_pipeline_stage_subtask(
        self,
        db: Session,
        task: TaskResource,
        task_crd: Task,
        subtasks: List[Subtask],
    ) -> bool:
        """
        Create the next pipeline stage subtask when the current stage completes.

        In pipeline mode, subtasks are created one at a time. When a stage completes,
        this method creates the subtask for the next stage.

        Args:
            db: Database session
            task: Task resource
            task_crd: Task CRD object
            subtasks: List of assistant subtasks ordered by message_id

        Returns:
            True if a new subtask was created, False otherwise
        """
        if not subtasks:
            return False

        team_id = subtasks[0].team_id

        # Get team to check collaboration model
        team = (
            db.query(Kind)
            .filter(
                Kind.id == team_id,
                Kind.kind == "Team",
                Kind.is_active.is_(True),
            )
            .first()
        )

        if not team:
            return False

        team_crd = Team.model_validate(team.json)

        # Only applies to pipeline mode
        if team_crd.spec.collaborationModel != "pipeline":
            return False

        members = team_crd.spec.members
        total_stages = len(members)

        if total_stages == 0:
            return False

        # Get all subtasks (including USER) to find the current round
        # The subtasks parameter only contains ASSISTANT subtasks, so we need to query again
        all_subtasks = (
            db.query(Subtask)
            .filter(Subtask.task_id == task.id)
            .order_by(Subtask.message_id.desc())
            .all()
        )

        # Count completed stages in the current round
        # Get the most recent batch of subtasks (after the last USER message)
        recent_assistant_subtasks = []
        for s in all_subtasks:
            if s.role == SubtaskRole.USER:
                break
            if s.role == SubtaskRole.ASSISTANT:
                recent_assistant_subtasks.insert(0, s)

        completed_stages = len(
            [
                s
                for s in recent_assistant_subtasks
                if s.status == SubtaskStatus.COMPLETED
            ]
        )

        # Debug log
        logger.info(
            f"Pipeline _create_next_pipeline_stage_subtask: task_id={task.id}, "
            f"completed_stages={completed_stages}, total_stages={total_stages}, "
            f"recent_assistant_count={len(recent_assistant_subtasks)}"
        )

        # If all stages are completed, no need to create more
        if completed_stages >= total_stages:
            logger.info(
                f"Pipeline task {task.id}: all {total_stages} stages completed, no more subtasks to create"
            )
            return False

        # Get the next stage index
        next_stage_index = completed_stages

        if next_stage_index >= len(members):
            return False

        next_member = members[next_stage_index]

        # Find the bot for the next stage
        bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Bot",
                Kind.name == next_member.botRef.name,
                Kind.namespace == next_member.botRef.namespace,
                Kind.is_active.is_(True),
            )
            .first()
        )

        if not bot:
            logger.error(
                f"Pipeline task {task.id}: bot {next_member.botRef.name} not found for stage {next_stage_index}"
            )
            return False

        # Get the last subtask to determine message_id and parent_id
        last_subtask = subtasks[-1]
        next_message_id = last_subtask.message_id + 1
        parent_id = last_subtask.message_id

        # Get executor info from the first subtask (reuse executor)
        executor_name = ""
        executor_namespace = ""
        if recent_assistant_subtasks:
            executor_name = recent_assistant_subtasks[0].executor_name or ""
            executor_namespace = recent_assistant_subtasks[0].executor_namespace or ""

        # Create the new subtask for the next stage
        new_subtask = Subtask(
            user_id=last_subtask.user_id,
            task_id=task.id,
            team_id=team_id,
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
            completed_at=None,
            result=None,
        )

        db.add(new_subtask)
        db.flush()  # Get the new subtask ID

        logger.info(
            f"Pipeline task {task.id}: created subtask {new_subtask.id} for stage {next_stage_index} "
            f"(bot={bot.name}, message_id={next_message_id})"
        )

        # Push mode: dispatch the new pipeline subtask to executor_manager
        # This ensures pipeline tasks work correctly in push mode
        try:
            from app.services.task_dispatcher import task_dispatcher

            if task_dispatcher.enabled:
                # Dispatch the pending subtask for this specific task
                import asyncio

                asyncio.create_task(
                    task_dispatcher.dispatch_pending_tasks(
                        db, task_ids=[task.id], limit=1
                    )
                )
                logger.info(
                    f"Pipeline task {task.id}: dispatching next stage subtask {new_subtask.id} in push mode"
                )
        except Exception as e:
            logger.warning(f"Pipeline push mode dispatch failed: {e}")

        return True

    def _emit_task_status_ws_event(
        self,
        user_id: int,
        task_id: int,
        status: str,
        progress: Optional[int] = None,
    ) -> None:
        """
        Emit task:status WebSocket event to notify frontend of task status changes.

        This method schedules the WebSocket event emission asynchronously to avoid
        blocking the database transaction.

        Note: In Celery worker context, ws_emitter is not available (different process),
        so this method will skip WebSocket emission silently.

        Args:
            user_id: User ID who owns the task
            task_id: Task ID
            status: New task status
            progress: Optional progress percentage
        """
        from app.services.chat.ws_emitter import get_main_event_loop, get_ws_emitter

        # Early check: if ws_emitter is not initialized (e.g., in Celery worker),
        # skip WebSocket emission entirely to avoid event loop issues
        ws_emitter = get_ws_emitter()
        if not ws_emitter:
            logger.debug(
                f"[WS] ws_emitter not available (likely Celery worker), skipping task:status event for task={task_id}"
            )
            return

        logger.info(
            f"[WS] _emit_task_status_ws_event called for task={task_id} status={status} progress={progress} user_id={user_id}"
        )

        async def emit_async():
            try:
                await ws_emitter.emit_task_status(
                    user_id=user_id,
                    task_id=task_id,
                    status=status,
                    progress=progress,
                )
                logger.info(
                    f"[WS] Successfully emitted task:status event for task={task_id} status={status} progress={progress}"
                )
            except Exception as e:
                logger.error(
                    f"[WS] Failed to emit task:status WebSocket event: {e}",
                    exc_info=True,
                )

        # Schedule async execution
        # Only use the main event loop (FastAPI's loop) to avoid cross-loop issues
        main_loop = get_main_event_loop()
        if main_loop and main_loop.is_running():
            # Schedule the coroutine to run in the main event loop
            asyncio.run_coroutine_threadsafe(emit_async(), main_loop)
            logger.info(
                f"[WS] Scheduled task:status event via run_coroutine_threadsafe for task={task_id}"
            )
        else:
            # Try to use current running loop (if we're already in FastAPI context)
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(emit_async())
                logger.info(
                    f"[WS] Scheduled task:status event via loop.create_task for task={task_id}"
                )
            except RuntimeError:
                logger.warning(
                    f"[WS] No running event loop available, cannot emit task:status event for task={task_id}"
                )

    def _emit_chat_start_ws_event(
        self,
        task_id: int,
        subtask_id: int,
        bot_name: Optional[str] = None,
        shell_type: str = "Chat",
    ) -> None:
        """
        Emit chat:start WebSocket event to notify frontend that AI response is starting.

        This method is called when an executor task starts running. It allows the frontend
        to establish the subtask-to-task mapping and prepare for receiving chat:done event.

        Note: In Celery worker context, ws_emitter is not available (different process),
        so this method will skip WebSocket emission silently.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            bot_name: Optional bot name
            shell_type: Shell type for frontend display (Chat, ClaudeCode, Agno, etc.)
        """
        from app.services.chat.ws_emitter import get_main_event_loop, get_ws_emitter

        # Early check: if ws_emitter is not initialized (e.g., in Celery worker),
        # skip WebSocket emission entirely to avoid event loop issues
        ws_emitter = get_ws_emitter()
        if not ws_emitter:
            logger.debug(
                f"[WS] ws_emitter not available (likely Celery worker), skipping chat:start event for task={task_id}"
            )
            return

        logger.info(
            f"[WS] _emit_chat_start_ws_event called for task={task_id} subtask={subtask_id} shell_type={shell_type}"
        )

        async def emit_async():
            try:
                await ws_emitter.emit_chat_start(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    bot_name=bot_name,
                    shell_type=shell_type,
                )
                logger.info(
                    f"[WS] Successfully emitted chat:start event for task={task_id} subtask={subtask_id} shell_type={shell_type}"
                )
            except Exception as e:
                logger.error(
                    f"[WS] Failed to emit chat:start WebSocket event: {e}",
                    exc_info=True,
                )

        # Schedule async execution
        # Only use the main event loop (FastAPI's loop) to avoid cross-loop issues
        main_loop = get_main_event_loop()
        if main_loop and main_loop.is_running():
            asyncio.run_coroutine_threadsafe(emit_async(), main_loop)
            logger.info(
                f"[WS] Scheduled chat:start event via run_coroutine_threadsafe for task={task_id}"
            )
        else:
            # Try to use current running loop (if we're already in FastAPI context)
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(emit_async())
                logger.info(
                    f"[WS] Scheduled chat:start event via loop.create_task for task={task_id}"
                )
            except RuntimeError:
                logger.warning(
                    f"[WS] No running event loop available, cannot emit chat:start event for task={task_id}"
                )

    def _emit_chat_done_ws_event(
        self,
        task_id: int,
        subtask_id: int,
        result: Optional[Dict[str, Any]] = None,
        message_id: Optional[int] = None,
    ) -> None:
        """
        Emit chat:done WebSocket event to notify frontend of completed subtask with message content.

        This method sends the message content to the frontend via WebSocket so that
        the frontend can display the AI response in real-time without polling.

        Note: In Celery worker context, ws_emitter is not available (different process),
        so this method will skip WebSocket emission silently.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            result: Result data containing the message content
            message_id: Message ID for ordering (primary sort key)
        """
        from app.services.chat.ws_emitter import get_main_event_loop, get_ws_emitter

        # Early check: if ws_emitter is not initialized (e.g., in Celery worker),
        # skip WebSocket emission entirely to avoid event loop issues
        ws_emitter = get_ws_emitter()
        if not ws_emitter:
            logger.debug(
                f"[WS] ws_emitter not available (likely Celery worker), skipping chat:done event for task={task_id}"
            )
            return

        logger.info(
            f"[WS] _emit_chat_done_ws_event called for task={task_id} subtask={subtask_id} message_id={message_id}"
        )

        async def emit_async():
            try:
                # Calculate offset from result content length
                offset = 0
                if result and isinstance(result, dict):
                    value = result.get("value", "")
                    if isinstance(value, str):
                        offset = len(value)

                await ws_emitter.emit_chat_done(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    offset=offset,
                    result=result,
                    message_id=message_id,
                )
                logger.info(
                    f"[WS] Successfully emitted chat:done event for task={task_id} subtask={subtask_id} message_id={message_id}"
                )
            except Exception as e:
                logger.error(
                    f"[WS] Failed to emit chat:done WebSocket event: {e}",
                    exc_info=True,
                )

        # Schedule async execution
        # Only use the main event loop (FastAPI's loop) to avoid cross-loop issues
        main_loop = get_main_event_loop()
        if main_loop and main_loop.is_running():
            asyncio.run_coroutine_threadsafe(emit_async(), main_loop)
            logger.info(
                f"[WS] Scheduled chat:done event via run_coroutine_threadsafe for task={task_id}"
            )
        else:
            # Try to use current running loop (if we're already in FastAPI context)
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(emit_async())
                logger.info(
                    f"[WS] Scheduled chat:done event via loop.create_task for task={task_id}"
                )
            except RuntimeError:
                logger.warning(
                    f"[WS] No running event loop available, cannot emit chat:done event for task={task_id}"
                )

    def _emit_chat_chunk_ws_event(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Emit chat:chunk WebSocket event to notify frontend of streaming content update.

        This method sends incremental content updates to the frontend via WebSocket
        for real-time streaming display.

        Note: In Celery worker context, ws_emitter is not available (different process),
        so this method will skip WebSocket emission silently.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            content: Content chunk to send (for text streaming)
            offset: Current offset in the full response
            result: Optional full result data (for executor tasks with thinking/workbench)
        """
        from app.services.chat.ws_emitter import get_main_event_loop, get_ws_emitter

        # Early check: if ws_emitter is not initialized (e.g., in Celery worker),
        # skip WebSocket emission entirely to avoid event loop issues
        ws_emitter = get_ws_emitter()
        if not ws_emitter:
            return  # Silently skip for chunk events

        logger.info(
            f"[WS] _emit_chat_chunk_ws_event called for task={task_id} subtask={subtask_id} offset={offset}"
        )

        async def emit_async():
            try:
                await ws_emitter.emit_chat_chunk(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    content=content,
                    offset=offset,
                    result=result,
                )
                logger.info(
                    f"[WS] Successfully emitted chat:chunk event for task={task_id} subtask={subtask_id}"
                )
            except Exception as e:
                logger.error(
                    f"[WS] Failed to emit chat:chunk WebSocket event: {e}",
                    exc_info=True,
                )

        # Schedule async execution
        # Only use the main event loop (FastAPI's loop) to avoid cross-loop issues
        main_loop = get_main_event_loop()
        if main_loop and main_loop.is_running():
            asyncio.run_coroutine_threadsafe(emit_async(), main_loop)
        else:
            # Try to use current running loop (if we're already in FastAPI context)
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(emit_async())
            except RuntimeError:
                pass  # Silently ignore if no event loop available for chunk events

    def _auto_delete_executors_if_enabled(
        self, db: Session, task_id: int, task_crd: Task, subtasks: List[Subtask]
    ) -> None:
        """Auto delete executors if enabled and task is in completed status"""
        # Check if auto delete executor is enabled and task is in completed status
        if (
            task_crd.metadata
            and task_crd.metadata.labels
            and task_crd.metadata.labels.get("autoDeleteExecutor") == "true"
            and task_crd.status
            and task_crd.status.status in ["COMPLETED", "FAILED"]
        ):

            # Prepare data for async execution - extract needed values before async execution
            # Filter subtasks with valid executor information and deduplicate
            unique_executor_keys = set()
            executors_data = []

            for subtask in subtasks:
                if subtask.executor_name:
                    subtask.executor_deleted_at = True
                    db.add(subtask)
                    executor_key = (subtask.executor_namespace, subtask.executor_name)
                    if executor_key not in unique_executor_keys:
                        unique_executor_keys.add(executor_key)
                        executors_data.append(
                            {
                                "name": subtask.executor_name,
                                "namespace": subtask.executor_namespace,
                            }
                        )

            async def delete_executors_async():
                """Asynchronously delete all executors for the task"""
                for executor in executors_data:
                    try:
                        logger.info(
                            f"Auto deleting executor for task {task_id}: ns={executor['namespace']} name={executor['name']}"
                        )
                        result = await self.delete_executor_task_async(
                            executor["name"], executor["namespace"]
                        )
                        logger.info(f"Successfully auto deleted executor: {result}")

                    except Exception as e:
                        logger.error(
                            f"Failed to auto delete executor ns={executor['namespace']} name={executor['name']}: {e}"
                        )

            # Schedule async execution
            asyncio.create_task(delete_executors_async())

    def _send_task_completion_notification(
        self, db: Session, task_id: int, task_crd: Task
    ) -> None:
        """Send webhook notification when task is completed or failed"""
        # Only send notification when task status is COMPLETED or FAILED
        if not task_crd.status or task_crd.status.status not in ["COMPLETED", "FAILED"]:
            return

        # Skip webhook notification for subscription-type tasks
        # Check BackgroundExecution table to reliably identify subscription tasks
        # This avoids issues with MySQL transaction isolation (REPEATABLE READ)
        execution = (
            db.query(BackgroundExecution)
            .filter(BackgroundExecution.task_id == task_id)
            .first()
        )
        if execution:
            logger.info(
                f"[_send_task_completion_notification] Task {task_id} is a subscription task "
                f"(BackgroundExecution id={execution.id}), skipping webhook notification"
            )
            return

        logger.info(
            f"[_send_task_completion_notification] Task {task_id} is not a subscription task, "
            f"proceeding with webhook notification"
        )

        try:
            user_message = task_crd.spec.title
            task_start_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            task_end_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            user_id = None

            subtasks = (
                db.query(Subtask)
                .filter(Subtask.task_id == task_id)
                .order_by(Subtask.message_id.asc())
                .all()
            )

            # Check if any subtask is still in RUNNING status
            running_subtasks = [
                s for s in subtasks if s.status == SubtaskStatus.RUNNING
            ]
            if running_subtasks:
                logger.info(
                    f"Skip notification for task {task_id}: {len(running_subtasks)} subtask(s) still running"
                )
                return

            for subtask in subtasks:
                user_id = subtask.user_id
                if subtask.status == SubtaskStatus.PENDING:
                    continue
                if subtask.role == SubtaskRole.USER:
                    user_message = subtask.prompt
                    task_start_time = (
                        subtask.created_at.strftime("%Y-%m-%d %H:%M:%S")
                        if isinstance(subtask.created_at, datetime)
                        else subtask.created_at
                    )
                if subtask.role == SubtaskRole.ASSISTANT:
                    task_end_time = (
                        subtask.updated_at.strftime("%Y-%m-%d %H:%M:%S")
                        if isinstance(subtask.updated_at, datetime)
                        else subtask.updated_at
                    )

            user_name = "Unknown"
            if user_id:
                user = db.query(User).filter(User.id == user_id).first()
                user_name = user.user_name

            task_type = (
                task_crd.metadata.labels
                and task_crd.metadata.labels.get("taskType")
                or "chat"
            )
            task_url = f"{settings.FRONTEND_URL}/{task_type}?taskId={task_id}"

            # Truncate description if too long
            description = user_message
            if len(user_message) > 20:
                description = user_message[:20] + "..."

            notification = Notification(
                user_name=user_name,
                event="task.end",
                id=str(task_id),
                start_time=task_start_time,
                end_time=task_end_time,
                description=description,
                status=task_crd.status.status,
                detail_url=task_url,
            )

            # Send notification asynchronously in background daemon thread to avoid blocking
            def send_notification_background():
                try:
                    webhook_notification_service.send_notification_sync(notification)
                except Exception as e:
                    logger.error(
                        f"Background webhook notification failed for task {task_id}: {str(e)}"
                    )

            thread = threading.Thread(target=send_notification_background, daemon=True)
            thread.start()
            logger.info(
                f"Webhook notification scheduled for task {task_id} with status {task_crd.status.status}"
            )

        except Exception as e:
            logger.error(
                f"Failed to schedule webhook notification for task {task_id}: {str(e)}"
            )

    def _update_background_execution_status(
        self, db: Session, task_id: int, task_crd: Task
    ) -> None:
        """
        Update BackgroundExecution status when a Subscription-triggered task completes.

        This method checks if the task was triggered by a Subscription (via background_executions table),
        and if so, updates the corresponding BackgroundExecution record in the database.

        Args:
            db: Database session
            task_id: Task ID
            task_crd: Task CRD object
        """
        # Only update when task is in a final state
        if not task_crd.status or task_crd.status.status not in [
            "COMPLETED",
            "FAILED",
            "CANCELLED",
        ]:
            return

        # Check if this task was triggered by a Subscription
        # Query background_executions table by task_id (same as _send_task_completion_notification)
        execution = (
            db.query(BackgroundExecution)
            .filter(BackgroundExecution.task_id == task_id)
            .first()
        )

        if not execution:
            # Not a Subscription-triggered task, skip
            return

        execution_id = execution.id

        try:

            # Use BackgroundExecutionManager directly for status update
            # This avoids circular dependency with subscription_service
            from app.schemas.subscription import BackgroundExecutionStatus
            from app.services.subscription.execution import background_execution_manager
            from app.services.subscription.helpers import extract_result_summary

            # Map task status to BackgroundExecutionStatus
            # For COMPLETED status, check if silent_exit flag is set in result
            status_map = {
                "COMPLETED": BackgroundExecutionStatus.COMPLETED,
                "FAILED": BackgroundExecutionStatus.FAILED,
                "CANCELLED": BackgroundExecutionStatus.CANCELLED,
            }
            new_status = status_map.get(task_crd.status.status)
            if not new_status:
                logger.warning(
                    f"Unknown task status '{task_crd.status.status}' for BackgroundExecution {execution_id}"
                )
                return

            # Check for silent_exit flag in result when task is COMPLETED
            # This handles Executor-type tasks (Claude Code, Agno) that call silent_exit tool
            if task_crd.status.status == "COMPLETED":
                is_silent_exit = False
                if task_crd.status.result and isinstance(task_crd.status.result, dict):
                    is_silent_exit = task_crd.status.result.get("silent_exit", False)

                if is_silent_exit:
                    new_status = BackgroundExecutionStatus.COMPLETED_SILENT
                    logger.info(
                        f"Detected silent_exit in task {task_id} result, "
                        f"setting BackgroundExecution {execution_id} status to COMPLETED_SILENT"
                    )

            # Prepare result_summary and error_message
            result_summary = None
            error_message = None
            if task_crd.status.status == "COMPLETED":
                # Extract actual model output from task result using shared helper
                result_summary = extract_result_summary(task_crd.status.result)
            elif task_crd.status.status == "FAILED":
                error_message = task_crd.status.errorMessage or "Task failed"
            elif task_crd.status.status == "CANCELLED":
                error_message = "Task was cancelled"

            # Use BackgroundExecutionManager to update status (this will also emit WebSocket event)
            # Skip notifications here because we will handle them separately with detail_url
            success = background_execution_manager.update_execution_status(
                db=db,
                execution_id=execution_id,
                status=new_status,
                result_summary=result_summary,
                error_message=error_message,
                skip_notifications=True,
            )

            if success:
                logger.info(
                    f"Updated BackgroundExecution {execution_id} status to {new_status.value} "
                    f"for task {task_id} via background_execution_manager"
                )

                # Trigger IM notification (DingTalk, etc.) if user has configured notify level
                try:
                    # We already have execution object from earlier query
                    if execution:
                        # Get Subscription CRD
                        subscription_kind = (
                            db.query(Kind)
                            .filter(
                                Kind.id == execution.subscription_id,
                                Kind.kind == "Subscription",
                            )
                            .first()
                        )

                        if subscription_kind:
                            from app.schemas.subscription import Subscription
                            from app.services.subscription.notification_service import (
                                subscription_notification_service,
                            )

                            subscription = Subscription.model_validate(
                                subscription_kind.json
                            )

                            # Call notify_execution_completed to trigger IM notifications
                            # Use run_coroutine_threadsafe since this is a sync method
                            asyncio.run_coroutine_threadsafe(
                                subscription_notification_service.notify_execution_completed(
                                    db=db,
                                    user_id=execution.user_id,
                                    subscription=subscription,
                                    execution=execution,
                                ),
                                asyncio.get_event_loop(),
                            )
                            logger.info(
                                f"[DingTalk Notification] Scheduled notification for "
                                f"execution {execution_id}, user {execution.user_id}"
                            )
                except Exception as notify_error:
                    # Log error but don't fail the task status update
                    logger.error(
                        f"[DingTalk Notification] Failed to schedule notification for "
                        f"execution {execution_id}: {str(notify_error)}"
                    )
            else:
                logger.warning(
                    f"Failed to update BackgroundExecution {execution_id} status for task {task_id}"
                )

        except Exception as e:
            logger.error(
                f"Failed to update BackgroundExecution status for task {task_id}: {str(e)}",
                exc_info=True,
            )

    def delete_executor_task_sync(
        self, executor_name: str, executor_namespace: str
    ) -> Dict:
        """
        Synchronous version of delete_executor_task to avoid event loop issues

        Args:
            executor_name: The executor task name to delete
            executor_namespace: Executor namespace (required)
        """
        if not executor_name:
            raise HTTPException(status_code=400, detail="executor_name are required")
        try:
            import requests

            payload = {
                "executor_name": executor_name,
                "executor_namespace": executor_namespace,
            }
            logger.info(
                f"executor.delete sync request url={settings.EXECUTOR_DELETE_TASK_URL} {payload}"
            )

            response = requests.post(
                settings.EXECUTOR_DELETE_TASK_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=30.0,
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            raise HTTPException(
                status_code=500, detail=f"Error deleting executor task: {str(e)}"
            )

    async def delete_executor_task_async(
        self, executor_name: str, executor_namespace: str
    ) -> Dict:
        """
        Asynchronous version of delete_executor_task

        Args:
            executor_name: The executor task name to delete
            executor_namespace: Executor namespace (required)
        """
        if not executor_name:
            raise HTTPException(status_code=400, detail="executor_name are required")
        try:
            payload = {
                "executor_name": executor_name,
                "executor_namespace": executor_namespace,
            }
            logger.info(
                f"executor.delete async request url={settings.EXECUTOR_DELETE_TASK_URL} {payload}"
            )

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    settings.EXECUTOR_DELETE_TASK_URL,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
                response.raise_for_status()
                return response.json()
        except httpx.HTTPError as e:
            raise HTTPException(
                status_code=500, detail=f"Error deleting executor task: {str(e)}"
            )


executor_kinds_service = ExecutorKindsService(Kind)
