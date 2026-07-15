# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve WeCode user API key placeholders in the Backend LLM proxy."""

import logging
from functools import wraps
from typing import Any, Awaitable, Callable

from fastapi import HTTPException, status

from app.models.user import User
from app.services import llm_proxy_service
from wecode.service.wecode_apikey_client import (
    WECODE_USER_API_KEY_PLACEHOLDER,
    get_or_create_apikey_async,
)

logger = logging.getLogger(__name__)

APIKeyResolver = Callable[[dict[str, Any], User], Awaitable[str]]


def _wrap_provider_api_key_resolver(original: APIKeyResolver) -> APIKeyResolver:
    """Wrap the core resolver with WeCode's user-scoped key lookup."""

    @wraps(original)
    async def wrapper(model_config: dict[str, Any], current_user: User) -> str:
        api_key = await original(model_config, current_user)
        api_key_template = str(model_config.get("_api_key_template") or api_key)
        if WECODE_USER_API_KEY_PLACEHOLDER not in api_key_template:
            return api_key

        user_name = (current_user.user_name or "").strip()
        if not user_name:
            logger.error(
                "Cannot resolve WeCode LLM proxy API key for user_id=%s: "
                "user_name is empty",
                current_user.id,
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Model credential identity unavailable",
            )

        try:
            real_api_key = (await get_or_create_apikey_async(user_name)).strip()
            if not real_api_key:
                raise ValueError("API key service returned an empty key")
        except Exception as exc:
            logger.error(
                "Failed to resolve WeCode LLM proxy API key for user_id=%s",
                current_user.id,
                exc_info=True,
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Failed to resolve model credentials",
            ) from exc

        return api_key_template.replace(
            WECODE_USER_API_KEY_PLACEHOLDER,
            real_api_key,
        )

    setattr(wrapper, "_wecode_patched", True)
    return wrapper


def apply_patch() -> None:
    """Patch the LLM proxy credential resolver once."""
    original = llm_proxy_service.resolve_llm_proxy_provider_api_key
    if getattr(original, "_wecode_patched", False):
        return
    llm_proxy_service.resolve_llm_proxy_provider_api_key = (
        _wrap_provider_api_key_resolver(original)
    )
    logger.info("Patched LLM proxy provider API key resolution")


apply_patch()
