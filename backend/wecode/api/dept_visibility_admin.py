# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Admin API for managing ERP department visibility config in Redis.

Operated by developers via curl on behalf of HR — no frontend UI is exposed.
HR submits a change request, a developer applies it through these endpoints,
and the new config takes effect on the next search.

Routes (registered at /internal/admin/dept-visibility):
    GET   /                  Read current hidden list and whitelist
    PUT   /hidden             Replace the hidden list (full overwrite)
    PUT   /whitelist          Replace the whitelist (full overwrite)
"""

import logging

from fastapi import APIRouter, Body, Depends, HTTPException

from app.core.security import get_current_user
from app.models.user import User
from wecode.service.dept_visibility import (
    FIELD_HIDDEN,
    FIELD_WHITELIST,
    get_visibility_config,
    write_field,
)

logger = logging.getLogger(__name__)
router = APIRouter()

ADMIN_USERNAMES = {"admin"}


def _ensure_admin(current_user: User) -> None:
    if current_user is None or current_user.user_name not in ADMIN_USERNAMES:
        raise HTTPException(status_code=403, detail="Admin privileges required")


@router.get("")
def read_config(current_user: User = Depends(get_current_user)):
    """Return the current hidden list and whitelist (sorted)."""
    _ensure_admin(current_user)
    cfg = get_visibility_config()
    return {
        "hidden_items": sorted(cfg.hidden_items),
        "whitelist_users": sorted(cfg.whitelist_users),
    }


@router.put("/hidden")
def update_hidden(
    items: list[str] = Body(..., embed=True),
    current_user: User = Depends(get_current_user),
):
    """Replace the hidden department list with the provided items."""
    _ensure_admin(current_user)
    try:
        stored = write_field(FIELD_HIDDEN, items)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    logger.info(
        f"dept_visibility: hidden_items updated by {current_user.user_name} "
        f"(count={len(stored)})"
    )
    return {"hidden_items": stored}


@router.put("/whitelist")
def update_whitelist(
    user_names: list[str] = Body(..., embed=True),
    current_user: User = Depends(get_current_user),
):
    """Replace the whitelist with the provided user_name list."""
    _ensure_admin(current_user)
    try:
        stored = write_field(FIELD_WHITELIST, user_names)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    logger.info(
        f"dept_visibility: whitelist_users updated by {current_user.user_name} "
        f"(count={len(stored)})"
    )
    return {"whitelist_users": stored}
