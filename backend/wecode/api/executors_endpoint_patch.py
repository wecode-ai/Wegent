# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Monkey-patch app.api.endpoints.adapter.executors /tasks/dispatch endpoint to replace
${WECODE_USER_API_KEY} placeholder with real API keys from external service.

This patch is for pull mode where executor_manager calls the HTTP endpoint.
For push mode, see dispatch_tasks_patch.py which patches the service method directly.

Auto-applied on import.
"""

import logging
from functools import wraps
from typing import Callable

try:
    from app.api.endpoints.adapter import executors as executors_module
    from wecode.service.dispatch_tasks_patch import _process_dispatch_response
except Exception:
    # If import fails at bootstrap time, skip patching to avoid breaking startup
    executors_module = None  # type: ignore
    _process_dispatch_response = None  # type: ignore

logger = logging.getLogger(__name__)


def _wrap_dispatch_endpoint(endpoint: Callable) -> Callable:
    """
    Wrap the dispatch_tasks endpoint to process API key replacement.
    """

    @wraps(endpoint)
    async def wrapper(*args, **kwargs):
        # Call the original endpoint
        result = await endpoint(*args, **kwargs)

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
        if username and _process_dispatch_response:
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
    Apply the patch to the /tasks/dispatch endpoint in adapter executors router.
    """
    if executors_module is None or _process_dispatch_response is None:
        logger.warning(
            "executors_module or _process_dispatch_response not available, skipping patch"
        )
        return

    router = getattr(executors_module, "router", None)
    if router is None or not hasattr(router, "routes"):
        logger.warning("adapter executors router not found, skipping patch")
        return

    for route in router.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", set())
        endpoint = getattr(route, "endpoint", None)

        # Skip non-callable endpoints or already patched ones
        if not callable(endpoint) or getattr(endpoint, "_wecode_patched", False):
            continue

        # Target the /tasks/dispatch POST endpoint
        if path == "/tasks/dispatch" and "POST" in methods:
            try:
                logger.info("Applying patch to adapter /tasks/dispatch endpoint")
                wrapped = _wrap_dispatch_endpoint(endpoint)
                route.endpoint = wrapped
                logger.info("Successfully patched adapter /tasks/dispatch endpoint")
            except Exception as e:
                logger.error(
                    f"Failed to patch adapter /tasks/dispatch endpoint: {str(e)}"
                )
                continue


# Auto-apply on import
apply_patch()
