# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Monkey-patch app.api.endpoints.users endpoints to avoid modifying open-source files.

- read_current_user: replace '***' placeholders with real tokens on response
- No changes to app/ code; patch is auto-applied on import from wecode.api.__init__
"""

from functools import wraps
from typing import Any, Dict, List

try:
    # Import target module/functions
    from app.api.endpoints import users as users_module
    from app.models.user import User
    # Also import the dependency provider to patch dependency chain directly
    from app.core import security as security_module
except Exception:
    users_module = None  # type: ignore
    User = None  # type: ignore
    security_module = None  # type: ignore

from wecode.service.get_user_gitinfo import get_user_gitinfo


def _needs_replace(item: Dict[str, Any]) -> bool:
    return item.get("git_token") == "***"


async def _replace_placeholders(current_user: Any) -> Any:
    """Replace '***' with real tokens for current_user.git_info"""
    if current_user is None or not getattr(current_user, "git_info", None):
        return current_user

    try:
        real_git_info: List[Dict[str, Any]] = await get_user_gitinfo.get_real_git_tokens(current_user.user_name)
        updated_git_info: List[Dict[str, Any]] = []
        for existing_item in current_user.git_info:
            new_item = dict(existing_item)
            if _needs_replace(new_item):
                for real_item in real_git_info:
                    if real_item.get("git_domain") == existing_item.get("git_domain"):
                        new_item["git_token"] = real_item.get("git_token")
                        break
            updated_git_info.append(new_item)
        current_user.git_info = updated_git_info
    except Exception:
        # Keep placeholders if any failure occurs
        pass
    return current_user


def apply_patch() -> None:
    # 1) Patch dependency provider (best-effort). Note: FastAPI Depends stores callable at decoration time.
    #    This may not affect already-registered routes, so we also patch the route endpoint directly below.
    if security_module is not None:
        _orig_get_current_user = getattr(security_module, "get_current_user", None)
        if _orig_get_current_user is not None and not getattr(_orig_get_current_user, "_wecode_patched", False):
            @wraps(_orig_get_current_user)
            async def patched_get_current_user(*args, **kwargs):
                user = _orig_get_current_user(*args, **kwargs)
                return await _replace_placeholders(user)
            setattr(patched_get_current_user, "_wecode_patched", True)
            setattr(security_module, "get_current_user", patched_get_current_user)

    # 2) Patch the actual route endpoint callable in users router so it surely executes our placeholder replacement
    try:
        router = getattr(users_module, "router", None)
        if router is not None and hasattr(router, "routes"):
            for route in router.routes:
                # APIRoute has .path and .methods, ensure GET /me
                path = getattr(route, "path", None)
                methods = getattr(route, "methods", set())
                endpoint = getattr(route, "endpoint", None)
                if path == "/me" and ("GET" in methods) and callable(endpoint) and not getattr(endpoint, "_wecode_patched", False):
                    orig_endpoint = endpoint
                    @wraps(orig_endpoint)
                    async def patched_endpoint(*args, **kwargs):
                        current_user = await orig_endpoint(*args, **kwargs)
                        return await _replace_placeholders(current_user)
                    setattr(patched_endpoint, "_wecode_patched", True)
                    # Replace route.endpoint so FastAPI uses our wrapper
                    route.endpoint = patched_endpoint
    except Exception:
        # fail silently to avoid impacting open-source behavior
        pass


# Auto apply patch on import
apply_patch()