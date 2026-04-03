# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cloud device monitoring service.

This module provides functionality to monitor cloud device online status
and send notifications when devices go offline or come back online.
"""

import json
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Set

from redis.asyncio import Redis
from sqlalchemy import and_
from sqlalchemy.orm import Session

from shared.models.db.kind import Kind
from shared.models.db.user import User
from wecode.service.dingtalk_webhook import DingTalkWebhookSender
from wecode.service.nevis_client import nevis_client
from wecode.service.ping_utils import ping_device_ip

logger = logging.getLogger(__name__)

DEVICE_ONLINE_KEY_PREFIX = "device:online:"
REDIS_OFFLINE_DEVICES_KEY = "cloud_device_monitor:offline_devices"
REDIS_KEY_TTL_SECONDS = 900  # 15 minutes

# Minimum device age (in minutes) before triggering offline alert
# Devices created within this window will not trigger alerts
MIN_DEVICE_AGE_MINUTES = 10

PRIORITY_USERS = {"gaofei", "qingfeng", "qindi", "liubin1", "jinshan"}


def sort_devices_by_priority(devices: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Sort devices with priority users first."""
    return sorted(
        devices,
        key=lambda d: (
            d.get("user_name", "").lower() not in PRIORITY_USERS,
            d.get("user_name", "").lower(),
        ),
    )


