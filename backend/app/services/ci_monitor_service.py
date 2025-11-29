# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
CI Monitor Service for handling CI events and triggering repairs
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.completion_condition import (
    CompletionCondition,
    ConditionStatus,
    GitPlatform,
)
from app.models.subtask import Subtask, SubtaskStatus
from app.schemas.completion_condition import (
    CIFailureInfo,
    GitHubCheckRunEvent,
    GitHubWorkflowRunEvent,
    GitLabPipelineEvent,
)
from app.services.completion_condition_service import CompletionConditionService
from app.services.webhook_notification import Notification, webhook_notification_service

logger = logging.getLogger(__name__)


# CI check types to monitor
CI_CHECK_TYPES = ["test", "lint", "build", "ci", "check"]

# Maximum log length
CI_LOG_MAX_LENGTH = 50000


class CIMonitorService:
    """Service for monitoring CI events and managing repair cycles"""

    def __init__(self, db: Session):
        self.db = db
        self.condition_service = CompletionConditionService(db)

    async def handle_github_check_run(
        self, event: GitHubCheckRunEvent
    ) -> List[CompletionCondition]:
        """Handle GitHub check_run webhook event"""
        logger.info(
            f"Handling GitHub check_run event for {event.repo_full_name}/{event.branch_name}: "
            f"status={event.status}, conclusion={event.conclusion}"
        )

        # Find matching conditions
        conditions = self.condition_service.get_pending_or_in_progress(
            event.repo_full_name, event.branch_name
        )

        if not conditions:
            logger.info(f"No pending conditions found for {event.repo_full_name}/{event.branch_name}")
            return []

        updated_conditions = []
        for condition in conditions:
            if condition.git_platform != GitPlatform.GITHUB:
                continue

            if event.status == "in_progress":
                # CI started running
                self._update_condition_in_progress(condition, event.html_url)
                await self._send_ci_running_notification(condition)
            elif event.status == "completed":
                if event.conclusion == "success":
                    # CI passed
                    await self._handle_ci_success(condition)
                elif event.conclusion in ("failure", "cancelled", "timed_out"):
                    # CI failed
                    await self._handle_ci_failure(
                        condition,
                        event.name,
                        event.html_url,
                    )
            updated_conditions.append(condition)

        return updated_conditions

    async def handle_github_workflow_run(
        self, event: GitHubWorkflowRunEvent
    ) -> List[CompletionCondition]:
        """Handle GitHub workflow_run webhook event"""
        logger.info(
            f"Handling GitHub workflow_run event for {event.repo_full_name}/{event.branch_name}: "
            f"status={event.status}, conclusion={event.conclusion}"
        )

        # Find matching conditions
        conditions = self.condition_service.get_pending_or_in_progress(
            event.repo_full_name, event.branch_name
        )

        if not conditions:
            logger.info(f"No pending conditions found for {event.repo_full_name}/{event.branch_name}")
            return []

        updated_conditions = []
        for condition in conditions:
            if condition.git_platform != GitPlatform.GITHUB:
                continue

            if event.status == "in_progress":
                self._update_condition_in_progress(condition, event.html_url)
                await self._send_ci_running_notification(condition)
            elif event.status == "completed":
                if event.conclusion == "success":
                    await self._handle_ci_success(condition)
                elif event.conclusion in ("failure", "cancelled", "timed_out"):
                    await self._handle_ci_failure(
                        condition,
                        event.name,
                        event.html_url,
                    )
            updated_conditions.append(condition)

        return updated_conditions

    async def handle_gitlab_pipeline(
        self, event: GitLabPipelineEvent
    ) -> List[CompletionCondition]:
        """Handle GitLab Pipeline webhook event"""
        logger.info(
            f"Handling GitLab pipeline event for {event.repo_full_name}/{event.ref}: "
            f"status={event.status}"
        )

        # Find matching conditions
        conditions = self.condition_service.get_pending_or_in_progress(
            event.repo_full_name, event.ref
        )

        if not conditions:
            logger.info(f"No pending conditions found for {event.repo_full_name}/{event.ref}")
            return []

        updated_conditions = []
        for condition in conditions:
            if condition.git_platform != GitPlatform.GITLAB:
                continue

            if event.status == "running":
                self._update_condition_in_progress(condition, event.web_url)
                await self._send_ci_running_notification(condition)
            elif event.status == "success":
                await self._handle_ci_success(condition)
            elif event.status in ("failed", "canceled"):
                await self._handle_ci_failure(
                    condition,
                    f"Pipeline #{event.pipeline_id}",
                    event.web_url,
                )
            updated_conditions.append(condition)

        return updated_conditions

    def _update_condition_in_progress(
        self, condition: CompletionCondition, url: Optional[str] = None
    ):
        """Update condition to IN_PROGRESS status"""
        condition.status = ConditionStatus.IN_PROGRESS
        if url:
            condition.external_url = url
        self.db.commit()
        logger.info(f"Condition {condition.id} set to IN_PROGRESS")

    async def _handle_ci_success(self, condition: CompletionCondition):
        """Handle successful CI completion"""
        condition.status = ConditionStatus.SATISFIED
        condition.satisfied_at = datetime.utcnow()
        self.db.commit()

        logger.info(f"Condition {condition.id} satisfied (CI passed)")

        # Check if subtask should be completed
        subtask = self.condition_service.update_subtask_status_if_needed(
            condition.subtask_id
        )

        # Send notification
        await self._send_condition_satisfied_notification(condition)

        # If all conditions satisfied, send fully completed notification
        if subtask and subtask.status == SubtaskStatus.COMPLETED:
            await self._send_subtask_fully_completed_notification(condition, subtask)

    async def _handle_ci_failure(
        self,
        condition: CompletionCondition,
        job_name: str,
        failure_url: Optional[str],
    ):
        """Handle CI failure and trigger repair if possible"""
        logger.info(
            f"Handling CI failure for condition {condition.id}: "
            f"retry_count={condition.retry_count}, max_retries={condition.max_retries}"
        )

        if condition.retry_count < condition.max_retries:
            # Can retry - trigger repair
            await self._trigger_ci_repair(condition, job_name, failure_url)
        else:
            # Max retries reached - mark as failed
            await self._mark_condition_failed(condition)

    async def _trigger_ci_repair(
        self,
        condition: CompletionCondition,
        job_name: str,
        failure_url: Optional[str],
    ):
        """Trigger CI repair by resuming agent session"""
        logger.info(f"Triggering CI repair for condition {condition.id}")

        # Get failure log (to be implemented with provider)
        failure_log = await self._get_ci_failure_log(condition, failure_url)

        # Increment retry count
        condition.retry_count += 1
        condition.last_failure_log = failure_log[:CI_LOG_MAX_LENGTH] if failure_log else None
        condition.status = ConditionStatus.PENDING  # Reset to wait for next CI run
        self.db.commit()

        # Update subtask to RUNNING for repair
        subtask = self.db.query(Subtask).filter(
            Subtask.id == condition.subtask_id
        ).first()
        if subtask:
            subtask.status = SubtaskStatus.RUNNING
            self.db.commit()

        # Send notification
        await self._send_ci_failed_notification(condition, job_name)

        # Trigger repair in executor (this will be called via API)
        repair_info = {
            "condition_id": condition.id,
            "subtask_id": condition.subtask_id,
            "task_id": condition.task_id,
            "session_id": condition.session_id,
            "executor_namespace": condition.executor_namespace,
            "executor_name": condition.executor_name,
            "retry_count": condition.retry_count,
            "max_retries": condition.max_retries,
            "failure_log": failure_log,
            "job_name": job_name,
            "failure_url": failure_url,
        }

        logger.info(f"CI repair info prepared: {repair_info}")
        return repair_info

    async def _mark_condition_failed(self, condition: CompletionCondition):
        """Mark condition as failed after max retries"""
        condition.status = ConditionStatus.FAILED
        self.db.commit()

        # Update subtask status
        subtask = self.db.query(Subtask).filter(
            Subtask.id == condition.subtask_id
        ).first()
        if subtask:
            subtask.status = SubtaskStatus.FAILED
            subtask.error_message = (
                f"CI failed after {condition.retry_count} repair attempts. "
                "Manual intervention required."
            )
            self.db.commit()

        # Send notification
        await self._send_max_retry_reached_notification(condition)

        logger.info(
            f"Condition {condition.id} marked as FAILED (max retries reached)"
        )

    async def _get_ci_failure_log(
        self, condition: CompletionCondition, failure_url: Optional[str]
    ) -> Optional[str]:
        """Get CI failure log from the platform (placeholder for provider integration)"""
        # TODO: Implement actual log retrieval from GitHub/GitLab providers
        # This will be done via the repository providers
        return f"CI failure log placeholder. Check: {failure_url}"

    # Notification methods
    async def _send_ci_running_notification(self, condition: CompletionCondition):
        """Send notification that CI is running"""
        await self._send_notification(
            condition,
            event="condition.ci_running",
            description=f"CI Pipeline started for {condition.repo_full_name}/{condition.branch_name}",
        )

    async def _send_ci_failed_notification(
        self, condition: CompletionCondition, job_name: str
    ):
        """Send notification that CI failed and repair is starting"""
        await self._send_notification(
            condition,
            event="condition.ci_failed",
            description=(
                f"CI failed ({job_name}). Starting automatic repair "
                f"(attempt {condition.retry_count}/{condition.max_retries})"
            ),
        )

    async def _send_condition_satisfied_notification(
        self, condition: CompletionCondition
    ):
        """Send notification that condition is satisfied"""
        await self._send_notification(
            condition,
            event="condition.satisfied",
            description=f"CI passed for {condition.repo_full_name}/{condition.branch_name}",
        )

    async def _send_subtask_fully_completed_notification(
        self, condition: CompletionCondition, subtask: Subtask
    ):
        """Send notification that subtask is fully completed"""
        await self._send_notification(
            condition,
            event="subtask.fully_completed",
            description=f"Task completed successfully with all CI checks passed",
        )

    async def _send_max_retry_reached_notification(self, condition: CompletionCondition):
        """Send notification that max retry count reached"""
        await self._send_notification(
            condition,
            event="condition.max_retry_reached",
            description=(
                f"Max repair attempts ({condition.max_retries}) reached. "
                "Manual intervention required."
            ),
        )

    async def _send_notification(
        self,
        condition: CompletionCondition,
        event: str,
        description: str,
    ):
        """Send webhook notification"""
        try:
            # Get user info
            from app.models.user import User
            user = self.db.query(User).filter(User.id == condition.user_id).first()
            user_name = user.user_name if user else "unknown"

            notification = Notification(
                user_name=user_name,
                event=event,
                id=str(condition.subtask_id),
                start_time=condition.created_at.isoformat() if condition.created_at else "",
                end_time=datetime.utcnow().isoformat(),
                description=description,
                status=condition.status.value,
                detail_url=condition.external_url or "",
            )
            await webhook_notification_service.send_notification(notification)
        except Exception as e:
            logger.error(f"Failed to send notification: {e}")


def get_ci_monitor_service(db: Session) -> CIMonitorService:
    """Factory function to create CIMonitorService"""
    return CIMonitorService(db)
