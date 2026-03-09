# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Monkey-patch executor_kinds_service.dispatch_tasks to replace
${WECODE_USER_API_KEY} placeholder with real API keys from external service.

This patch works for both:
- Pull mode: executor_manager calls /tasks/dispatch HTTP endpoint
- Push mode: task_dispatcher calls dispatch_tasks directly

Auto-applied on import.
"""

import json
import logging
from functools import wraps
from typing import Callable, Dict

try:
    from app.services.adapters.executor_kinds import executor_kinds_service
except Exception:
    # If import fails at bootstrap time, skip patching to avoid breaking startup
    executor_kinds_service = None  # type: ignore

from wecode.service.wecode_apikey_client import (
    WECODE_USER_API_KEY_PLACEHOLDER,
    get_or_create_apikey_async,
    replace_api_key_in_config,
)

logger = logging.getLogger(__name__)


async def _process_dispatch_response(response_data: Dict, username: str) -> Dict:
    """
    Process the dispatch response to replace API key placeholders.

    Args:
        response_data: The original response from dispatch_tasks
        username: The username to get API key for

    Returns:
        The processed response with API keys replaced
    """
    if not isinstance(response_data, dict) or "tasks" not in response_data:
        return response_data

    tasks = response_data.get("tasks", [])
    if not isinstance(tasks, list):
        return response_data

    # Check if any bot or model_config has the placeholder
    needs_replacement = False
    for task in tasks:
        if not isinstance(task, dict):
            continue

        # Check model_config.api_key
        model_config = task.get("model_config")
        if model_config and isinstance(model_config, dict):
            api_key = model_config.get("api_key", "")
            if api_key and WECODE_USER_API_KEY_PLACEHOLDER in api_key:
                needs_replacement = True
                break

        # Check bot.agent_config
        bots = task.get("bot", [])
        if not isinstance(bots, list):
            continue

        for bot in bots:
            if not isinstance(bot, dict) or "agent_config" not in bot:
                continue

            agent_config = bot.get("agent_config")
            if agent_config and WECODE_USER_API_KEY_PLACEHOLDER in json.dumps(
                agent_config
            ):
                needs_replacement = True
                break

        if needs_replacement:
            break

    # If no replacement needed, return original response
    if not needs_replacement:
        return response_data

    try:
        # Get the real API key
        real_apikey = await get_or_create_apikey_async(username)

        # Replace placeholders in all tasks
        processed_tasks = []
        for task in tasks:
            if not isinstance(task, dict):
                processed_tasks.append(task)
                continue

            processed_task = dict(task)

            # Replace in model_config.api_key
            if "model_config" in processed_task and isinstance(
                processed_task["model_config"], dict
            ):
                processed_task["model_config"] = replace_api_key_in_config(
                    processed_task["model_config"], real_apikey
                )

            # Replace in bot.agent_config
            if "bot" in processed_task and isinstance(processed_task["bot"], list):
                processed_bots = []
                for bot in processed_task["bot"]:
                    if not isinstance(bot, dict):
                        processed_bots.append(bot)
                        continue

                    processed_bot = dict(bot)
                    if "agent_config" in processed_bot:
                        processed_bot["agent_config"] = replace_api_key_in_config(
                            processed_bot["agent_config"], real_apikey
                        )
                    processed_bots.append(processed_bot)
                processed_task["bot"] = processed_bots
            processed_tasks.append(processed_task)

        return {**response_data, "tasks": processed_tasks}

    except Exception as e:
        logger.error(f"Failed to replace API key for user {username}: {str(e)}")
        # Return original response if replacement fails
        return response_data


def _wrap_dispatch_tasks(original_method: Callable) -> Callable:
    """
    Wrap the dispatch_tasks method to process API key replacement.

    Note: original_method is already a bound method of executor_kinds_service,
    so we don't need to pass self explicitly.
    """

    @wraps(original_method)
    async def wrapper(*args, **kwargs):
        # Call the original bound method
        result = await original_method(*args, **kwargs)

        # Extract username from the response
        username = None
        if isinstance(result, dict) and "tasks" in result:
            tasks = result.get("tasks", [])
            if isinstance(tasks, list) and len(tasks) > 0:
                first_task = tasks[0]
                if isinstance(first_task, dict) and "user" in first_task:
                    user_info = first_task.get("user")
                    if isinstance(user_info, dict):
                        username = user_info.get("name")

        # If we have a username, process the response
        if username:
            try:
                result = await _process_dispatch_response(result, username)
            except Exception as e:
                logger.error(
                    f"Error processing dispatch response for user {username}: {str(e)}"
                )
                # Continue with original result if processing fails

        return result

    # Mark as patched to avoid double patching
    setattr(wrapper, "_wecode_patched", True)
    return wrapper


def apply_patch() -> None:
    """
    Apply the patch to executor_kinds_service.dispatch_tasks method.
    """
    if executor_kinds_service is None:
        logger.warning(
            "executor_kinds_service not available, skipping dispatch_tasks patch"
        )
        return

    original_method = getattr(executor_kinds_service, "dispatch_tasks", None)
    if original_method is None:
        logger.warning("dispatch_tasks method not found, skipping patch")
        return

    # Skip if already patched
    if getattr(original_method, "_wecode_patched", False):
        logger.debug("dispatch_tasks already patched, skipping")
        return

    try:
        logger.info("Applying patch to executor_kinds_service.dispatch_tasks")
        wrapped = _wrap_dispatch_tasks(original_method)
        executor_kinds_service.dispatch_tasks = wrapped
        logger.info("Successfully patched executor_kinds_service.dispatch_tasks")
    except Exception as e:
        logger.error(f"Failed to patch dispatch_tasks: {str(e)}")


# Auto-apply on import
apply_patch()
