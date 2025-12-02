# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Async Resume Service for handling external event-driven session recovery.
This service manages the WAITING state and resumes agent sessions when
external events arrive via webhooks.
"""

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.subtask import Subtask, SubtaskStatus
from app.services.webhook_notification import Notification, webhook_notification_service

logger = logging.getLogger(__name__)


class AsyncResumeService:
    """Service for managing async mode subtask resumption."""

    def __init__(self):
        self.enabled = settings.ASYNC_MODE_ENABLED
        self.default_max_resume_count = settings.DEFAULT_MAX_RESUME_COUNT
        self.default_waiting_timeout = settings.DEFAULT_WAITING_TIMEOUT

    async def set_waiting_state(
        self,
        db: Session,
        subtask_id: int,
        waiting_for: str,
        timeout: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Set a subtask to WAITING state.

        Args:
            db: Database session
            subtask_id: ID of the subtask
            waiting_for: Type of event being waited for (e.g., "ci_pipeline")
            timeout: Optional timeout in seconds

        Returns:
            Dict with operation result
        """
        if not self.enabled:
            return {"success": False, "error": "Async mode is disabled"}

        subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()

        if not subtask:
            return {"success": False, "error": f"Subtask {subtask_id} not found"}

        if subtask.status != SubtaskStatus.RUNNING:
            return {
                "success": False,
                "error": f"Subtask must be RUNNING to enter WAITING state, current: {subtask.status}",
            }

        # Update subtask to WAITING state
        subtask.status = SubtaskStatus.WAITING
        subtask.waiting_for = waiting_for
        subtask.waiting_since = datetime.now()
        subtask.waiting_timeout = timeout or self.default_waiting_timeout

        db.commit()
        db.refresh(subtask)

        logger.info(
            f"Subtask {subtask_id} entered WAITING state, waiting_for={waiting_for}"
        )

        # Send notification
        await self._send_notification(
            subtask=subtask,
            event="subtask.waiting",
            description=f"Subtask is waiting for {waiting_for}",
        )

        return {
            "success": True,
            "subtask_id": subtask_id,
            "waiting_for": waiting_for,
            "waiting_since": subtask.waiting_since.isoformat(),
        }

    async def resume_from_webhook(
        self,
        db: Session,
        git_repo: str,
        branch_name: str,
        webhook_payload: Dict[str, Any],
        waiting_for: str = "ci_pipeline",
        source: str = "webhook",
    ) -> Dict[str, Any]:
        """
        Resume waiting subtasks based on webhook event matching.

        Args:
            db: Database session
            git_repo: Repository identifier (e.g., "owner/repo")
            branch_name: Branch name
            webhook_payload: Raw webhook payload to send to agent
            waiting_for: Event type to match
            source: Source of the webhook (github, gitlab, etc.)

        Returns:
            Dict with operation results
        """
        if not self.enabled:
            return {"success": False, "error": "Async mode is disabled", "resumed_count": 0}

        # Find WAITING subtasks matching the repo and branch
        # We need to join with Task to get git_repo and branch_name
        from app.models.kind import Kind

        # Query for waiting subtasks
        waiting_subtasks = (
            db.query(Subtask)
            .filter(
                and_(
                    Subtask.status == SubtaskStatus.WAITING,
                    Subtask.waiting_for == waiting_for,
                )
            )
            .all()
        )

        if not waiting_subtasks:
            logger.debug(f"No waiting subtasks found for {waiting_for}")
            return {"success": True, "resumed_count": 0, "message": "No matching subtasks"}

        # For each waiting subtask, check if it matches the repo and branch
        resumed_count = 0
        results = []

        for subtask in waiting_subtasks:
            # Get the task to check git_repo and branch_name
            task = (
                db.query(Kind)
                .filter(
                    and_(
                        Kind.kind == "Task",
                        Kind.id == subtask.task_id,
                    )
                )
                .first()
            )

            if not task:
                continue

            task_json = task.json
            task_git_repo = task_json.get("spec", {}).get("git_repo", "")
            task_branch = task_json.get("spec", {}).get("branch_name", "")

            # Match by repo and branch (case-insensitive)
            if (
                git_repo.lower() == task_git_repo.lower()
                or git_repo.lower() in task_git_repo.lower()
                or task_git_repo.lower() in git_repo.lower()
            ):
                if branch_name.lower() == task_branch.lower():
                    # Found a match, resume this subtask
                    result = await self._resume_subtask(
                        db=db,
                        subtask=subtask,
                        webhook_payload=webhook_payload,
                        source=source,
                    )
                    results.append(result)
                    if result.get("resumed"):
                        resumed_count += 1

        return {
            "success": True,
            "resumed_count": resumed_count,
            "results": results,
        }

    async def resume_subtask_by_id(
        self,
        db: Session,
        subtask_id: int,
        webhook_payload: Dict[str, Any],
        source: str = "callback",
    ) -> Dict[str, Any]:
        """
        Resume a specific subtask by ID.

        Args:
            db: Database session
            subtask_id: ID of the subtask to resume
            webhook_payload: Payload to send to agent
            source: Source of the callback

        Returns:
            Dict with operation result
        """
        if not self.enabled:
            return {"success": False, "error": "Async mode is disabled"}

        subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()

        if not subtask:
            return {"success": False, "error": f"Subtask {subtask_id} not found"}

        if subtask.status != SubtaskStatus.WAITING:
            return {
                "success": False,
                "error": f"Subtask is not in WAITING state, current: {subtask.status}",
            }

        return await self._resume_subtask(
            db=db,
            subtask=subtask,
            webhook_payload=webhook_payload,
            source=source,
        )

    async def _resume_subtask(
        self,
        db: Session,
        subtask: Subtask,
        webhook_payload: Dict[str, Any],
        source: str,
    ) -> Dict[str, Any]:
        """
        Internal method to resume a subtask.

        Args:
            db: Database session
            subtask: Subtask to resume
            webhook_payload: Payload to send to agent
            source: Source of the event

        Returns:
            Dict with operation result
        """
        # Check max resume count
        if subtask.resume_count >= subtask.max_resume_count:
            logger.warning(
                f"Subtask {subtask.id} reached max resume count ({subtask.max_resume_count})"
            )

            # Mark as failed
            subtask.status = SubtaskStatus.FAILED
            subtask.error_message = f"Max resume count ({subtask.max_resume_count}) reached"
            subtask.waiting_for = None
            subtask.waiting_since = None

            db.commit()

            # Send notification
            await self._send_notification(
                subtask=subtask,
                event="subtask.max_resume_reached",
                description=f"Subtask failed: max resume count reached",
            )

            return {
                "success": False,
                "resumed": False,
                "subtask_id": subtask.id,
                "error": "Max resume count reached",
            }

        # Update subtask to RUNNING state and increment resume count
        subtask.status = SubtaskStatus.RUNNING
        subtask.resume_count += 1
        subtask.waiting_for = None
        subtask.waiting_since = None

        # Store the webhook payload in result for the executor to pick up
        current_result = subtask.result or {}
        current_result["resume_payload"] = {
            "source": source,
            "timestamp": datetime.now().isoformat(),
            "payload": webhook_payload,
        }
        subtask.result = current_result

        db.commit()
        db.refresh(subtask)

        logger.info(
            f"Subtask {subtask.id} resumed (count={subtask.resume_count}), source={source}"
        )

        # Send notification
        await self._send_notification(
            subtask=subtask,
            event="subtask.resumed",
            description=f"Subtask resumed from {source} (attempt {subtask.resume_count})",
        )

        return {
            "success": True,
            "resumed": True,
            "subtask_id": subtask.id,
            "resume_count": subtask.resume_count,
        }

    async def check_waiting_timeouts(self, db: Session) -> Dict[str, Any]:
        """
        Check for WAITING subtasks that have exceeded their timeout.
        Should be called periodically by a background task.

        Args:
            db: Database session

        Returns:
            Dict with timeout results
        """
        if not self.enabled:
            return {"success": False, "error": "Async mode is disabled"}

        now = datetime.now()
        timed_out_count = 0

        # Find waiting subtasks with timeout configured
        waiting_subtasks = (
            db.query(Subtask)
            .filter(
                and_(
                    Subtask.status == SubtaskStatus.WAITING,
                    Subtask.waiting_timeout.isnot(None),
                    Subtask.waiting_timeout > 0,
                    Subtask.waiting_since.isnot(None),
                )
            )
            .all()
        )

        for subtask in waiting_subtasks:
            elapsed_seconds = (now - subtask.waiting_since).total_seconds()

            if elapsed_seconds > subtask.waiting_timeout:
                logger.warning(
                    f"Subtask {subtask.id} timed out after {elapsed_seconds}s "
                    f"(timeout={subtask.waiting_timeout}s)"
                )

                # Mark as failed
                subtask.status = SubtaskStatus.FAILED
                subtask.error_message = f"Waiting timeout exceeded ({subtask.waiting_timeout}s)"
                subtask.waiting_for = None
                subtask.waiting_since = None

                timed_out_count += 1

                # Send notification
                await self._send_notification(
                    subtask=subtask,
                    event="subtask.waiting_timeout",
                    description=f"Subtask failed: waiting timeout exceeded",
                )

        if timed_out_count > 0:
            db.commit()

        return {
            "success": True,
            "timed_out_count": timed_out_count,
        }

    async def _send_notification(
        self,
        subtask: Subtask,
        event: str,
        description: str,
    ) -> None:
        """Send webhook notification for subtask events."""
        try:
            notification = Notification(
                user_name="system",
                event=event,
                id=str(subtask.id),
                start_time=subtask.created_at.isoformat() if subtask.created_at else "",
                end_time=datetime.now().isoformat(),
                description=description,
                status=subtask.status.value,
                detail_url="",
            )
            await webhook_notification_service.send_notification(notification)
        except Exception as e:
            logger.error(f"Failed to send notification: {e}")


# Global service instance
async_resume_service = AsyncResumeService()
