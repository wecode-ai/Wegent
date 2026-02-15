# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Monkey-patch model_resolver._process_model_config_placeholders to replace
${WECODE_USER_API_KEY} placeholder with real API keys from external service.

This patch ensures that the new dispatcher.py flow (which uses request_builder.py
and model_resolver.py) correctly replaces the ${WECODE_USER_API_KEY} placeholder.

Auto-applied on import.
"""

import logging
from functools import wraps
from typing import Any, Callable, Dict, Optional

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
                f"[model_resolver_patch] Attempting to get API key for user: {username}"
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
                                f"[model_resolver_patch] Successfully retrieved existing API key for user: {username}"
                            )
                            return apikey.strip()

            # If no valid API key found, create a new one
            logger.info(
                f"[model_resolver_patch] No existing API key found, creating new one for user: {username}"
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
                            f"[model_resolver_patch] Successfully created new API key for user: {username}"
                        )
                        return apikey.strip()

            raise Exception(
                f"Failed to get valid API key from create response: {result}"
            )

        except httpx.HTTPStatusError as e:
            logger.error(
                f"[model_resolver_patch] HTTP error when getting/creating API key for {username}: "
                f"{e.response.status_code} - {e.response.text}"
            )
            raise Exception(f"HTTP error: {e.response.status_code}")
        except Exception as e:
            logger.error(
                f"[model_resolver_patch] Error getting/creating API key for {username}: {str(e)}"
            )
            raise


def _replace_wecode_user_api_key(value: str, real_apikey: str) -> str:
    """
    Replace ${WECODE_USER_API_KEY} placeholder in a string with real API key.

    Args:
        value: String that may contain the placeholder
        real_apikey: The real API key to replace with

    Returns:
        String with placeholder replaced
    """
    if not value or not isinstance(value, str):
        return value
    return value.replace(WECODE_USER_API_KEY_PLACEHOLDER, real_apikey)


def _wrap_process_model_config_placeholders(original_func: Callable) -> Callable:
    """
    Wrap the _process_model_config_placeholders function to handle ${WECODE_USER_API_KEY}.

    The original function handles placeholders like ${user.name}, ${agent_config.xxx}, etc.
    This wrapper adds support for ${WECODE_USER_API_KEY} which requires an external API call.
    """

    @wraps(original_func)
    def wrapper(
        model_config: Dict[str, Any],
        user_id: int,
        user_name: str,
        agent_config: Optional[Dict[str, Any]] = None,
        task_data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        # First call the original function to handle standard placeholders
        result = original_func(
            model_config=model_config,
            user_id=user_id,
            user_name=user_name,
            agent_config=agent_config,
            task_data=task_data,
        )

        # Check if api_key contains ${WECODE_USER_API_KEY} placeholder
        api_key = result.get("api_key", "")
        if api_key and WECODE_USER_API_KEY_PLACEHOLDER in api_key:
            if not user_name:
                logger.warning(
                    "[model_resolver_patch] Cannot replace ${WECODE_USER_API_KEY}: user_name is empty"
                )
                return result

            try:
                # Get the real API key from external service
                real_apikey = _get_or_create_apikey_sync(user_name)
                result["api_key"] = _replace_wecode_user_api_key(api_key, real_apikey)
                logger.info(
                    f"[model_resolver_patch] Successfully replaced ${{WECODE_USER_API_KEY}} "
                    f"for user: {user_name}"
                )
            except Exception as e:
                logger.error(
                    f"[model_resolver_patch] Failed to replace ${{WECODE_USER_API_KEY}} "
                    f"for user {user_name}: {str(e)}"
                )
                # Keep the original placeholder if replacement fails
                # This allows downstream error handling to catch the issue

        return result

    # Mark as patched to avoid double patching
    setattr(wrapper, "_wecode_patched", True)
    return wrapper


def apply_patch() -> None:
    """
    Apply the patch to model_resolver._process_model_config_placeholders function.
    """
    try:
        from app.services.chat.config import model_resolver
    except ImportError:
        logger.warning(
            "[model_resolver_patch] model_resolver module not available, skipping patch"
        )
        return

    original_func = getattr(model_resolver, "_process_model_config_placeholders", None)
    if original_func is None:
        logger.warning(
            "[model_resolver_patch] _process_model_config_placeholders function not found, skipping patch"
        )
        return

    # Skip if already patched
    if getattr(original_func, "_wecode_patched", False):
        logger.debug(
            "[model_resolver_patch] _process_model_config_placeholders already patched, skipping"
        )
        return

    try:
        logger.info(
            "[model_resolver_patch] Applying patch to model_resolver._process_model_config_placeholders"
        )
        wrapped = _wrap_process_model_config_placeholders(original_func)
        model_resolver._process_model_config_placeholders = wrapped
        logger.info(
            "[model_resolver_patch] Successfully patched model_resolver._process_model_config_placeholders"
        )
    except Exception as e:
        logger.error(
            f"[model_resolver_patch] Failed to patch _process_model_config_placeholders: {str(e)}"
        )


# Auto-apply on import
apply_patch()
