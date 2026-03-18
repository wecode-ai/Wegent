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

import json
import logging
from functools import wraps
from typing import Callable

from wecode.service.wecode_apikey_client import (
    WECODE_USER_API_KEY_PLACEHOLDER,
    get_or_create_apikey_sync,
    replace_api_key_in_config,
)

logger = logging.getLogger(__name__)


def _parse_preferences(preferences) -> dict:
    """Parse user.preferences to dict (handles str, dict, None)."""
    if not preferences:
        return {}
    if isinstance(preferences, dict):
        return preferences
    if isinstance(preferences, str):
        try:
            return json.loads(preferences)
        except (json.JSONDecodeError, TypeError):
            return {}
    return {}


def _wrap_build_user_info(original_method: Callable) -> Callable:
    """
    Wrap _build_user_info to inject decrypted sina_mail_token into user dict.
    """

    @wraps(original_method)
    def wrapper(self, user, git_domain=None):
        user_info = original_method(self, user, git_domain)
        # Inject decrypted sina_mail_token from user preferences
        prefs = _parse_preferences(user.preferences)
        encrypted = prefs.get("sina_mail_token")
        if encrypted:
            try:
                from shared.utils.crypto import decrypt_sensitive_data

                decrypted = decrypt_sensitive_data(encrypted)
                if decrypted:
                    user_info["sina_mail_token"] = decrypted
            except Exception:
                logger.warning(
                    "[request_builder_patch] Failed to decrypt sina_mail_token"
                )
        return user_info

    setattr(wrapper, "_wecode_user_info_patched", True)
    return wrapper


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
                    real_apikey = get_or_create_apikey_sync(user_name)

                    # Replace in model_config
                    result.model_config = replace_api_key_in_config(
                        result.model_config, real_apikey
                    )

                    # Also replace in bot configs if present
                    if result.bot and isinstance(result.bot, list):
                        result.bot = replace_api_key_in_config(result.bot, real_apikey)

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

    # Patch _build_user_info to inject sina_mail_token
    original_build_user_info = getattr(TaskRequestBuilder, "_build_user_info", None)
    if original_build_user_info and not getattr(
        original_build_user_info, "_wecode_user_info_patched", False
    ):
        try:
            logger.info(
                "[request_builder_patch] Applying patch to TaskRequestBuilder._build_user_info"
            )
            TaskRequestBuilder._build_user_info = _wrap_build_user_info(
                original_build_user_info
            )
            logger.info(
                "[request_builder_patch] Successfully patched TaskRequestBuilder._build_user_info"
            )
        except Exception as e:
            logger.error(
                f"[request_builder_patch] Failed to patch _build_user_info: {str(e)}"
            )


# Auto-apply on import
apply_patch()
