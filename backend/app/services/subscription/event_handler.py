# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subscription event handler for processing execution status changes.

This module handles events from SubscriptionEventEmitter and dispatches
notifications to followers when execution status changes.

This separates the notification logic from the chat trigger module,
following the single responsibility principle.
"""

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class SubscriptionEventHandler:
    """Handler for subscription execution events.

    This class receives callbacks from SubscriptionEventEmitter when
    execution status changes and handles notification dispatch.
    """

    def __init__(
        self,
        subscription_id: int,
        execution_id: int,
        subscription_display_name: str,
        team_display_name: Optional[str] = None,
        trigger_reason: Optional[str] = None,
        task_id: Optional[int] = None,
        base_url: Optional[str] = None,
    ):
        """Initialize the event handler.

        Args:
            subscription_id: The Subscription ID
            execution_id: The BackgroundExecution ID
            subscription_display_name: Display name of the subscription
            team_display_name: Display name of the Team (Agent)
            trigger_reason: The trigger reason/prompt
            task_id: The Task ID for generating detail URL
            base_url: The frontend base URL for generating detail URL
        """
        self.subscription_id = subscription_id
        self.execution_id = execution_id
        self.subscription_display_name = subscription_display_name
        self.team_display_name = team_display_name
        self.trigger_reason = trigger_reason
        self.task_id = task_id
        self.base_url = base_url

    async def on_execution_completed(
        self,
        status: str,
        result_summary: str,
        is_silent_exit: bool = False,
    ) -> None:
        """Handle execution completion event.

        Called when execution status changes to COMPLETED or COMPLETED_SILENT.

        Args:
            status: Execution status (COMPLETED, COMPLETED_SILENT, etc.)
            result_summary: Summary of the execution result
            is_silent_exit: Whether this is a silent exit
        """
        # Skip notifications for silent exits
        if is_silent_exit:
            logger.info(
                f"[SubscriptionEventHandler] Skipping notification for silent exit "
                f"execution_id={self.execution_id}"
            )
            return

        await self._dispatch_notifications(status, result_summary)

    async def on_execution_failed(
        self,
        error_message: str,
    ) -> None:
        """Handle execution failure event.

        Called when execution status changes to FAILED.

        Args:
            error_message: Error message describing the failure
        """
        await self._dispatch_notifications("FAILED", f"执行失败: {error_message}")

    async def _dispatch_notifications(
        self,
        status: str,
        result_summary: str,
    ) -> None:
        """Dispatch notifications to followers.

        Args:
            status: Execution status
            result_summary: Summary of the execution result
        """
        try:
            from app.db.session import get_db_session
            from app.services.subscription.notification_dispatcher import (
                subscription_notification_dispatcher,
            )

            with get_db_session() as db:
                logger.info(
                    f"[SubscriptionEventHandler] Dispatching notifications for "
                    f"subscription {self.subscription_id}, execution {self.execution_id}, status={status}"
                )

                # Build subscription display name with team info
                subscription_info = self.subscription_display_name
                if self.team_display_name:
                    subscription_info = (
                        f"{subscription_info} ({self.team_display_name})"
                    )

                # Format the result summary
                formatted_summary = self._format_result_summary(result_summary)

                # Generate detail URL
                detail_url = None
                if self.task_id and self.base_url:
                    detail_url = (
                        f"{self.base_url.rstrip('/')}/chat?taskId={self.task_id}"
                    )

                await subscription_notification_dispatcher.dispatch_execution_notifications(
                    db,
                    subscription_id=self.subscription_id,
                    execution_id=self.execution_id,
                    subscription_display_name=subscription_info,
                    result_summary=formatted_summary,
                    status=status,
                    detail_url=detail_url,
                )
        except Exception as e:
            logger.error(
                f"[SubscriptionEventHandler] Failed to dispatch notifications for "
                f"subscription {self.subscription_id}: {e}",
                exc_info=True,
            )

    def _format_result_summary(self, ai_result: str) -> str:
        """Format AI result into a concise summary for notifications.

        Args:
            ai_result: The raw AI response

        Returns:
            Formatted summary with trigger reason and AI response preview
        """
        # Add trigger reason if available
        trigger_info = ""
        if self.trigger_reason:
            trigger_text = (
                self.trigger_reason[:200] + "..."
                if len(self.trigger_reason) > 200
                else self.trigger_reason
            )
            trigger_info = f"触发内容: {trigger_text}\n\n"

        # Get AI response preview
        ai_summary = self._extract_ai_summary(ai_result)

        return f"{trigger_info}回复内容: {ai_summary}"

    def _extract_ai_summary(self, ai_result: str) -> str:
        """Extract a concise summary from AI response.

        Args:
            ai_result: The raw AI response

        Returns:
            Concise summary (up to 200 chars, trying to end at sentence boundary)
        """
        if not ai_result:
            return "无回复内容"

        result = ai_result.strip()

        if len(result) <= 200:
            return result

        preview = result[:200]

        # Try to find a sentence boundary within the preview
        import re

        last_boundary = -1
        for match in re.finditer(r"[.!?。！？]\s", preview):
            last_boundary = match.end()

        if last_boundary > 50:
            return preview[:last_boundary] + "..."

        # Try to find a word boundary
        last_space = preview.rfind(" ", 150, 200)
        if last_space > 0:
            return preview[:last_space] + "..."

        return preview + "..."


# Singleton instance factory
def create_subscription_event_handler(
    subscription_id: int,
    execution_id: int,
    subscription_display_name: str,
    team_display_name: Optional[str] = None,
    trigger_reason: Optional[str] = None,
    task_id: Optional[int] = None,
    base_url: Optional[str] = None,
) -> SubscriptionEventHandler:
    """Factory function to create a SubscriptionEventHandler.

    Args:
        subscription_id: The Subscription ID
        execution_id: The BackgroundExecution ID
        subscription_display_name: Display name of the subscription
        team_display_name: Display name of the Team (Agent)
        trigger_reason: The trigger reason/prompt
        task_id: The Task ID for generating detail URL
        base_url: The frontend base URL for generating detail URL

    Returns:
        SubscriptionEventHandler instance
    """
    return SubscriptionEventHandler(
        subscription_id=subscription_id,
        execution_id=execution_id,
        subscription_display_name=subscription_display_name,
        team_display_name=team_display_name,
        trigger_reason=trigger_reason,
        task_id=task_id,
        base_url=base_url,
    )
