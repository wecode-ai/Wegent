# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from app.core import security
from app.models.user import User

# Logger instance
logger = logging.getLogger(__name__)

# Quota related router
router = APIRouter()


@router.api_route("/{path:path}", methods=["GET"])
async def get_quota(
    path: str, request: Request, current_user: User = Depends(security.get_current_user)
):
    """
    Get user quota information - Open source version
    Returns empty quota information by default

    Args:
        path: Request path
        request: FastAPI request object
        current_user: Current authenticated user

    Returns:
        dict: Empty quota information dictionary
    """
    logger.info(f"get quota for user {current_user.email}, path: {path}")
    return {}
