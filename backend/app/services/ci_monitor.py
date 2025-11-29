# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
CI Monitor Service for handling CI events and auto-fix workflow
"""
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.api.dependencies import get_db_context
from app.core.config import settings
from app.models.completion_condition import (
    CompletionCondition,
    ConditionStatus,
    ConditionType,
    GitPlatform,
)
from app.services.completion_condition import completion_condition_service
from app.services.webhook_notification import Notification, webhook_notification_service

logger = logging.getLogger(__name__)


class CIMonitorService:
    """Service for monitoring CI events and triggering auto-fix"""

    def __init__(self):
        self.enabled = getattr(settings, "CI_MONITOR_ENABLED", True)
        self.max_retries = getattr(settings, "CI_MAX_RETRIES", 5)

    async def handle_ci_started(
        self,
        repo_full_name: str,
        branch_name: str,
        external_id: str,
        external_url: Optional[str] = None,
        git_platform: GitPlatform = GitPlatform.GITHUB,
        git_domain: Optional[str] = None,
    ):
        """Handle CI pipeline started event"""
        if not self.enabled:
            return

        with get_db_context() as db:
            # Find matching conditions
            conditions = completion_condition_service.find_by_repo_and_branch(
                db,
                repo_full_name=repo_full_name,
                branch_name=branch_name,
                git_platform=git_platform,
                status_list=[ConditionStatus.PENDING],
            )

            if not conditions:
                logger.debug(
                    f"No pending conditions found for {repo_full_name}/{branch_name}"
                )
                return

            # Update conditions to IN_PROGRESS
            for condition in conditions:
                condition.status = ConditionStatus.IN_PROGRESS
                condition.external_id = external_id
                if external_url:
                    condition.external_url = external_url

            db.commit()
            logger.info(
                f"Updated {len(conditions)} conditions to IN_PROGRESS for "
                f"{repo_full_name}/{branch_name}"
            )

    async def handle_ci_success(
        self,
        repo_full_name: str,
        branch_name: str,
        external_id: str,
        git_platform: GitPlatform = GitPlatform.GITHUB,
    ):
        """Handle CI pipeline success event"""
        if not self.enabled:
            return

        with get_db_context() as db:
            # Find matching conditions
            conditions = completion_condition_service.find_by_repo_and_branch(
                db,
                repo_full_name=repo_full_name,
                branch_name=branch_name,
                git_platform=git_platform,
                status_list=[ConditionStatus.PENDING, ConditionStatus.IN_PROGRESS],
            )

            if not conditions:
                logger.debug(
                    f"No active conditions found for {repo_full_name}/{branch_name}"
                )
                return

            # Update conditions to SATISFIED
            for condition in conditions:
                condition.status = ConditionStatus.SATISFIED
                condition.satisfied_at = datetime.utcnow()

            db.commit()
            logger.info(
                f"Updated {len(conditions)} conditions to SATISFIED for "
                f"{repo_full_name}/{branch_name}"
            )

            # Send notifications for each satisfied condition
            for condition in conditions:
                await self._send_condition_satisfied_notification(db, condition)

                # Check if all conditions for the task are satisfied
                await self._check_task_fully_completed(db, condition.task_id)

    async def handle_ci_failure(
        self,
        repo_full_name: str,
        branch_name: str,
        external_id: str,
        conclusion: str,
        git_platform: GitPlatform = GitPlatform.GITHUB,
    ):
        """Handle CI pipeline failure event"""
        if not self.enabled:
            return

        with get_db_context() as db:
            # Find matching conditions
            conditions = completion_condition_service.find_by_repo_and_branch(
                db,
                repo_full_name=repo_full_name,
                branch_name=branch_name,
                git_platform=git_platform,
                status_list=[ConditionStatus.PENDING, ConditionStatus.IN_PROGRESS],
            )

            if not conditions:
                logger.debug(
                    f"No active conditions found for {repo_full_name}/{branch_name}"
                )
                return

            for condition in conditions:
                await self._handle_condition_failure(
                    db, condition, conclusion, git_platform
                )

    async def _handle_condition_failure(
        self,
        db: Session,
        condition: CompletionCondition,
        conclusion: str,
        git_platform: GitPlatform,
    ):
        """Handle a single condition failure with retry logic"""
        logger.info(
            f"Handling CI failure for condition {condition.id}: "
            f"retry_count={condition.retry_count}, max_retries={condition.max_retries}"
        )

        # Check if we can retry
        if completion_condition_service.can_retry(condition):
            # Attempt auto-fix
            await self._trigger_auto_fix(db, condition, conclusion, git_platform)
        else:
            # Max retries reached
            condition.status = ConditionStatus.FAILED
            condition.last_failure_log = f"Max retries ({condition.max_retries}) reached. Last conclusion: {conclusion}"
            db.commit()

            logger.warning(
                f"Condition {condition.id} failed after {condition.retry_count} retries"
            )

            # Send max retry notification
            await self._send_max_retry_notification(db, condition)

    async def _trigger_auto_fix(
        self,
        db: Session,
        condition: CompletionCondition,
        conclusion: str,
        git_platform: GitPlatform,
    ):
        """Trigger auto-fix workflow by creating a new subtask"""
        logger.info(f"Triggering auto-fix for condition {condition.id}")

        # Fetch CI logs
        ci_logs = await self._fetch_ci_logs(condition, git_platform)

        # Increment retry count
        completion_condition_service.increment_retry(
            db,
            condition_id=condition.id,
            failure_log=ci_logs[:10000] if ci_logs else f"CI failed with conclusion: {conclusion}",
        )

        # Create a fix subtask
        await self._create_fix_subtask(db, condition, ci_logs, conclusion)

        # Send notification about auto-fix attempt
        await self._send_ci_failed_notification(db, condition, conclusion)

    async def _fetch_ci_logs(
        self,
        condition: CompletionCondition,
        git_platform: GitPlatform,
    ) -> Optional[str]:
        """Fetch CI logs from the git platform"""
        try:
            if git_platform == GitPlatform.GITHUB:
                from app.repository.github_provider import GitHubProvider

                provider = GitHubProvider()
                # Note: This would need user context for authentication
                # For now, return a placeholder
                return f"CI logs for GitHub run {condition.external_id} - implement log fetching"

            elif git_platform == GitPlatform.GITLAB:
                from app.repository.gitlab_provider import GitLabProvider

                provider = GitLabProvider()
                return f"CI logs for GitLab pipeline {condition.external_id} - implement log fetching"

        except Exception as e:
            logger.error(f"Failed to fetch CI logs: {e}")
            return None

    async def _create_fix_subtask(
        self,
        db: Session,
        condition: CompletionCondition,
        ci_logs: Optional[str],
        conclusion: str,
    ):
        """Create a new subtask to fix CI issues"""
        from app.services.subtask import subtask_service

        # Build the fix prompt
        fix_prompt = self._build_fix_prompt(condition, ci_logs, conclusion)

        # Get the original subtask to find context
        original_subtask = subtask_service.get_subtask_by_id(
            db, subtask_id=condition.subtask_id, user_id=condition.user_id
        )

        if not original_subtask:
            logger.error(f"Original subtask {condition.subtask_id} not found")
            return

        # Create new fix subtask
        from app.schemas.subtask import SubtaskCreate

        fix_subtask_data = SubtaskCreate(
            task_id=condition.task_id,
            team_id=original_subtask.team_id,
            title=f"Auto-fix CI failure (attempt {condition.retry_count})",
            bot_ids=original_subtask.bot_ids,
            prompt=fix_prompt,
            parent_id=original_subtask.id,
            message_id=original_subtask.message_id + 1,
        )

        fix_subtask = subtask_service.create_subtask(
            db, obj_in=fix_subtask_data, user_id=condition.user_id
        )

        logger.info(
            f"Created fix subtask {fix_subtask.id} for condition {condition.id}"
        )

        # TODO: Trigger subtask execution through executor manager

    def _build_fix_prompt(
        self,
        condition: CompletionCondition,
        ci_logs: Optional[str],
        conclusion: str,
    ) -> str:
        """Build the prompt for the fix subtask"""
        prompt_parts = [
            f"CI pipeline failed with conclusion: {conclusion}",
            f"This is auto-fix attempt {condition.retry_count + 1} of {condition.max_retries}.",
            "",
            "Please analyze the CI failure and fix the issues.",
        ]

        if ci_logs:
            prompt_parts.extend([
                "",
                "## CI Failure Logs",
                "```",
                ci_logs[:8000],  # Limit log size
                "```",
            ])

        prompt_parts.extend([
            "",
            "## Instructions",
            "1. Analyze the CI failure logs above",
            "2. Identify the root cause of the failure",
            "3. Make the necessary code changes to fix the issue",
            "4. Commit and push the fix",
        ])

        return "\n".join(prompt_parts)

    async def _check_task_fully_completed(self, db: Session, task_id: int):
        """Check if all conditions for a task are satisfied and send notification"""
        status = completion_condition_service.get_task_completion_status(
            db, task_id=task_id
        )

        if status["all_conditions_satisfied"]:
            logger.info(f"Task {task_id} is fully completed with all CI checks passed")
            await self._send_task_fully_completed_notification(db, task_id)

    async def _send_condition_satisfied_notification(
        self, db: Session, condition: CompletionCondition
    ):
        """Send notification when a condition is satisfied"""
        try:
            from app.models.user import User

            user = db.query(User).filter(User.id == condition.user_id).first()
            user_name = user.user_name if user else "unknown"

            notification = Notification(
                user_name=user_name,
                event="condition.satisfied",
                id=str(condition.id),
                start_time=condition.created_at.isoformat() if condition.created_at else "",
                end_time=datetime.utcnow().isoformat(),
                description=f"CI check passed for {condition.repo_full_name}/{condition.branch_name}",
                status="satisfied",
                detail_url=condition.external_url or "",
            )
            await webhook_notification_service.send_notification(notification)
        except Exception as e:
            logger.error(f"Failed to send condition satisfied notification: {e}")

    async def _send_ci_failed_notification(
        self, db: Session, condition: CompletionCondition, conclusion: str
    ):
        """Send notification when CI fails and auto-fix is triggered"""
        try:
            from app.models.user import User

            user = db.query(User).filter(User.id == condition.user_id).first()
            user_name = user.user_name if user else "unknown"

            notification = Notification(
                user_name=user_name,
                event="condition.ci_failed",
                id=str(condition.id),
                start_time=condition.created_at.isoformat() if condition.created_at else "",
                end_time=datetime.utcnow().isoformat(),
                description=f"CI failed ({conclusion}) for {condition.repo_full_name}/{condition.branch_name}. Auto-fix attempt {condition.retry_count}/{condition.max_retries}",
                status="failed",
                detail_url=condition.external_url or "",
            )
            await webhook_notification_service.send_notification(notification)
        except Exception as e:
            logger.error(f"Failed to send CI failed notification: {e}")

    async def _send_max_retry_notification(
        self, db: Session, condition: CompletionCondition
    ):
        """Send notification when max retries are reached"""
        try:
            from app.models.user import User

            user = db.query(User).filter(User.id == condition.user_id).first()
            user_name = user.user_name if user else "unknown"

            notification = Notification(
                user_name=user_name,
                event="condition.max_retry_reached",
                id=str(condition.id),
                start_time=condition.created_at.isoformat() if condition.created_at else "",
                end_time=datetime.utcnow().isoformat(),
                description=f"Max retries ({condition.max_retries}) reached for {condition.repo_full_name}/{condition.branch_name}. Manual intervention required.",
                status="failed",
                detail_url=condition.external_url or "",
            )
            await webhook_notification_service.send_notification(notification)
        except Exception as e:
            logger.error(f"Failed to send max retry notification: {e}")

    async def _send_task_fully_completed_notification(
        self, db: Session, task_id: int
    ):
        """Send notification when task is fully completed with all CI checks"""
        try:
            from app.models.user import User
            from app.services.adapters.task_kinds import task_kinds_service

            # Get task info
            task = task_kinds_service.get_task_by_id(db, task_id=task_id)
            if not task:
                return

            user = db.query(User).filter(User.id == task.get("user_id")).first()
            user_name = user.user_name if user else "unknown"

            notification = Notification(
                user_name=user_name,
                event="task.fully_completed",
                id=str(task_id),
                start_time=task.get("created_at", ""),
                end_time=datetime.utcnow().isoformat(),
                description=f"Task '{task.get('title', '')}' completed with all CI checks passed",
                status="completed",
                detail_url=f"{settings.FRONTEND_URL}/tasks/{task_id}",
            )
            await webhook_notification_service.send_notification(notification)
        except Exception as e:
            logger.error(f"Failed to send task fully completed notification: {e}")


# Global service instance
ci_monitor_service = CIMonitorService()
