# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Monkey-patch app.services.device_router to replace ${WECODE_USER_API_KEY}
placeholder with real API keys from external service.

This patch ensures that device task dispatch has the same API key replacement
behavior as executor_manager task dispatch (via executors_endpoint_patch.py).

Auto-applied on import.
"""

import json
import logging
from functools import wraps
from typing import Any, Callable, Dict

try:
    from app.services import device_router as device_router_module
    from wecode.api.executors_endpoint_patch import (
        _get_or_create_apikey,
        _replace_api_key_in_config,
    )
except Exception:
    # If import fails at bootstrap time, skip patching to avoid breaking startup
    device_router_module = None  # type: ignore

logger = logging.getLogger(__name__)


async def _process_task_data_api_key(
    task_data: Dict[str, Any], username: str
) -> Dict[str, Any]:
    """
    Process task data to replace ${WECODE_USER_API_KEY} placeholder with real API key.

    This function mirrors the logic in executors_endpoint_patch._process_dispatch_response
    but operates on a single task_data dict instead of the full response.

    Args:
        task_data: The formatted task data dict
        username: The username to get API key for

    Returns:
        The task_data with API keys replaced
    """
    # Check if any bot has the placeholder
    bots = task_data.get("bot", [])
    if not isinstance(bots, list):
        return task_data

    needs_replacement = False
    for bot in bots:
        if not isinstance(bot, dict) or "agent_config" not in bot:
            continue

        agent_config = bot.get("agent_config")
        if agent_config and "${WECODE_USER_API_KEY}" in json.dumps(agent_config):
            needs_replacement = True
            break

    if not needs_replacement:
        return task_data

    try:
        # Get the real API key
        real_apikey = await _get_or_create_apikey(username)

        # Replace placeholders in all bots
        processed_bots = []
        for bot in bots:
            if not isinstance(bot, dict):
                processed_bots.append(bot)
                continue

            processed_bot = dict(bot)
            if "agent_config" in processed_bot:
                processed_bot["agent_config"] = _replace_api_key_in_config(
                    processed_bot["agent_config"],
                    real_apikey,
                )
            processed_bots.append(processed_bot)

        return {
            **task_data,
            "bot": processed_bots,
        }

    except Exception as e:
        logger.error(f"Failed to replace API key for user {username}: {str(e)}")
        # Return original task_data if replacement fails
        return task_data


def _wrap_route_task_to_device(original_func: Callable) -> Callable:
    """
    Wrap the route_task_to_device function to process API key replacement.
    """

    @wraps(original_func)
    async def wrapper(
        db,
        user_id,
        device_id,
        task,
        subtask,
        team,
        user,
        auth_token="",
        user_subtask=None,
    ):
        from fastapi import HTTPException
        from datetime import datetime

        from app.models.subtask import Subtask, SubtaskStatus
        from app.services.adapters.executor_kinds import executor_kinds_service
        from app.services.device_service import device_service
        from app.core.socketio import get_sio

        # Verify device is online
        device_info = await device_service.get_device_online_info(user_id, device_id)
        if not device_info:
            raise HTTPException(status_code=400, detail="Selected device is offline")

        # Re-query ORM objects within this session to avoid cross-session issues
        local_subtask = db.query(Subtask).filter(Subtask.id == subtask.id).first()

        if not local_subtask:
            raise HTTPException(status_code=404, detail="Subtask not found")

        # Update subtask with device executor info
        local_subtask.executor_name = f"device-{device_id}"
        local_subtask.executor_namespace = f"user-{user_id}"
        local_subtask.status = SubtaskStatus.RUNNING
        local_subtask.started_at = datetime.now()
        db.add(local_subtask)
        db.commit()

        # Refresh to get updated state
        db.refresh(local_subtask)

        # Use executor_kinds_service to format task data
        formatted_result = executor_kinds_service._format_subtasks_response(
            db, [local_subtask]
        )

        if not formatted_result.get("tasks"):
            raise HTTPException(status_code=500, detail="Failed to format task data")

        task_data = formatted_result["tasks"][0]

        # Process API key replacement if user has a name
        if user and user.user_name:
            try:
                task_data = await _process_task_data_api_key(task_data, user.user_name)
                logger.info(
                    f"[DeviceRouterPatch] Processed API key replacement for user: {user.user_name}"
                )
            except Exception as e:
                logger.error(
                    f"[DeviceRouterPatch] Error processing API key replacement: {str(e)}"
                )
                # Continue with original task_data if processing fails

        # Push task to device via WebSocket
        sio = get_sio()
        device_room = f"device:{user_id}:{device_id}"

        await sio.emit(
            "task:execute", task_data, room=device_room, namespace="/local-executor"
        )

        logger.info(
            f"[DeviceRouter] Task routed to device: task_id={task.id}, "
            f"subtask_id={subtask.id}, device_id={device_id}"
        )

        return True

    # Mark as patched to avoid double patching
    setattr(wrapper, "_wecode_patched", True)
    return wrapper


def apply_patch() -> None:
    """
    Apply the patch to route_task_to_device function in device_router module.
    """
    if device_router_module is None:
        logger.warning("device_router module not available, skipping patch")
        return

    original_func = getattr(device_router_module, "route_task_to_device", None)
    if original_func is None:
        logger.warning("route_task_to_device function not found, skipping patch")
        return

    # Skip if already patched
    if getattr(original_func, "_wecode_patched", False):
        logger.debug("route_task_to_device already patched, skipping")
        return

    try:
        logger.info("Applying patch to device_router.route_task_to_device")
        wrapped = _wrap_route_task_to_device(original_func)
        device_router_module.route_task_to_device = wrapped
        logger.info("Successfully patched device_router.route_task_to_device")
    except Exception as e:
        logger.error(f"Failed to patch device_router.route_task_to_device: {str(e)}")


# Auto-apply on import
apply_patch()
