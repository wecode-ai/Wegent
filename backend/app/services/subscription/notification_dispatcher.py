# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subscription notification dispatcher for sending notifications to followers.

This module provides functionality to:
- Dispatch notifications to followers based on their notification settings
- Send notifications via Messager channels (DingTalk, Feishu, etc.)
- Handle notification failures gracefully
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.subscription import (
    NotificationLevel,
    SubscriptionFollowConfig,
)
from app.services.subscription.notification_service import (
    subscription_notification_service,
)

logger = logging.getLogger(__name__)

# Messager CRD kind
MESSAGER_KIND = "Messager"


class SubscriptionNotificationDispatcher:
    """Dispatcher for sending subscription execution notifications to followers."""

    async def dispatch_execution_notifications(
        self,
        db: Session,
        *,
        subscription_id: int,
        execution_id: int,
        subscription_display_name: str,
        result_summary: str,
        status: str,
        detail_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Dispatch notifications to all followers based on their settings.

        Args:
            db: Database session
            subscription_id: Subscription ID
            execution_id: Background execution ID
            subscription_display_name: Display name of the subscription
            result_summary: Summary of the execution result
            status: Execution status (COMPLETED, FAILED, etc.)
            detail_url: URL to view execution details

        Returns:
            Dict with notification dispatch results
        """
        logger.info(
            f"[SubscriptionNotificationDispatcher] Dispatching notifications for "
            f"subscription {subscription_id} execution {execution_id} result_summary: {result_summary}"
        )
        # Get all accepted followers with their settings
        followers_with_settings = (
            subscription_notification_service.get_followers_with_settings(
                db, subscription_id=subscription_id
            )
        )

        results = {
            "total_followers": len(followers_with_settings),
            "silent_count": 0,
            "default_count": 0,
            "notify_count": 0,
            "notify_success": 0,
            "notify_failed": 0,
            "errors": [],
        }

        for user_id, config in followers_with_settings:
            level = config.notification_level

            if level == NotificationLevel.SILENT:
                results["silent_count"] += 1
                # Silent: no notification sent, execution marked as COMPLETED_SILENT
                continue

            elif level == NotificationLevel.DEFAULT:
                results["default_count"] += 1
                # Default: no special notification, WebSocket handles it
                continue

            elif level == NotificationLevel.NOTIFY:
                results["notify_count"] += 1
                # Notify: send notification via Messager channels
                if config.notification_channel_ids:
                    try:
                        await self._send_messager_notifications(
                            db=db,
                            user_id=user_id,
                            channel_ids=config.notification_channel_ids,
                            subscription_id=subscription_id,
                            execution_id=execution_id,
                            subscription_display_name=subscription_display_name,
                            result_summary=result_summary,
                            status=status,
                            detail_url=detail_url,
                        )
                        results["notify_success"] += 1
                    except Exception as e:
                        results["notify_failed"] += 1
                        results["errors"].append(
                            f"Failed to notify user {user_id}: {str(e)}"
                        )
                        logger.warning(
                            f"[SubscriptionNotificationDispatcher] Failed to notify user {user_id}: {e}"
                        )
                else:
                    # No channels configured, log warning
                    logger.warning(
                        f"[SubscriptionNotificationDispatcher] User {user_id} has notify level "
                        f"but no channels configured"
                    )

        logger.info(
            f"[SubscriptionNotificationDispatcher] Dispatched notifications for "
            f"subscription {subscription_id} execution {execution_id}: "
            f"silent={results['silent_count']}, default={results['default_count']}, "
            f"notify={results['notify_count']} (success={results['notify_success']}, "
            f"failed={results['notify_failed']})"
        )

        return results

    async def _send_messager_notifications(
        self,
        db: Session,
        *,
        user_id: int,
        channel_ids: List[int],
        subscription_id: int,
        execution_id: int,
        subscription_display_name: str,
        result_summary: str,
        status: str,
        detail_url: Optional[str] = None,
    ) -> None:
        """
        Send notifications via Messager channels.

        Args:
            db: Database session
            user_id: User ID to notify
            channel_ids: List of Messager channel IDs
            subscription_id: Subscription ID
            execution_id: Background execution ID
            subscription_display_name: Display name of the subscription
            result_summary: Summary of the execution result
            status: Execution status
            detail_url: URL to view execution details
        """
        # Get user's IM bindings
        user_bindings = subscription_notification_service.get_user_im_bindings(
            db, user_id=user_id
        )

        # Format the notification message
        message = self._format_notification_message(
            subscription_display_name=subscription_display_name,
            status=status,
            result_summary=result_summary,
            detail_url=detail_url,
        )

        # Send to each configured channel
        tasks = []
        for channel_id in channel_ids:
            channel_id_str = str(channel_id)

            # Check if user has binding for this channel
            if channel_id_str not in user_bindings:
                logger.warning(
                    f"[SubscriptionNotificationDispatcher] User {user_id} has no binding "
                    f"for channel {channel_id}"
                )
                continue

            binding = user_bindings[channel_id_str]

            # Get channel info
            channel = (
                db.query(Kind)
                .filter(
                    Kind.id == channel_id,
                    Kind.kind == MESSAGER_KIND,
                    Kind.is_active == True,
                )
                .first()
            )

            if not channel:
                logger.warning(
                    f"[SubscriptionNotificationDispatcher] Channel {channel_id} not found"
                )
                continue

            spec = channel.json.get("spec", {})
            channel_type = spec.get("channelType", "")

            # Dispatch based on channel type
            if channel_type == "dingtalk":
                tasks.append(
                    self._send_dingtalk_notification(
                        db=db,
                        channel=channel,
                        binding=binding,
                        user_id=user_id,
                        message=message,
                        subscription_id=subscription_id,
                        execution_id=execution_id,
                    )
                )
            else:
                logger.warning(
                    f"[SubscriptionNotificationDispatcher] Unsupported channel type: {channel_type}"
                )

        # Run all notification tasks concurrently
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _send_dingtalk_notification(
        self,
        db: Session,
        *,
        channel: Kind,
        binding: Any,
        user_id: int,
        message: str,
        subscription_id: int,
        execution_id: int,
    ) -> None:
        """
        Send notification via DingTalk.

        Args:
            db: Database session
            channel: Messager Kind
            binding: User's IM binding info
            user_id: User ID
            message: Notification message
            subscription_id: Subscription ID
            execution_id: Background execution ID
        """
        try:
            # Get DingTalk user ID from binding
            # For oToMessages/batchSend API, we need staffId (sender_staff_id), not sender_id
            dingtalk_user_id = binding.sender_staff_id or binding.sender_id
            if not dingtalk_user_id:
                logger.warning(
                    f"[SubscriptionNotificationDispatcher] User {user_id} has no "
                    f"sender_staff_id or sender_id for DingTalk channel {channel.id}"
                )
                return

            # Get channel config for robot credentials
            spec = channel.json.get("spec", {})
            config = spec.get("config", {})
            client_id = config.get("client_id")
            client_secret_encrypted = config.get("client_secret")

            if not client_id or not client_secret_encrypted:
                logger.warning(
                    f"[SubscriptionNotificationDispatcher] Channel {channel.id} missing "
                    f"client_id or client_secret"
                )
                return

            # Decrypt the client_secret (stored encrypted in database)
            from shared.utils.crypto import decrypt_sensitive_data

            client_secret = decrypt_sensitive_data(client_secret_encrypted)

            # Send actual DingTalk message via robot API
            from app.services.channels.dingtalk.sender import DingTalkRobotSender

            sender = DingTalkRobotSender(
                client_id=client_id,
                client_secret=client_secret,
            )

            # Send markdown message for better formatting
            result = await sender.send_markdown_message(
                user_ids=[dingtalk_user_id],
                title="订阅通知",
                text=message,
            )

            if result.get("success"):
                logger.info(
                    f"[SubscriptionNotificationDispatcher] Sent DingTalk notification "
                    f"to user {user_id} (dingtalk_id={dingtalk_user_id})"
                )
            else:
                logger.warning(
                    f"[SubscriptionNotificationDispatcher] Failed to send DingTalk "
                    f"notification to user {user_id}: {result.get('error')}"
                )

        except Exception as e:
            logger.error(
                f"[SubscriptionNotificationDispatcher] Failed to send DingTalk "
                f"notification to user {user_id}: {e}"
            )
            raise

    def _format_notification_message(
        self,
        *,
        subscription_display_name: str,
        status: str,
        result_summary: str,
        detail_url: Optional[str] = None,
    ) -> str:
        """
        Format the notification message.

        Args:
            subscription_display_name: Display name of the subscription
            status: Execution status
            result_summary: Summary of the execution result
            detail_url: URL to view execution details

        Returns:
            Formatted notification message
        """
        status_emoji = "✅" if status == "COMPLETED" else "❌"
        status_text = "执行成功" if status == "COMPLETED" else "执行失败"

        # Truncate summary to 300 characters for better readability
        truncated_summary = (
            result_summary[:300] + "..."
            if len(result_summary) > 300
            else result_summary
        )

        # For DingTalk markdown, use explicit line breaks with double newlines
        message_lines = [
            "📬 订阅任务通知",
            "",
            f"**订阅**: {subscription_display_name}",
            "",
            f"**状态**: {status_emoji} {status_text}",
            "",
            "**执行结果**:",
            f"\n\n{truncated_summary}",
        ]

        if detail_url:
            message_lines.extend(["", f"[查看详情]({detail_url})"])

        # Join with explicit newlines for better DingTalk rendering
        message = "\n".join(message_lines)

        return message


# Singleton instance
subscription_notification_dispatcher = SubscriptionNotificationDispatcher()
