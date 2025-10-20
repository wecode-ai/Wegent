# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Quota endpoint patch module
Apply monkey patch to app.api.endpoints.quota to implement proxy forwarding for quota information
Do not modify open source code, follow minimal intrusion principle
"""
from typing import Any, Callable
from functools import wraps
import httpx
import logging

try:
    from fastapi import HTTPException
    from app.api.endpoints import quota as quota_module
except Exception:
    quota_module = None

logger = logging.getLogger(__name__)


def _wrap_quota_endpoint(endpoint: Callable) -> Callable:
    """
    Wrap quota endpoint to implement proxy forwarding to external quota service
    """
    @wraps(endpoint)
    async def wrapper(*args, **kwargs):
        path = kwargs.get("path", "")
        request = kwargs.get("request")
        current_user = kwargs.get("current_user")
        
        if not current_user:
            return await endpoint(*args, **kwargs)
        
        target_url = f"http://copilot.weibo.com/v1/{path}"
        
        headers = {str(k): str(v) for k, v in request.headers.items()}
        headers.pop("host", None)
        headers.pop("Authorization", None)
        headers["wecode-user"] = current_user.user_name
        
        body = await request.body()
        
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.request(
                    method=request.method,
                    url=target_url,
                    headers=headers,
                    params=request.query_params,
                    content=body,
                    timeout=10
                )
            
            content_type = resp.headers.get("content-type", "")
            if content_type.startswith("application/json"):
                json_data = resp.json()
                if isinstance(json_data, dict):
                    json_data["quota_source"] = "wecode"
                return json_data
            return resp.text
            
        except httpx.RequestError as e:
            logger.error(f"Quota service request failed: {str(e)}")
            return await endpoint(*args, **kwargs)
        except Exception as e:
            logger.error(f"Unexpected error in quota proxy: {str(e)}")
            return await endpoint(*args, **kwargs)
    
    # Mark as patched to avoid duplicate patching
    setattr(wrapper, "_wecode_patched", True)
    return wrapper


def apply_patch() -> None:
    """
    Apply quota endpoint patch
    Traverse routes in app.api.endpoints.quota.router and wrap endpoints
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
        
        # Skip non-callable endpoints or already patched endpoints
        if not callable(endpoint) or getattr(endpoint, "_wecode_patched", False):
            continue
        
        # Apply patch to all quota-related routes
        if path == "/{path:path}" and "GET" in methods:
            try:
                wrapped = _wrap_quota_endpoint(endpoint)
                route.endpoint = wrapped
            except Exception as e:
                logger.error(f"Failed to apply quota endpoint patch: {str(e)}")
                continue


apply_patch()