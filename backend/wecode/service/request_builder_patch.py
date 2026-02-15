# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Monkey-patch TaskRequestBuilder.build to replace ${WECODE_USER_API_KEY}
placeholder with real API keys from external service.

This patch ensures that the new dispatcher.py flow (which uses request_builder.py)
correctly replaces the ${WECODE_USER_API_KEY} placeholder in model_config.api_key.

Auto-applied on import.
"""

import logging
from functools import wraps
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

# Placeholder constant
WECODE_USER_API_KEY_PLACEHOLDER = "${WECODE_USER_API_KEY}"


def _get_or_create_apikey_sync(username: str) -> str:
    """
    Synchronous version of get_or_create_apikey for use in sync contexts.

    Args:
        username: The username to get/create API key for

    Returns:
        The API key string

    Raises:
        Exception: If both get and create operations fail
    """
    import httpx

    # External API endpoints (same as dispatch_tasks_patch.py)
    APIKEY_GET_URL = "https://copilot.weibo.com/v1/wecode_apikey/get_apikeys"
    APIKEY_CREATE_URL = "https://copilot.weibo.com/v1/wecode_apikey/create_apikey"
    AUTH_SIGN = "wecode_apikey_server_auth_91854e590f3c647c6237745794e4"

    payload = {"username": username, "sign": AUTH_SIGN}

    with httpx.Client() as client:
        try:
            # First try to get existing API key
            logger.info(
                f"[request_builder_patch] Attempting to get API key for user: {username}"
            )
            response = client.post(
                APIKEY_GET_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=10.0,
            )
            response.raise_for_status()
            result = response.json()

            # Check if we got valid API keys (response format: {"data": {"apikeys": [...]}})
            if result and isinstance(result, dict):
                data = result.get("data", {})
                if isinstance(data, dict):
                    apikeys = data.get("apikeys", [])
                    if isinstance(apikeys, list) and len(apikeys) > 0:
                        # Take the first API key
                        apikey = apikeys[0]
                        if apikey and isinstance(apikey, str) and apikey.strip():
                            logger.info(
                                f"[request_builder_patch] Successfully retrieved existing API key for user: {username}"
                            )
                            return apikey.strip()

            # If no valid API key found, create a new one
            logger.info(
                f"[request_builder_patch] No existing API key found, creating new one for user: {username}"
            )
            response = client.post(
                APIKEY_CREATE_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=10.0,
            )
            response.raise_for_status()
            result = response.json()

            # Check create response format: {"data": {"apikey": "..."}}
            if result and isinstance(result, dict):
                data = result.get("data", {})
                if isinstance(data, dict):
                    apikey = data.get("apikey")
                    if apikey and isinstance(apikey, str) and apikey.strip():
                        logger.info(
                            f"[request_builder_patch] Successfully created new API key for user: {username}"
                        )
                        return apikey.strip()

            raise Exception(
                f"Failed to get valid API key from create response: {result}"
            )

        except httpx.HTTPStatusError as e:
            logger.error(
                f"[request_builder_patch] HTTP error when getting/creating API key for {username}: "
                f"{e.response.status_code} - {e.response.text}"
            )
            raise Exception(f"HTTP error: {e.response.status_code}")
        except Exception as e:
            logger.error(
                f"[request_builder_patch] Error getting/creating API key for {username}: {str(e)}"
            )
            raise


def _replace_api_key_in_config(config: Any, real_apikey: str) -> Any:
    """
    Recursively replace ${WECODE_USER_API_KEY} placeholder in config with real API key.

    Args:
        config: The configuration object (dict, list, or primitive)
        real_apikey: The real API key to replace with

    Returns:
        The config with placeholders replaced
    """
    if isinstance(config, dict):
        result = {}
        for key, value in config.items():
            result[key] = _replace_api_key_in_config(value, real_apikey)
        return result
    elif isinstance(config, list):
        return [_replace_api_key_in_config(item, real_apikey) for item in config]
    elif isinstance(config, str):
        return config.replace(WECODE_USER_API_KEY_PLACEHOLDER, real_apikey)
    else:
        return config


def _wrap_build_method(original_method: Callable) -> Callable:
    """
    Wrap the TaskRequestBuilder.build method to process API key replacement.
    """

    @wraps(original_method)
    def wrapper(self, *args, **kwargs):
        # Call the original method
        result = original_method(self, *args, **kwargs)

        # Check if model_config.api_key contains the placeholder
        if result.model_config and isinstance(result.model_config, dict):
            api_key = result.model_config.get("api_key", "")
            if api_key and WECODE_USER_API_KEY_PLACEHOLDER in api_key:
                # Get username from result
                user_name = result.user_name
                if not user_name:
                    logger.warning(
                        "[request_builder_patch] Cannot replace ${WECODE_USER_API_KEY}: user_name is empty"
                    )
                    return result

                try:
                    # Get the real API key from external service
                    real_apikey = _get_or_create_apikey_sync(user_name)

                    # Replace in model_config
                    result.model_config = _replace_api_key_in_config(
                        result.model_config, real_apikey
                    )

                    # Also replace in bot configs if present
                    if result.bot and isinstance(result.bot, list):
                        result.bot = _replace_api_key_in_config(result.bot, real_apikey)

                    logger.info(
                        f"[request_builder_patch] Successfully replaced ${{WECODE_USER_API_KEY}} "
                        f"for user: {user_name}"
                    )
                except Exception as e:
                    logger.error(
                        f"[request_builder_patch] Failed to replace ${{WECODE_USER_API_KEY}} "
                        f"for user {user_name}: {str(e)}"
                    )
                    # Keep the original placeholder if replacement fails

        return result

    # Mark as patched to avoid double patching
    setattr(wrapper, "_wecode_patched", True)
    return wrapper


def apply_patch() -> None:
    """
    Apply the patch to TaskRequestBuilder.build method.
    """
    try:
        from app.services.execution.request_builder import TaskRequestBuilder
    except ImportError:
        logger.warning(
            "[request_builder_patch] TaskRequestBuilder not available, skipping patch"
        )
        return

    original_method = getattr(TaskRequestBuilder, "build", None)
    if original_method is None:
        logger.warning(
            "[request_builder_patch] TaskRequestBuilder.build method not found, skipping patch"
        )
        return

    # Skip if already patched
    if getattr(original_method, "_wecode_patched", False):
        logger.debug(
            "[request_builder_patch] TaskRequestBuilder.build already patched, skipping"
        )
        return

    try:
        logger.info(
            "[request_builder_patch] Applying patch to TaskRequestBuilder.build"
        )
        wrapped = _wrap_build_method(original_method)
        TaskRequestBuilder.build = wrapped
        logger.info(
            "[request_builder_patch] Successfully patched TaskRequestBuilder.build"
        )
    except Exception as e:
        logger.error(
            f"[request_builder_patch] Failed to patch TaskRequestBuilder.build: {str(e)}"
        )


# Auto-apply on import
apply_patch()
