# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Monkey-patch app.api.endpoints.users endpoints to avoid modifying open-source files.

- read_current_user: replace '***' placeholders with real tokens on response
- read_wegent_runtime_user: expose internal employee_id and Weibo uid
- No changes to app/ code; patch is auto-applied on import from wecode.api.__init__
"""

import json
from typing import Any, Dict, List, Optional

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session
from starlette.routing import request_response

try:
    from app.api.dependencies import get_db
except Exception:
    get_db = None  # type: ignore

try:
    from app.services.auth import extract_token_from_header, verify_task_token
except Exception:
    extract_token_from_header = None  # type: ignore
    verify_task_token = None  # type: ignore

try:
    from app.models.user import User
except Exception:
    User = None  # type: ignore

WegentRuntimeUserResponse = None  # type: ignore

try:
    from shared.utils.crypto import encrypt_sensitive_data_with_embedded_iv
except Exception:
    encrypt_sensitive_data_with_embedded_iv = None  # type: ignore

try:
    from app.api.endpoints import users as users_module
except Exception:
    users_module = None  # type: ignore

from wecode.service.get_user_gitinfo import get_user_gitinfo


def _needs_replace(item: Dict[str, Any]) -> bool:
    return item.get("git_token") == "***"


def _replace_placeholders(current_user: Any) -> Any:
    """Replace '***' with real tokens for current_user.git_info"""
    if current_user is None or not getattr(current_user, "git_info", None):
        return current_user

    try:
        real_git_info: List[Dict[str, Any]] = get_user_gitinfo.get_real_git_tokens(
            current_user.user_name
        )
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


def _load_preferences(raw_preferences: Any) -> Dict[str, Any]:
    if isinstance(raw_preferences, dict):
        return dict(raw_preferences)
    if not raw_preferences:
        return {}
    try:
        parsed = json.loads(raw_preferences)
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _get_internal_runtime_uid(user: Any) -> str:
    preferences = _load_preferences(getattr(user, "preferences", None))
    weibo_binding = preferences.get("weibo_binding")
    if isinstance(weibo_binding, dict):
        uid = weibo_binding.get("uid")
        if uid:
            return str(uid)
    return str(user.id)


def _get_internal_employee_id(user: Any) -> str:
    preferences = _load_preferences(getattr(user, "preferences", None))
    company_profile = preferences.get("company_profile")
    if isinstance(company_profile, dict):
        employee_id = company_profile.get("employee_id")
        if employee_id:
            return str(employee_id)
    return ""


def _get_internal_company_name(user: Any) -> str:
    preferences = _load_preferences(getattr(user, "preferences", None))
    company_profile = preferences.get("company_profile")
    if isinstance(company_profile, dict):
        name = company_profile.get("name")
        if name:
            return str(name)
    return user.user_name


def _patch_wegent_runtime_route(route: Any) -> None:
    endpoint = getattr(route, "endpoint", None)
    if getattr(endpoint, "_wecode_patched", False):
        return

    setattr(_patched_wegent_runtime_user, "_wecode_patched", True)
    route.endpoint = _patched_wegent_runtime_user
    if getattr(route, "dependant", None) is not None:
        route.dependant.call = _patched_wegent_runtime_user
    route.app = request_response(route.get_route_handler())


def _load_users_module() -> Any:
    global users_module
    if users_module is not None:
        return users_module

    try:
        from app.api.endpoints import users as loaded_users_module
    except Exception:
        return None

    users_module = loaded_users_module
    return users_module


def _load_runtime_dependencies() -> bool:
    global extract_token_from_header
    global verify_task_token
    global User
    global WegentRuntimeUserResponse
    global encrypt_sensitive_data_with_embedded_iv

    if extract_token_from_header is None or verify_task_token is None:
        try:
            from app.services.auth import (
                extract_token_from_header as loaded_extract_token_from_header,
            )
            from app.services.auth import verify_task_token as loaded_verify_task_token
        except Exception:
            return False

        extract_token_from_header = loaded_extract_token_from_header
        verify_task_token = loaded_verify_task_token

    if User is None:
        try:
            from app.models.user import User as loaded_user
        except Exception:
            return False

        User = loaded_user

    if WegentRuntimeUserResponse is None:
        loaded_users_module = _load_users_module()
        loaded_runtime_response = getattr(
            loaded_users_module, "WegentRuntimeUserResponse", None
        )
        if loaded_runtime_response is None:
            return False

        WegentRuntimeUserResponse = loaded_runtime_response

    if encrypt_sensitive_data_with_embedded_iv is None:
        try:
            from shared.utils.crypto import (
                encrypt_sensitive_data_with_embedded_iv as loaded_encrypt,
            )
        except Exception:
            return False

        encrypt_sensitive_data_with_embedded_iv = loaded_encrypt

    return True


async def _patched_wegent_runtime_user(
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
):
    """Return encrypted internal user information for a Wegent task token."""

    if not _load_runtime_dependencies():
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Wegent runtime dependencies unavailable",
        )

    token = extract_token_from_header(authorization or "")
    token_info = verify_task_token(token or "")
    if not token_info:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Wegent token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = (
        db.query(User)
        .filter(User.id == token_info.user_id, User.is_active.is_(True))
        .first()
    )
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )

    payload = {
        "employee_id": _get_internal_employee_id(user),
        "email": user.email or "",
        "name": _get_internal_company_name(user),
        "uid": _get_internal_runtime_uid(user),
        "expire_at": int(token_info.expire_at or 0),
    }
    return WegentRuntimeUserResponse(
        user=encrypt_sensitive_data_with_embedded_iv(
            json.dumps(payload, ensure_ascii=False)
        )
    )


def apply_patch() -> None:
    # Patch route endpoints after app.api.api has included users.router into api_router.
    try:
        router = getattr(_load_users_module(), "router", None)
        if router is not None and hasattr(router, "routes"):
            for route in router.routes:
                path = getattr(route, "path", None)
                methods = getattr(route, "methods", set())
                if path == "/me/wegent-runtime" and ("GET" in methods):
                    _patch_wegent_runtime_route(route)
            try:
                from app.api.router import api_router

                for route in api_router.routes:
                    path = getattr(route, "path", None)
                    methods = getattr(route, "methods", set())
                    endpoint = getattr(route, "endpoint", None)
                    if (
                        path == "/users/me"
                        and ("GET" in methods)
                        and callable(endpoint)
                        and not getattr(endpoint, "_wecode_patched", False)
                    ):
                        orig_endpoint = endpoint

                        async def patched_endpoint(*args, **kwargs):
                            current_user = await orig_endpoint(*args, **kwargs)
                            return _replace_placeholders(current_user)

                        setattr(patched_endpoint, "_wecode_patched", True)
                        route.endpoint = patched_endpoint
                        if getattr(route, "dependant", None) is not None:
                            route.dependant.call = patched_endpoint
                        route.app = request_response(route.get_route_handler())
                    if path == "/users/me/wegent-runtime" and ("GET" in methods):
                        _patch_wegent_runtime_route(route)
            except Exception:
                pass
    except Exception:
        # fail silently to avoid impacting open-source behavior
        pass


# Auto apply patch on import
apply_patch()
