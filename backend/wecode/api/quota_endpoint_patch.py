# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Quota endpoint patch module
Apply monkey patch to app.api.endpoints.quota to implement proxy forwarding
to the unified AIGC quota service (aigc_quota).
Do not modify open source code, follow minimal intrusion principle.
"""
import logging
from functools import wraps
from typing import Callable

import httpx

try:
    from app.api.endpoints import quota as quota_module
except Exception:
    quota_module = None

logger = logging.getLogger(__name__)

AIGC_QUOTA_URL = (
    "https://copilot.weibo.com/v1/wecode_quota/user_aigc_model_quota_detail"
)


def _transform_aigc_response(raw: dict) -> dict:
    """
    Transform the AIGC quota service response into the unified format
    consumed by the frontend.
    """
    user_quota = raw.get("user_quota", 0)
    user_usage = raw.get("user_usage", 0)
    return {
        "data": {
            "quota": user_quota,
            "usage": round(user_usage, 2),
            "remaining": round(user_quota - user_usage, 2),
            "usage_rate": raw.get("user_usage_rate", 0),
            "user": raw.get("username", ""),
        },
        "quota_source": "AIGC",
        "status": "success",
    }


def _wrap_quota_endpoint(endpoint: Callable) -> Callable:
    """
    Wrap quota endpoint to proxy to the unified AIGC quota service.
    """

    @wraps(endpoint)
    async def wrapper(*args, **kwargs):
        current_user = kwargs.get("current_user")

        if not current_user:
            return await endpoint(*args, **kwargs)

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    AIGC_QUOTA_URL,
                    json={"user_name": current_user.user_name},
                    timeout=10,
                )
                resp.raise_for_status()

            raw = resp.json()
            if not isinstance(raw, dict) or "user_quota" not in raw:
                logger.warning("Unexpected AIGC quota response: %s", raw)
                return await endpoint(*args, **kwargs)

            return _transform_aigc_response(raw)

        except Exception as e:
            logger.error("AIGC quota service request failed: %s", e)
            return await endpoint(*args, **kwargs)

    setattr(wrapper, "_wecode_patched", True)
    return wrapper


def apply_patch() -> None:
    """
    Apply quota endpoint patch.
    Traverse routes in app.api.endpoints.quota.router and wrap endpoints.
    """
    if quota_module is None:
        logger.warning("quota_module not available, skipping patch")
        return

    router = getattr(quota_module, "router", None)
    if router is None or not hasattr(router, "routes"):
        logger.warning("Quota router not found, skipping patch")
        return

    for route in router.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", set())
        endpoint = getattr(route, "endpoint", None)

        if not callable(endpoint) or getattr(endpoint, "_wecode_patched", False):
            continue

        if path == "/{path:path}" and "GET" in methods:
            try:
                route.endpoint = _wrap_quota_endpoint(endpoint)
            except Exception as e:
                logger.error("Failed to apply quota endpoint patch: %s", e)
                continue


apply_patch()
