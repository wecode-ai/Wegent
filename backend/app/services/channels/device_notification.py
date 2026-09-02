# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device Notification Service for IM Channels.

This module provides functionality to send notifications to users via IM channels
when their default execution target is changed from the PC/Web interface.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from app.models.kind import Kind
from app.services.channels.worker_client import channel_worker_client

logger = logging.getLogger(__name__)

# CRD kind for IM channels
MESSAGER_KIND = "Messager"
MESSAGER_USER_ID = 0


@dataclass(frozen=True)
class _DeviceNotificationTarget:
    channel_key: str
    channel_id: int | None
    channel_type: str
    sender_id: str
    config: dict[str, Any] | None


async def send_default_device_notification(
    user_id: int,
    target_type: str,
    device_name: Optional[str] = None,
) -> Dict[str, Any]:
    """Ask the provider-owning sibling process to send the notification."""
    return await channel_worker_client.send_device_notification(
        user_id=user_id,
        target_type=target_type,
        device_name=device_name,
    )


async def _send_default_device_notification_locally(
    *,
    user_id: int,
    target_type: str,
    device_name: Optional[str],
    is_channel_running: Callable[[int], bool],
) -> Dict[str, Any]:
    """
    Send notification to user's bound IM channels when default device is changed.

    Args:
        user_id: ID of the user who changed the default device
        target_type: Type of target - 'cloud' or 'device'
        device_name: Device name (only for device type)

    Returns:
        Dict with notification results
    """
    from app.services.chat.storage.db import run_sync_in_executor

    targets = await run_sync_in_executor(_load_notification_targets_sync, user_id)

    if not targets:
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

    results: List[Dict[str, Any]] = []

    for target in targets:
        try:
            if target.channel_id is None:
                results.append(
                    {
                        "channel_id": target.channel_key,
                        "success": False,
                        "error": "Invalid channel ID",
                    }
                )
                continue

            if not is_channel_running(target.channel_id):
                logger.warning(
                    "[DeviceNotification] Channel %d not running, skipping",
                    target.channel_id,
                )
                results.append(
                    {
                        "channel_id": target.channel_id,
                        "success": False,
                        "error": "Channel not running",
                    }
                )
                continue

            # Send notification based on channel type
            if target.channel_type == "dingtalk":
                result = await _send_dingtalk_notification(
                    target.config,
                    target.sender_id,
                    message,
                )
            elif target.channel_type == "telegram":
                result = await _send_telegram_notification(
                    target.config,
                    target.sender_id,
                    message,
                )
            else:
                logger.warning(
                    "[DeviceNotification] Unsupported channel type: %s",
                    target.channel_type,
                )
                result = {
                    "success": False,
                    "error": f"Unsupported channel type: {target.channel_type}",
                }

            results.append({"channel_id": target.channel_id, **result})

        except Exception as e:
            logger.exception(
                "[DeviceNotification] Error sending notification to channel %s: %s",
                target.channel_key,
                e,
            )
            results.append(
                {
                    "channel_id": target.channel_key,
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


def _load_notification_targets_sync(
    user_id: int,
) -> tuple[_DeviceNotificationTarget, ...]:
    from app.services.chat.storage.db import get_db_session
    from app.services.im.notification_dispatcher import get_channel_config
    from app.services.subscription.notification_service import (
        subscription_notification_service,
    )

    with get_db_session() as db:
        bindings = subscription_notification_service.get_user_im_bindings(
            db,
            user_id=user_id,
        )
        channel_ids = {
            channel_id
            for channel_key in bindings
            if (channel_id := _parse_channel_id(channel_key)) is not None
        }
        channels = (
            db.query(Kind)
            .filter(
                Kind.id.in_(channel_ids),
                Kind.kind == MESSAGER_KIND,
                Kind.user_id == MESSAGER_USER_ID,
                Kind.is_active == True,
            )
            .all()
            if channel_ids
            else []
        )
        configs = {channel.id: get_channel_config(channel) for channel in channels}
        return tuple(
            _DeviceNotificationTarget(
                channel_key=channel_key,
                channel_id=(channel_id := _parse_channel_id(channel_key)),
                channel_type=binding.channel_type,
                sender_id=binding.sender_id,
                config=configs.get(channel_id) if channel_id is not None else None,
            )
            for channel_key, binding in bindings.items()
        )


def _parse_channel_id(channel_key: str) -> int | None:
    try:
        return int(channel_key)
    except (TypeError, ValueError):
        return None


async def _send_dingtalk_notification(
    config: dict[str, Any] | None,
    sender_id: str,
    message: str,
) -> Dict[str, Any]:
    """Send notification via DingTalk channel."""
    from app.services.channels.dingtalk.sender import DingTalkRobotSender

    if config is None:
        return {"success": False, "error": "Channel not found"}

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
    config: dict[str, Any] | None,
    sender_id: str,
    message: str,
) -> Dict[str, Any]:
    """Send notification via Telegram channel."""
    from app.services.channels.telegram.sender import TelegramBotSender

    if config is None:
        return {"success": False, "error": "Channel not found"}

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
