# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Evaluation grading task monitor service.

This module provides a background job to monitor and recover stuck grading tasks.
It checks for RUNNING tasks that have been executing for too long and updates
their status based on the associated Wegent Task's actual state.

This approach:
- Does NOT modify core Wegent code (operations.py, etc.)
- Reuses existing mechanisms (background worker pattern from jobs.py)
- Runs independently as a daemon thread
- Queries Wegent Task status to determine actual completion state
"""

import logging
from datetime import datetime, timedelta
from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.subtask import Subtask
from app.models.task import TaskResource
from shared.models.db.enums import SubtaskRole, SubtaskStatus
from wecode.models.evaluation import EvalGradingTask, GradingTaskStatus

logger = logging.getLogger(__name__)

# Default timeout for stuck task detection (30 minutes)
DEFAULT_STUCK_TIMEOUT_MINUTES = 30


class GradingTaskMonitor:
    """
    Monitor for detecting and recovering stuck grading tasks.

    This service periodically checks for grading tasks that have been
    in RUNNING status for too long and updates their status based on
    the actual Wegent Task state.
    """

    def __init__(self, stuck_timeout_minutes: int = DEFAULT_STUCK_TIMEOUT_MINUTES):
        """
        Initialize the grading task monitor.

        Args:
            stuck_timeout_minutes: Minutes after which a RUNNING task is considered stuck
        """
        self.stuck_timeout_minutes = stuck_timeout_minutes

    def find_stuck_tasks(self, db: Session) -> List[EvalGradingTask]:
        """
        Find grading tasks that have been RUNNING for too long.

        Args:
            db: Database session

        Returns:
            List of stuck grading tasks
        """
        cutoff_time = datetime.now() - timedelta(minutes=self.stuck_timeout_minutes)

        stuck_tasks = (
            db.query(EvalGradingTask)
            .filter(
                EvalGradingTask.status == GradingTaskStatus.RUNNING,
                EvalGradingTask.started_at < cutoff_time,
                EvalGradingTask.task_id > 0,  # Must have associated Wegent Task
            )
            .all()
        )

        if stuck_tasks:
            logger.info(
                f"[Evaluation Monitor] Found {len(stuck_tasks)} stuck grading tasks "
                f"(running > {self.stuck_timeout_minutes} minutes)"
            )

        return stuck_tasks

    def find_running_tasks(self, db: Session) -> List[EvalGradingTask]:
        """
        Find all grading tasks that are currently RUNNING.

        This method is used for quick status sync - checking if the associated
        Wegent Task has completed so we can update the grading task status immediately.

        Args:
            db: Database session

        Returns:
            List of running grading tasks
        """
        running_tasks = (
            db.query(EvalGradingTask)
            .filter(
                EvalGradingTask.status == GradingTaskStatus.RUNNING,
                EvalGradingTask.task_id > 0,  # Must have associated Wegent Task
            )
            .all()
        )

        return running_tasks

    def get_wegent_task_state(
        self, db: Session, task_id: int
    ) -> Tuple[Optional[str], Optional[str]]:
        """
        Get the status and result of a Wegent Task.

        Args:
            db: Database session
            task_id: Wegent Task ID

        Returns:
            Tuple of (status, result_content)
            - status: Task status from JSON (PENDING, RUNNING, COMPLETED, FAILED, etc.)
            - result_content: AI-generated content if completed
        """
        wegent_task = (
            db.query(TaskResource)
            .filter(TaskResource.id == task_id, TaskResource.kind == "Task")
            .first()
        )

        if not wegent_task:
            return None, None

        task_json = wegent_task.json or {}
        status_data = task_json.get("status", {})
        task_status = status_data.get("status", "PENDING")

        # Get result content from the assistant subtask
        result_content = None
        if task_status == "COMPLETED":
            assistant_subtask = (
                db.query(Subtask)
                .filter(
                    Subtask.task_id == task_id,
                    Subtask.role == SubtaskRole.ASSISTANT,
                    Subtask.status == SubtaskStatus.COMPLETED,
                )
                .order_by(Subtask.message_id.desc())
                .first()
            )

            if assistant_subtask and assistant_subtask.result:
                # Extract text content from result
                result_data = assistant_subtask.result
                if isinstance(result_data, dict):
                    result_content = result_data.get("text", "")
                elif isinstance(result_data, str):
                    result_content = result_data

        return task_status, result_content

    def recover_stuck_task(
        self,
        db: Session,
        grading_task: EvalGradingTask,
    ) -> bool:
        """
        Attempt to recover a stuck grading task based on Wegent Task state.

        Args:
            db: Database session
            grading_task: The stuck grading task

        Returns:
            True if task was recovered, False otherwise
        """
        task_status, result_content = self.get_wegent_task_state(
            db, grading_task.task_id
        )

        if task_status is None:
            # Wegent Task not found - mark as failed
            logger.warning(
                f"[Evaluation Monitor] Wegent Task {grading_task.task_id} not found "
                f"for grading task {grading_task.id}, marking as failed"
            )
            grading_task.status = GradingTaskStatus.FAILED
            grading_task.error_message = "Associated Wegent Task not found"
            grading_task.completed_at = datetime.now()
            db.flush()
            return True

        if task_status == "COMPLETED":
            # Wegent Task completed - complete the grading task
            logger.info(
                f"[Evaluation Monitor] Wegent Task {grading_task.task_id} completed, "
                f"recovering grading task {grading_task.id}"
            )

            # Import grading service to properly complete the task
            from wecode.service.evaluation.grading_service import GradingService

            grading_service = GradingService()
            grading_service.complete(
                db,
                grading_task,
                report_content=result_content or "AI grading completed (recovered)",
            )
            return True

        elif task_status in ("FAILED", "CANCELLED"):
            # Wegent Task failed - fail the grading task
            # Try to get detailed error message from subtask
            assistant_subtask = (
                db.query(Subtask)
                .filter(
                    Subtask.task_id == grading_task.task_id,
                    Subtask.role == SubtaskRole.ASSISTANT,
                )
                .order_by(Subtask.message_id.desc())
                .first()
            )

            error_msg = f"Wegent Task {task_status.lower()}"
            if assistant_subtask:
                # Get error message from subtask if available
                if assistant_subtask.error_message:
                    error_msg = assistant_subtask.error_message
                # Also check result for error details
                elif assistant_subtask.result:
                    result = assistant_subtask.result
                    if isinstance(result, dict):
                        # Check common error fields
                        if result.get("error"):
                            error_msg = str(result.get("error"))
                        elif result.get("errorMessage"):
                            error_msg = str(result.get("errorMessage"))
                        elif result.get("message"):
                            error_msg = str(result.get("message"))

            logger.info(
                f"[Evaluation Monitor] Wegent Task {grading_task.task_id} {task_status}, "
                f"marking grading task {grading_task.id} as failed. Error: {error_msg}"
            )
            grading_task.status = GradingTaskStatus.FAILED
            grading_task.error_message = error_msg[:2000]
            grading_task.completed_at = datetime.now()
            db.flush()
            return True

        elif task_status == "RUNNING":
            # Wegent Task still running but stuck - check subtask status
            # If assistant subtask is completed, we can extract the result
            assistant_subtask = (
                db.query(Subtask)
                .filter(
                    Subtask.task_id == grading_task.task_id,
                    Subtask.role == SubtaskRole.ASSISTANT,
                )
                .order_by(Subtask.message_id.desc())
                .first()
            )

            if assistant_subtask:
                if assistant_subtask.status == SubtaskStatus.COMPLETED:
                    # Subtask completed but Task not updated - extract result
                    result_data = assistant_subtask.result
                    if isinstance(result_data, dict):
                        result_content = result_data.get("text", "")
                    elif isinstance(result_data, str):
                        result_content = result_data

                    if result_content:
                        logger.info(
                            f"[Evaluation Monitor] Subtask completed for grading task "
                            f"{grading_task.id}, recovering with result"
                        )
                        from wecode.service.evaluation.grading_service import (
                            GradingService,
                        )

                        grading_service = GradingService()
                        grading_service.complete(
                            db,
                            grading_task,
                            report_content=result_content,
                        )
                        return True

                elif assistant_subtask.status == SubtaskStatus.FAILED:
                    # Subtask failed
                    error_msg = assistant_subtask.error_message or "Subtask failed"
                    logger.info(
                        f"[Evaluation Monitor] Subtask failed for grading task "
                        f"{grading_task.id}: {error_msg}"
                    )
                    grading_task.status = GradingTaskStatus.FAILED
                    grading_task.error_message = error_msg[:2000]
                    grading_task.completed_at = datetime.now()
                    db.flush()
                    return True

            # Still truly running - don't recover yet
            logger.debug(
                f"[Evaluation Monitor] Grading task {grading_task.id} still running, "
                f"Wegent Task status: {task_status}"
            )
            return False

        # Unknown status - log and skip
        logger.warning(
            f"[Evaluation Monitor] Unknown Wegent Task status '{task_status}' "
            f"for grading task {grading_task.id}"
        )
        return False

    def run_check(self, db: Session) -> int:
        """
        Run a single check cycle for grading tasks.

        This method performs two checks:
        1. Quick sync: Check all RUNNING tasks to see if their Wegent Task completed
        2. Stuck recovery: Check for tasks stuck for too long and force-recover them

        Args:
            db: Database session

        Returns:
            Number of tasks recovered/synced
        """
        recovered_count = 0

        # First, do a quick status sync for all running tasks
        # This allows us to quickly detect completed tasks without waiting for timeout
        running_tasks = self.find_running_tasks(db)
        for task in running_tasks:
            try:
                if self.recover_stuck_task(db, task):
                    recovered_count += 1
                    logger.info(
                        f"[Evaluation Monitor] Synced grading task {task.id} status"
                    )
            except Exception as e:
                logger.error(
                    f"[Evaluation Monitor] Error syncing grading task {task.id}: {e}"
                )

        if recovered_count > 0:
            logger.info(
                f"[Evaluation Monitor] Synced {recovered_count} grading tasks"
            )

        return recovered_count


# Singleton instance
_grading_task_monitor: Optional[GradingTaskMonitor] = None


def get_grading_task_monitor() -> GradingTaskMonitor:
    """
    Get the singleton grading task monitor instance.

    Returns:
        GradingTaskMonitor instance
    """
    global _grading_task_monitor
    if _grading_task_monitor is None:
        _grading_task_monitor = GradingTaskMonitor()
    return _grading_task_monitor
