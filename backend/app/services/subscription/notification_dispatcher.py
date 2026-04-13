# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subscription notification dispatcher for sending notifications to followers.

This module provides functionality to:
- Dispatch notifications to followers based on their notification settings
- Send notifications via Messager channels (DingTalk, Feishu, etc.)
- Send notifications via configured webhooks (DingTalk, Feishu, custom)
- Handle notification failures gracefully
"""

import asyncio
import hashlib
import hmac
import logging
import re
import time
from typing import Any, Dict, List, Optional

import httpx
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.subscription import (
    NotificationLevel,
    NotificationWebhook,
    NotificationWebhookType,
    SubscriptionFollowConfig,
)
from app.services.subscription.notification_service import (
    subscription_notification_service,
)

logger = logging.getLogger(__name__)

# Messager CRD kind
MESSAGER_KIND = "Messager"

# Attachment URL pattern for link conversion
ATTACHMENT_URL_PATTERN = r"/api/attachments/(\d+)/download"


def _convert_to_frontend_attachment_url(attachment_id: str | int) -> str:
    """Convert attachment ID to frontend download URL."""
    from app.core.config import settings

    base_url = settings.FRONTEND_URL.rstrip("/")
    return f"{base_url}/download/attachment/{attachment_id}"


def _convert_attachment_links_to_public(message: str) -> str:
    """
    Convert attachment download URLs to public share URLs.

    This is necessary for external channels (DingTalk, Feishu, Webhook, etc.) to ensure
    any logged-in user can download the attachment, not just the creator.

    Converts:
        /api/attachments/123/download
    To:
        https://wegent.com/download/shared?token=xxx

    The generated token contains a random nonce to prevent enumeration attacks.

    Args:
        message: Original message that may contain attachment links

    Returns:
        Message with converted public share URLs
    """
    from app.api.endpoints.adapter.attachments import (
        _generate_public_share_token,
    )
    from app.core.config import settings

    base_url = settings.FRONTEND_URL.rstrip("/")

    # Find all attachment URLs and replace with public share URLs
    def replace_url(match: re.Match) -> str:
        attachment_id = int(match.group(1))

        # Generate public share token for this attachment
        try:
            token = _generate_public_share_token(
                attachment_id=attachment_id, expires_in_days=7
            )
            return f"{base_url}/download/shared?token={token}"
        except Exception as e:
            logger.warning(
                f"Failed to generate public share link for attachment {attachment_id}: {e}"
            )
            # Fallback to regular frontend URL
            return _convert_to_frontend_attachment_url(attachment_id)

    converted = re.sub(ATTACHMENT_URL_PATTERN, replace_url, message)
    return converted


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
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_id,
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .first()
        )
        subscription_owner_id = subscription.user_id if subscription else None

        # Format the notification message based on status
        formatted_message = self._format_notification_message(
            subscription_display_name=subscription_display_name,
            status=status,
            result_summary=result_summary,
            detail_url=detail_url,
        )
        # Convert attachment links to public share URLs for external IM channels
        # This allows any logged-in user to download, not just the creator
        formatted_message = self._convert_attachment_links(
            formatted_message, db, subscription_owner_id or user_id
        )
        logger.info(
            f"[_send_messager_notifications] Formatted message with detail_url: {detail_url}, status: {status}"
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
                binding_config = (
                    subscription_notification_service.get_subscription_channel_binding_config(
                        db, subscription_id=subscription_id, channel_id=channel_id
                    )
                    if subscription_owner_id == user_id
                    else None
                )
                send_private = True
                send_group = False
                group_conversation_id = None
                if binding_config:
                    send_private = bool(binding_config.get("bind_private", True))
                    send_group = bool(binding_config.get("bind_group", False))
                    group_conversation_id = binding_config.get("group_conversation_id")
                tasks.append(
                    self._send_dingtalk_notification(
                        db=db,
                        channel=channel,
                        binding=binding,
                        user_id=user_id,
                        message=formatted_message,
                        subscription_id=subscription_id,
                        execution_id=execution_id,
                        subscription_display_name=subscription_display_name,
                        send_private=send_private,
                        send_group=send_group,
                        group_conversation_id=group_conversation_id,
                    )
                )
            elif channel_type == "telegram":
                tasks.append(
                    self._send_telegram_notification(
                        db=db,
                        channel=channel,
                        binding=binding,
                        user_id=user_id,
                        message=formatted_message,
                        subscription_id=subscription_id,
                        execution_id=execution_id,
                        subscription_display_name=subscription_display_name,
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
        subscription_display_name: str,
        send_private: bool = True,
        send_group: bool = False,
        group_conversation_id: Optional[str] = None,
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
            subscription_display_name: Display name of the subscription
        """
        try:
            dingtalk_user_id = binding.sender_staff_id or binding.sender_id
            if send_private and not dingtalk_user_id:
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

            # Check if AI card template is configured
            card_template_id = config.get("card_template_id")

            if card_template_id:
                # Use AI card for better visual experience
                # Note: status field in AI card is designed for streaming scenarios
                # (e.g., "thinking..."). For completed notifications, we add status
                # indicator to content instead of using status field.

                # Add status icon to content for visual indication
                content_with_status = message

                logger.info(
                    f"[_send_dingtalk_notification] Sending AI card notification with "
                    f"template={card_template_id}"
                )

                if send_private:
                    result = await sender.send_ai_card_notification(
                        user_id=dingtalk_user_id,
                        title=subscription_display_name,
                        content=content_with_status,
                        card_template_id=card_template_id,
                        status="",
                        enable_streaming=False,
                    )
                    if result.get("success"):
                        logger.info(
                            f"[SubscriptionNotificationDispatcher] Sent DingTalk AI card "
                            f"notification to user {user_id} (dingtalk_id={dingtalk_user_id}, "
                            f"outTrackId={result.get('outTrackId')})"
                        )
                    else:
                        logger.warning(
                            f"[SubscriptionNotificationDispatcher] Failed to send DingTalk "
                            f"AI card notification to user {user_id}: {result.get('error')}"
                        )

                if send_group and group_conversation_id:
                    group_open_space_id = f"dtv1.card//IM_GROUP.{group_conversation_id}"
                    logger.info(
                        f"[_send_dingtalk_notification] Sending group AI card to "
                        f"group_conversation_id={group_conversation_id}, open_space_id={group_open_space_id}"
                    )
                    group_result = await sender.send_ai_card_notification(
                        user_id=dingtalk_user_id or "group",
                        title=subscription_display_name,
                        content=content_with_status,
                        card_template_id=card_template_id,
                        status="",
                        enable_streaming=False,
                        open_space_id=group_open_space_id,
                    )
                    logger.info(
                        f"[_send_dingtalk_notification] Group AI card result: {group_result}"
                    )
                    if group_result.get("success"):
                        logger.info(
                            f"[SubscriptionNotificationDispatcher] Sent DingTalk group AI card "
                            f"conversation_id={group_conversation_id}"
                        )
                    else:
                        logger.warning(
                            f"[SubscriptionNotificationDispatcher] Failed to send DingTalk "
                            f"group AI card conversation_id={group_conversation_id}: "
                            f"{group_result.get('error')}"
                        )
            else:
                # Fallback to markdown message (legacy mode)
                # Format message with subscription name as header (same as webhook)
                # - title: Shows in contact list preview, use content preview
                # - text: The actual message content with subscription name as header
                title_preview = message[:20] + "..." if len(message) > 20 else message
                # Remove newlines from title preview for cleaner display
                title_preview = title_preview.replace("\n", " ").strip()
                text_with_title = f"### {subscription_display_name}\n\n{message}"

                # Send markdown message for better formatting
                logger.info(
                    f"[_send_dingtalk_notification] Sending markdown message (AI card template not configured) "
                    f"with length: {len(message)}, contains detail_url: {'[查看详情]' in message}"
                )
                if send_private:
                    result = await sender.send_markdown_message(
                        user_ids=[dingtalk_user_id],
                        title=title_preview,
                        text=text_with_title,
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

                if send_group and group_conversation_id:
                    logger.info(
                        "[SubscriptionNotificationDispatcher] Group delivery skipped because "
                        "AI card template is not configured"
                    )

        except Exception as e:
            logger.error(
                f"[SubscriptionNotificationDispatcher] Failed to send DingTalk "
                f"notification to user {user_id}: {e}"
            )
            raise

    async def _send_telegram_notification(
        self,
        db: Session,
        *,
        channel: Kind,
        binding: Any,
        user_id: int,
        message: str,
        subscription_id: int,
        execution_id: int,
        subscription_display_name: str,
    ) -> None:
        """
        Send notification via Telegram.

        Args:
            db: Database session
            channel: Messager Kind
            binding: User's IM binding info
            user_id: User ID
            message: Notification message
            subscription_id: Subscription ID
            execution_id: Background execution ID
            subscription_display_name: Display name of the subscription
        """
        try:
            # Get Telegram chat ID from binding
            # For Telegram, we use sender_id which is the chat_id
            telegram_chat_id = binding.sender_id
            if not telegram_chat_id:
                logger.warning(
                    f"[SubscriptionNotificationDispatcher] User {user_id} has no "
                    f"sender_id (chat_id) for Telegram channel {channel.id}"
                )
                return

            # Get channel config for bot token
            spec = channel.json.get("spec", {})
            config = spec.get("config", {})
            bot_token_encrypted = config.get("bot_token")

            if not bot_token_encrypted:
                logger.warning(
                    f"[SubscriptionNotificationDispatcher] Channel {channel.id} missing "
                    f"bot_token"
                )
                return

            # Decrypt the bot_token (stored encrypted in database)
            from shared.utils.crypto import decrypt_sensitive_data

            bot_token = decrypt_sensitive_data(bot_token_encrypted)

            # Send actual Telegram message via bot API
            from app.services.channels.telegram.sender import TelegramBotSender

            sender = TelegramBotSender(bot_token=bot_token)

            # Format message with subscription name as header (same as webhook)
            text_with_title = f"*{subscription_display_name}*\n\n{message}"

            # Send markdown message for better formatting
            logger.info(
                f"[_send_telegram_notification] Sending message with length: {len(message)}, "
                f"contains detail_url: {'[查看详情]' in message}"
            )
            result = await sender.send_markdown_message(
                chat_id=int(telegram_chat_id),
                text=text_with_title,
            )

            if result.get("success"):
                logger.info(
                    f"[SubscriptionNotificationDispatcher] Sent Telegram notification "
                    f"to user {user_id} (chat_id={telegram_chat_id})"
                )
            else:
                logger.warning(
                    f"[SubscriptionNotificationDispatcher] Failed to send Telegram "
                    f"notification to user {user_id}: {result.get('error')}"
                )

        except Exception as e:
            logger.error(
                f"[SubscriptionNotificationDispatcher] Failed to send Telegram "
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

        If execution succeeded (COMPLETED), return the original result_summary.
        If execution failed, return a formatted failure notification.

        Args:
            subscription_display_name: Display name of the subscription
            status: Execution status
            result_summary: Summary of the execution result
            detail_url: URL to view execution details

        Returns:
            Formatted notification message
        """
        # If execution succeeded, return original content
        if status == "COMPLETED":
            return result_summary

        # If execution failed, format a failure notification
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
            f"**状态**: ❌ 执行失败",
            "",
            "**错误信息**:",
            f"\n\n{truncated_summary}",
        ]

        if detail_url:
            message_lines.extend(["", f"[查看详情]({detail_url})"])

        # Join with explicit newlines for better DingTalk rendering
        message = "\n".join(message_lines)

        return message

    async def dispatch_webhook_notifications(
        self,
        *,
        webhooks: List[NotificationWebhook],
        subscription_display_name: str,
        result_summary: str,
        status: str,
        execution_id: int,
        detail_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Dispatch notifications to configured webhooks.

        This method sends notifications directly to webhooks configured on the subscription,
        without requiring user bindings. It supports DingTalk, Feishu, and custom webhooks.

        Args:
            webhooks: List of NotificationWebhook configurations
            subscription_display_name: Display name of the subscription
            result_summary: Summary of the execution result
            status: Execution status (COMPLETED, FAILED, etc.)
            execution_id: Background execution ID
            detail_url: URL to view execution details

        Returns:
            Dict with webhook notification dispatch results
        """
        results = {
            "total_webhooks": len(webhooks),
            "enabled_count": 0,
            "success_count": 0,
            "failed_count": 0,
            "errors": [],
        }

        # Filter enabled webhooks
        enabled_webhooks = [w for w in webhooks if w.enabled]
        results["enabled_count"] = len(enabled_webhooks)

        # Log all webhooks for debugging
        for i, w in enumerate(webhooks):
            logger.info(
                f"[SubscriptionNotificationDispatcher] Webhook {i}: "
                f"type={w.type.value}, enabled={w.enabled}, "
                f"url={w.url[:50]}..., has_secret={bool(w.secret)}"
            )

        if not enabled_webhooks:
            logger.info(
                f"[SubscriptionNotificationDispatcher] No enabled webhooks for "
                f"subscription {subscription_display_name}"
            )
            return results

        logger.info(
            f"[SubscriptionNotificationDispatcher] Sending to {len(enabled_webhooks)} enabled webhooks"
        )

        # Send to each webhook concurrently
        tasks = []
        for webhook in enabled_webhooks:
            logger.info(
                f"[SubscriptionNotificationDispatcher] Preparing webhook: "
                f"type={webhook.type.value}, url={webhook.url}..."
            )
            tasks.append(
                self._send_webhook_notification(
                    webhook=webhook,
                    subscription_display_name=subscription_display_name,
                    result_summary=result_summary,
                    status=status,
                    execution_id=execution_id,
                    detail_url=detail_url,
                )
            )

        # Gather results
        task_results = await asyncio.gather(*tasks, return_exceptions=True)

        for i, result in enumerate(task_results):
            if isinstance(result, Exception):
                results["failed_count"] += 1
                results["errors"].append(
                    f"Webhook {enabled_webhooks[i].type.value} failed: {str(result)}"
                )
            elif result.get("success"):
                results["success_count"] += 1
            else:
                results["failed_count"] += 1
                results["errors"].append(
                    f"Webhook {enabled_webhooks[i].type.value} failed: {result.get('error', 'Unknown error')}"
                )

        # Log summary with errors
        error_details = ""
        if results["errors"]:
            error_details = f", errors={'; '.join(results['errors'])}"

        logger.info(
            f"[SubscriptionNotificationDispatcher] Webhook notifications for "
            f"subscription {subscription_display_name}: "
            f"total={results['total_webhooks']}, enabled={results['enabled_count']}, "
            f"success={results['success_count']}, failed={results['failed_count']}"
            f"{error_details}"
        )

        return results

    def _decrypt_webhook_secret(self, secret: Optional[str]) -> Optional[str]:
        """
        Decrypt webhook secret if it's encrypted.

        Args:
            secret: The secret value (may be encrypted with ENC: prefix)

        Returns:
            Decrypted secret or original value if not encrypted
        """
        if not secret:
            return None

        # Check if secret is encrypted (has ENC: prefix)
        if secret.startswith("ENC:"):
            from shared.utils.crypto import decrypt_sensitive_data

            encrypted_value = secret[4:]  # Remove "ENC:" prefix
            return decrypt_sensitive_data(encrypted_value)

        return secret

    async def _send_webhook_notification(
        self,
        *,
        webhook: NotificationWebhook,
        subscription_display_name: str,
        result_summary: str,
        status: str,
        execution_id: int,
        detail_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Send notification to a single webhook.

        Args:
            webhook: Webhook configuration
            subscription_display_name: Display name of the subscription
            result_summary: Summary of the execution result
            status: Execution status
            execution_id: Background execution ID
            detail_url: URL to view execution details

        Returns:
            Dict with success status and optional error message
        """
        # Decrypt secret if encrypted
        decrypted_secret = self._decrypt_webhook_secret(webhook.secret)

        logger.info(
            f"[_send_webhook_notification] Processing webhook:\n"
            f"  Type: {webhook.type.value}\n"
            f"  URL: {webhook.url[:50]}...\n"
            f"  Has Secret: {bool(webhook.secret)}\n"
            f"  Status: {status}\n"
            f"  Execution ID: {execution_id}"
        )

        # Format the notification message based on status
        try:
            formatted_message = self._format_notification_message(
                subscription_display_name=subscription_display_name,
                status=status,
                result_summary=result_summary,
                detail_url=detail_url,
            )
            logger.info(
                f"[_send_webhook_notification] Formatted message, length: {len(formatted_message)}"
            )
        except Exception as e:
            logger.error(
                f"[_send_webhook_notification] Failed to format message: {e}",
                exc_info=True,
            )
            return {"success": False, "error": f"Message formatting failed: {str(e)}"}

        # Convert attachment links to public share URLs for external webhooks
        # This allows any logged-in user to download, not just the creator
        try:
            formatted_message = _convert_attachment_links_to_public(formatted_message)
            logger.info(
                f"[_send_webhook_notification] Converted attachment links to public URLs, final length: {len(formatted_message)}"
            )
        except Exception as e:
            logger.error(
                f"[_send_webhook_notification] Failed to convert attachment links: {e}",
                exc_info=True,
            )
            return {
                "success": False,
                "error": f"Attachment link conversion failed: {str(e)}",
            }

        try:
            if webhook.type == NotificationWebhookType.DINGTALK:
                return await self._send_dingtalk_webhook(
                    url=webhook.url,
                    secret=decrypted_secret,
                    subscription_display_name=subscription_display_name,
                    result_summary=formatted_message,
                    status=status,
                    detail_url=detail_url,
                )
            elif webhook.type == NotificationWebhookType.FEISHU:
                return await self._send_feishu_webhook(
                    url=webhook.url,
                    secret=decrypted_secret,
                    subscription_display_name=subscription_display_name,
                    result_summary=formatted_message,
                    status=status,
                    detail_url=detail_url,
                )
            elif webhook.type == NotificationWebhookType.CUSTOM:
                return await self._send_custom_webhook(
                    url=webhook.url,
                    secret=decrypted_secret,
                    subscription_display_name=subscription_display_name,
                    result_summary=formatted_message,
                    status=status,
                    execution_id=execution_id,
                    detail_url=detail_url,
                )
            else:
                return {
                    "success": False,
                    "error": f"Unknown webhook type: {webhook.type}",
                }
        except Exception as e:
            logger.error(
                f"[SubscriptionNotificationDispatcher] Failed to send {webhook.type.value} "
                f"webhook notification: {e}"
            )
            return {"success": False, "error": str(e)}

    async def _send_dingtalk_webhook(
        self,
        *,
        url: str,
        secret: Optional[str],
        subscription_display_name: str,
        result_summary: str,
        status: str,
        detail_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Send notification via DingTalk webhook.

        DingTalk webhook format:
        https://oapi.dingtalk.com/robot/send?access_token=xxx

        With signing:
        https://oapi.dingtalk.com/robot/send?access_token=xxx&timestamp=xxx&sign=xxx

        Args:
            url: DingTalk webhook URL
            secret: Optional signing secret
            subscription_display_name: Display name of the subscription
            result_summary: Summary of the execution result
            status: Execution status
            detail_url: URL to view execution details

        Returns:
            Dict with success status and optional error message
        """
        try:
            # Build the webhook URL with signature if secret is provided
            # DingTalk signing algorithm:
            # 1. timestamp (milliseconds) + "\n" + secret
            # 2. HMAC-SHA256 with secret as key
            # 3. Base64 encode
            # 4. URL encode (quote_plus)
            final_url = url
            if secret:
                import base64
                import urllib.parse

                timestamp = str(int(time.time() * 1000))
                string_to_sign = f"{timestamp}\n{secret}"
                hmac_code = hmac.new(
                    secret.encode("utf-8"),
                    string_to_sign.encode("utf-8"),
                    digestmod=hashlib.sha256,
                ).digest()
                # Use standard base64 encoding, then URL encode
                sign = urllib.parse.quote_plus(
                    base64.b64encode(hmac_code).decode("utf-8")
                )

                # Append timestamp and sign to URL
                separator = "&" if "?" in url else "?"
                final_url = f"{url}{separator}timestamp={timestamp}&sign={sign}"

            # Send model output directly as markdown
            # DingTalk webhook payload:
            # - title: Shows in contact list preview, use content preview instead of subscription name
            # - text: The actual message content with subscription name as header
            # Truncate title to first 20 chars of result_summary for contact list preview
            title_preview = (
                result_summary[:20] + "..."
                if len(result_summary) > 20
                else result_summary
            )
            # Remove newlines from title preview for cleaner display
            title_preview = title_preview.replace("\n", " ").strip()
            text_with_title = f"### {subscription_display_name}\n\n{result_summary}"
            payload = {
                "msgtype": "markdown",
                "markdown": {
                    "title": title_preview,
                    "text": text_with_title,
                },
            }

            # Log request details
            logger.info(
                f"[_send_dingtalk_webhook] Sending request:\n"
                f"  URL: {url}\n"
                f"  Final URL: {final_url}\n"
                f"  Has Secret: {bool(secret)}\n"
                f"  Payload: {payload}"
            )

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(final_url, json=payload)
                response.raise_for_status()
                result = response.json()

                # Log response details
                logger.info(
                    f"[_send_dingtalk_webhook] Received response:\n"
                    f"  Status Code: {response.status_code}\n"
                    f"  Response Body: {result}"
                )

                if result.get("errcode") == 0:
                    logger.info(
                        f"[SubscriptionNotificationDispatcher] Sent DingTalk webhook notification "
                        f"for subscription {subscription_display_name}"
                    )
                    return {"success": True}
                else:
                    error_msg = result.get("errmsg", "Unknown error")
                    logger.warning(
                        f"[SubscriptionNotificationDispatcher] DingTalk webhook failed: {error_msg}"
                    )
                    return {"success": False, "error": error_msg}
        except Exception as e:
            logger.error(
                f"[_send_dingtalk_webhook] Exception occurred: {type(e).__name__}: {e}",
                exc_info=True,
            )
            return {"success": False, "error": f"{type(e).__name__}: {str(e)}"}

    async def _send_feishu_webhook(
        self,
        *,
        url: str,
        secret: Optional[str],
        subscription_display_name: str,
        result_summary: str,
        status: str,
        detail_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Send notification via Feishu webhook.

        Feishu webhook format:
        https://open.feishu.cn/open-apis/bot/v2/hook/xxx

        With signing:
        timestamp + sign in request body

        Args:
            url: Feishu webhook URL
            secret: Optional signing secret
            subscription_display_name: Display name of the subscription
            result_summary: Summary of the execution result
            status: Execution status
            detail_url: URL to view execution details

        Returns:
            Dict with success status and optional error message
        """
        # Send model output directly as rich text
        # Build rich text content - just the result_summary
        content_lines = [
            [{"tag": "text", "text": result_summary}],
        ]

        # Feishu webhook payload - just send the result_summary
        payload: Dict[str, Any] = {
            "msg_type": "post",
            "content": {
                "post": {
                    "zh_cn": {
                        "title": subscription_display_name,
                        "content": content_lines,
                    }
                }
            },
        }

        # Add signature if secret is provided
        if secret:
            timestamp = str(int(time.time()))
            string_to_sign = f"{timestamp}\n{secret}"
            hmac_code = hmac.new(
                string_to_sign.encode("utf-8"),
                digestmod=hashlib.sha256,
            ).digest()
            import base64

            sign = base64.b64encode(hmac_code).decode("utf-8")
            payload["timestamp"] = timestamp
            payload["sign"] = sign

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            result = response.json()

            if result.get("code") == 0 or result.get("StatusCode") == 0:
                logger.info(
                    f"[SubscriptionNotificationDispatcher] Sent Feishu webhook notification "
                    f"for subscription {subscription_display_name}"
                )
                return {"success": True}
            else:
                error_msg = result.get(
                    "msg", result.get("StatusMessage", "Unknown error")
                )
                logger.warning(
                    f"[SubscriptionNotificationDispatcher] Feishu webhook failed: {error_msg}"
                )
                return {"success": False, "error": error_msg}

    async def _send_custom_webhook(
        self,
        *,
        url: str,
        secret: Optional[str],
        subscription_display_name: str,
        result_summary: str,
        status: str,
        execution_id: int,
        detail_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Send notification via custom webhook.

        Custom webhook sends a JSON payload with all execution details.
        If secret is provided, it's included in the X-Webhook-secret header.

        Args:
            url: Custom webhook URL
            secret: Optional secret for authentication header
            subscription_display_name: Display name of the subscription
            result_summary: Summary of the execution result
            status: Execution status
            execution_id: Background execution ID
            detail_url: URL to view execution details

        Returns:
            Dict with success status and optional error message
        """
        # Custom webhook payload - just send the model output
        payload = {
            "content": result_summary,
            "subscription_name": subscription_display_name,
            "timestamp": int(time.time()),
        }

        # Build headers
        headers = {"Content-Type": "application/json"}
        if secret:
            headers["X-Webhook-secret"] = secret

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()

            logger.info(
                f"[SubscriptionNotificationDispatcher] Sent custom webhook notification "
                f"for subscription {subscription_display_name} to {url}"
            )
            return {"success": True}

    def _convert_attachment_links(self, message: str, db: Session, user_id: int) -> str:
        """
        Convert attachment download URLs to public share URLs.

        This is necessary for external IM channels (DingTalk, etc.) to ensure
        any logged-in user can download the attachment, not just the creator.

        Converts:
            /api/attachments/123/download
        To:
            https://wegent.com/download/attachment/public?token=xxx

        The generated token contains a random nonce to prevent enumeration attacks.

        Args:
            message: Original message that may contain attachment links
            db: Database session for generating share tokens
            user_id: User ID (attachment owner) for generating share tokens

        Returns:
            Message with converted public share URLs
        """
        from app.api.endpoints.adapter.attachments import (
            _generate_public_share_token,
        )
        from app.core.config import settings

        base_url = settings.FRONTEND_URL.rstrip("/")

        # Find all attachment URLs and replace with public share URLs
        def replace_url(match: re.Match) -> str:
            attachment_id = int(match.group(1))

            # Generate public share token for this attachment
            try:
                token = _generate_public_share_token(
                    attachment_id=attachment_id, expires_in_days=7
                )
                return f"{base_url}/download/shared?token={token}"
            except Exception as e:
                logger.warning(
                    f"Failed to generate public share link for attachment {attachment_id}: {e}"
                )
                # Fallback to regular frontend URL
                return _convert_to_frontend_attachment_url(attachment_id)

        converted = re.sub(ATTACHMENT_URL_PATTERN, replace_url, message)
        return converted


# Singleton instance
subscription_notification_dispatcher = SubscriptionNotificationDispatcher()
