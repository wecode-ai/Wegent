# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Monkey-patch ModelService to enforce admin-only access for all methods
except list_model_names, without modifying open-source app/ code.

- Only list_model_names is publicly accessible.
- All other methods (create_model, get_models, count_active_models, get_by_id, update_model, delete_model)
  require admin user via current_user in kwargs.
- current_user must be provided; missing current_user is treated as non-admin.

This patch is auto-applied on import.
"""

from typing import Any, Callable, Dict

try:
    from fastapi import HTTPException
    from app.services.model import ModelService  # target class to patch
except Exception:
    # If import fails at bootstrap time, skip patching
    ModelService = None  # type: ignore


def _is_admin(user: Any) -> bool:
    """
    Determine if a user is admin.
    Strategy: treat specific usernames as admin to avoid modifying DB schema.
    Adjust the set below as needed.
    """
    if user is None:
        return False
    username = getattr(user, "user_name", None)
    return username in {"admin"}


def _ensure_admin(kwargs: Dict[str, Any]) -> None:
    current_user = kwargs.get("current_user")
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin privileges required")


def _wrap_admin_only(method: Callable) -> Callable:
    def wrapper(self, *args, **kwargs):
        _ensure_admin(kwargs)
        return method(self, *args, **kwargs)
    # mark as patched to avoid double patching
    setattr(wrapper, "_wecode_patched", True)
    return wrapper


def apply_patch() -> None:
    if ModelService is None:
        return

    # List of methods to protect (admin-only)
    admin_methods = [
        "create_model",
        "get_models",
        "count_active_models",
        "get_by_id",
        "update_model",
        "delete_model",
    ]
    # list_model_names is intentionally excluded (public)

    for name in admin_methods:
        orig = getattr(ModelService, name, None)
        if callable(orig) and not getattr(orig, "_wecode_patched", False):
            patched = _wrap_admin_only(orig)
            setattr(ModelService, name, patched)  # type: ignore[attr-defined]


# Auto-apply on import
apply_patch()