async def check_cloud_devices_status(
    db: Session, redis_client: Redis
) -> Dict[str, Any]:
    """
    Check cloud devices online status.

    Args:
        db: Database session
        redis_client: Redis client

    Returns:
        Dictionary containing:
        - total: Total number of cloud devices
        - online_count: Number of online devices
        - offline_count: Number of offline devices
        - online_devices: List of online device info dictionaries
        - offline_devices: List of offline device info dictionaries
        - new_offline: List of device IDs that are newly offline
        - recovered: List of device IDs that are back online
    """
    # Get all cloud devices from database
    devices = (
        db.query(Kind)
        .filter(
            and_(
                Kind.kind == "Device",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
        )
        .all()
    )

    # Filter cloud devices by cloud_config existence, exclude openclaw bindShell
    cloud_devices = []
    for device in devices:
        spec = device.json.get("spec", {})
        if spec.get("cloudConfig") and spec.get("bindShell") != "openclaw":
            cloud_devices.append(device)

    # Get last offline devices from Redis for comparison
    last_offline = await get_last_offline_devices(redis_client)
    current_offline_ids: Set[str] = set()
    online_devices: List[Dict[str, Any]] = []
    offline_devices: List[Dict[str, Any]] = []

    # Calculate minimum creation time threshold for offline alert filtering
    # Devices created within MIN_DEVICE_AGE_MINUTES will not trigger offline alerts
    min_age_threshold = datetime.now() - timedelta(minutes=MIN_DEVICE_AGE_MINUTES)

    # Check each device's online status
    for device in cloud_devices:
        spec = device.json.get("spec", {})
        device_id = device.name
        user_id = device.user_id
        display_name = spec.get("displayName", device_id)
        cloud_config = spec.get("cloudConfig", {})
        sandbox_id = cloud_config.get("sandboxId")

        # Check online status from Redis
        key = f"{DEVICE_ONLINE_KEY_PREFIX}{user_id}:{device_id}"
        online_info = None
        try:
            data = await redis_client.get(key)
            if data:
                online_info = json.loads(data)
        except Exception as e:
            logger.warning(f"Error checking online status for {device_id}: {e}")

        # Get user_name for the device (user_id in device is the User.id)
        user_name = "-"
        try:
            user = db.query(User).filter(User.id == user_id).first()
            if user:
                user_name = user.user_name or "-"
        except Exception:
            pass

        # Get client IP: prefer spec.clientIp, fallback to sandbox API
        client_ip = spec.get("clientIp")
        if not client_ip and sandbox_id:
            try:
                sandbox_info = await nevis_client.get_sandbox(sandbox_id)
                details = sandbox_info.get("details", {})
                client_ip = details.get("urls")
            except Exception as e:
                logger.debug(f"Failed to get sandbox IP for {device_id}: {e}")
        client_ip = client_ip or "-"

        device_info = {
            "id": device.id,
            "device_id": device_id,
            "name": display_name,
            "user_id": user_id,
            "user_name": user_name,
            "client_ip": client_ip,
            "sandbox_id": sandbox_id or "-",
            "image_id": cloud_config.get("imageId") or "-",
            "created_at": (
                cloud_config.get("createdAt", "-")[:19]
                if cloud_config.get("createdAt")
                else "-"
            ),
            "last_heartbeat": (
                online_info.get("last_heartbeat", "-")[:19] if online_info else "-"
            ),
            "executor_version": (
                online_info.get("executor_version") or "-" if online_info else "-"
            ),
        }

        if online_info:
            online_devices.append(device_info)
        else:
            # Check device creation time to avoid false alerts for newly created devices
            created_at_str = cloud_config.get("createdAt")
            should_skip_alert = False

            if created_at_str and created_at_str != "-":
                try:
                    # Parse created_at (format: "2025-01-15T10:30:00...")
                    created_at = datetime.fromisoformat(
                        created_at_str.replace("Z", "+00:00")
                    )
                    if created_at > min_age_threshold:
                        # Device is too new, skip offline alert
                        should_skip_alert = True
                        logger.debug(
                            f"[cloud-device-monitor] Device {device_id} created at {created_at}, "
                            f"skipping offline alert (within {MIN_DEVICE_AGE_MINUTES} min window)"
                        )
                except Exception as e:
                    logger.warning(
                        f"[cloud-device-monitor] Failed to parse createdAt for device {device_id}: {e}"
                    )

            if not should_skip_alert:
                offline_devices.append(device_info)
                current_offline_ids.add(device_id)
            else:
                # Device is offline but too new, don't add to offline list
                # This prevents false alerts during device initialization
                logger.info(
                    f"[cloud-device-monitor] Device {device_id} is offline but created recently, "
                    f"not alerting"
                )

    # Ping all devices (both online and offline) to check network reachability
    for device_info in online_devices:
        ping_result = await ping_device_ip(device_info.get("client_ip"))
        device_info["ping_result"] = ping_result
    for device_info in offline_devices:
        ping_result = await ping_device_ip(device_info.get("client_ip"))
        device_info["ping_result"] = ping_result

    # Calculate changes
    new_offline = list(current_offline_ids - last_offline)
    recovered = list(last_offline - current_offline_ids)

    # Save current offline devices to Redis
    await save_offline_devices(redis_client, list(current_offline_ids))

    return {
        "total": len(cloud_devices),
        "online_count": len(online_devices),
        "offline_count": len(offline_devices),
        "online_devices": online_devices,
        "offline_devices": offline_devices,
        "new_offline": new_offline,
        "recovered": recovered,
    }


async def get_last_offline_devices(redis_client: Redis) -> Set[str]:
    """
    Get last check's offline device IDs from Redis.

    Args:
        redis_client: Redis client

    Returns:
        Set of device IDs that were offline in the last check
    """
    try:
        data = await redis_client.get(REDIS_OFFLINE_DEVICES_KEY)
        if data:
            device_list = json.loads(data)
            return set(device_list)
    except Exception as e:
        logger.warning(f"Error reading last offline devices from Redis: {e}")
    return set()


async def save_offline_devices(redis_client: Redis, device_ids: List[str]) -> None:
    """
    Save current offline device IDs to Redis.

    Args:
        redis_client: Redis client
        device_ids: List of offline device IDs
    """
    try:
        await redis_client.set(
            REDIS_OFFLINE_DEVICES_KEY,
            json.dumps(device_ids),
            ex=REDIS_KEY_TTL_SECONDS,
        )
    except Exception as e:
        logger.warning(f"Error saving offline devices to Redis: {e}")


def format_device_table(devices: List[Dict[str, Any]]) -> str:
    """
    Format device list as markdown table.

    Args:
        devices: List of device info dictionaries

    Returns:
        Markdown formatted table
    """
    if not devices:
        return "_无_"

    # Sort devices with priority users first
    sorted_devices = sort_devices_by_priority(devices)

    rows = []
    for d in sorted_devices:
        rows.append(f"| {d['user_name']} | {d['user_id']} | {d['device_id']} |")
    return "\n".join(rows)


def format_offline_device_table(devices: List[Dict[str, Any]]) -> str:
    """
    Format offline device list as markdown table with more details.

    Args:
        devices: List of device info dictionaries

    Returns:
        Markdown formatted table
    """
    if not devices:
        return "_无_"

    # Sort devices with priority users first
    sorted_devices = sort_devices_by_priority(devices)

    rows = []
    for d in sorted_devices:
        sandbox_id = d.get("sandbox_id", "-")
        rows.append(
            f"| {d['user_name']} | {d['user_id']} | {d['device_id']} | {sandbox_id} |"
        )
    return "\n".join(rows)


def format_device_table_with_ping(devices: List[Dict[str, Any]]) -> str:
    """
    Format device list as markdown table with IP and ping info.

    Args:
        devices: List of device info dictionaries (may contain 'ping_result')

    Returns:
        Markdown formatted table with IP and ping columns
    """
    if not devices:
        return "_无_"

    # Sort devices with priority users first
    sorted_devices = sort_devices_by_priority(devices)

    rows = []
    for d in sorted_devices:
        ip_str = d.get("client_ip", "-") or "-"
        sandbox_id = d.get("sandbox_id", "-") or "-"
        ping_result = d.get("ping_result")
        if ping_result:
            # Handle both dict and object (PingResult) types
            if isinstance(ping_result, dict):
                status = ping_result.get("status")
                latency_ms = ping_result.get("latency_ms", 0)
            else:
                # PingResult object
                status = getattr(ping_result, "status", None)
                latency_ms = getattr(ping_result, "latency_ms", 0)

            if status == "ok":
                ping_str = f"{latency_ms:.0f}ms ✅"
            elif status == "no_ip":
                ping_str = "no ip ➖"
            else:
                ping_str = "timeout ❌"
        else:
            ping_str = "N/A"
        rows.append(
            f"| {d['user_name']} | {d['user_id']} | {d['device_id']} | {sandbox_id} | {ip_str} | {ping_str} |"
        )
    return "\n".join(rows)


async def send_monitoring_report(
    redis_client: Redis,
    check_result: Dict[str, Any],
    webhook_sender: DingTalkWebhookSender,
) -> bool:
    """
    Send monitoring report to DingTalk group.

    Args:
        redis_client: Redis client (unused, kept for compatibility)
        check_result: Result from check_cloud_devices_status
        webhook_sender: DingTalk webhook sender instance

    Returns:
        True if message was sent successfully, False otherwise
    """
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Build message sections
    sections = []

    # Header and summary
    sections.append(f"### ☁️ 云设备状态监控报告\n")
    sections.append(f"**统计概览**")
    sections.append(f"- 总设备数: {check_result['total']}")
    sections.append(f"- 在线: {check_result['online_count']} ✅")
    sections.append(f"- 离线: {check_result['offline_count']} ⚠️")
    sections.append("")

    # New offline devices
    new_offline_ids = set(check_result["new_offline"])
    new_offline_devices = [
        d for d in check_result["offline_devices"] if d["device_id"] in new_offline_ids
    ]

    if check_result["new_offline"]:
        sections.append(f"**新增离线设备 ⚠️ ({len(new_offline_devices)} 个)**")
        sections.append("| User Name | User ID | Device ID | SandboxId | IP | Ping |")
        sections.append("|-----------|---------|-----------|-----------|----|------|")
        sections.append(format_device_table_with_ping(new_offline_devices))
        sections.append("")

    # Recovered devices
    recovered_ids = set(check_result["recovered"])
    recovered_devices = [
        d for d in check_result["online_devices"] if d["device_id"] in recovered_ids
    ]

    if check_result["recovered"]:
        sections.append(f"**恢复在线设备 ✅ ({len(recovered_devices)} 个)**")
        sections.append("| User Name | User ID | Device ID | SandboxId | IP | Ping |")
        sections.append("|-----------|---------|-----------|-----------|----|------|")
        sections.append(format_device_table_with_ping(recovered_devices))
        sections.append("")

    # Current offline devices list
    if check_result["offline_count"] > 0:
        sections.append(f"**当前离线设备列表 ({check_result['offline_count']} 个)**")
        sections.append("| User Name | User ID | Device ID | SandboxId | IP | Ping |")
        sections.append("|-----------|---------|-----------|-----------|----|------|")
        sections.append(format_device_table_with_ping(check_result["offline_devices"]))
        sections.append("")

    # Footer
    sections.append(f"*检查时间: {timestamp}*")

    # Send the message
    content = "\n".join(sections)
    return await webhook_sender.send_markdown(
        title=f"云设备状态监控报告 ({timestamp})", content=content
    )
