# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared dependencies for Wecode API endpoints."""

from fastapi import Depends

from app.core.security import (
    get_admin_user,
    get_current_user_flexible_for_executor,
)
from app.models.user import User


def get_admin_user_by_jwt_or_api_key(
    current_user: User = Depends(get_current_user_flexible_for_executor),
) -> User:
    """Authenticate an administrator with a JWT or personal API key."""
    return get_admin_user(current_user)
