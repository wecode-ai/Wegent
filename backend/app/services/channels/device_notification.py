# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device Notification Service for IM Channels.

This module provides functionality to send notifications to users via IM channels
when their default execution target is changed from the PC/Web interface.
"""

import logging
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind

logger = logging.getLogger(__name__)

# CRD kind for IM channels
MESSAGER_KIND = "Messager"
MESSAGER_USER_ID = 0


async def send_default_device_notification(
    db: Session,
    user_id: int,
    target_type: str,
    device_name: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Send notification to user's bound IM channels when default device is changed.

    Args:
        db: Database session
        user_id: ID of the user who changed the default device
        target_type: Type of target - 'cloud' or 'device'
        device_name: Device name (only for device type)

    Returns:
        Dict with notification results
    """
    from app.services.channels.manager import get_channel_manager
    from app.services.subscription.notification_service import (
        subscription_notification_service,
    )

    # Get user's IM channel bindings
    user_bindings = subscription_notification_service.get_user_im_bindings(
        db, user_id=user_id
    )

    if not user_bindings:
        logger.debug(
            "[DeviceNotification] User %d has no IM channel bindings, skipping notification",
            user_id,
        )
        return {"success": True, "sent": 0, "message": "No IM channels bound"}

    # Build notification message
    if target_type == "cloud":
        message = (
            "✅ 默认执行目标已切换为**公共模式**\n\n现在通过 IM 发送的消息将在云端执行"
        )
    else:
        message = f"✅ 默认执行目标已切换为设备 **{device_name or '未知设备'}**\n\n现在通过 IM 发送的消息将在该设备上执行"

    channel_manager = get_channel_manager()
    results: List[Dict[str, Any]] = []

    for channel_id_str, binding in user_bindings.items():
        try:
            channel_id = int(channel_id_str)
            channel_type = binding.channel_type
            sender_id = binding.sender_id

            # Get the channel provider
            provider = channel_manager.get_channel(channel_id)
            if not provider:
                logger.warning(
                    "[DeviceNotification] Channel %d not running, skipping",
                    channel_id,
                )
                results.append(
                    {
                        "channel_id": channel_id,
                        "success": False,
                        "error": "Channel not running",
                    }
                )
                continue

            # Send notification based on channel type
            if channel_type == "dingtalk":
                result = await _send_dingtalk_notification(
                    db, channel_id, sender_id, message
                )
            elif channel_type == "telegram":
                result = await _send_telegram_notification(
                    db, channel_id, sender_id, message
                )
            else:
                logger.warning(
                    "[DeviceNotification] Unsupported channel type: %s", channel_type
                )
                result = {
                    "success": False,
                    "error": f"Unsupported channel type: {channel_type}",
                }

            results.append({"channel_id": channel_id, **result})

        except Exception as e:
            logger.exception(
                "[DeviceNotification] Error sending notification to channel %s: %s",
                channel_id_str,
                e,
            )
            results.append(
                {
                    "channel_id": channel_id_str,
                    "success": False,
                    "error": str(e),
                }
            )

    sent_count = sum(1 for r in results if r.get("success"))
    return {
        "success": True,
        "sent": sent_count,
        "total": len(results),
        "results": results,
    }


async def _send_dingtalk_notification(
    db: Session,
    channel_id: int,
    sender_id: str,
    message: str,
) -> Dict[str, Any]:
    """Send notification via DingTalk channel."""
    from app.services.channels.dingtalk.sender import DingTalkRobotSender

    # Get channel config
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
        return {"success": False, "error": "Channel not found"}

    config = channel.json.get("spec", {}).get("config", {})
    client_id = config.get("clientId")
    client_secret = config.get("clientSecret")

    if not client_id or not client_secret:
        return {"success": False, "error": "Missing DingTalk credentials"}

    sender = DingTalkRobotSender(client_id, client_secret)

    # Send text message
    result = await sender.send_text_message(
        user_ids=[sender_id],
        content=message,
    )

    return result


async def _send_telegram_notification(
    db: Session,
    channel_id: int,
    sender_id: str,
    message: str,
) -> Dict[str, Any]:
    """Send notification via Telegram channel."""
    from app.services.channels.telegram.sender import TelegramBotSender

    # Get channel config
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
        return {"success": False, "error": "Channel not found"}

    config = channel.json.get("spec", {}).get("config", {})
    bot_token = config.get("botToken")

    if not bot_token:
        return {"success": False, "error": "Missing Telegram bot token"}

    sender = TelegramBotSender(bot_token)

    # Send text message
    result = await sender.send_text_message(
        chat_id=sender_id,
        text=message,
    )

    return result
