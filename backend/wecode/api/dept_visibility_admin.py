# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Admin API for managing ERP department visibility config in Redis.

Operated by developers via curl on behalf of HR — no frontend UI is exposed.
HR submits a whitelist change request, a developer applies it through the
whitelist endpoint, and the new config takes effect on the next search.

Routes (registered at /internal/admin/dept-visibility):
    GET   /                  Read the current whitelist
    PUT   /whitelist          Replace the whitelist (full overwrite)
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.security import get_admin_user
from app.models.user import User
from wecode.service.dept_visibility import (
    FIELD_WHITELIST,
    get_visibility_config,
    write_field,
)

logger = logging.getLogger(__name__)
router = APIRouter()

_MAX_LIST_LEN = 1000


class WhitelistUpdate(BaseModel):
    user_names: list[str] = Field(..., max_length=_MAX_LIST_LEN)


@router.get("")
def read_config(current_user: User = Depends(get_admin_user)):
    """Return the current whitelist (sorted)."""
    cfg = get_visibility_config()
    return {"whitelist_users": sorted(cfg.whitelist_users)}


@router.put("/whitelist")
def update_whitelist(
    body: WhitelistUpdate,
    current_user: User = Depends(get_admin_user),
):
    """Replace the whitelist with the provided user_name list."""
    try:
        stored = write_field(FIELD_WHITELIST, body.user_names)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    logger.info(
        f"dept_visibility: whitelist_users updated by {current_user.user_name} "
        f"(count={len(stored)})"
    )
    return {"whitelist_users": stored}
